use crate::runtime::Shared;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use serde::Deserialize;
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

#[derive(Clone)]
pub struct ApiState {
    pub shared: Arc<Shared>,
}

pub fn router(shared: Arc<Shared>) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/internal/v1/instances/{instance_id}/logs", get(logs))
        .route("/internal/v1/proxy/{instance_id}/{*path}", any(proxy))
        .with_state(ApiState { shared })
}

async fn healthz(State(state): State<ApiState>) -> Json<serde_json::Value> {
    let identity = state.shared.identity.read().await;
    let quarantined = state
        .shared
        .quarantined
        .load(std::sync::atomic::Ordering::SeqCst);
    Json(serde_json::json!({
        "status": if quarantined { "quarantined" } else { "ok" },
        "quarantined": quarantined,
        "nodeId": identity.node_id,
        "name": identity.name,
        "generation": identity.generation,
        "adapter": "docker-cli",
        "dockerVersion": state.shared.docker_version,
        "dataEndpoint": state.shared.args.data_endpoint
    }))
}

#[derive(Debug, Deserialize)]
struct LogQuery {
    epoch: Option<i64>,
    after: Option<i64>,
}

async fn logs(
    State(state): State<ApiState>,
    Path(instance_id): Path<Uuid>,
    headers: HeaderMap,
    Query(query): Query<LogQuery>,
) -> Response {
    if !authorized(&state, &headers).await {
        return unauthorized();
    }
    let runtimes = state.shared.runtimes.read().await;
    let Some(runtime) = runtimes.get(&instance_id) else {
        return not_found("instance is not managed by this node");
    };
    let epoch = query.epoch.unwrap_or_else(|| runtime.logs.metadata().1);
    let batch = runtime.logs.batch(epoch, query.after.unwrap_or(0));
    Json(batch).into_response()
}

async fn proxy(
    State(state): State<ApiState>,
    Path((instance_id, path)): Path<(Uuid, String)>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !authorized(&state, &headers).await {
        return unauthorized();
    }
    if state
        .shared
        .quarantined
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return quarantined();
    }
    if !safe_forward_path(&path) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "code": "INVALID_PLUGIN_PATH",
                "message": "path traversal is not allowed",
                "retryable": false
            })),
        )
            .into_response();
    }
    let (host_port, running) = {
        let runtimes = state.shared.runtimes.read().await;
        let Some(runtime) = runtimes.get(&instance_id) else {
            return not_found("instance is not managed by this node");
        };
        let status = runtime.status_copy();
        (
            status.host_port,
            matches!(
                status.state,
                crate::runtime::RuntimeState::Ready | crate::runtime::RuntimeState::Starting
            ),
        )
    };
    if !running {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "code": "INSTANCE_NOT_READY",
                "message": "instance is not ready",
                "retryable": true
            })),
        )
            .into_response();
    }
    let Some(port) = host_port else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "code": "INSTANCE_NO_PORT",
                "message": "instance has no published port",
                "retryable": true
            })),
        )
            .into_response();
    };
    let target = format!("http://127.0.0.1:{port}/{}", path.trim_start_matches('/'));
    let mut request = state
        .shared
        .http
        .request(method, target)
        .timeout(Duration::from_secs(15));
    for (name, value) in headers.iter() {
        let name = name.as_str().to_ascii_lowercase();
        if matches!(
            name.as_str(),
            "host"
                | "authorization"
                | "cookie"
                | "content-length"
                | "connection"
                | "transfer-encoding"
        ) {
            continue;
        }
        request = request.header(name, value);
    }
    if !body.is_empty() {
        request = request.body(body);
    }
    match request.send().await {
        Ok(response) => {
            let status = response.status();
            if response
                .content_length()
                .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
            {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(serde_json::json!({
                        "code": "UPSTREAM_RESPONSE_TOO_LARGE",
                        "message": "plugin response exceeded the 8 MiB gateway limit",
                        "retryable": false
                    })),
                )
                    .into_response();
            }
            let content_type = response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let bytes = match response.bytes().await {
                Ok(bytes) => bytes,
                Err(error) => {
                    return (
                        StatusCode::BAD_GATEWAY,
                        Json(serde_json::json!({
                            "code": "UPSTREAM_BODY_ERROR",
                            "message": error.to_string(),
                            "retryable": true
                        })),
                    )
                        .into_response()
                }
            };
            if bytes.len() > MAX_RESPONSE_BYTES {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(serde_json::json!({
                        "code": "UPSTREAM_RESPONSE_TOO_LARGE",
                        "message": "plugin response exceeded the 8 MiB gateway limit",
                        "retryable": false
                    })),
                )
                    .into_response();
            }
            let mut out = (status, bytes).into_response();
            if let Some(content_type) = content_type {
                if let Ok(value) = header::HeaderValue::from_str(&content_type) {
                    out.headers_mut().insert(header::CONTENT_TYPE, value);
                }
            }
            out.headers_mut().insert(
                "x-opsweave-instance-id",
                header::HeaderValue::from_str(&instance_id.to_string()).unwrap(),
            );
            out
        }
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({
                "code": "UPSTREAM_UNAVAILABLE",
                "message": error.to_string(),
                "retryable": true
            })),
        )
            .into_response(),
    }
}

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

fn safe_forward_path(path: &str) -> bool {
    if path.contains('\0') || path.contains('\\') {
        return false;
    }
    for segment in path.split('/') {
        let decoded = urlencoding::decode(segment)
            .map(|value| value.into_owned())
            .unwrap_or_else(|_| segment.to_string());
        if decoded == "." || decoded == ".." || decoded.contains('/') || decoded.contains('\\') {
            return false;
        }
    }
    true
}

fn quarantined() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({
            "code": "NODE_QUARANTINED",
            "message": "node credential or lease is invalid; workloads are isolated",
            "retryable": false
        })),
    )
        .into_response()
}

async fn authorized(state: &ApiState, headers: &HeaderMap) -> bool {
    if state
        .shared
        .quarantined
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return false;
    }
    let expected = state.shared.identity.read().await.data_token.clone();
    let Some(provided) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return false;
    };
    constant_time_eq(expected.as_bytes(), provided.trim().as_bytes())
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({
            "code": "NODE_AUTH_FAILED",
            "message": "node data credential is missing or invalid",
            "retryable": false
        })),
    )
        .into_response()
}

fn not_found(message: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({
            "code": "NOT_FOUND",
            "message": message,
            "retryable": false
        })),
    )
        .into_response()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0_u8;
    for (a, b) in left.iter().zip(right) {
        diff |= a ^ b;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::safe_forward_path;

    #[test]
    fn rejects_path_traversal_variants() {
        assert!(safe_forward_path("api/hello"));
        assert!(safe_forward_path("api/hello/items/1"));
        assert!(!safe_forward_path("api/../admin"));
        assert!(!safe_forward_path("api/%2e%2e/admin"));
        assert!(!safe_forward_path("api/%2fadmin"));
        assert!(!safe_forward_path("api\\admin"));
    }
}
