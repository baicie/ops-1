use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, Method, Uri};
use axum::response::{IntoResponse, Response};
use opsweave_contracts::ManifestV11;
use rand::Rng;
use serde_json::Value;
use sqlx::FromRow;
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, Clone, FromRow)]
#[allow(dead_code)]
struct RouteRow {
    instance_id: Uuid,
    node_id: Uuid,
    data_endpoint: String,
    data_token: String,
    manifest: Value,
    generation: i64,
    plugin_id: String,
    version: String,
}

pub async fn proxy(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((plugin_id, path)): Path<(String, String)>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    if !matches!(
        auth.role,
        opsweave_contracts::Role::Admin
            | opsweave_contracts::Role::Operator
            | opsweave_contracts::Role::Viewer
    ) {
        return Err(AppError::forbidden("unsupported role"));
    }
    let routes = route_candidates(&state, &plugin_id).await?;
    let Some(first) = routes.first() else {
        return Err(AppError::unavailable(
            "CAPABILITY_UNAVAILABLE",
            format!("no healthy instance is currently effective for {plugin_id}"),
        ));
    };
    let manifest: ManifestV11 = serde_json::from_value(first.manifest.clone())
        .map_err(|error| AppError::internal(format!("active manifest invalid: {error}")))?;
    let backend = manifest
        .backend
        .as_ref()
        .ok_or_else(|| AppError::bad_request("plugin has no backend service"))?;
    let requested = format!("/{path}");
    if !safe_forward_path(&requested) {
        return Err(AppError::bad_request(
            "INVALID_PLUGIN_PATH: path traversal is not allowed",
        ));
    }
    if !(requested == backend.api_prefix
        || requested.starts_with(&format!("{}/", backend.api_prefix.trim_end_matches('/'))))
    {
        return Err(AppError::not_found(
            "path is outside the plugin's registered API prefix",
        ));
    }
    let request_id = Uuid::new_v4().to_string();
    let attempts = if method == Method::GET || method == Method::HEAD {
        routes.len().max(2)
    } else {
        1
    };
    let route_start = if routes.len() > 1 {
        rand::thread_rng().gen_range(0..routes.len())
    } else {
        0
    };
    let mut last_error = None;
    for attempt in 0..attempts {
        let route = &routes[(route_start + attempt) % routes.len()];
        if let Err(error) =
            crate::nodes::validate_node_data_endpoint(&state.config, &route.data_endpoint)
        {
            last_error = Some(error.to_string());
            continue;
        }
        let query = uri
            .query()
            .map(|value| format!("?{value}"))
            .unwrap_or_default();
        let target = format!(
            "{}/internal/v1/proxy/{}{}{}",
            route.data_endpoint.trim_end_matches('/'),
            route.instance_id,
            requested,
            query
        );
        let mut request = state
            .http
            .request(method.clone(), target)
            .bearer_auth(&route.data_token)
            .header("x-opsweave-request-id", &request_id)
            .header("x-opsweave-plugin-id", &route.plugin_id)
            .header("x-opsweave-plugin-version", &route.version)
            .header(
                "x-opsweave-activation-revision",
                route.generation.to_string(),
            )
            .header("x-opsweave-user-id", auth.user_id.to_string())
            .header("x-opsweave-user-role", auth.role.to_string())
            .timeout(Duration::from_secs(
                state.config.request_timeout_seconds.max(1),
            ));
        for (name, value) in headers.iter() {
            let name_str = name.as_str().to_ascii_lowercase();
            if matches!(
                name_str.as_str(),
                "host"
                    | "authorization"
                    | "cookie"
                    | "content-length"
                    | "connection"
                    | "transfer-encoding"
                    | "upgrade"
            ) || name_str.starts_with("x-opsweave-")
            {
                continue;
            }
            request = request.header(name, value);
        }
        if !body.is_empty() {
            request = request.body(body.clone());
        }
        match request.send().await {
            Ok(response) => {
                let status = response.status();
                if status.is_server_error() && attempt + 1 < attempts {
                    last_error = Some(format!("instance returned {status}"));
                    tokio::time::sleep(Duration::from_millis(120)).await;
                    continue;
                }
                if response
                    .content_length()
                    .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
                {
                    return Err(AppError::unavailable(
                        "UPSTREAM_RESPONSE_TOO_LARGE",
                        "plugin response exceeded the 8 MiB gateway limit",
                    ));
                }
                let content_type = response
                    .headers()
                    .get(header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string);
                let bytes = response.bytes().await.map_err(|error| {
                    AppError::internal(format!("read plugin response: {error}"))
                })?;
                if bytes.len() > MAX_RESPONSE_BYTES {
                    return Err(AppError::unavailable(
                        "UPSTREAM_RESPONSE_TOO_LARGE",
                        "plugin response exceeded the 8 MiB gateway limit",
                    ));
                }
                let mut out = (status, bytes).into_response();
                if let Some(content_type) = content_type {
                    if let Ok(value) = header::HeaderValue::from_str(&content_type) {
                        out.headers_mut().insert(header::CONTENT_TYPE, value);
                    }
                }
                out.headers_mut().insert(
                    "x-opsweave-request-id",
                    header::HeaderValue::from_str(&request_id)
                        .map_err(|_| AppError::internal("request id header"))?,
                );
                return Ok(out);
            }
            Err(error) => {
                tracing::warn!(plugin = %plugin_id, error = %error, "gateway request failed");
                last_error = Some(error.to_string());
                if attempt + 1 >= attempts {
                    break;
                }
            }
        }
    }
    Err(AppError::unavailable(
        "UPSTREAM_UNAVAILABLE",
        last_error.unwrap_or_else(|| "plugin instance did not respond".into()),
    ))
}

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

fn safe_forward_path(path: &str) -> bool {
    if path.contains('\0') || path.contains('\\') || path.contains('\\') {
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

async fn route_candidates(state: &AppState, plugin_id: &str) -> AppResult<Vec<RouteRow>> {
    let rows = sqlx::query_as::<_, RouteRow>(
        r#"
        SELECT i.id AS instance_id, i.node_id, n.data_endpoint, n.data_token,
               p.manifest, r.generation, r.plugin_id, r.version
        FROM kernel.activation_revisions r
        JOIN kernel.plugin_deployments d ON d.id = r.deployment_id
        JOIN kernel.plugin_packages p ON p.package_id = r.package_id
        JOIN kernel.trusted_publishers tp ON tp.publisher_id = p.publisher
        JOIN kernel.plugin_instances i ON i.deployment_id = d.id
        JOIN kernel.nodes n ON n.id = i.node_id
        WHERE r.plugin_id = $1
          AND r.status = 'ACTIVE'
          AND tp.trust_state = 'TRUSTED'
          AND i.state = 'READY'
          AND i.desired_action = 'START'
          AND n.revoked_at IS NULL
          AND n.status = 'READY'
          AND n.last_seen_at > now() - ($2 || ' seconds')::interval
          AND n.data_endpoint IS NOT NULL
        ORDER BY i.slot
        "#,
    )
    .bind(plugin_id)
    .bind(state.config.node_stale_seconds)
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::safe_forward_path;

    #[test]
    fn rejects_path_traversal_variants() {
        assert!(safe_forward_path("/api/hello"));
        assert!(safe_forward_path("/api/hello/items/1"));
        assert!(!safe_forward_path("/api/../admin"));
        assert!(!safe_forward_path("/api/%2e%2e/admin"));
        assert!(!safe_forward_path("/api/%2E%2E/admin"));
        assert!(!safe_forward_path("/api/%2fadmin"));
        assert!(!safe_forward_path("/api\\admin"));
    }
}
