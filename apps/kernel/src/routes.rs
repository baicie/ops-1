use crate::assets;
use crate::auth::{self, AuthUser};
use crate::capabilities;
use crate::deployments;
use crate::diagnostics;
use crate::error::AppError;
use crate::gateway;
use crate::incidents;
use crate::jobs;
use crate::logs;
use crate::nodes;
use crate::packages;
use crate::plugins;
use crate::publishers;
use crate::state::AppState;
use crate::static_site;
use crate::storage;
use crate::users;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, get, post};
use axum::{Json, Router};
use tower_http::trace::TraceLayer;

pub fn build(state: AppState) -> Router {
    let public = Router::new()
        .route("/livez", get(diagnostics::livez))
        .route("/readyz", get(diagnostics::readyz))
        // Unauthenticated by design: a staging preview must be able to prove
        // which build it serves before anyone signs in. The payload is a closed
        // set of five fields, so it cannot become an environment dump.
        .route("/api/v1/version", get(version))
        .route(
            "/api/v1/auth/login",
            post(auth::login).layer(DefaultBodyLimit::max(64 * 1024)),
        )
        .route(
            "/api/v1/node-enrollment/redeem",
            post(nodes::redeem_enrollment).layer(DefaultBodyLimit::max(64 * 1024)),
        )
        .route(
            "/internal/v1/nodes/{node_id}/heartbeat",
            post(nodes::heartbeat),
        )
        .route(
            "/internal/v1/nodes/{node_id}/workload-token",
            post(capabilities::issue_workload_token),
        )
        .route(
            "/internal/v1/workload-tokens/refresh",
            post(capabilities::refresh_workload_token),
        )
        .route(
            "/internal/v1/nodes/{node_id}/instances/{instance_id}/env",
            get(capabilities::instance_environment),
        )
        .route(
            "/internal/v1/pipeline-jobs/{job_id}/claim",
            post(jobs::claim_job),
        )
        .route(
            "/internal/v1/pipeline-jobs/claim-next",
            post(jobs::claim_next),
        )
        .route(
            "/internal/v1/pipeline-jobs/{job_id}/definition",
            get(jobs::worker_definition),
        )
        .route(
            "/internal/v1/pipeline-jobs/{job_id}/snapshot",
            get(jobs::get_snapshot).post(jobs::save_snapshot),
        )
        .route(
            "/internal/v1/pipeline-jobs/{job_id}/start",
            post(jobs::start_job),
        )
        .route(
            "/internal/v1/pipeline-jobs/{job_id}/heartbeat",
            post(jobs::heartbeat),
        )
        .route(
            "/internal/v1/pipeline-jobs/{job_id}/checkpoint",
            post(jobs::checkpoint),
        )
        .route(
            "/internal/v1/pipeline-jobs/{job_id}/result",
            post(jobs::result),
        )
        .route(
            "/api/v1/capabilities/{name}/{major}/{*path}",
            any(capabilities::invoke),
        )
        .route(
            "/assets/{publisher}/{plugin_id}/{version}/{*path}",
            get(assets::serve_asset),
        )
        .route("/api/{*path}", any(api_not_found))
        .route("/internal/{*path}", any(api_not_found));

    let protected = Router::new()
        .route("/api/v1/auth/logout", post(auth::logout))
        .route("/api/v1/auth/me", get(auth::me))
        .route("/api/v1/health", get(plugins::overview))
        .route("/api/v1/overview", get(plugins::overview))
        .route("/api/v1/plugins", get(plugins::list_plugins))
        .route(
            "/api/v1/plugins/packages",
            post(packages::upload).layer(DefaultBodyLimit::max(80 * 1024 * 1024)),
        )
        .route("/api/v1/plugins/{plugin_id}", get(plugins::get_plugin))
        .route(
            "/api/v1/plugins/{plugin_id}/packages",
            get(plugins::list_packages),
        )
        .route(
            "/api/v1/plugins/{plugin_id}/deployments",
            get(deployments::list_deployments).post(deployments::create_deployment),
        )
        .route(
            "/api/v1/plugins/{plugin_id}/activations",
            post(deployments::activate),
        )
        .route(
            "/api/v1/plugins/{plugin_id}/disable",
            post(deployments::disable),
        )
        .route(
            "/api/v1/plugins/{plugin_id}/enable",
            post(deployments::enable),
        )
        .route(
            "/api/v1/plugins/{plugin_id}/uninstall",
            post(deployments::uninstall),
        )
        .route(
            "/api/v1/plugins/{plugin_id}/rollback",
            post(deployments::rollback),
        )
        .route(
            "/api/v1/deployments/{deployment_id}",
            get(deployments::get_deployment),
        )
        .route("/api/v1/instances/{instance_id}", get(logs::get_instance))
        .route(
            "/api/v1/instances/{instance_id}/logs/live",
            get(logs::live_logs),
        )
        .route("/api/v1/nodes", get(nodes::list_nodes))
        .route(
            "/api/v1/nodes/enrollment-tokens",
            post(nodes::create_enrollment_token),
        )
        .route("/api/v1/nodes/{node_id}", get(nodes::get_node))
        .route(
            "/api/v1/nodes/{node_id}/instances",
            get(nodes::node_instances),
        )
        .route(
            "/api/v1/nodes/{node_id}/resource-history",
            get(nodes::resource_history),
        )
        .route("/api/v1/nodes/{node_id}", delete(nodes::revoke_node))
        .route("/api/v1/audit", get(diagnostics::audit_events))
        .route("/api/v1/diagnostics", get(diagnostics::diagnostics))
        .route("/bootstrap", get(diagnostics::bootstrap_page))
        .route(
            "/api/v1/settings/runtime-policies",
            get(diagnostics::settings_policies),
        )
        .route("/api/v1/users", get(users::list_users))
        .route("/api/v1/users", post(users::create_user))
        .route(
            "/api/v1/users/{user_id}",
            axum::routing::patch(users::update_user),
        )
        .route("/api/v1/publishers", get(publishers::list_publishers))
        .route("/api/v1/publishers", post(publishers::add_publisher))
        .route(
            "/api/v1/publishers/{publisher_id}",
            delete(publishers::revoke_publisher),
        )
        .route("/api/v1/extensions", get(plugins::extensions))
        .route("/api/v1/capabilities", get(plugins::capabilities))
        .route(
            "/api/v1/capabilities/{name}/{major}/resolve",
            get(capabilities::resolve),
        )
        .route(
            "/api/v1/capability-grants",
            get(capabilities::list_grants).post(capabilities::create_grant),
        )
        .route(
            "/api/v1/capability-grants/{grant_id}",
            delete(capabilities::revoke_grant),
        )
        .route(
            "/api/v1/plugin-storage/{plugin_id}",
            get(storage::get_binding).post(storage::ensure_binding),
        )
        .route(
            "/api/v1/plugin-storage/{plugin_id}/migrations",
            get(storage::list_migrations).post(storage::apply_migration),
        )
        .route(
            "/api/v1/pipelines",
            get(jobs::list_pipelines).post(jobs::create_pipeline),
        )
        .route(
            "/api/v1/pipelines/validate",
            post(jobs::validate_pipeline_definition),
        )
        .route(
            "/api/v1/pipelines/{pipeline_id}/drafts",
            get(jobs::list_drafts).post(jobs::create_draft),
        )
        .route(
            "/api/v1/pipelines/{pipeline_id}/drafts/{draft_id}",
            get(jobs::get_draft).put(jobs::update_draft),
        )
        .route(
            "/api/v1/pipelines/{pipeline_id}/drafts/{draft_id}/publish",
            post(jobs::publish_draft),
        )
        .route("/api/v1/pipelines/preview", post(jobs::preview_pipeline))
        .route("/api/v1/pipelines/{pipeline_id}", get(jobs::get_pipeline))
        .route(
            "/api/v1/pipelines/{pipeline_id}/revisions",
            get(jobs::list_revisions).post(jobs::publish_revision),
        )
        .route(
            "/api/v1/pipelines/{pipeline_id}/revisions/{revision}",
            get(jobs::get_revision),
        )
        .route(
            "/api/v1/pipelines/{pipeline_id}/revisions/{revision}/plan",
            get(jobs::get_plan),
        )
        .route("/api/v1/jobs", get(jobs::list_jobs).post(jobs::submit_job))
        .route("/api/v1/jobs/{job_id}", get(jobs::get_job))
        .route("/api/v1/jobs/{job_id}/result", get(jobs::get_job_result))
        .route(
            "/api/v1/jobs/{job_id}/diagnostics",
            get(jobs::get_job_diagnostics),
        )
        .route("/api/v1/jobs/{job_id}/cancel", post(jobs::cancel_job))
        // G11 business slice. Authority and the permission matrix live in
        // docs/design/g11-incident/incident-adr.md; every write below is gated by
        // AuthUser::require_operator inside the handler, and reads are scoped by
        // the same predicate the job list uses.
        .route(
            "/api/v1/incidents",
            get(incidents::list_incidents).post(incidents::create_incident),
        )
        .route(
            "/api/v1/incidents/{incident_id}",
            get(incidents::get_incident),
        )
        .route(
            "/api/v1/incidents/{incident_id}/evidence",
            get(incidents::list_evidence).post(incidents::append_evidence),
        )
        // G12 B: the bytes behind one evidence row. A separate route so the
        // evidence list never carries content: a caller that may read metadata
        // asks again, in one bounded request, for the single row it wants.
        .route(
            "/api/v1/incidents/{incident_id}/evidence/{evidence_id}/content",
            get(incidents::read_evidence_content),
        )
        .route(
            "/api/v1/incidents/{incident_id}/verdict",
            get(incidents::get_verdict).post(incidents::create_verdict),
        )
        // G12 C: the two lifecycle operations and the trail they write. Closing is
        // its own route rather than a status field on a PATCH, because a closure is a
        // decision with a required verdict, a required revision and a required reason -
        // not one assignable column among five.
        .route(
            "/api/v1/incidents/{incident_id}/close",
            post(incidents::close_incident),
        )
        .route(
            "/api/v1/incidents/{incident_id}/owner",
            post(incidents::transfer_owner),
        )
        // Scoped by the incident read predicate, so the trail of a record is exactly
        // as visible as the record. /api/v1/audit answers the platform-wide question
        // and is not a substitute for this one.
        .route(
            "/api/v1/incidents/{incident_id}/timeline",
            get(incidents::get_timeline),
        )
        .route("/api/v1/gateway/{plugin_id}/{*path}", any(gateway::proxy))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::csrf_middleware,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ));

    // Client routes answer 200 with the shell, missing resources stay 404, and
    // the bundle is compressed and revalidatable; see `static_site`.
    //
    // The fallback is installed *before* the layers below, because `Router::layer`
    // only wraps a fallback that already exists when it runs. Wrapping the SPA
    // shell is not optional: it is the entry point of every page, so it needs the
    // same CSP, `x-request-id` and trace span as an API response, and it gets them
    // from this one stack rather than from a second copy of the header logic.
    public
        .merge(protected)
        .fallback_service(static_site::StaticSite::new(state.config.web_dist.clone()).router())
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(middleware::from_fn(security_headers))
        .layer(middleware::from_fn(request_id))
        .layer(TraceLayer::new_for_http())
        // Outermost, exactly as before: it wraps API and bundle alike.
        .layer(static_site::compression_layer())
        .with_state(state)
}

