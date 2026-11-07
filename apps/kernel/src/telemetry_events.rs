//! G13-B1 slice 3: automation Event ingest and incident dedup.
//!
//! The endpoint accepts only an `owa1` principal with EVENT_INGEST. The
//! workspace is the principal's; a body value is a consistency check, never a
//! grant. The payload is bounded and digested, never Evidence; evidence still
//! requires collect -> v2 attestation -> Kernel content verification.
//!
//! Idempotency has two layers: the Event table key
//! `(workspace, source, idempotency_key)` and the incident key
//! `(workspace, source, native_id)` for active states. A retry returns the
//! original identifiers; a duplicate Event never creates a second Incident.

use crate::automation;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

const MAX_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_CLOCK_SKEW_SECONDS: i64 = 300;
const MAX_AGE_DAYS: i64 = 90;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRequest {
    pub native_id: String,
    pub source_id: Uuid,
    pub workspace_id: Uuid,
    pub occurred_at: DateTime<Utc>,
    pub observed_at: DateTime<Utc>,
    pub severity: String,
    pub trigger_state: String,
    pub payload_digest: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventResponse {
    pub event_id: Uuid,
    pub incident_id: Option<Uuid>,
    pub deduplicated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automation: Option<crate::automation_flow::AutomationRunView>,
}

#[derive(Debug, sqlx::FromRow)]
struct EventRow {
    event_id: Uuid,
    incident_id: Option<Uuid>,
}

fn validate(req: &EventRequest) -> AppResult<()> {
    let native = req.native_id.trim();
    if native.is_empty() || native.len() > 200 {
        return Err(AppError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "EVENT_PAYLOAD_INVALID",
            "nativeId must be 1-200 bytes",
        ));
    }
    if !matches!(req.trigger_state.as_str(), "PROBLEM" | "RESOLVED") {
        return Err(AppError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "EVENT_PAYLOAD_INVALID",
            "triggerState must be PROBLEM or RESOLVED",
        ));
    }
    if !matches!(
        req.severity.as_str(),
        "CRITICAL" | "MAJOR" | "MINOR" | "WARNING" | "INFO"
    ) {
        return Err(AppError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "EVENT_PAYLOAD_INVALID",
            "severity is not in the contract enum",
        ));
    }
    let now = Utc::now();
    if req.occurred_at > req.observed_at + chrono::Duration::seconds(MAX_CLOCK_SKEW_SECONDS) {
        return Err(AppError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "EVENT_TIME_INVALID",
            "occurredAt is later than observedAt plus the allowed skew",
        ));
    }
    if req.observed_at < now - chrono::Duration::days(MAX_AGE_DAYS) {
        return Err(AppError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "EVENT_TIME_INVALID",
            "observedAt is older than the retention window",
        ));
    }
    let payload_bytes = serde_json::to_vec(&req.payload).map_err(AppError::from)?;
    if payload_bytes.len() > MAX_PAYLOAD_BYTES {
        return Err(AppError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "EVENT_PAYLOAD_TOO_LARGE",
            "payload exceeds 64 KiB",
        ));
    }
    let computed = format!(
        "sha256:{}",
        hex::encode(Sha256::digest(opsweave_contracts::canonical_json(
            &req.payload
        )))
    );
    if computed != req.payload_digest {
        return Err(AppError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "EVENT_DIGEST_MISMATCH",
            "payloadDigest does not match the canonical payload bytes",
        ));
    }
    Ok(())
}

fn idempotency_key(req: &EventRequest) -> String {
    let mut hasher = Sha256::new();
    hasher.update(req.workspace_id.to_string().as_bytes());
    hasher.update(b"|");
    hasher.update(req.source_id.to_string().as_bytes());
    hasher.update(b"|");
    hasher.update(req.native_id.trim().as_bytes());
    hasher.update(b"|");
    hasher.update(req.trigger_state.as_bytes());
    hasher.update(b"|");
    hasher.update(
        req.occurred_at
            .to_rfc3339_opts(SecondsFormat::Secs, true)
            .as_bytes(),
    );
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn header_key(headers: &HeaderMap) -> AppResult<String> {
    let key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "EVENT_IDEMPOTENCY_CONFLICT",
                "Idempotency-Key header is required",
            )
        })?;
    Ok(key.to_string())
}

/// `POST /api/v1/telemetry/events`
pub async fn ingest(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<EventRequest>,
) -> AppResult<(StatusCode, Json<EventResponse>)> {
    let principal = automation::authenticate(&state, &headers).await?;
    principal.require_op("EVENT_INGEST")?;
    if req.workspace_id != principal.claims.workspace_id
        || req.source_id != principal.claims.source_id
    {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "EVENT_SOURCE_FORBIDDEN",
            "the event does not belong to this principal's workspace/source",
        ));
    }
    validate(&req)?;
    let key = idempotency_key(&req);
    let supplied = header_key(&headers)?;
    if supplied != key {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "EVENT_IDEMPOTENCY_CONFLICT",
            "Idempotency-Key does not match the event fields",
        ));
    }

    // A retry is allowed to return the original result without consuming the
    // principal again. Only a genuinely new Event spends the operation.
    if let Some(existing) = find_event(&state.db, req.workspace_id, req.source_id, &key).await? {
        return Ok((
            StatusCode::OK,
            Json(EventResponse {
                event_id: existing.event_id,
                incident_id: existing.incident_id,
                deduplicated: true,
                automation: None,
            }),
        ));
    }
    if let Err(error) = principal.consume_once(&state, "EVENT_INGEST").await {
        // A concurrent request may have inserted the same event between our
        // lookup and the consume attempt. That is a duplicate, not a replay.
        if let Some(existing) = find_event(&state.db, req.workspace_id, req.source_id, &key).await?
        {
            return Ok((
                StatusCode::OK,
                Json(EventResponse {
                    event_id: existing.event_id,
                    incident_id: existing.incident_id,
                    deduplicated: true,
                    automation: None,
                }),
            ));
        }
        return Err(error);
    }

    let (status, response) = store_event(&state.db, &principal, &req, &key).await?;
    Ok((status, Json(response)))
}

