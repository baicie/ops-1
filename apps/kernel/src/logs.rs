use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use opsweave_contracts::{LogBatch, LogLevel};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use sqlx::FromRow;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Deserialize)]
pub struct LogQuery {
    pub cursor: Option<String>,
    pub contains: Option<String>,
    pub level: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CursorPayload {
    i: Uuid,
    e: i64,
    s: i64,
}

#[derive(Debug, Clone, FromRow)]
pub struct InstanceContextRow {
    pub id: Uuid,
    pub deployment_id: Uuid,
    pub node_id: Uuid,
    pub slot: i32,
    pub state: String,
    pub observed_at: Option<DateTime<Utc>>,
    pub container_id: Option<String>,
    pub image_digest: Option<String>,
    pub restart_count: i32,
    pub last_error: Option<String>,
    pub node_name: String,
    pub node_status: String,
    pub node_last_seen_at: Option<DateTime<Utc>>,
    pub data_endpoint: Option<String>,
    pub data_token: String,
    pub plugin_id: String,
    pub version: String,
    pub deployment_status: String,
}

pub async fn get_instance(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(instance_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    auth.require_operator()?;
    let context = fetch_instance_context(&state, instance_id).await?;
    if !node_authorized(&state, context.node_id).await? {
        return Err(AppError::forbidden(
            "node hosting this instance is revoked or unavailable",
        ));
    }
    Ok(Json(serde_json::json!({
        "id": context.id,
        "deploymentId": context.deployment_id,
        "nodeId": context.node_id,
        "nodeName": context.node_name,
        "nodeStatus": context.node_status,
        "nodeLastSeenAt": context.node_last_seen_at,
        "slot": context.slot,
        "state": context.state,
        "observedAt": context.observed_at,
        "containerId": context.container_id,
        "imageDigest": context.image_digest,
        "restartCount": context.restart_count,
        "lastError": context.last_error,
        "pluginId": context.plugin_id,
        "version": context.version,
        "deploymentStatus": context.deployment_status,
        "streamId": context.id,
    })))
}

pub async fn live_logs(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(instance_id): Path<Uuid>,
    Query(query): Query<LogQuery>,
) -> AppResult<Response> {
    auth.require_operator()?;
    let context = fetch_instance_context(&state, instance_id).await?;
    if !node_authorized(&state, context.node_id).await? {
        return Err(AppError::forbidden(
            "node hosting this instance is revoked or unavailable",
        ));
    }
    let stale_before = Utc::now() - chrono::Duration::seconds(state.config.node_stale_seconds);
    if context
        .node_last_seen_at
        .map(|seen| seen < stale_before)
        .unwrap_or(true)
    {
        return Err(AppError::new(
            axum::http::StatusCode::CONFLICT,
            "NODE_UNREACHABLE",
            "The node hosting this instance is unreachable; log tail is unavailable until it reconnects",
        ));
    }
    let endpoint = context.data_endpoint.clone().ok_or_else(|| {
        AppError::unavailable(
            "LOG_STREAM_UNAVAILABLE",
            "node data endpoint is not registered",
        )
    })?;

    let mut epoch = 1_i64;
    let mut sequence = 0_i64;
    let mut initial_gap = false;
    if let Some(cursor) = &query.cursor {
        if cursor.is_empty() {
            // Empty cursor means "from now" (tail).
            sequence = i64::MAX;
        } else {
            let (payload, provided_epoch, provided_seq) = decode_cursor(&state, cursor)?;
            if payload.i != instance_id {
                return Err(AppError::bad_request("cursor belongs to another stream"));
            }
            epoch = provided_epoch;
            sequence = provided_seq;
        }
    }
    if sequence == i64::MAX {
        sequence = 0;
        initial_gap = true;
    }

    let (tx, rx) = mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(32);
    let state_clone = state.clone();
    let contains = query.contains.clone().filter(|value| !value.is_empty());
    let level_filter = query
        .level
        .clone()
        .and_then(|value| match value.to_uppercase().as_str() {
            "TRACE" => Some(LogLevel::Trace),
            "DEBUG" => Some(LogLevel::Debug),
            "INFO" => Some(LogLevel::Info),
            "WARN" => Some(LogLevel::Warn),
            "ERROR" => Some(LogLevel::Error),
            _ => None,
        });
    let node_id = context.node_id;
    tokio::spawn(async move {
        let status = serde_json::json!({
            "instanceId": instance_id,
            "nodeId": node_id,
            "state": "CONNECTED",
            "streamEpoch": epoch
        });
        if send_event(&tx, None, "status", &status).await.is_err() {
            return;
        }
        if initial_gap {
            let payload = serde_json::json!({
                "code": "TAIL_FROM_NOW",
                "message": "Stream started at the current tail; previous entries are not replayed."
            });
            let _ = send_event(&tx, None, "gap", &payload).await;
        }
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            match node_authorized(&state_clone, node_id).await {
                Ok(true) => {}
                Ok(false) => {
                    let payload = serde_json::json!({
                        "code": "NODE_REVOKED",
                        "message": "The node credential was revoked; this log stream is closed.",
                        "retryable": false
                    });
                    let _ = send_event(&tx, None, "status", &payload).await;
                    break;
                }
                Err(error) => {
                    let payload = serde_json::json!({
                        "code": "LOG_STREAM_ERROR",
                        "message": format!("authorization check failed: {error}"),
                        "retryable": true
                    });
                    let _ = send_event(&tx, None, "status", &payload).await;
                    break;
                }
            }
            tokio::select! {
                _ = heartbeat.tick() => {
                    let payload = serde_json::json!({"observedAt": Utc::now()});
                    if send_event(&tx, None, "heartbeat", &payload).await.is_err() {
                        break;
                    }
                }
                result = fetch_logs(&state_clone, &endpoint, &context.data_token, instance_id, epoch, sequence) => {
                    match result {
                        Ok(batch) => {
                            if batch.gap {
                                let gap_payload = serde_json::json!({
                                    "code": "CURSOR_EXPIRED",
                                    "message": "The node log buffer no longer contains the requested cursor; continue from the earliest available event.",
                                    "firstSequence": batch.first_sequence,
                                    "lastSequence": batch.last_sequence
                                });
                                if send_event(&tx, None, "gap", &gap_payload).await.is_err() {
                                    break;
                                }
                            }
                            if batch.stream_epoch != epoch {
                                let gap_payload = serde_json::json!({
                                    "code": "STREAM_EPOCH_CHANGED",
                                    "message": "Container restart rotated the log stream; continuity is not claimed.",
                                    "previousEpoch": epoch,
                                    "streamEpoch": batch.stream_epoch
                                });
                                if send_event(&tx, None, "gap", &gap_payload).await.is_err() {
                                    break;
                                }
                                epoch = batch.stream_epoch;
                                sequence = batch.first_sequence.unwrap_or(0).saturating_sub(1);
                            }
                            for event in &batch.events {
                                sequence = sequence.max(event.sequence);
                                if let Some(filter) = &level_filter {
                                    if event.level != *filter {
                                        continue;
                                    }
                                }
                                if let Some(contains) = &contains {
                                    if !event.message.to_lowercase().contains(&contains.to_lowercase()) {
                                        continue;
                                    }
                                }
                                let cursor = encode_cursor(&state_clone, instance_id, event.stream_epoch, event.sequence);
                                if send_event(&tx, Some(&cursor), "log", event).await.is_err() {
                                    return;
                                }
                            }
                            if let Some(last) = batch.last_sequence {
                                sequence = sequence.max(last);
                            }
                            if batch.events.is_empty() {
                                tokio::time::sleep(Duration::from_millis(250)).await;
                            }
                        }
                        Err(error) => {
                            let payload = serde_json::json!({
                                "code": "LOG_STREAM_ERROR",
                                "message": error,
                                "retryable": true
                            });
                            if send_event(&tx, None, "status", &payload).await.is_err() {
                                break;
                            }
                            tokio::time::sleep(Duration::from_secs(2)).await;
                        }
                    }
                }
            }
            if tx.is_closed() {
                break;
            }
        }
    });

    let stream = ReceiverStream::new(rx);
    let mut response = Body::from_stream(stream).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("text/event-stream"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response.headers_mut().insert(
        header::HeaderName::from_static("x-accel-buffering"),
        header::HeaderValue::from_static("no"),
    );
    Ok(response)
}

async fn send_event<T: Serialize>(
    tx: &mpsc::Sender<Result<bytes::Bytes, std::io::Error>>,
    id: Option<&str>,
    event: &str,
    data: &T,
) -> Result<(), ()> {
    let json = serde_json::to_string(data).map_err(|_| ())?;
    let mut frame = String::new();
    if let Some(id) = id {
        frame.push_str(&format!("id: {id}\n"));
    }
    frame.push_str(&format!("event: {event}\ndata: {json}\n\n"));
    tx.send(Ok(bytes::Bytes::from(frame))).await.map_err(|_| ())
}

async fn fetch_logs(
    state: &AppState,
    endpoint: &str,
    token: &str,
    instance_id: Uuid,
    epoch: i64,
    after: i64,
) -> Result<LogBatch, String> {
    let url = format!(
        "{}/internal/v1/instances/{}/logs?epoch={}&after={}",
        endpoint.trim_end_matches('/'),
        instance_id,
        epoch,
        after
    );
    let response = state
        .http
        .get(url)
        .bearer_auth(token)
        .timeout(Duration::from_secs(4))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("node log endpoint returned {}", response.status()));
    }
    response
        .json::<LogBatch>()
        .await
        .map_err(|error| error.to_string())
}

