use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::Value;
use uuid::Uuid;

pub enum ReceiptStart {
    New(Uuid),
    Replay(StatusCode, Json<Value>),
}

pub fn idempotency_key(headers: &HeaderMap) -> AppResult<String> {
    let key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| value.len() >= 8 && value.len() <= 128)
        .ok_or_else(|| {
            AppError::bad_request("Idempotency-Key header is required (8..=128 characters)")
        })?;
    Ok(key.to_string())
}

pub async fn start(
    state: &AppState,
    key: &str,
    action: &str,
    digest: &str,
) -> AppResult<ReceiptStart> {
    let existing = sqlx::query_as::<_, (Uuid, String, String, Option<i32>, Option<Value>)>(
        "SELECT id, request_digest, status, response_code, response_body FROM kernel.operation_receipts WHERE idempotency_key = $1 AND action = $2",
    )
    .bind(key)
    .bind(action)
    .fetch_optional(&state.db)
    .await?;
    if let Some((id, existing_digest, status, code, body)) = existing {
        if existing_digest != digest {
            return Err(AppError::conflict(
                "IDEMPOTENCY_CONFLICT",
                "This Idempotency-Key was already used with a different request payload",
            ));
        }
        let status_code =
            StatusCode::from_u16(code.unwrap_or(202) as u16).unwrap_or(StatusCode::ACCEPTED);
        let body = body.unwrap_or_else(|| {
            serde_json::json!({
                "requestId": id,
                "receiptStatus": status,
                "replayed": true
            })
        });
        return Ok(ReceiptStart::Replay(status_code, Json(body)));
    }
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO kernel.operation_receipts (id, idempotency_key, action, request_digest, status) VALUES ($1,$2,$3,$4,'ACCEPTED')",
    )
    .bind(id)
    .bind(key)
    .bind(action)
    .bind(digest)
    .execute(&state.db)
    .await?;
    Ok(ReceiptStart::New(id))
}

pub async fn finish(
    state: &AppState,
    id: Uuid,
    status: &str,
    code: StatusCode,
    body: Value,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE kernel.operation_receipts SET status = $2, response_code = $3, response_body = $4, updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(status)
    .bind(code.as_u16() as i32)
    .bind(body)
    .execute(&state.db)
    .await?;
    Ok(())
}

pub fn digest_json<T: serde::Serialize>(value: &T) -> String {
    opsweave_bundle::sha256_digest(&serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec()))
}
