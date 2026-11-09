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
/// Pre-split entry points that no longer have an application to render them.
///
/// Returns the path to redirect to, preserving the query. Kept as a closed table
/// for the same reason the client-route prefixes are: an open rule ("anything not
/// a file") would swallow genuine 404s.
fn legacy_entry_redirect(path: &str, query: Option<&str>) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    let target = match trimmed {
        "/login" => "/admin/login".to_string(),
        // The split briefly mounted the platform console under /console. Anything
        // that recorded that path (a bookmark, a log line, a runbook) still has to
        // land somewhere real, and /admin is where the console actually lives.
        // Deep paths keep their tail so a bookmarked page still resolves.
        "/console" => "/admin".to_string(),
        other if other.starts_with("/console/") => {
            format!("/admin/{}", &other["/console/".len()..])
        }
        // The pre-split workspace entry: /app still exists, so only the exact
        // root needs steering, and the ops application resolves it itself.
        _ => return None,
    };
    Some(match query {
        Some(query) if !query.is_empty() => format!("{target}?{query}"),
        _ => target,
    })
}

const REVALIDATE_CACHE: &str = "no-cache";
/// The base the Platform Console's bundle is emitted under. Kept in step with
/// `base` in apps/platform-console/vite.config.ts.
const PRIMARY_BASE: &str = "/admin";

