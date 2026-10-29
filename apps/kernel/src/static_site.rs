//! Static delivery of the built SPA bundle.
//!
//! `ServeDir` answered every unknown path with the shell but let
//! `not_found_service` stamp that answer `404`, shipped the 988 KB bundle
//! uncompressed and attached no cache metadata, so each navigation downloaded
//! it again. This module keeps `ServeDir` for file lookup and fixes the three:
//! a status that matches the answer, `Cache-Control`/`ETag` revalidation, and
//! gzip for the text payloads.

use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::Router;
use tower::ServiceExt;
use tower_http::compression::predicate::{
    DefaultPredicate, NotForContentType, Predicate, SizeAbove,
};
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};

/// Vite writes a content hash into every bundle file name under `/assets`, so a
/// rebuild can never reuse an old name.
const IMMUTABLE_CACHE: &str = "public, max-age=31536000, immutable";

/// The shell and every other unhashed file must be revalidated before reuse.
const REVALIDATE_CACHE: &str = "no-cache";

/// Path prefixes the client router owns; each is answered `200` with the shell.
///
/// A closed table rather than "every path that is not a file": a request for a
/// missing resource has to stay a `404`. Segments match whole, so
/// `/admindashboard` is not `/admin`; the pre-G04 spellings (`/plugins`,
/// `/nodes`, ...) are listed because the client still redirects them.
const CLIENT_ROUTE_PREFIXES: &[&str] = &[
    "/admin",
    "/app",
    "/login",
    "/403",
    "/ext",
    "/plugins",
    "/pipelines",
    "/jobs",
    "/nodes",
    "/instances",
    "/settings",
    "/governance",
    "/activity",
    "/access",
    "/ops-center",
];

/// The web bundle on disk: `index.html` plus whatever the build emitted.
#[derive(Clone)]
pub struct StaticSite {
    root: PathBuf,
    shell: PathBuf,
}

impl StaticSite {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        let shell = root.join("index.html");
        Self { root, shell }
    }

    /// Serve the bundle: `ServeDir` for real files, this module for the shell.
    pub fn router(self) -> Router {
        let files = ServeDir::new(&self.root);
        Router::new()
            .fallback_service(files)
            .layer(middleware::from_fn_with_state(self, serve))
    }

    /// What `path` addresses, without serving it.
    async fn resolve(&self, path: &str) -> Target {
        let Some(relative) = relative_path(path) else {
            return Target::Missing;
        };
        if relative.as_os_str().is_empty() || relative == Path::new("index.html") {
            return if is_file(&self.shell).await {
                Target::Shell
            } else {
                Target::Missing
            };
        }
        let candidate = self.root.join(&relative);
        if is_file(&candidate).await {
            Target::File(candidate)
        } else if is_client_route(path) {
            Target::Shell
        } else {
            Target::Missing
        }
    }

    /// Hashed bundle output may be cached forever; everything else revalidates.
    fn cache_control(&self, path: &str) -> &'static str {
        match path.strip_prefix("/assets/") {
            Some(rest) if !rest.is_empty() => IMMUTABLE_CACHE,
            _ => REVALIDATE_CACHE,
        }
    }
}

enum Target {
    /// `index.html`, for `/`, `/index.html` and every client route.
    Shell,
    /// A file that exists inside the bundle root.
    File(PathBuf),
    /// Nothing serves this path; `ServeDir` answers `404`.
    Missing,
}

/// gzip for text payloads, skipped for formats that are already compressed.
///
/// The tower-http default already leaves `image/*` (except `image/svg+xml`,
/// which is text), SSE and gRPC alone; fonts, media, archives and WebAssembly
/// are added here so a request never spends CPU on bytes that cannot shrink.
pub fn compression_layer() -> CompressionLayer<impl Predicate> {
    CompressionLayer::new().compress_when(
        SizeAbove::new(256)
            .and(DefaultPredicate::new())
            .and(NotForContentType::const_new("font/"))
            .and(NotForContentType::const_new("video/"))
            .and(NotForContentType::const_new("audio/"))
            .and(NotForContentType::const_new("application/zip"))
            .and(NotForContentType::const_new("application/gzip"))
            .and(NotForContentType::const_new("application/wasm"))
            .and(NotForContentType::const_new("application/octet-stream")),
    )
}