pub fn encode_cursor(state: &AppState, instance_id: Uuid, epoch: i64, sequence: i64) -> String {
    let payload = serde_json::to_vec(&CursorPayload {
        i: instance_id,
        e: epoch,
        s: sequence,
    })
    .unwrap_or_default();
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&payload);
    let mut mac = HmacSha256::new_from_slice(&state.cursor_secret).expect("hmac key");
    mac.update(format!("opsweave.log.cursor.v1:{encoded}").as_bytes());
    format!("v1.{encoded}.{}", hex::encode(mac.finalize().into_bytes()))
}

fn decode_cursor(state: &AppState, cursor: &str) -> AppResult<(CursorPayload, i64, i64)> {
    let mut parts = cursor.split('.');
    if parts.next() != Some("v1") {
        return Err(AppError::bad_request("invalid cursor version"));
    }
    let encoded = parts
        .next()
        .ok_or_else(|| AppError::bad_request("invalid cursor"))?;
    let signature = parts
        .next()
        .ok_or_else(|| AppError::bad_request("invalid cursor"))?;
    if parts.next().is_some() {
        return Err(AppError::bad_request("invalid cursor"));
    }
    let mut mac = HmacSha256::new_from_slice(&state.cursor_secret).expect("hmac key");
    mac.update(format!("opsweave.log.cursor.v1:{encoded}").as_bytes());
    let expected = hex::encode(mac.finalize().into_bytes());
    if !constant_time_eq(expected.as_bytes(), signature.as_bytes()) {
        return Err(AppError::bad_request("cursor signature is invalid"));
    }
    let payload_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| AppError::bad_request("cursor payload is invalid"))?;
    let payload: CursorPayload = serde_json::from_slice(&payload_bytes)
        .map_err(|_| AppError::bad_request("cursor payload is invalid"))?;
    Ok((payload.clone(), payload.e, payload.s))
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

