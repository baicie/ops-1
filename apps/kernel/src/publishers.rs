use crate::audit;
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::Json;
use chrono::{DateTime, Utc};
use opsweave_bundle::{key_fingerprint, parse_public_key};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PublisherView {
    pub publisher_id: String,
    pub fingerprint: String,
    pub trust_state: String,
    pub note: Option<String>,
    pub created_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

pub async fn list_publishers(
    State(state): State<AppState>,
    _auth: AuthUser,
) -> AppResult<Json<Vec<PublisherView>>> {
    let rows = sqlx::query_as::<_, PublisherView>(
        "SELECT publisher_id, fingerprint, trust_state, note, created_at, revoked_at FROM kernel.trusted_publishers ORDER BY publisher_id",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddPublisherRequest {
    pub publisher_id: String,
    pub public_key_hex: String,
    pub note: Option<String>,
}

pub async fn add_publisher(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(payload): Json<AddPublisherRequest>,
) -> AppResult<Json<PublisherView>> {
    auth.require_admin()?;
    if payload.publisher_id.len() < 3 || payload.publisher_id.len() > 96 {
        return Err(AppError::bad_request(
            "publisherId must be 3..=96 characters",
        ));
    }
    let key = parse_public_key(&payload.public_key_hex)
        .map_err(|error| AppError::bad_request(format!("invalid public key: {error}")))?;
    let fingerprint = key_fingerprint(&key);
    sqlx::query(
        r#"
        INSERT INTO kernel.trusted_publishers (publisher_id, public_key_hex, fingerprint, trust_state, note)
        VALUES ($1,$2,$3,'TRUSTED',$4)
        ON CONFLICT (publisher_id) DO UPDATE
          SET public_key_hex=EXCLUDED.public_key_hex,
              fingerprint=EXCLUDED.fingerprint,
              trust_state='TRUSTED',
              note=EXCLUDED.note,
              revoked_at=NULL
        "#,
    )
    .bind(&payload.publisher_id)
    .bind(payload.public_key_hex.trim().to_lowercase())
    .bind(&fingerprint)
    .bind(&payload.note)
    .execute(&state.db)
    .await?;
    audit::record(
        &state.db,
        "publisher.added",
        "USER",
        &auth.user_id.to_string(),
        "publisher",
        &payload.publisher_id,
        "publisher.trust",
        "CONFIRMED",
        serde_json::json!({"fingerprint": fingerprint}),
        None,
    )
    .await?;
    let row = sqlx::query_as::<_, PublisherView>(
        "SELECT publisher_id, fingerprint, trust_state, note, created_at, revoked_at FROM kernel.trusted_publishers WHERE publisher_id=$1",
    )
    .bind(&payload.publisher_id)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(row))
}

pub async fn revoke_publisher(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(publisher_id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    auth.require_admin()?;
    let affected = sqlx::query(
        "UPDATE kernel.trusted_publishers SET trust_state='REVOKED', revoked_at=now() WHERE publisher_id=$1",
    )
    .bind(&publisher_id)
    .execute(&state.db)
    .await?
    .rows_affected();
    if affected == 0 {
        return Err(AppError::not_found("publisher not found"));
    }
    audit::record(
        &state.db,
        "publisher.revoked",
        "USER",
        &auth.user_id.to_string(),
        "publisher",
        &publisher_id,
        "publisher.revoke",
        "CONFIRMED",
        serde_json::json!({"newInstallsRejected": true}),
        None,
    )
    .await?;
    Ok(Json(
        serde_json::json!({"ok": true, "publisherId": publisher_id}),
    ))
}