/// Path prefixes the client router owns; each is answered `200` with the shell.
///
/// A closed table rather than "every path that is not a file": a request for a
/// missing resource has to stay a `404`. Segments match whole, so
/// `/admindashboard` is not `/admin`; the pre-G04 spellings (`/plugins`,
/// `/nodes`, ...) are listed because the client still redirects them.
const CLIENT_ROUTE_PREFIXES: &[&str] = &[
    "/admin",
    "/console",
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
///
/// G14.2: there is more than one bundle now. The Platform Console and the Ops
/// Web are separate applications with separate builds, so a request under
/// `/console` must be answered with the console's shell and a request under
/// `/app` with the ops shell. Serving one shell for both would mount the wrong
/// router and the other application would 404 on its own routes.
///
/// `extra` holds the additional mounts; the primary root keeps its existing
/// behaviour so an installation with one bundle is unchanged.
#[derive(Clone)]
pub struct StaticSite {
    root: PathBuf,
    shell: PathBuf,
    extra: Vec<Mount>,
}

/// One additional application bundle and the path prefix it owns.
#[derive(Clone)]
pub struct Mount {
    prefix: String,
    root: PathBuf,
    shell: PathBuf,
}

impl Mount {
    pub fn new(prefix: impl Into<String>, root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        let shell = root.join("index.html");
        Self {
            prefix: prefix.into(),
            root,
            shell,
        }
    }

    fn owns(&self, path: &str) -> bool {
        let trimmed = path.trim_end_matches('/');
        trimmed == self.prefix
            || trimmed
                .strip_prefix(&self.prefix)
                .is_some_and(|rest| rest.starts_with('/'))
    }
}

impl StaticSite {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        let shell = root.join("index.html");
        Self {
            root,
            shell,
            extra: Vec::new(),
        }
    }

    /// Mount another application bundle under `prefix`.
    pub fn with_mount(mut self, mount: Mount) -> Self {
        self.extra.push(mount);
        self
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
        // A path an additional application owns is resolved inside THAT bundle,
        // never against the primary one: the two have different `index.html`
        // files, and picking the wrong one mounts the wrong router.
        if let Some(mount) = self.extra.iter().find(|mount| mount.owns(path)) {
            // The mount's own prefix is part of the URL, not of the bundle: a
            // build emitted under `base: '/app/'` writes `/app/assets/...` into
            // its shell, and the file on disk is `<root>/assets/...`. Stripping
            // here is what makes the two agree. Without it every asset of a
            // mounted application 404s - the page loads and renders nothing.
            let inner = path
                .strip_prefix(&mount.prefix)
                .filter(|rest| !rest.is_empty())
                .unwrap_or("/");
            return resolve_in(&mount.root, &mount.shell, inner, true).await;
        }
        self.resolve_primary(path).await
    }

    async fn resolve_primary(&self, path: &str) -> Target {
        // The primary bundle is emitted with `base: '/admin/'` for the same
        // reason the ops one is: two applications share an origin. A file is
        // therefore addressed as `/admin/assets/x` while living at
        // `<root>/assets/x`, so the base is stripped before the lookup.
        // Two spellings reach the same bundle: a FILE is addressed under the
        // bundle's base (`/admin/assets/x` -> `<root>/assets/x`), while a CLIENT
        // ROUTE keeps its public form (`/admin/overview`, `/admin/plugins/x`).
        // Trying the base-stripped path first and falling back to the original
        // keeps both working; stripping unconditionally made every console route
        // 404 (`/admin/overview` -> `/overview`, which is nobody's route).
        if let Some(rest) = path.strip_prefix(PRIMARY_BASE) {
            let rest = if rest.is_empty() { "/" } else { rest };
            if let Some(relative) = relative_path(rest) {
                if !relative.as_os_str().is_empty() {
                    let candidate = self.root.join(&relative);
                    if is_file(&candidate).await {
                        return Target::File(candidate);
                    }
                }
            }
        }
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

/// Resolve a path inside one bundle root.
///
/// `always_shell` is for a mounted application: any path it owns that is not a
/// real file is one of ITS client routes, because the mount owns the whole
/// prefix. Without it, a console route added after this code was written would
/// 404 until someone extended the closed prefix table.
async fn resolve_in(root: &Path, shell: &Path, path: &str, always_shell: bool) -> Target {
    let Some(relative) = relative_path(path) else {
        return Target::Missing;
    };
    if relative.as_os_str().is_empty() || relative == Path::new("index.html") {
        return if is_file(shell).await {
            Target::ShellAt(shell.to_path_buf())
        } else {
            Target::Missing
        };
    }
    let candidate = root.join(&relative);
    if is_file(&candidate).await {
        Target::File(candidate)
    } else if always_shell && is_file(shell).await {
        Target::ShellAt(shell.to_path_buf())
    } else if is_client_route(path) {
        Target::Shell
    } else {
        Target::Missing
    }
}

enum Target {
    /// `index.html`, for `/`, `/index.html` and every client route.
    Shell,
    /// A specific bundle's shell, when more than one bundle is mounted.
    ShellAt(PathBuf),
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
    // G14.2 split the single bundle into two applications, each mounted under its
    // own base (`/console`, `/app`). A bare `/login` therefore belongs to neither:
    // both applications serve `/login` INSIDE their base, and the old path has no
    // router to match it. Bookmarking or landing on it would render an empty shell.
    //
    // Signing in is a platform act, so the bare path forwards to the Platform
    // Console's login and carries the original query (which holds `?next=`). A
    // redirect and not a rewrite: the browser must end up with a URL that matches
    // the router that will actually render.
    if let Some(target) = crate::static_site::legacy_entry_redirect(&path, request.uri().query()) {
        return axum::response::Redirect::temporary(&target).into_response();
    }
    let cache_control = HeaderValue::from_static(site.cache_control(&path));
    let (file, shell) = match site.resolve(&path).await {
        Target::Missing => return next.run(request).await,
        Target::Shell => (site.shell.clone(), true),
        Target::ShellAt(shell) => (shell, true),
        Target::File(file) => (file, false),
    };

    let etag = etag_for(&file).await;
    if is_not_modified(request.headers(), etag.as_ref()) {
        return not_modified(etag, cache_control);
    }

    // The shell is answered here rather than by `ServeDir`: a client route and a
    // missing file look identical to a directory lookup.
    // Serve the file we RESOLVED, not the URI we received. `next.run` hands the
    // original path to `ServeDir`, which for a base-mounted bundle
    // (`/admin/assets/x`) looks for `<root>/admin/assets/x` and answers 404 even
    // though `<root>/assets/x` is the file that exists. Resolving and then
    // delegating only works when the URL and the disk layout are identical;
    // they are not once an application sets a Vite `base`.
    let mut response = if shell || is_file(&file).await {
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
        ops_root: Option<PathBuf>,
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
            Self {
                root,
                ops_root: None,
            }
        }

        /// A second bundle whose shell is distinguishable from the first, which
        /// is the whole point of the assertion below.
        fn with_second_bundle(mut self, name: &str) -> Self {
            let root = std::env::temp_dir()
                .join(format!("opsweave-static-{}-{name}-ops", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(root.join("assets")).unwrap();
            std::fs::write(
                root.join("index.html"),
                "<!doctype html><html><body><div id=\"root\"></div><script type=\"module\" src=\"/assets/ops-entry.js\"></script></body></html>",
            )
            .unwrap();
            std::fs::write(root.join("assets/ops-entry.js"), BUNDLE_LINE).unwrap();
            self.ops_root = Some(root);
            self
        }

        fn app(&self) -> Router {
            let mut site = StaticSite::new(&self.root);
            if let Some(ops) = self.ops_root.clone() {
                site = site.with_mount(Mount::new("/app", ops));
            }
            site.router().layer(compression_layer())
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
            if let Some(ops) = &self.ops_root {
                let _ = std::fs::remove_dir_all(ops);
            }
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

    /// A base-mounted bundle addresses its own assets under the base
    /// (`/admin/assets/x`, `/app/assets/x`) while the files live at
    /// `<root>/assets/x`. Resolving the file and then handing the ORIGINAL URI to
    /// `ServeDir` answered 404 for every one of them: the page loaded, its CSS and
    /// JS did not, and the result was a blank document whose components "did not
    /// exist". This is the shape a split breaks in, so it is asserted.
    #[tokio::test]
    async fn assets_of_a_base_mounted_bundle_resolve_under_their_base() {
        let fixture = Fixture::new("base-assets").with_second_bundle("base-assets");
        let app = fixture.app();

        // The primary bundle's hashed asset, addressed under /admin.
        let response = get(&app, "/admin/assets/index-abc123.js").await;
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "a primary-bundle asset must resolve under its base, not only at /assets"
        );

        // The mounted bundle's asset, addressed under /app.
        let response = get(&app, "/app/assets/ops-entry.js").await;
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "a mounted bundle's asset must resolve inside its own root"
        );

        // The base-stripped spelling keeps working for the primary bundle.
        assert_eq!(
            get(&app, "/assets/index-abc123.js").await.status(),
            StatusCode::OK
        );

        // A client route under the base still returns that bundle's shell.
        let shell = read_body(get(&app, "/admin/overview").await).await;
        assert!(String::from_utf8_lossy(&shell).contains("/assets/index-abc123.js"));
    }

    /// A path recorded under the briefly-used `/console` base still lands on the
    /// console, and a deep path keeps its tail.
    #[tokio::test]
    async fn a_console_path_is_forwarded_to_the_console_application() {
        let fixture = Fixture::new("console-redirect");
        let app = fixture.app();
        for (from, to) in [
            ("/console", "/admin"),
            ("/console/overview", "/admin/overview"),
            (
                "/console/nodes/node-1?tab=logs",
                "/admin/nodes/node-1?tab=logs",
            ),
        ] {
            let response = get(&app, from).await;
            assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT, "{from}");
            assert_eq!(
                response
                    .headers()
                    .get(axum::http::header::LOCATION)
                    .and_then(|value| value.to_str().ok()),
                Some(to),
                "{from}"
            );
        }
    }

    /// The split left `/login` belonging to neither application: each serves it
    /// INSIDE its base, so the bare path rendered an empty shell. Signing in is a
    /// platform act, so it forwards to the console's login and keeps the query.
    #[tokio::test]
    async fn a_bare_login_is_redirected_into_the_console_application() {
        let fixture = Fixture::new("legacy-login").with_second_bundle("legacy-login");
        let app = fixture.app();

        let response = get(&app, "/login?next=/app/incidents").await;
        assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
        assert_eq!(
            response
                .headers()
                .get(axum::http::header::LOCATION)
                .and_then(|value| value.to_str().ok()),
            Some("/admin/login?next=/app/incidents"),
            "the query carries the post-login destination and must survive"
        );

        // A path that is genuinely missing stays a 404: the redirect is a closed
        // table, not "anything unfound goes to the login page".
        assert_eq!(
            get(&app, "/nope-not-a-route").await.status(),
            StatusCode::NOT_FOUND
        );
    }

    /// G14.2: two applications, two shells. A `/app` route must be answered with
    /// the ops bundle, not the console's, or the browser mounts the wrong router
    /// and every ops route 404s inside a shell that loaded successfully.
    #[tokio::test]
    async fn a_mounted_application_serves_its_own_shell_not_the_primary_one() {
        let fixture = Fixture::new("two-bundles").with_second_bundle("two-bundles");
        let app = fixture.app();

        let console = read_body(get(&app, "/admin/overview").await).await;
        let console_html = String::from_utf8_lossy(&console);
        assert!(
            console_html.contains("/assets/index-abc123.js"),
            "the primary bundle answers the platform console, got: {console_html}"
        );

        let ops = read_body(get(&app, "/app/incidents").await).await;
        let ops_html = String::from_utf8_lossy(&ops);
        assert!(
            ops_html.contains("/assets/ops-entry.js"),
            "an /app route must be answered by the ops bundle's shell, got: {ops_html}"
        );
        assert!(
            !ops_html.contains("/assets/index-abc123.js"),
            "the ops shell must not be the console's shell"
        );

        // A deep route the mount owns but the closed prefix table never listed
        // still reaches the ops shell: the mount owns the whole prefix.
        assert_eq!(
            get(&app, "/app/incidents/abc").await.status(),
            StatusCode::OK
        );
        // And the primary bundle's own assets still resolve.
        assert_eq!(
            get(&app, "/assets/index-abc123.js").await.status(),
            StatusCode::OK
        );
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
            // `/login` moved out of this list in G14.2: it used to be answered with
            // the shell because one bundle rendered everything. Now each
            // application serves `/login` inside its own base, so the bare path has
            // no router and is redirected instead - asserted separately in
            // `a_bare_login_is_redirected_into_the_console_application`.
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