/// Build identity served by `GET /api/v1/version`.
///
/// Exactly five fields: version, commitSha, buildTime, environment, startedAt.
/// Anything that would leak configuration (DSN, keys, env dump) is deliberately
/// absent and must stay absent.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildIdentity {
    pub version: &'static str,
    pub commit_sha: Option<String>,
    pub build_time: Option<String>,
    pub environment: &'static str,
    pub started_at: String,
}

async fn version(State(state): State<AppState>) -> Json<BuildIdentity> {
    let config = state.config.as_ref();
    Json(BuildIdentity {
        version: env!("CARGO_PKG_VERSION"),
        commit_sha: config.build_sha.clone(),
        build_time: config.build_time.clone(),
        environment: config.environment.as_str(),
        started_at: config
            .started_at
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    })
}

async fn api_not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({
            "code": "NOT_FOUND",
            "message": "API route not found",
            "requestId": uuid::Uuid::new_v4().to_string(),
            "retryable": false
        })),
    )
        .into_response()
}

async fn request_id(mut request: Request, next: Next) -> Response {
    let id = request
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    request
        .headers_mut()
        .insert("x-request-id", HeaderValue::from_str(&id).unwrap());
    let mut response = next.run(request).await;
    if let Ok(value) = HeaderValue::from_str(&id) {
        response.headers_mut().insert("x-request-id", value);
    }
    response
}