async fn serve(State(site): State<StaticSite>, request: Request, next: Next) -> Response {
    let method = request.method();
    if method != Method::GET && method != Method::HEAD {
        return next.run(request).await;
    }

    let path = request.uri().path().to_owned();
    let cache_control = HeaderValue::from_static(site.cache_control(&path));
    let (file, shell) = match site.resolve(&path).await {
        Target::Missing => return next.run(request).await,
        Target::Shell => (site.shell.clone(), true),
        Target::File(file) => (file, false),
    };

    let etag = etag_for(&file).await;
    if is_not_modified(request.headers(), etag.as_ref()) {
        return not_modified(etag, cache_control);
    }

    // The shell is answered here rather than by `ServeDir`: a client route and a
    // missing file look identical to a directory lookup.
    let mut response = if shell {
        serve_file(&file, request).await
    } else {
        next.run(request).await
    };

    if matches!(
        response.status(),
        StatusCode::OK | StatusCode::PARTIAL_CONTENT
    ) {
        let headers = response.headers_mut();
        headers.insert(header::CACHE_CONTROL, cache_control);
        if let Some(etag) = etag {
            headers.insert(header::ETAG, etag);
        }
    }
    response
}

/// Serve one file through `ServeFile` so `HEAD` and content types keep behaving
/// exactly as they do for the rest of the bundle.
async fn serve_file(path: &Path, request: Request) -> Response {
    match ServeFile::new(path).oneshot(request).await {
        Ok(response) => response.map(Body::new),
        Err(never) => match never {},
    }
}

/// A weak validator built from size and mtime: both move when the file is
/// rebuilt, and neither needs the bundle to be read to answer a revalidation.
async fn etag_for(path: &Path) -> Option<HeaderValue> {
    let metadata = tokio::fs::metadata(path).await.ok()?;
    let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    HeaderValue::from_str(&format!(
        "W/\"{:x}-{:x}-{:x}\"",
        metadata.len(),
        modified.as_secs(),
        modified.subsec_nanos()
    ))
    .ok()
}

fn is_not_modified(headers: &HeaderMap, etag: Option<&HeaderValue>) -> bool {
    let Some(etag) = etag.and_then(|value| value.to_str().ok()) else {
        return false;
    };
    let etag = etag.trim_start_matches("W/");
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .any(|candidate| candidate == "*" || candidate.trim_start_matches("W/") == etag)
}

fn not_modified(etag: Option<HeaderValue>, cache_control: HeaderValue) -> Response {
    let mut response = StatusCode::NOT_MODIFIED.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, cache_control);
    if let Some(etag) = etag {
        headers.insert(header::ETAG, etag);
    }
    response
}

/// Translate a request path into a path inside the bundle, or `None` when it
/// tries to leave it.
fn relative_path(path: &str) -> Option<PathBuf> {
    let decoded = urlencoding::decode(path).ok()?;
    let mut relative = PathBuf::new();
    for component in Path::new(decoded.trim_start_matches('/')).components() {
        match component {
            Component::Normal(part) => relative.push(part),
            _ => return None,
        }
    }
    Some(relative)
}

