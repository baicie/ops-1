use crate::assets;
use crate::auth::{self, AuthUser};
use crate::deployments;
use crate::diagnostics;
use crate::error::AppError;
use crate::gateway;
use crate::logs;
use crate::nodes;
use crate::packages;
use crate::plugins;
use crate::publishers;
use crate::state::AppState;
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
        .route("/api/v1/auth/login", post(auth::login))
        .route(
            "/api/v1/node-enrollment/redeem",
            post(nodes::redeem_enrollment),
        )
        .route(
            "/internal/v1/nodes/{node_id}/heartbeat",
            post(nodes::heartbeat),
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
        .route("/api/v1/plugins/packages", post(packages::upload))
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
        .layer(DefaultBodyLimit::max(80 * 1024 * 1024))
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