async fn find_event(
    db: &PgPool,
    workspace_id: Uuid,
    source_id: Uuid,
    key: &str,
) -> AppResult<Option<EventRow>> {
    Ok(sqlx::query_as::<_, EventRow>(
        "SELECT event_id, incident_id FROM kernel.telemetry_events
          WHERE workspace_id=$1 AND source_id=$2 AND idempotency_key=$3",
    )
    .bind(workspace_id)
    .bind(source_id)
    .bind(key)
    .fetch_optional(db)
    .await?)
}

async fn store_event(
    db: &PgPool,
    principal: &automation::AutomationPrincipal,
    req: &EventRequest,
    key: &str,
) -> AppResult<(StatusCode, EventResponse)> {
    let late: bool = sqlx::query_scalar(
        "SELECT EXISTS(
             SELECT 1 FROM kernel.telemetry_events
              WHERE workspace_id=$1 AND source_id=$2 AND native_id=$3
                AND occurred_at > $4)",
    )
    .bind(req.workspace_id)
    .bind(req.source_id)
    .bind(req.native_id.trim())
    .bind(req.occurred_at)
    .fetch_one(db)
    .await?;

    let mut tx = db.begin().await?;
    let active: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT incident_id, status FROM kernel.incidents
          WHERE workspace_id=$1 AND source_id=$2 AND native_id=$3
            AND status IN ('OPEN','INVESTIGATING','CONCLUDED')
          ORDER BY created_at DESC LIMIT 1",
    )
    .bind(req.workspace_id)
    .bind(req.source_id)
    .bind(req.native_id.trim())
    .fetch_optional(&mut *tx)
    .await?;

    let mut incident_id = active.as_ref().map(|(id, _)| *id);
    if incident_id.is_none() && req.trigger_state == "PROBLEM" {
        let recurrence: Option<Uuid> = sqlx::query_scalar(
            "SELECT incident_id FROM kernel.incidents
              WHERE workspace_id=$1 AND source_id=$2 AND native_id=$3 AND status='CLOSED'
              ORDER BY created_at DESC LIMIT 1",
        )
        .bind(req.workspace_id)
        .bind(req.source_id)
        .bind(req.native_id.trim())
        .fetch_optional(&mut *tx)
        .await?;
        let id = Uuid::new_v4();
        let title = incident_title(req);
        let severity = if req.severity == "INFO" {
            "WARNING"
        } else {
            req.severity.as_str()
        };
        // Two different Event keys for one nativeId can race here: both
        // transactions read "no active incident" before either committed, and
        // the partial unique index is the only arbiter. DO NOTHING (rather than
        // a raw 23505) lets the loser re-read the winner's row and attach its
        // Event to it - the Event is legitimate and must not be dropped.
        let inserted: Option<Uuid> = sqlx::query_scalar(
            "INSERT INTO kernel.incidents
                 (incident_id,title,severity,status,source,native_id,started_at,owner,workspace_id,source_id,origin,recurrence_of)
             VALUES ($1,$2,$3,'OPEN','ZABBIX',$4,$5,$6,$7,$8,'AUTOMATION',$9)
             ON CONFLICT DO NOTHING
             RETURNING incident_id",
        )
        .bind(id)
        .bind(title)
        .bind(severity)
        .bind(req.native_id.trim())
        .bind(req.occurred_at)
        .bind(Uuid::parse_str(crate::automation::AUTOMATION_USER_ID).expect("owner is a literal uuid"))
        .bind(req.workspace_id)
        .bind(req.source_id)
        .bind(recurrence)
        .fetch_optional(&mut *tx)
        .await?;
        incident_id = match inserted {
            Some(id) => Some(id),
            None => {
                // The conflicting inserter committed before ON CONFLICT
                // returned, so a fresh statement in this READ COMMITTED
                // transaction sees it. If it does not, the conflict was not
                // the active-incident key and the caller gets a stable code,
                // never a raw database error.
                let winner: Option<Uuid> = sqlx::query_scalar(
                    "SELECT incident_id FROM kernel.incidents
                      WHERE workspace_id=$1 AND source_id=$2 AND native_id=$3
                        AND status IN ('OPEN','INVESTIGATING','CONCLUDED')
                      ORDER BY created_at DESC LIMIT 1",
                )
                .bind(req.workspace_id)
                .bind(req.source_id)
                .bind(req.native_id.trim())
                .fetch_optional(&mut *tx)
                .await?;
                let Some(winner) = winner else {
                    tx.rollback().await?;
                    return Err(AppError::conflict(
                        "EVENT_INCIDENT_CONFLICT",
                        "a concurrent Event changed this incident set; retry the same Idempotency-Key",
                    ));
                };
                Some(winner)
            }
        };
    }

    let event_id = Uuid::new_v4();
    let inserted: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO kernel.telemetry_events
             (event_id,workspace_id,source_id,native_id,idempotency_key,trigger_state,severity,
              occurred_at,observed_at,payload_digest,payload,late,incident_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (workspace_id,source_id,idempotency_key) DO NOTHING
         RETURNING event_id",
    )
    .bind(event_id)
    .bind(req.workspace_id)
    .bind(req.source_id)
    .bind(req.native_id.trim())
    .bind(key)
    .bind(&req.trigger_state)
    .bind(&req.severity)
    .bind(req.occurred_at)
    .bind(req.observed_at)
    .bind(&req.payload_digest)
    .bind(&req.payload)
    .bind(late)
    .bind(incident_id)
    .fetch_optional(&mut *tx)
    .await?;

    if inserted.is_none() {
        // Lost the idempotency race: return the winner's identifiers.
        tx.rollback().await?;
        let existing = find_event(db, req.workspace_id, req.source_id, key)
            .await?
            .ok_or_else(|| {
                AppError::conflict(
                    "EVENT_IDEMPOTENCY_CONFLICT",
                    "the event conflicted but the winner is not readable",
                )
            })?;
        return Ok((
            StatusCode::OK,
            EventResponse {
                event_id: existing.event_id,
                incident_id: existing.incident_id,
                deduplicated: true,
                automation: None,
            },
        ));
    }

    let mut job_id = None;
    if let (Some(incident_id), "PROBLEM") = (incident_id, req.trigger_state.as_str()) {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.automation_jobs
                 (job_id,event_id,incident_id,principal_id,source_id,status,max_attempts)
             VALUES ($1,$2,$3,$4,$5,'PENDING',$6)",
        )
        .bind(id)
        .bind(event_id)
        .bind(incident_id)
        .bind(principal.principal_id())
        .bind(req.source_id)
        .bind(crate::automation_worker::default_max_attempts())
        .execute(&mut *tx)
        .await?;
        job_id = Some(id);
    }

    if let Some(incident_id) = incident_id {
        crate::incidents::audit_automation_event(
            &mut tx,
            principal.principal_id(),
            incident_id,
            json!({
                "eventId": event_id,
                "nativeId": req.native_id.trim(),
                "triggerState": req.trigger_state,
                "severity": req.severity,
                "late": late,
            }),
        )
        .await?;
    }

    crate::audit::record_in_tx(
        &mut tx,
        "telemetry.event.ingested",
        "AUTOMATION",
        &principal.principal_id().to_string(),
        "TELEMETRY_EVENT",
        &event_id.to_string(),
        "EVENT_INGEST",
        "ACCEPTED",
        json!({
            "sourceId": req.source_id,
            "nativeId": req.native_id.trim(),
            "triggerState": req.trigger_state,
            "deduplicated": false,
            "late": late,
            "incidentId": incident_id,
        }),
        None,
    )
    .await?;

    tx.commit().await?;
    Ok((
        StatusCode::ACCEPTED,
        EventResponse {
            event_id,
            incident_id,
            deduplicated: false,
            automation: job_id.map(crate::automation_flow::AutomationRunView::pending),
        },
    ))
}