fn is_client_route(path: &str) -> bool {
    let path = path.trim_end_matches('/');
    CLIENT_ROUTE_PREFIXES.iter().any(|prefix| {
        path == *prefix
            || path
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

async fn is_file(path: &Path) -> bool {
    tokio::fs::metadata(path)
        .await
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use tower::ServiceExt;

    // 593 bytes in the real build, so the fixture clears the 256-byte floor that
    // keeps gzip away from responses too small to gain anything.
    const SHELL: &str = concat!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
        "<meta name=\"theme-color\" content=\"#0f172a\">",
        "<link rel=\"icon\" type=\"image/svg+xml\" href=\"/favicon.svg\">",
        "<title>OpsWeave</title>",
        "<style>html,body{margin:0;height:100%}#root{min-height:100vh}</style>",
        "<script type=\"module\" src=\"/assets/index-abc123.js\"></script>",
        "</head><body><div id=\"root\"></div>",
        "<noscript>OpsWeave needs JavaScript enabled to render this console.</noscript>",
        "</body></html>"
    );
    const BUNDLE_LINE: &str = "console.log('opsweave kernel bundle');\n";

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let root =
                std::env::temp_dir().join(format!("opsweave-static-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(root.join("assets")).unwrap();
            std::fs::create_dir_all(root.join("fonts")).unwrap();
            std::fs::write(root.join("index.html"), SHELL).unwrap();
            std::fs::write(root.join("assets/index-abc123.js"), BUNDLE_LINE.repeat(120)).unwrap();
            std::fs::write(
                root.join("favicon.svg"),
                format!(
                    "<svg xmlns=\"http://www.w3.org/2000/svg\">{}</svg>",
                    "<path d=\"M0 0h10v10H0z\"/>".repeat(30)
                ),
            )
            .unwrap();
            std::fs::write(root.join("logo.png"), vec![0x89u8; 1500]).unwrap();
            std::fs::write(root.join("fonts/inter.woff2"), vec![0x77u8; 1500]).unwrap();
            Self { root }
        }

        fn app(&self) -> Router {
            StaticSite::new(&self.root)
                .router()
                .layer(compression_layer())
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    async fn request(
        app: &Router,
        method: Method,
        path: &str,
        headers: &[(&str, &str)],
    ) -> Response {
        let mut builder = axum::http::Request::builder().method(method).uri(path);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        app.clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    async fn get(app: &Router, path: &str) -> Response {
        request(app, Method::GET, path, &[]).await
    }

    async fn read_body(response: Response) -> Vec<u8> {
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec()
    }

    fn header_of(response: &Response, name: header::HeaderName) -> String {
        response
            .headers()
            .get(name)
            .map(|value| value.to_str().unwrap().to_string())
            .unwrap_or_default()
    }

    #[tokio::test]
    async fn hashed_asset_is_gzipped_cached_and_etagged() {
        let fixture = Fixture::new("hashed");
        let app = fixture.app();

        let plain = get(&app, "/assets/index-abc123.js").await;
        assert_eq!(plain.status(), StatusCode::OK);
        assert_eq!(header_of(&plain, header::CACHE_CONTROL), IMMUTABLE_CACHE);
        assert!(header_of(&plain, header::ETAG).starts_with("W/\""));
        assert!(plain.headers().get(header::CONTENT_ENCODING).is_none());
        let plain_len = read_body(plain).await.len();

        let gzipped = request(
            &app,
            Method::GET,
            "/assets/index-abc123.js",
            &[("accept-encoding", "gzip")],
        )
        .await;
        assert_eq!(gzipped.status(), StatusCode::OK);
        assert_eq!(header_of(&gzipped, header::CONTENT_ENCODING), "gzip");
        assert!(header_of(&gzipped, header::VARY).contains("accept-encoding"));
        assert_eq!(header_of(&gzipped, header::CACHE_CONTROL), IMMUTABLE_CACHE);
        assert!(header_of(&gzipped, header::ETAG).starts_with("W/\""));
        let gzipped_len = read_body(gzipped).await.len();
        assert!(
            gzipped_len * 4 < plain_len,
            "gzip {gzipped_len} bytes vs raw {plain_len} bytes"
        );
    }

    #[tokio::test]
    async fn etag_revalidation_answers_304_without_the_body() {
        let fixture = Fixture::new("revalidate");
        let app = fixture.app();

        for path in ["/assets/index-abc123.js", "/admin/overview"] {
            let first = get(&app, path).await;
            let etag = header_of(&first, header::ETAG);
            assert!(!etag.is_empty(), "{path} must carry an ETag");
            let expected_cache = if path.starts_with("/assets/") {
                IMMUTABLE_CACHE
            } else {
                REVALIDATE_CACHE
            };
            assert_eq!(header_of(&first, header::CACHE_CONTROL), expected_cache);

            let second =
                request(&app, Method::GET, path, &[("if-none-match", etag.as_str())]).await;
            assert_eq!(second.status(), StatusCode::NOT_MODIFIED, "{path}");
            assert_eq!(header_of(&second, header::CACHE_CONTROL), expected_cache);
            assert!(read_body(second).await.is_empty(), "{path}");
        }
    }

    #[tokio::test]
    async fn client_routes_answer_200_with_the_shell() {
        let fixture = Fixture::new("client-routes");
        let app = fixture.app();

        for path in [
            "/",
            "/index.html",
            "/admin",
            "/admin/overview",
            "/admin/plugins/demo",
            "/app",
            "/app/home",
            "/login",
            "/403",
            "/plugins",
            "/plugins/demo",
            "/nodes",
            "/nodes/node-1",
            "/pipelines/p-1/editor",
            "/jobs/job-1",
            "/governance",
            "/activity",
            "/access",
            "/settings",
            "/settings/diagnostics",
            "/ops-center",
            "/ext/demo/page",
            "/instances/instance-1/logs",
        ] {
            let response = get(&app, path).await;
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            assert!(
                header_of(&response, header::CONTENT_TYPE).starts_with("text/html"),
                "{path} must be served as HTML"
            );
            assert_eq!(
                header_of(&response, header::CACHE_CONTROL),
                REVALIDATE_CACHE,
                "{path}"
            );
            assert_eq!(read_body(response).await, SHELL.as_bytes(), "{path}");
        }
    }

    #[tokio::test]
    async fn unmatched_resource_paths_stay_404() {
        let fixture = Fixture::new("missing");
        let app = fixture.app();

        for path in [
            "/assets/missing.js",
            "/assets/",
            "/api",
            "/api/v1/nonexistent",
            "/internal/v1/nonexistent",
            "/nonexistent",
            "/admindashboard",
            "/../Cargo.toml",
        ] {
            let response = get(&app, path).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
            assert!(
                response.headers().get(header::CACHE_CONTROL).is_none(),
                "{path} must not be cached"
            );
        }

        // A directory without its trailing slash is redirected by `ServeDir`; the
        // redirect lands on the 404 above, not on the shell.
        let directory = get(&app, "/assets").await;
        assert_eq!(directory.status(), StatusCode::TEMPORARY_REDIRECT);
        assert!(header_of(&directory, header::LOCATION).starts_with("/assets"));
    }

    #[tokio::test]
    async fn already_compressed_formats_are_not_gzipped_but_svg_is() {
        let fixture = Fixture::new("compression");
        let app = fixture.app();

        for path in ["/logo.png", "/fonts/inter.woff2"] {
            let response = request(&app, Method::GET, path, &[("accept-encoding", "gzip")]).await;
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            assert!(
                response.headers().get(header::CONTENT_ENCODING).is_none(),
                "{path} is already compressed"
            );
        }

        let svg = request(
            &app,
            Method::GET,
            "/favicon.svg",
            &[("accept-encoding", "gzip")],
        )
        .await;
        assert_eq!(
            header_of(&svg, header::CONTENT_ENCODING),
            "gzip",
            "svg is text and must be compressed"
        );
    }

    #[tokio::test]
    async fn head_on_a_client_route_answers_200_without_a_body() {
        let fixture = Fixture::new("head");
        let app = fixture.app();

        let response = request(&app, Method::HEAD, "/admin/overview", &[]).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(read_body(response).await.is_empty());
    }

    /// The four paths this change is judged on, with the headers a browser sees.
    #[tokio::test]
    async fn four_representative_paths_report_the_expected_headers() {
        let fixture = Fixture::new("matrix");
        let app = fixture.app();

        for (path, accept_encoding, expected_status, expected_encoding) in [
            (
                "/assets/index-abc123.js",
                Some("gzip"),
                StatusCode::OK,
                "gzip",
            ),
            ("/admin/overview", Some("gzip"), StatusCode::OK, "gzip"),
            ("/api/v1/nonexistent", None, StatusCode::NOT_FOUND, ""),
            ("/assets/missing.js", None, StatusCode::NOT_FOUND, ""),
        ] {
            let headers: Vec<(&str, &str)> = accept_encoding
                .map(|value| ("accept-encoding", value))
                .into_iter()
                .collect();
            let response = request(&app, Method::GET, path, &headers).await;
            let status = response.status();
            let encoding = header_of(&response, header::CONTENT_ENCODING);
            let cache = header_of(&response, header::CACHE_CONTROL);
            let etag = header_of(&response, header::ETAG);
            let len = read_body(response).await.len();
            println!(
                "GET {path} -> {status} | content-encoding: {encoding:?} | cache-control: {cache:?} | etag: {etag:?} | body {len} bytes"
            );
            assert_eq!(status, expected_status, "{path}");
            assert_eq!(encoding, expected_encoding, "{path}");
        }
    }

    /// The pre-fix wiring, kept as a guard: `not_found_service` forces the shell
    /// to `404`, which is what a browser, a monitor and a crawler saw for a deep
    /// link even though the body rendered.
    #[tokio::test]
    async fn spa_shell_status_before_and_after() {
        let fixture = Fixture::new("before-after");
        let before_app = Router::new().fallback_service(
            ServeDir::new(&fixture.root)
                .not_found_service(ServeFile::new(fixture.root.join("index.html"))),
        );

        let before = get(&before_app, "/admin/overview").await;
        let before_status = before.status();
        let before_len = read_body(before).await.len();

        let after = get(&fixture.app(), "/admin/overview").await;
        let after_status = after.status();
        let after_len = read_body(after).await.len();

        println!("before (not_found_service): GET /admin/overview -> {before_status}, {before_len} bytes");
        println!(
            "after  (static_site)      : GET /admin/overview -> {after_status}, {after_len} bytes"
        );

        assert_eq!(
            (before_status, before_len),
            (StatusCode::NOT_FOUND, SHELL.len())
        );
        assert_eq!((after_status, after_len), (StatusCode::OK, SHELL.len()));
    }
}