async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    // A route that set its own policy keeps it. The blanket policy below is built
    // for the application shell ('self' scripts, inline styles); a response that
    // carries untrusted bytes must be tighter than that, and overwriting it here
    // would silently downgrade the one route where the content is arbitrary text
    // (GET /incidents/{id}/evidence/{evidenceId}/content sets
    // "default-src 'none'; sandbox").
    if !headers.contains_key(header::CONTENT_SECURITY_POLICY) {
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
            ),
        );
    }
    response
}

#[allow(dead_code)]
async fn method_not_allowed() -> AppError {
    AppError::new(
        StatusCode::METHOD_NOT_ALLOWED,
        "METHOD_NOT_ALLOWED",
        "HTTP method is not supported for this route",
    )
}

#[allow(dead_code)]
fn _method_marker(_: Method) {}

#[allow(dead_code)]
fn _auth_marker(_: AuthUser) {}

#[cfg(test)]
mod tests {
    use super::BuildIdentity;
    use super::*;
    use axum::body::Body;
    use std::path::PathBuf;
    use tower::ServiceExt;

    #[test]
    fn version_payload_carries_exactly_the_five_contract_fields() {
        let payload = BuildIdentity {
            version: "9.9.9",
            commit_sha: Some("0123456789abcdef0123456789abcdef01234567".to_string()),
            build_time: None,
            environment: "STAGING",
            started_at: "2026-10-28T15:29:00Z".to_string(),
        };
        let value = serde_json::to_value(&payload).unwrap();
        let object = value.as_object().unwrap();
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "buildTime",
                "commitSha",
                "environment",
                "startedAt",
                "version"
            ]
        );
        assert!(object["buildTime"].is_null());
        assert_eq!(object["environment"], "STAGING");
        assert_eq!(object["version"], "9.9.9");
    }

    // ---- Middleware parity: the static layer must be wrapped like the API ----

    const SECURITY_HEADER_NAMES: [&str; 5] = [
        "content-security-policy",
        "x-frame-options",
        "x-content-type-options",
        "referrer-policy",
        "x-request-id",
    ];

    const SHELL: &str = concat!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
        "<title>OpsWeave</title>",
        "<script type=\"module\" crossorigin src=\"/assets/index-abc123.js\"></script>",
        "</head><body><div id=\"root\"></div></body></html>"
    );
    const BUNDLE_LINE: &str = "console.log('opsweave kernel bundle');\n";

    struct WebBundle {
        root: PathBuf,
    }

    impl WebBundle {
        fn new(name: &str) -> Self {
            let root =
                std::env::temp_dir().join(format!("opsweave-routes-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(root.join("assets")).unwrap();
            std::fs::write(root.join("index.html"), SHELL).unwrap();
            std::fs::write(root.join("assets/index-abc123.js"), BUNDLE_LINE.repeat(120)).unwrap();
            Self { root }
        }

        /// The production router. The pool is lazy: an anonymous GET for a file or
        /// the shell never issues a query, so no database is needed to read headers.
        fn app(&self) -> Router {
            let mut config = crate::config::Config::from_env();
            config.web_dist = self.root.clone();
            let pool = sqlx::postgres::PgPoolOptions::new()
                .max_connections(1)
                .connect_lazy("postgres://127.0.0.1:1/opsweave?sslmode=disable")
                .expect("lazy pool");
            let state = AppState::new(config, pool, vec![0u8; 32]).expect("app state");
            build(state)
        }
    }

    impl Drop for WebBundle {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    async fn get(app: &Router, path: &str, request_id: Option<&str>) -> Response {
        let mut builder = axum::http::Request::builder().method(Method::GET).uri(path);
        if let Some(id) = request_id {
            builder = builder.header("x-request-id", id);
        }
        app.clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    fn header_of(response: &Response, name: &str) -> Option<String> {
        response
            .headers()
            .get(name)
            .map(|value| value.to_str().unwrap().to_string())
    }

    /// Prints exactly what a browser receives, then hands the values back so the
    /// caller can assert on them.
    fn report(label: &str, path: &str, response: &Response) -> Vec<Option<String>> {
        let values: Vec<Option<String>> = SECURITY_HEADER_NAMES
            .iter()
            .map(|name| header_of(response, name))
            .collect();
        println!("[{label}] GET {path} -> {}", response.status());
        for (name, value) in SECURITY_HEADER_NAMES.iter().zip(values.iter()) {
            println!(
                "[{label}]   {name}: {}",
                value.as_deref().unwrap_or("<absent>")
            );
        }
        values
    }

    #[tokio::test]
    async fn api_responses_carry_the_security_header_set() {
        let bundle = WebBundle::new("api-headers");
        let app = bundle.app();

        let response = get(&app, "/api/v1/version", None).await;
        assert_eq!(response.status(), StatusCode::OK);
        let values = report("api", "/api/v1/version", &response);
        for (name, value) in SECURITY_HEADER_NAMES.iter().zip(values) {
            assert!(value.is_some(), "API response is missing {name}");
        }
    }

    /// The shell and the hashed bundle are entry points for every page, so they
    /// must be wrapped by the same middleware stack as the API.
    #[tokio::test]
    async fn static_layer_carries_the_same_headers_as_the_api() {
        let bundle = WebBundle::new("static-headers");
        let app = bundle.app();

        let api = get(&app, "/api/v1/version", None).await;
        let api_values = report("api", "/api/v1/version", &api);

        for path in ["/", "/admin/overview", "/assets/index-abc123.js"] {
            let response = get(&app, path, None).await;
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            let values = report("static", path, &response);
            for (index, name) in SECURITY_HEADER_NAMES.iter().enumerate() {
                let (static_value, api_value) = (&values[index], &api_values[index]);
                assert_eq!(
                    static_value.is_some(),
                    api_value.is_some(),
                    "{path} disagrees with the API on whether {name} is set"
                );
                // `x-request-id` is per request by design; parity means "issued",
                // and the echo itself is covered by the test below.
                if *name != "x-request-id" {
                    assert_eq!(
                        static_value, api_value,
                        "{path} must receive the same {name} policy value as the API"
                    );
                }
            }
        }
    }

    /// The trace layer is installed by the same chain, so a static request has
    /// to open one span exactly like an API request does.
    #[tokio::test]
    async fn static_layer_opens_a_trace_span() {
        use std::sync::{Arc, Mutex};
        use tracing::span::Attributes;
        use tracing_subscriber::layer::{Context, SubscriberExt};
        use tracing_subscriber::registry::LookupSpan;
        use tracing_subscriber::Layer;

        #[derive(Clone, Default)]
        struct SpanNames(Arc<Mutex<Vec<String>>>);

        impl<S> Layer<S> for SpanNames
        where
            S: tracing::Subscriber + for<'lookup> LookupSpan<'lookup>,
        {
            fn on_new_span(
                &self,
                attrs: &Attributes<'_>,
                _id: &tracing::span::Id,
                _ctx: Context<'_, S>,
            ) {
                self.0
                    .lock()
                    .unwrap()
                    .push(attrs.metadata().name().to_string());
            }
        }

        let bundle = WebBundle::new("trace-span");
        let app = bundle.app();
        let names = SpanNames::default();
        // A tokio test runs on the current-thread runtime, so the thread-local
        // default stays installed for every await below.
        let guard =
            tracing::subscriber::set_default(tracing_subscriber::registry().with(names.clone()));

        let shell = get(&app, "/admin/overview", None).await;
        let api = get(&app, "/api/v1/version", None).await;
        drop(guard);

        assert_eq!(shell.status(), StatusCode::OK);
        assert_eq!(api.status(), StatusCode::OK);
        let recorded = names.0.lock().unwrap().clone();
        println!("trace spans opened: {recorded:?}");
        assert_eq!(
            recorded
                .iter()
                .filter(|name| name.as_str() == "request")
                .count(),
            2,
            "the shell and the API must each open one request span: {recorded:?}"
        );
    }

    #[tokio::test]
    async fn request_id_is_echoed_on_the_static_layer() {
        let bundle = WebBundle::new("request-id");
        let app = bundle.app();

        for path in ["/", "/assets/index-abc123.js"] {
            let echoed = get(&app, path, Some("opsweave-probe-1")).await;
            assert_eq!(
                header_of(&echoed, "x-request-id").as_deref(),
                Some("opsweave-probe-1"),
                "{path} must echo the inbound request id"
            );

            let generated = get(&app, path, None).await;
            let id = header_of(&generated, "x-request-id").unwrap_or_default();
            assert_eq!(
                id.len(),
                36,
                "{path} must mint a uuid request id, got {id:?}"
            );
            assert!(uuid::Uuid::parse_str(&id).is_ok(), "{path}: {id:?}");
        }
    }
}
