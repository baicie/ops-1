use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

#[allow(clippy::too_many_arguments)]
pub async fn record(
    db: &PgPool,
    event_type: &str,
    actor_type: &str,
    actor_id: &str,
    subject_type: &str,
    subject_id: &str,
    action: &str,
    result: &str,
    details: Value,
    request_id: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO kernel.audit_events
          (id, event_type, actor_type, actor_id, subject_type, subject_id, action, result, details, request_id, occurred_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(event_type)
    .bind(actor_type)
    .bind(actor_id)
    .bind(subject_type)
    .bind(subject_id)
    .bind(action)
    .bind(result)
    .bind(details)
    .bind(request_id)
    .bind(Utc::now())
    .execute(db)
    .await?;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AuditEventView {
    pub id: Uuid,
    pub event_type: String,
    pub actor_type: String,
    pub actor_id: String,
    pub subject_type: String,
    pub subject_id: String,
    pub action: String,
    pub result: String,
    pub details: Value,
    pub request_id: Option<String>,
    pub occurred_at: DateTime<Utc>,
}

pub async fn list(
    db: &PgPool,
    limit: i64,
    subject_type: Option<&str>,
    subject_id: Option<&str>,
) -> Result<Vec<AuditEventView>, sqlx::Error> {
    sqlx::query_as::<_, AuditEventView>(
        r#"
        SELECT id, event_type, actor_type, actor_id, subject_type, subject_id,
               action, result, details, request_id, occurred_at
        FROM kernel.audit_events
        WHERE ($1::text IS NULL OR subject_type = $1)
          AND ($2::text IS NULL OR subject_id = $2)
        ORDER BY occurred_at DESC
        LIMIT $3
        "#,
    )
    .bind(subject_type)
    .bind(subject_id)
    .bind(limit.clamp(1, 500))
    .fetch_all(db)
    .await
}