fn incident_title(req: &EventRequest) -> String {
    for field in ["trigger", "host", "name"] {
        if let Some(value) = req.payload.get(field).and_then(Value::as_str) {
            let trimmed = value.trim();
            if trimmed.chars().count() >= 4 {
                return trimmed.chars().take(200).collect();
            }
        }
    }
    format!("Zabbix event {}", req.native_id.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::{AutomationClaims, AutomationPrincipal, PrincipalRow};
    use sqlx::postgres::PgConnectOptions;
    use sqlx::PgPool;

    const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";

    async fn test_pool() -> Option<PgPool> {
        let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(std::env::VarError::NotPresent) => {
                if std::env::var(REQUIRE_DATABASE_ENV).ok().as_deref() == Some("1") {
                    panic!("{REQUIRE_DATABASE_ENV} is set but OPSWEAVE_TEST_DATABASE_URL is unset");
                }
                return None;
            }
            Err(std::env::VarError::NotUnicode(_)) => {
                panic!("OPSWEAVE_TEST_DATABASE_URL is not valid UTF-8")
            }
        };
        let options: PgConnectOptions = url.parse().unwrap();
        let pool = PgPool::connect_with(options).await.unwrap();
        crate::db::migrate(&pool).await.unwrap();
        Some(pool)
    }

    fn principal() -> AutomationPrincipal {
        let principal_id = Uuid::new_v4();
        let now = Utc::now();
        AutomationPrincipal {
            row: PrincipalRow {
                principal_id,
                plugin_id: "zabbix-source".into(),
                instance_id: Uuid::new_v4(),
                node_id: Uuid::new_v4(),
                node_generation: 1,
                workspace_id: crate::scope::legacy_workspace(),
                source_id: Uuid::new_v4(),
                allowed_ops: vec!["EVENT_INGEST".into()],
                event_id: None,
                incident_id: None,
                budget: json!({}),
                issued_at: now,
                expires_at: now + chrono::Duration::seconds(300),
                jti: Uuid::new_v4(),
                revoked_at: None,
            },
            claims: AutomationClaims {
                v: 1,
                kind: "automation".into(),
                principal_id,
                plugin_id: "zabbix-source".into(),
                instance_id: Uuid::new_v4(),
                node_id: Uuid::new_v4(),
                node_generation: 1,
                workspace_id: crate::scope::legacy_workspace(),
                source_id: Uuid::new_v4(),
                allowed_ops: vec!["EVENT_INGEST".into()],
                event_id: None,
                incident_id: None,
                budget: json!({}),
                issued_at: now.timestamp(),
                expires_at: (now + chrono::Duration::seconds(300)).timestamp(),
                jti: Uuid::new_v4(),
                audience: "opsweave-kernel".into(),
            },
        }
    }

    fn digest(payload: &Value) -> String {
        format!(
            "sha256:{}",
            hex::encode(Sha256::digest(opsweave_contracts::canonical_json(payload)))
        )
    }

    #[tokio::test]
    async fn duplicate_event_creates_one_incident_and_resolved_creates_none() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let workspace = crate::scope::legacy_workspace();
        let source_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.telemetry_sources
                 (source_id,workspace_id,plugin_id,secret_ref,endpoint,tls_policy,state)
             VALUES ($1,$2,'zabbix-source','secretref:zabbix/main','https://zabbix.example/api_jsonrpc.php','VERIFY','READY')",
        )
        .bind(source_id)
        .bind(workspace)
        .execute(&pool)
        .await
        .unwrap();
        let actor = principal();
        sqlx::query(
            "INSERT INTO kernel.automation_principals
                 (principal_id,plugin_id,instance_id,node_id,node_generation,workspace_id,source_id,
                  allowed_ops,event_id,incident_id,budget,issued_at,expires_at,jti)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
        )
        .bind(actor.row.principal_id)
        .bind(&actor.row.plugin_id)
        .bind(actor.row.instance_id)
        .bind(actor.row.node_id)
        .bind(actor.row.node_generation)
        .bind(actor.row.workspace_id)
        .bind(source_id)
        .bind(&actor.row.allowed_ops)
        .bind(actor.row.event_id)
        .bind(actor.row.incident_id)
        .bind(&actor.row.budget)
        .bind(actor.row.issued_at)
        .bind(actor.row.expires_at)
        .bind(actor.row.jti)
        .execute(&pool)
        .await
        .unwrap();

        let mut req = request();
        req.workspace_id = workspace;
        req.source_id = source_id;
        req.native_id = "duplicate-native".into();
        req.payload_digest = digest(&req.payload);
        let key = idempotency_key(&req);
        let first = store_event(&pool, &actor, &req, &key).await.unwrap();
        assert_eq!(first.0, StatusCode::ACCEPTED);
        let incident_id = first.1.incident_id.expect("PROBLEM creates an incident");
        let second = store_event(&pool, &actor, &req, &key).await.unwrap();
        assert_eq!(second.1.event_id, first.1.event_id);
        assert_eq!(second.1.incident_id, Some(incident_id));

        let incidents: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incidents WHERE workspace_id=$1 AND source_id=$2",
        )
        .bind(workspace)
        .bind(source_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(incidents, 1);

        let mut resolved = request();
        resolved.workspace_id = workspace;
        resolved.source_id = source_id;
        resolved.native_id = "resolved-native".into();
        resolved.trigger_state = "RESOLVED".into();
        resolved.payload_digest = digest(&resolved.payload);
        let resolved = store_event(&pool, &actor, &resolved, &idempotency_key(&resolved))
            .await
            .unwrap();
        assert!(
            resolved.1.incident_id.is_none(),
            "RESOLVED is not an incident"
        );

        let _ = sqlx::query("DELETE FROM kernel.telemetry_events WHERE source_id=$1")
            .bind(source_id)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM kernel.incidents WHERE source_id=$1")
            .bind(source_id)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM kernel.automation_jobs WHERE source_id=$1")
            .bind(source_id)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM kernel.automation_principals WHERE source_id=$1")
            .bind(source_id)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM kernel.telemetry_sources WHERE source_id=$1")
            .bind(source_id)
            .execute(&pool)
            .await;
    }

    /// B1.4 invariant: the Event handler owns the incident as the non-login
    /// automation service user, and the operator row rule is `owner = caller`.
    /// An UNCLAIMED automation incident is therefore invisible to the operator's
    /// ordinary reads and writes - which is exactly why the claim queue exists.
    /// This test pins the narrow half: fixing the operator lockout must not widen
    /// `OwnedRows`, so the ordinary read stays closed until a claim has moved the
    /// owner. incident_claims::tests drives the queue and the claim.
    #[tokio::test]
    async fn an_unclaimed_automation_incident_stays_invisible_to_the_operator_row_rule() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let workspace = crate::scope::legacy_workspace();
        let source_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.telemetry_sources
                 (source_id,workspace_id,plugin_id,secret_ref,endpoint,tls_policy,state)
             VALUES ($1,$2,'zabbix-source','secretref:zabbix/main','https://zabbix.example/api_jsonrpc.php','VERIFY','READY')",
        )
        .bind(source_id)
        .bind(workspace)
        .execute(&pool)
        .await
        .unwrap();
        let operator = seed_claim_user(&pool, "operator").await;
        let admin = seed_claim_user(&pool, "admin").await;
        sqlx::query(
            "INSERT INTO kernel.business_workspace_members (workspace_id,user_id)
             VALUES ($1,$2) ON CONFLICT DO NOTHING",
        )
        .bind(workspace)
        .bind(operator)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO kernel.business_workspace_members (workspace_id,user_id)
             VALUES ($1,$2) ON CONFLICT DO NOTHING",
        )
        .bind(workspace)
        .bind(admin)
        .execute(&pool)
        .await
        .unwrap();
        let actor = principal();
        sqlx::query(
            "INSERT INTO kernel.automation_principals
                 (principal_id,plugin_id,instance_id,node_id,node_generation,workspace_id,source_id,
                  allowed_ops,event_id,incident_id,budget,issued_at,expires_at,jti)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
        )
        .bind(actor.row.principal_id)
        .bind(&actor.row.plugin_id)
        .bind(actor.row.instance_id)
        .bind(actor.row.node_id)
        .bind(actor.row.node_generation)
        .bind(actor.row.workspace_id)
        .bind(source_id)
        .bind(&actor.row.allowed_ops)
        .bind(actor.row.event_id)
        .bind(actor.row.incident_id)
        .bind(&actor.row.budget)
        .bind(actor.row.issued_at)
        .bind(actor.row.expires_at)
        .bind(actor.row.jti)
        .execute(&pool)
        .await
        .unwrap();

        let mut req = request();
        req.workspace_id = workspace;
        req.source_id = source_id;
        req.native_id = format!("b14-repro-{}", Uuid::new_v4());
        req.payload_digest = digest(&req.payload);
        let key = idempotency_key(&req);
        let (_, stored) = store_event(&pool, &actor, &req, &key).await.unwrap();
        let incident_id = stored.incident_id.expect("PROBLEM creates an incident");

        let owner: Uuid =
            sqlx::query_scalar("SELECT owner FROM kernel.incidents WHERE incident_id=$1")
                .bind(incident_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            owner.to_string(),
            crate::automation::AUTOMATION_USER_ID,
            "the Event handler owns the incident as the automation service user"
        );

        let operator_scope = crate::scope::DataScope::for_test(
            operator,
            vec![workspace],
            crate::scope::RowRule::for_role(opsweave_contracts::Role::Operator),
        );
        let visible = crate::incidents::query_incidents(
            &pool,
            operator_scope.clone(),
            crate::incidents::IncidentListQuery::default(),
        )
        .await
        .unwrap();
        let ids: Vec<Uuid> = visible.items.iter().map(|item| item.id).collect();
        assert!(
            !ids.contains(&incident_id),
            "REPRODUCED: the workspace operator's incident list does not contain the automation incident"
        );
        let read = crate::incidents::query_incident(&pool, operator_scope.clone(), incident_id)
            .await
            .unwrap_err();
        assert_eq!(read.status, StatusCode::NOT_FOUND);

        // The two writes go through the real HTTP handlers with a real operator
        // AuthUser and real membership rows: the same 404 the read gives is what
        // every writer's incident predicate gives.
        let state = crate::state::AppState::new(
            crate::config::Config::from_env(),
            pool.clone(),
            b"b14-repro-cursor".to_vec(),
        )
        .unwrap();
        let (status, body) = post_as_operator(
            state.clone(),
            operator,
            incident_id,
            "/evidence",
            json!({
                "kind": "OPERATOR_NOTE",
                "source": "operator:b14-repro",
                "collectedAt": Utc::now().to_rfc3339(),
                "contentRef": "note:b14-repro"
            }),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "REPRODUCED: the operator cannot append evidence to the automation incident: {body}"
        );
        let (status, body) = post_as_operator(
            state.clone(),
            operator,
            incident_id,
            "/verdict",
            json!({
                "verdict": "CONFIRMED",
                "rationale": "the automation evidence is enough to confirm this"
            }),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "REPRODUCED: the operator cannot sign a human verdict on the automation incident: {body}"
        );

        let admin_scope = crate::scope::DataScope::for_test(
            admin,
            vec![workspace],
            crate::scope::RowRule::for_role(opsweave_contracts::Role::Admin),
        );
        assert!(
            crate::incidents::query_incident(&pool, admin_scope, incident_id)
                .await
                .is_ok(),
            "the workspace admin can read it, which is why the defect is invisible in an admin-only smoke test"
        );

        let _ = sqlx::query("DELETE FROM kernel.automation_jobs WHERE source_id=$1")
            .bind(source_id)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM kernel.telemetry_events WHERE source_id=$1")
            .bind(source_id)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM kernel.incidents WHERE source_id=$1")
            .bind(source_id)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM kernel.automation_principals WHERE source_id=$1")
            .bind(source_id)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM kernel.telemetry_sources WHERE source_id=$1")
            .bind(source_id)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM kernel.users WHERE id=ANY($1)")
            .bind(&[operator, admin][..])
            .execute(&pool)
            .await;
    }

    /// A real source + principal fixture, with the actor's claims bound to the
    /// same workspace/source the Event names. Returns (workspace, source, actor).
    async fn seed_event_fixture(pool: &PgPool) -> (Uuid, Uuid, AutomationPrincipal) {
        seed_event_fixture_in(pool, crate::scope::legacy_workspace()).await
    }

    async fn seed_event_fixture_in(
        pool: &PgPool,
        workspace: Uuid,
    ) -> (Uuid, Uuid, AutomationPrincipal) {
        let source_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.telemetry_sources
                 (source_id,workspace_id,plugin_id,secret_ref,endpoint,tls_policy,state)
             VALUES ($1,$2,'zabbix-source','secretref:zabbix/concurrency','https://zabbix.example/api_jsonrpc.php','VERIFY','READY')",
        )
        .bind(source_id)
        .bind(workspace)
        .execute(pool)
        .await
        .unwrap();
        let mut actor = principal();
        actor.row.workspace_id = workspace;
        actor.row.source_id = source_id;
        actor.claims.workspace_id = workspace;
        actor.claims.source_id = source_id;
        sqlx::query(
            "INSERT INTO kernel.automation_principals
                 (principal_id,plugin_id,instance_id,node_id,node_generation,workspace_id,source_id,
                  allowed_ops,event_id,incident_id,budget,issued_at,expires_at,jti)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
        )
        .bind(actor.row.principal_id)
        .bind(&actor.row.plugin_id)
        .bind(actor.row.instance_id)
        .bind(actor.row.node_id)
        .bind(actor.row.node_generation)
        .bind(actor.row.workspace_id)
        .bind(actor.row.source_id)
        .bind(&actor.row.allowed_ops)
        .bind(actor.row.event_id)
        .bind(actor.row.incident_id)
        .bind(&actor.row.budget)
        .bind(actor.row.issued_at)
        .bind(actor.row.expires_at)
        .bind(actor.row.jti)
        .execute(pool)
        .await
        .unwrap();
        (workspace, source_id, actor)
    }

    async fn cleanup_event_fixture(pool: &PgPool, source: Uuid, incident_ids: &[Uuid]) {
        for incident in incident_ids {
            let _ = sqlx::query(
                "DELETE FROM kernel.audit_events WHERE subject_type='INCIDENT' AND subject_id=$1",
            )
            .bind(incident.to_string())
            .execute(pool)
            .await;
        }
        let _ = sqlx::query("DELETE FROM kernel.automation_jobs WHERE source_id=$1")
            .bind(source)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM kernel.telemetry_events WHERE source_id=$1")
            .bind(source)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM kernel.incidents WHERE source_id=$1")
            .bind(source)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM kernel.automation_principals WHERE source_id=$1")
            .bind(source)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM kernel.telemetry_sources WHERE source_id=$1")
            .bind(source)
            .execute(pool)
            .await;
    }

    fn event_request(
        workspace: Uuid,
        source: Uuid,
        native: &str,
        at: DateTime<Utc>,
    ) -> EventRequest {
        let mut req = request();
        req.workspace_id = workspace;
        req.source_id = source;
        req.native_id = native.to_string();
        req.occurred_at = at;
        req.observed_at = at;
        req.payload_digest = digest(&req.payload);
        req
    }

    /// The pre-fix writer shape, reproduced: two transactions both read "no
    /// active incident" and both INSERT without ON CONFLICT. The partial unique
    /// index refuses the loser with SQLSTATE 23505, which the handler's `?`
    /// maps through `From<sqlx::Error>` to INTERNAL (500). The fix below turns
    /// that same conflict into "attach to the winner".
    #[tokio::test]
    async fn the_pre_fix_insert_shape_gives_the_loser_a_raw_unique_violation() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let (workspace, source, actor) = seed_event_fixture(&pool).await;
        let native = format!("pre-fix-native-{}", Uuid::new_v4());
        let service = Uuid::parse_str(crate::automation::AUTOMATION_USER_ID).unwrap();
        let mut first = pool.begin().await.unwrap();
        let mut second = pool.begin().await.unwrap();
        for tx in [&mut first, &mut second] {
            let active: Option<Uuid> = sqlx::query_scalar(
                "SELECT incident_id FROM kernel.incidents
                  WHERE workspace_id=$1 AND source_id=$2 AND native_id=$3
                    AND status IN ('OPEN','INVESTIGATING','CONCLUDED')",
            )
            .bind(workspace)
            .bind(source)
            .bind(&native)
            .fetch_optional(&mut **tx)
            .await
            .unwrap();
            assert!(
                active.is_none(),
                "both readers start from no active incident"
            );
        }
        sqlx::query(
            "INSERT INTO kernel.incidents
               (incident_id,title,severity,status,source,native_id,started_at,owner,workspace_id,source_id,origin)
             VALUES ($1,'pre-fix first','MAJOR','OPEN','ZABBIX',$2,now(),$3,$4,$5,'AUTOMATION')",
        )
        .bind(Uuid::new_v4())
        .bind(&native)
        .bind(service)
        .bind(workspace)
        .bind(source)
        .execute(&mut *first)
        .await
        .unwrap();
        // The winner commits, as the real race does; the loser's INSERT then
        // conflicts with the committed row.
        first.commit().await.unwrap();
        let error = sqlx::query(
            "INSERT INTO kernel.incidents
               (incident_id,title,severity,status,source,native_id,started_at,owner,workspace_id,source_id,origin)
             VALUES ($1,'pre-fix second','MAJOR','OPEN','ZABBIX',$2,now(),$3,$4,$5,'AUTOMATION')",
        )
        .bind(Uuid::new_v4())
        .bind(&native)
        .bind(service)
        .bind(workspace)
        .bind(source)
        .execute(&mut *second)
        .await
        .unwrap_err();
        match error {
            sqlx::Error::Database(database) => {
                assert_eq!(
                    database.code().as_deref(),
                    Some("23505"),
                    "the loser hits the active-incident unique index"
                );
            }
            other => panic!("expected a unique violation, got {other:?}"),
        }
        second.rollback().await.unwrap();
        let _ = actor;
        let incident: Uuid = sqlx::query_scalar(
            "SELECT incident_id FROM kernel.incidents WHERE source_id=$1 AND native_id=$2",
        )
        .bind(source)
        .bind(&native)
        .fetch_one(&pool)
        .await
        .unwrap();
        cleanup_event_fixture(&pool, source, &[incident]).await;
    }

    /// 64 different Event keys for one nativeId, all at once. Every Event is
    /// legitimate (a distinct state change/time), so none may be dropped and
    /// none may answer with a raw unique-constraint error: exactly one Incident
    /// is created and every Event is attached to it.
    #[tokio::test]
    async fn concurrent_distinct_event_keys_create_one_incident_and_keep_every_event() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let (workspace, source, actor) = seed_event_fixture(&pool).await;
        let native = format!("concurrent-native-{}", Uuid::new_v4());
        let base = Utc::now() - chrono::Duration::seconds(120);
        let mut tasks = Vec::new();
        for index in 0..64 {
            let pool = pool.clone();
            let actor = actor.clone();
            let native = native.clone();
            tasks.push(tokio::spawn(async move {
                let req = event_request(
                    workspace,
                    source,
                    &native,
                    base + chrono::Duration::seconds(index),
                );
                let key = idempotency_key(&req);
                store_event(&pool, &actor, &req, &key).await.map(|_| ())
            }));
        }
        let mut incident_ids = std::collections::HashSet::new();
        for task in tasks {
            let outcome = task.await.unwrap();
            match outcome {
                Ok(()) => {}
                Err(error) => panic!("an Event was refused: {error:?}"),
            }
        }
        let incidents: Vec<Uuid> = sqlx::query_scalar(
            "SELECT incident_id FROM kernel.incidents WHERE source_id=$1 AND native_id=$2",
        )
        .bind(source)
        .bind(&native)
        .fetch_all(&pool)
        .await
        .unwrap();
        incident_ids.extend(incidents.iter().copied());
        assert_eq!(incidents.len(), 1, "one nativeId, one active incident");
        let events: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.telemetry_events WHERE source_id=$1 AND native_id=$2",
        )
        .bind(source)
        .bind(&native)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(events, 64, "no legitimate Event was dropped");
        let jobs: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.automation_jobs WHERE source_id=$1 AND incident_id=$2",
        )
        .bind(source)
        .bind(incidents[0])
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(jobs, 64, "each accepted PROBLEM Event has one durable job");

        cleanup_event_fixture(&pool, source, &incidents).await;
    }

    /// 16 requests with the SAME Idempotency-Key: one Event, one Incident, one
    /// Job, and every retry is answered with the winner's identifiers.
    #[tokio::test]
    async fn concurrent_same_key_retries_answer_with_one_event() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let (workspace, source, actor) = seed_event_fixture(&pool).await;
        let native = format!("same-key-native-{}", Uuid::new_v4());
        let req = event_request(workspace, source, &native, Utc::now());
        let key = idempotency_key(&req);
        let mut tasks = Vec::new();
        for _ in 0..16 {
            let pool = pool.clone();
            let actor = actor.clone();
            let req = EventRequest {
                native_id: req.native_id.clone(),
                source_id: req.source_id,
                workspace_id: req.workspace_id,
                occurred_at: req.occurred_at,
                observed_at: req.observed_at,
                severity: req.severity.clone(),
                trigger_state: req.trigger_state.clone(),
                payload_digest: req.payload_digest.clone(),
                payload: req.payload.clone(),
            };
            let key = key.clone();
            tasks.push(tokio::spawn(async move {
                store_event(&pool, &actor, &req, &key)
                    .await
                    .map(|(status, view)| {
                        (status, view.event_id, view.incident_id, view.deduplicated)
                    })
            }));
        }
        let mut event_ids = std::collections::HashSet::new();
        let mut incident_id = None;
        let mut accepted = 0;
        for task in tasks {
            let (status, event, incident, deduplicated) = task.await.unwrap().unwrap();
            if status == StatusCode::ACCEPTED {
                accepted += 1;
                assert!(!deduplicated);
            } else {
                assert!(deduplicated, "a retry must say it is a duplicate");
            }
            event_ids.insert(event);
            if let Some(incident) = incident {
                incident_id = Some(incident);
            }
        }
        assert_eq!(accepted, 1, "one request created the Event");
        assert_eq!(event_ids.len(), 1, "one Event id for one key");
        let incident = incident_id.expect("the winner created an incident");
        let events: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.telemetry_events WHERE source_id=$1 AND idempotency_key=$2",
        )
        .bind(source)
        .bind(&key)
        .fetch_one(&pool)
        .await
        .unwrap();
        let jobs: i64 =
            sqlx::query_scalar("SELECT count(*) FROM kernel.automation_jobs WHERE incident_id=$1")
                .bind(incident)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(events, 1);
        assert_eq!(jobs, 1);

        cleanup_event_fixture(&pool, source, &[incident]).await;
    }

    /// RESOLVED before PROBLEM: the RESOLVED Event has no incident to name, and
    /// the later PROBLEM creates the incident without rewriting history.
    #[tokio::test]
    async fn resolved_before_problem_leaves_the_resolved_event_unlinked() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let (workspace, source, actor) = seed_event_fixture(&pool).await;
        let native = format!("out-of-order-{}", Uuid::new_v4());
        let mut resolved = event_request(workspace, source, &native, Utc::now());
        resolved.trigger_state = "RESOLVED".into();
        let resolved_key = idempotency_key(&resolved);
        let (_, resolved_view) = store_event(&pool, &actor, &resolved, &resolved_key)
            .await
            .unwrap();
        assert!(resolved_view.incident_id.is_none());

        let problem = event_request(
            workspace,
            source,
            &native,
            Utc::now() + chrono::Duration::seconds(1),
        );
        let problem_key = idempotency_key(&problem);
        let (_, problem_view) = store_event(&pool, &actor, &problem, &problem_key)
            .await
            .unwrap();
        let incident = problem_view
            .incident_id
            .expect("PROBLEM creates the incident");

        let stored_resolved: Option<Uuid> =
            sqlx::query_scalar("SELECT incident_id FROM kernel.telemetry_events WHERE event_id=$1")
                .bind(resolved_view.event_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(
            stored_resolved.is_none(),
            "the out-of-order RESOLVED Event is not retroactively attached"
        );

        cleanup_event_fixture(&pool, source, &[incident]).await;
    }

    /// A new PROBLEM after a CLOSED incident is a recurrence row, not a second
    /// active row and not a refusal.
    #[tokio::test]
    async fn a_new_problem_after_a_closed_incident_is_a_recurrence() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let (workspace, source, actor) = seed_event_fixture(&pool).await;
        let native = format!("recurrence-{}", Uuid::new_v4());
        let first = event_request(workspace, source, &native, Utc::now());
        let (_, first_view) = store_event(&pool, &actor, &first, &idempotency_key(&first))
            .await
            .unwrap();
        let first_incident = first_view.incident_id.unwrap();
        let service = Uuid::parse_str(crate::automation::AUTOMATION_USER_ID).unwrap();
        sqlx::query(
            "INSERT INTO kernel.incident_verdicts (incident_id,verdict,rationale,decided_by)
             VALUES ($1,'CONFIRMED','fixture conclusion before closure',$2)",
        )
        .bind(first_incident)
        .bind(service)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("UPDATE kernel.incidents SET status='CONCLUDED' WHERE incident_id=$1")
            .bind(first_incident)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE kernel.incidents
                SET status='CLOSED', closed_at=now(), closed_by=$2,
                    closure_note='fixture closure before recurrence', revision=revision+1
              WHERE incident_id=$1",
        )
        .bind(first_incident)
        .bind(service)
        .execute(&pool)
        .await
        .unwrap();

        let second = event_request(
            workspace,
            source,
            &native,
            Utc::now() + chrono::Duration::seconds(2),
        );
        let (_, second_view) = store_event(&pool, &actor, &second, &idempotency_key(&second))
            .await
            .unwrap();
        let second_incident = second_view
            .incident_id
            .expect("the recurrence is a new row");
        assert_ne!(second_incident, first_incident);
        let recurrence: Option<Uuid> =
            sqlx::query_scalar("SELECT recurrence_of FROM kernel.incidents WHERE incident_id=$1")
                .bind(second_incident)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(recurrence, Some(first_incident));
        let active: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incidents
              WHERE source_id=$1 AND native_id=$2 AND status IN ('OPEN','INVESTIGATING')",
        )
        .bind(source)
        .bind(&native)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(active, 1);

        cleanup_event_fixture(&pool, source, &[first_incident, second_incident]).await;
    }

    /// The same nativeId in two workspaces and in two sources is four different
    /// incidents; nothing merges across either boundary.
    #[tokio::test]
    async fn native_id_identity_is_scoped_by_workspace_and_source() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let workspace_a = crate::scope::legacy_workspace();
        let workspace_b = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.business_workspaces (workspace_id,key,name)
             VALUES ($1,$2,'concurrency workspace B')",
        )
        .bind(workspace_b)
        .bind(format!("concurrency-b-{workspace_b}"))
        .execute(&pool)
        .await
        .unwrap();
        let (_, source_a, actor_a) = seed_event_fixture_in(&pool, workspace_a).await;
        let (_, source_b, actor_b) = seed_event_fixture_in(&pool, workspace_b).await;
        let (_, source_c, actor_c) = seed_event_fixture_in(&pool, workspace_a).await;
        let native = format!("scoped-native-{}", Uuid::new_v4());
        let mut incidents = Vec::new();
        for (workspace, source, actor) in [
            (workspace_a, source_a, &actor_a),
            (workspace_b, source_b, &actor_b),
            // Same workspace, different source.
            (workspace_a, source_c, &actor_c),
        ] {
            let req = event_request(workspace, source, &native, Utc::now());
            let (_, view) = store_event(&pool, actor, &req, &idempotency_key(&req))
                .await
                .unwrap();
            incidents.push(
                view.incident_id
                    .expect("each scope creates its own incident"),
            );
        }
        assert_eq!(
            incidents
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            3
        );
        let scoped: i64 =
            sqlx::query_scalar("SELECT count(*) FROM kernel.incidents WHERE native_id=$1")
                .bind(&native)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(scoped, 3);

        cleanup_event_fixture(&pool, source_a, &incidents).await;
        cleanup_event_fixture(&pool, source_b, &[]).await;
        cleanup_event_fixture(&pool, source_c, &[]).await;
        let _ = sqlx::query("DELETE FROM kernel.business_workspaces WHERE workspace_id=$1")
            .bind(workspace_b)
            .execute(&pool)
            .await;
    }

    fn request() -> EventRequest {
        EventRequest {
            native_id: "evt-1".into(),
            source_id: Uuid::new_v4(),
            workspace_id: Uuid::new_v4(),
            occurred_at: Utc::now(),
            observed_at: Utc::now(),
            severity: "MAJOR".into(),
            trigger_state: "PROBLEM".into(),
            payload_digest: String::new(),
            payload: json!({"trigger": "CPU high", "host": "web-1"}),
        }
    }

    #[test]
    fn idempotency_key_is_stable_and_field_bound() {
        let mut req = request();
        let key = idempotency_key(&req);
        assert_eq!(key, idempotency_key(&req));
        req.native_id = "evt-2".into();
        assert_ne!(key, idempotency_key(&req));
    }

    #[test]
    fn digest_must_match_canonical_payload() {
        let mut req = request();
        let digest = format!(
            "sha256:{}",
            hex::encode(Sha256::digest(opsweave_contracts::canonical_json(
                &req.payload
            )))
        );
        req.payload_digest = digest.clone();
        assert!(validate(&req).is_ok());
        req.payload = json!({"trigger": "CPU low"});
        let error = validate(&req).unwrap_err();
        assert_eq!(error.code, "EVENT_DIGEST_MISMATCH");
    }

    async fn seed_claim_user(pool: &PgPool, role: &str) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.users (id,email,display_name,password_hash,role)
             VALUES ($1,$2,$3,'not-a-real-hash',$4)",
        )
        .bind(id)
        .bind(format!("b14-{id}@example.invalid"))
        .bind(format!("b14 {role}"))
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn post_as_operator(
        state: crate::state::AppState,
        user: Uuid,
        incident_id: Uuid,
        suffix: &str,
        body: Value,
    ) -> (StatusCode, String) {
        use axum::body::Body;
        use axum::http::Request;
        use axum::routing::post;
        use tower::ServiceExt;

        let router = axum::Router::new()
            .route(
                "/api/v1/incidents/{incident_id}/evidence",
                post(crate::incidents::append_evidence),
            )
            .route(
                "/api/v1/incidents/{incident_id}/verdict",
                post(crate::incidents::create_verdict),
            )
            .layer(axum::middleware::from_fn(
                move |mut request: axum::extract::Request, next: axum::middleware::Next| async move {
                    request.extensions_mut().insert(crate::auth::AuthUser {
                        user_id: user,
                        email: format!("{user}@example.invalid"),
                        display_name: "b14 operator".into(),
                        role: opsweave_contracts::Role::Operator,
                        session_id: Uuid::new_v4(),
                        csrf_token: "csrf".into(),
                        via_cookie: true,
                    });
                    next.run(request).await
                },
            ))
            .with_state(state);
        let response = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/v1/incidents/{incident_id}{suffix}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&bytes).to_string())
    }
}
