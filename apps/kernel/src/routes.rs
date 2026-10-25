use crate::assets;
use crate::auth::{self, AuthUser};
use crate::capabilities;
use crate::deployments;
use crate::diagnostics;
use crate::error::AppError;
use crate::gateway;
use crate::jobs;
use crate::logs;
use crate::nodes;
use crate::packages;
use crate::plugins;
use crate::publishers;
use crate::state::AppState;
use crate::storage;
use crate::users;
use axum::extract::{DefaultBodyLimit, Request};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, get, post};
use axum::{Json, Router};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

pub fn build(state: AppState) -> Router {
    let public = Router::new()
        .route("/livez", get(diagnostics::livez))
        .route("/readyz", get(diagnostics::readyz))
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
        .route("/api/v1/jobs", post(jobs::submit_job))
        .route("/api/v1/jobs/{job_id}", get(jobs::get_job))
        .route("/api/v1/jobs/{job_id}/cancel", post(jobs::cancel_job))
        .route("/api/v1/gateway/{plugin_id}/{*path}", any(gateway::proxy))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::csrf_middleware,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ));

    let api = public
        .merge(protected)
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(middleware::from_fn(security_headers))
        .layer(middleware::from_fn(request_id))
        .layer(TraceLayer::new_for_http());

    let index = state.config.web_dist.join("index.html");
    let static_service =
        ServeDir::new(&state.config.web_dist).not_found_service(ServeFile::new(index));
    api.fallback_service(static_service).with_state(state)
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
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        ),
    );
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