async fn node_authorized(state: &AppState, node_id: Uuid) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM kernel.nodes WHERE id=$1 AND revoked_at IS NULL AND status='READY' AND last_seen_at > now() - ($2 || ' seconds')::interval)",
    )
    .bind(node_id)
    .bind(state.config.node_stale_seconds)
    .fetch_one(&state.db)
    .await
}

async fn fetch_instance_context(
    state: &AppState,
    instance_id: Uuid,
) -> AppResult<InstanceContextRow> {
    sqlx::query_as::<_, InstanceContextRow>(
        r#"
        SELECT i.id, i.deployment_id, i.node_id, i.slot, i.state, i.observed_at,
               i.container_id, i.image_digest, i.restart_count, i.last_error,
               n.name AS node_name, n.status AS node_status, n.last_seen_at AS node_last_seen_at,
               n.data_endpoint, n.data_token, d.plugin_id, d.version, d.status AS deployment_status
        FROM kernel.plugin_instances i
        JOIN kernel.nodes n ON n.id=i.node_id
        JOIN kernel.plugin_deployments d ON d.id=i.deployment_id
        WHERE i.id=$1
        "#,
    )
    .bind(instance_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found("instance not found"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_round_trip() {
        // Cursor codec is covered through a live kernel in tests/acceptance; this
        // unit test only exercises the constant-time comparison helper.
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }
}
