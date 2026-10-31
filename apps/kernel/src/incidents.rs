//! G11 business slice: Incident -> Evidence -> Human Verdict.
//!
//! Authority, field minimality, the state machine, the permission matrix and the
//! concurrency rules are argued in docs/design/g11-incident/incident-adr.md; the
//! wire format is contracts/openapi/incident-v1.yaml. This module implements
//! those two documents and nothing else.
//!
//! Permission gates reuse the existing AuthUser::require_operator primitive.
//! The visibility predicate deliberately copies the job list predicate
//! (jobs.rs:1883): admin and viewer read everything, an operator reads only what
//! it owns.

use crate::audit;
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

const SEVERITIES: &[&str] = &["CRITICAL", "MAJOR", "MINOR", "WARNING"];
const STATUSES: &[&str] = &["OPEN", "INVESTIGATING", "CONCLUDED", "CLOSED"];
const SOURCES: &[&str] = &["MANUAL", "API"];
const EVIDENCE_KINDS: &[&str] = &[
    "METRIC_SNAPSHOT",
    "LOG_EXCERPT",
    "QUERY_RESULT",
    "OPERATOR_NOTE",
];
const EVIDENCE_TRUSTS: &[&str] = &["SOURCE_ATTESTED", "OPERATOR_ASSERTED", "UNVERIFIED"];
const VERDICT_VALUES: &[&str] = &["CONFIRMED", "REFUTED", "INCONCLUSIVE"];

/// Who is asking, reduced to the two facts the SQL layer needs.
///
/// sees_all is the verbatim job-list predicate, expressed once so the two
/// resources cannot drift apart. This is data scoping, not a permission gate:
/// every write endpoint still calls AuthUser::require_operator() first.
#[derive(Debug, Clone, Copy)]
struct Caller {
    user_id: Uuid,
    sees_all: bool,
}

impl Caller {
    fn from_auth(auth: &AuthUser) -> Self {
        Self {
            user_id: auth.user_id,
            sees_all: auth.role.is_admin() || !auth.role.can_operate(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateIncidentRequest {
    pub title: String,
    pub severity: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub native_id: Option<String>,
    #[serde(default)]
    pub related_entity: Option<String>,
    pub started_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateEvidenceRequest {
    pub kind: String,
    pub source: String,
    pub collected_at: DateTime<Utc>,
    pub content_ref: String,
    pub trust: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateVerdictRequest {
    pub verdict: String,
    pub rationale: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncidentListQuery {
    pub status: Option<String>,
    pub severity: Option<String>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncidentList {
    pub items: Vec<IncidentView>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceList {
    pub items: Vec<EvidenceView>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncidentView {
    pub id: Uuid,
    pub title: String,
    pub severity: String,
    pub status: String,
    pub source: String,
    pub native_id: Option<String>,
    pub related_entity: Option<String>,
    pub started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub owner: Uuid,
    /// Derived at read time from kernel.incident_evidence; never a column, so it
    /// can never disagree with the evidence rows it names.
    pub evidence_refs: Vec<Uuid>,
    /// Derived at read time from kernel.incident_verdicts.
    pub human_verdict: Option<VerdictView>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct VerdictView {
    pub incident_id: Uuid,
    pub verdict: String,
    pub rationale: String,
    pub decided_by: Uuid,
    pub decided_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceView {
    #[serde(rename = "id")]
    pub evidence_id: Uuid,
    pub incident_id: Uuid,
    pub kind: String,
    pub source: String,
    pub collected_at: DateTime<Utc>,
    pub content_ref: String,
    pub trust: String,
}

#[derive(Debug, Clone, FromRow)]
struct IncidentRow {
    incident_id: Uuid,
    title: String,
    severity: String,
    status: String,
    source: String,
    native_id: Option<String>,
    related_entity: Option<String>,
    started_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    owner: Uuid,
    evidence_refs: sqlx::types::Json<Vec<Uuid>>,
    verdict_value: Option<String>,
    verdict_rationale: Option<String>,
    verdict_decided_by: Option<Uuid>,
    verdict_decided_at: Option<DateTime<Utc>>,
}

impl IncidentRow {
    fn into_view(self) -> IncidentView {
        let human_verdict = match (
            self.verdict_value,
            self.verdict_rationale,
            self.verdict_decided_by,
            self.verdict_decided_at,
        ) {
            (Some(verdict), Some(rationale), Some(decided_by), Some(decided_at)) => {
                Some(VerdictView {
                    incident_id: self.incident_id,
                    verdict,
                    rationale,
                    decided_by,
                    decided_at,
                })
            }
            // No verdict row, or a partially readable one: report absence rather
            // than inventing a conclusion.
            _ => None,
        };
        IncidentView {
            id: self.incident_id,
            title: self.title,
            severity: self.severity,
            status: self.status,
            source: self.source,
            native_id: self.native_id,
            related_entity: self.related_entity,
            started_at: self.started_at,
            updated_at: self.updated_at,
            owner: self.owner,
            evidence_refs: self.evidence_refs.0,
            human_verdict,
        }
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub async fn create_incident(
    State(state): State<AppState>,
    auth: AuthUser,
    body: Bytes,
) -> AppResult<(StatusCode, Json<IncidentView>)> {
    auth.require_operator()?;
    let payload: CreateIncidentRequest = parse_json(body)?;
    let caller = Caller::from_auth(&auth);
    let (created, incident) = insert_incident(&state.db, caller, payload).await?;
    if created {
        audit::record(
            &state.db,
            "INCIDENT_CREATED",
            "USER",
            &auth.user_id.to_string(),
            "INCIDENT",
            &incident.id.to_string(),
            "CREATE",
            "ACCEPTED",
            serde_json::json!({
                "severity": incident.severity,
                "source": incident.source,
                "nativeId": incident.native_id,
            }),
            None,
        )
        .await?;
    }
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(incident)))
}

pub async fn list_incidents(
    State(state): State<AppState>,
    auth: AuthUser,
    Query(query): Query<IncidentListQuery>,
) -> AppResult<Json<IncidentList>> {
    let caller = Caller::from_auth(&auth);
    let (items, next_cursor) = query_incidents(&state.db, caller, query).await?;
    Ok(Json(IncidentList { items, next_cursor }))
}

pub async fn get_incident(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(incident_id): Path<Uuid>,
) -> AppResult<Json<IncidentView>> {
    let caller = Caller::from_auth(&auth);
    Ok(Json(query_incident(&state.db, caller, incident_id).await?))
}

pub async fn append_evidence(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(incident_id): Path<Uuid>,
    body: Bytes,
) -> AppResult<(StatusCode, Json<EvidenceView>)> {
    auth.require_operator()?;
    let payload: CreateEvidenceRequest = parse_json(body)?;
    let caller = Caller::from_auth(&auth);
    let (created, evidence) = insert_evidence(&state.db, caller, incident_id, payload).await?;
    if created {
        audit::record(
            &state.db,
            "INCIDENT_EVIDENCE_ADDED",
            "USER",
            &auth.user_id.to_string(),
            "INCIDENT",
            &incident_id.to_string(),
            "ADD_EVIDENCE",
            "ACCEPTED",
            serde_json::json!({
                "evidenceId": evidence.evidence_id,
                "kind": evidence.kind,
                "trust": evidence.trust,
            }),
            None,
        )
        .await?;
    }
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(evidence)))
}

pub async fn list_evidence(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(incident_id): Path<Uuid>,
) -> AppResult<Json<EvidenceList>> {
    let caller = Caller::from_auth(&auth);
    let items = query_evidence(&state.db, caller, incident_id).await?;
    Ok(Json(EvidenceList { items }))
}

pub async fn create_verdict(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(incident_id): Path<Uuid>,
    body: Bytes,
) -> AppResult<(StatusCode, Json<VerdictView>)> {
    auth.require_operator()?;
    let payload: CreateVerdictRequest = parse_json(body)?;
    let caller = Caller::from_auth(&auth);
    let verdict = insert_verdict(&state.db, caller, incident_id, payload).await?;
    audit::record(
        &state.db,
        "INCIDENT_VERDICT_RECORDED",
        "USER",
        &auth.user_id.to_string(),
        "INCIDENT",
        &incident_id.to_string(),
        "RECORD_VERDICT",
        "ACCEPTED",
        serde_json::json!({ "verdict": verdict.verdict }),
        None,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(verdict)))
}

pub async fn get_verdict(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(incident_id): Path<Uuid>,
) -> AppResult<Json<VerdictView>> {
    let caller = Caller::from_auth(&auth);
    Ok(Json(query_verdict(&state.db, caller, incident_id).await?))
}

// ---------------------------------------------------------------------------
// Data operations
//
// Split out from the handlers so the DB-level contract (idempotency, scope,
// state transitions) is unit-testable without an HTTP surface; the handlers add
// only the permission gate, JSON parsing and the audit record.
// ---------------------------------------------------------------------------

async fn insert_incident(
    db: &PgPool,
    caller: Caller,
    payload: CreateIncidentRequest,
) -> AppResult<(bool, IncidentView)> {
    let title = bounded(&payload.title, "title", 4, 200)?;
    let severity = closed_set(&payload.severity, SEVERITIES, "severity")?;
    let source = match payload.source.as_deref() {
        Some(value) => closed_set(value, SOURCES, "source")?,
        None => "MANUAL".to_string(),
    };
    let native_id = optional_bounded(payload.native_id.as_deref(), "nativeId", 200)?;
    let related_entity =
        match optional_bounded(payload.related_entity.as_deref(), "relatedEntity", 200)? {
            Some(value) if value.chars().count() < 3 => {
                return Err(AppError::bad_request(
                    "relatedEntity must be between 3 and 200 characters",
                ))
            }
            other => other,
        };

    let incident_id = Uuid::new_v4();
    let created: Option<Uuid> = sqlx::query_scalar(
        r#"
        INSERT INTO kernel.incidents
          (incident_id,title,severity,status,source,native_id,related_entity,
           started_at,owner)
        VALUES ($1,$2,$3,'OPEN',$4,$5,$6,$7,$8)
        ON CONFLICT DO NOTHING
        RETURNING incident_id
        "#,
    )
    .bind(incident_id)
    .bind(&title)
    .bind(&severity)
    .bind(&source)
    .bind(native_id.as_deref())
    .bind(related_entity.as_deref())
    .bind(payload.started_at)
    .bind(caller.user_id)
    .fetch_optional(db)
    .await?;

    match created {
        Some(id) => Ok((true, query_incident(db, caller, id).await?)),
        None => {
            // A conflicting insert can only mean the natural key already exists.
            // Re-read it instead of telling the caller to retry: a replay must be
            // answered, not rejected.
            let existing: Option<Uuid> = sqlx::query_scalar(
                "SELECT incident_id FROM kernel.incidents WHERE source=$1 AND native_id=$2",
            )
            .bind(&source)
            .bind(native_id.as_deref())
            .fetch_optional(db)
            .await?;
            let Some(existing) = existing else {
                return Err(AppError::conflict(
                    "INCIDENT_WRITE_CONFLICT",
                    "a concurrent write changed this incident set; retry the request",
                ));
            };
            Ok((false, query_incident(db, caller, existing).await?))
        }
    }
}

async fn query_incidents(
    db: &PgPool,
    caller: Caller,
    query: IncidentListQuery,
) -> AppResult<(Vec<IncidentView>, Option<String>)> {
    let limit = i64::from(query.limit.unwrap_or(20).clamp(1, 100));
    let status = match query.status.as_deref() {
        Some(value) => Some(closed_set(value, STATUSES, "status filter")?),
        None => None,
    };
    let severity = match query.severity.as_deref() {
        Some(value) => Some(closed_set(value, SEVERITIES, "severity filter")?),
        None => None,
    };
    let (cursor_time, cursor_id) = match query.cursor.as_deref() {
        Some(value) => {
            let (time, id) = decode_cursor(value)?;
            (Some(time), Some(id))
        }
        None => (None, None),
    };
    let sql = format!(
        "{INCIDENT_SELECT}
         WHERE ($1::boolean OR i.owner=$2)
           AND ($3::text IS NULL OR i.status=$3)
           AND ($4::text IS NULL OR i.severity=$4)
           AND ($5::timestamptz IS NULL OR (i.started_at,i.incident_id) < ($5,$6::uuid))
         ORDER BY i.started_at DESC, i.incident_id DESC
         LIMIT $7"
    );
    let rows = sqlx::query_as::<_, IncidentRow>(&sql)
        .bind(caller.sees_all)
        .bind(caller.user_id)
        .bind(status.as_deref())
        .bind(severity.as_deref())
        .bind(cursor_time)
        .bind(cursor_id)
        .bind(limit + 1)
        .fetch_all(db)
        .await?;
    let has_more = rows.len() as i64 > limit;
    let visible = if has_more {
        &rows[..rows.len() - 1]
    } else {
        &rows[..]
    };
    let next_cursor = if has_more {
        visible.last().map(encode_cursor)
    } else {
        None
    };
    let items: Vec<IncidentView> = visible
        .iter()
        .cloned()
        .map(IncidentRow::into_view)
        .collect();
    Ok((items, next_cursor))
}

async fn query_incident(db: &PgPool, caller: Caller, incident_id: Uuid) -> AppResult<IncidentView> {
    let sql = format!("{INCIDENT_SELECT} WHERE i.incident_id=$3 AND ($1::boolean OR i.owner=$2)");
    let row = sqlx::query_as::<_, IncidentRow>(&sql)
        .bind(caller.sees_all)
        .bind(caller.user_id)
        .bind(incident_id)
        .fetch_optional(db)
        .await?;
    row.map(IncidentRow::into_view)
        .ok_or_else(incident_not_found)
}

async fn insert_evidence(
    db: &PgPool,
    caller: Caller,
    incident_id: Uuid,
    payload: CreateEvidenceRequest,
) -> AppResult<(bool, EvidenceView)> {
    let kind = closed_set(&payload.kind, EVIDENCE_KINDS, "kind")?;
    let source = bounded(&payload.source, "source", 2, 200)?;
    let content_ref = bounded(&payload.content_ref, "contentRef", 2, 1000)?;
    let trust = closed_set(&payload.trust, EVIDENCE_TRUSTS, "trust")?;

    let status = incident_status(db, caller, incident_id).await?;
    if status == "CLOSED" {
        return Err(AppError::conflict(
            "INCIDENT_CLOSED",
            "this incident is closed and accepts no new evidence",
        ));
    }

    let evidence_id = Uuid::new_v4();
    let inserted = sqlx::query_as::<_, EvidenceView>(
        r#"
        INSERT INTO kernel.incident_evidence
          (evidence_id,incident_id,kind,source,collected_at,content_ref,trust)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT DO NOTHING
        RETURNING evidence_id,incident_id,kind,source,collected_at,content_ref,trust
        "#,
    )
    .bind(evidence_id)
    .bind(incident_id)
    .bind(&kind)
    .bind(&source)
    .bind(payload.collected_at)
    .bind(&content_ref)
    .bind(&trust)
    .fetch_optional(db)
    .await?;

    let Some(evidence) = inserted else {
        let existing = sqlx::query_as::<_, EvidenceView>(
            r#"
            SELECT evidence_id,incident_id,kind,source,collected_at,content_ref,trust
            FROM kernel.incident_evidence
            WHERE incident_id=$1 AND kind=$2 AND source=$3 AND content_ref=$4
            "#,
        )
        .bind(incident_id)
        .bind(&kind)
        .bind(&source)
        .bind(&content_ref)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| {
            AppError::conflict(
                "INCIDENT_WRITE_CONFLICT",
                "a concurrent write changed this evidence set; retry the request",
            )
        })?;
        return Ok((false, existing));
    };

    // T2: an incident becomes INVESTIGATING when the first evidence lands. A
    // conditional UPDATE keeps this a compare-and-set: a concurrent verdict that
    // already moved the incident to CONCLUDED is never silently reopened.
    sqlx::query(
        "UPDATE kernel.incidents SET status='INVESTIGATING', updated_at=now()
          WHERE incident_id=$1 AND status='OPEN'",
    )
    .bind(incident_id)
    .execute(db)
    .await?;

    Ok((true, evidence))
}

async fn query_evidence(
    db: &PgPool,
    caller: Caller,
    incident_id: Uuid,
) -> AppResult<Vec<EvidenceView>> {
    incident_status(db, caller, incident_id).await?;
    Ok(sqlx::query_as::<_, EvidenceView>(
        r#"
        SELECT evidence_id,incident_id,kind,source,collected_at,content_ref,trust
        FROM kernel.incident_evidence
        WHERE incident_id=$1
        ORDER BY collected_at DESC, evidence_id DESC
        "#,
    )
    .bind(incident_id)
    .fetch_all(db)
    .await?)
}

async fn insert_verdict(
    db: &PgPool,
    caller: Caller,
    incident_id: Uuid,
    payload: CreateVerdictRequest,
) -> AppResult<VerdictView> {
    let verdict = closed_set(&payload.verdict, VERDICT_VALUES, "verdict")?;
    let rationale = bounded(&payload.rationale, "rationale", 10, 4000)?;
    let requires_evidence = verdict != "INCONCLUSIVE";

    // One transaction, and the incident row is locked first: two operators
    // concluding at the same instant are serialized, so the second one sees the
    // first verdict and gets 409 instead of overwriting signed history.
    let mut tx = db.begin().await?;
    let status: Option<String> = sqlx::query_scalar(
        "SELECT status FROM kernel.incidents
          WHERE incident_id=$1 AND ($2::boolean OR owner=$3) FOR UPDATE",
    )
    .bind(incident_id)
    .bind(caller.sees_all)
    .bind(caller.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(status) = status else {
        return Err(incident_not_found());
    };
    if status == "CLOSED" {
        return Err(AppError::conflict(
            "INCIDENT_CLOSED",
            "this incident is closed and accepts no verdict",
        ));
    }
    let concluded: Option<Uuid> =
        sqlx::query_scalar("SELECT incident_id FROM kernel.incident_verdicts WHERE incident_id=$1")
            .bind(incident_id)
            .fetch_optional(&mut *tx)
            .await?;
    if concluded.is_some() {
        return Err(AppError::conflict(
            "INCIDENT_ALREADY_CONCLUDED",
            "this incident already has a human verdict; a verdict is write-once",
        ));
    }
    if requires_evidence {
        let has_evidence: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM kernel.incident_evidence WHERE incident_id=$1)",
        )
        .bind(incident_id)
        .fetch_one(&mut *tx)
        .await?;
        if !has_evidence {
            return Err(AppError::conflict(
                "INCIDENT_EVIDENCE_REQUIRED",
                "CONFIRMED and REFUTED need at least one evidence row; use INCONCLUSIVE when evidence is missing",
            ));
        }
    }
    let view = sqlx::query_as::<_, VerdictView>(
        r#"
        INSERT INTO kernel.incident_verdicts
          (incident_id,verdict,rationale,decided_by)
        VALUES ($1,$2,$3,$4)
        RETURNING incident_id,verdict,rationale,decided_by,decided_at
        "#,
    )
    .bind(incident_id)
    .bind(&verdict)
    .bind(&rationale)
    .bind(caller.user_id)
    .fetch_one(&mut *tx)
    .await?;
    // Compare-and-set on the status too: if anything moved the incident out of a
    // concludable state, the verdict rolls back rather than being left attached
    // to an inconsistent status.
    let updated = sqlx::query(
        "UPDATE kernel.incidents SET status='CONCLUDED', updated_at=now()
          WHERE incident_id=$1 AND status IN ('OPEN','INVESTIGATING')",
    )
    .bind(incident_id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(AppError::conflict(
            "INCIDENT_STATE_CONFLICT",
            "the incident changed state while the verdict was being recorded; reload before retrying",
        ));
    }
    tx.commit().await?;
    Ok(view)
}

async fn query_verdict(db: &PgPool, caller: Caller, incident_id: Uuid) -> AppResult<VerdictView> {
    incident_status(db, caller, incident_id).await?;
    sqlx::query_as::<_, VerdictView>(
        "SELECT incident_id,verdict,rationale,decided_by,decided_at
         FROM kernel.incident_verdicts WHERE incident_id=$1",
    )
    .bind(incident_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| {
        AppError::new(
            StatusCode::NOT_FOUND,
            "INCIDENT_VERDICT_NOT_FOUND",
            "this incident has no human verdict yet",
        )
    })
}

async fn incident_status(db: &PgPool, caller: Caller, incident_id: Uuid) -> AppResult<String> {
    sqlx::query_scalar(
        "SELECT status FROM kernel.incidents
          WHERE incident_id=$1 AND ($2::boolean OR owner=$3)",
    )
    .bind(incident_id)
    .bind(caller.sees_all)
    .bind(caller.user_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(incident_not_found)
}

/// Shared projection: one SELECT shape drives both the list and the detail, so a
/// derived field cannot exist on one and be missing on the other. The evidence
/// refs are capped at the newest 100; the evidence endpoint is the complete list.
const INCIDENT_SELECT: &str = r#"
SELECT i.incident_id, i.title, i.severity, i.status, i.source,
       i.native_id, i.related_entity, i.started_at, i.updated_at, i.owner,
       COALESCE((
         SELECT jsonb_agg(ref.evidence_id ORDER BY ref.collected_at DESC, ref.evidence_id DESC)
         FROM (
           SELECT evidence_id, collected_at
           FROM kernel.incident_evidence
           WHERE incident_id = i.incident_id
           ORDER BY collected_at DESC, evidence_id DESC
           LIMIT 100
         ) ref
       ), '[]'::jsonb) AS evidence_refs,
       v.verdict AS verdict_value,
       v.rationale AS verdict_rationale,
       v.decided_by AS verdict_decided_by,
       v.decided_at AS verdict_decided_at
FROM kernel.incidents i
LEFT JOIN kernel.incident_verdicts v ON v.incident_id = i.incident_id"#;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Parses a request body into the contract type.
///
/// A hand-rolled parse instead of the Json extractor so a malformed body still
/// gets the documented code/message/requestId/retryable envelope instead of the
/// extractor's plain-text rejection: an unexplained 400 is still an inexplicable
/// error.
fn parse_json<T: DeserializeOwned>(body: Bytes) -> AppResult<T> {
    serde_json::from_slice(&body)
        .map_err(|error| AppError::bad_request(format!("invalid request body: {error}")))
}

fn incident_not_found() -> AppError {
    AppError::new(
        StatusCode::NOT_FOUND,
        "INCIDENT_NOT_FOUND",
        "incident not found",
    )
}

/// Trims and bounds a required text field. Length is counted in characters, the
/// same unit PostgreSQL length() uses in the table CHECK constraints.
fn bounded(value: &str, field: &str, min: usize, max: usize) -> AppResult<String> {
    let trimmed = value.trim();
    let length = trimmed.chars().count();
    if length < min || length > max {
        return Err(AppError::bad_request(format!(
            "{field} must be between {min} and {max} characters"
        )));
    }
    Ok(trimmed.to_string())
}

fn optional_bounded(value: Option<&str>, field: &str, max: usize) -> AppResult<Option<String>> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => {
            if value.chars().count() > max {
                return Err(AppError::bad_request(format!(
                    "{field} must be at most {max} characters"
                )));
            }
            Ok(Some(value.to_string()))
        }
        None => Ok(None),
    }
}

/// Rejects any value outside a closed set. The set duplicates the table CHECK
/// constraint on purpose: the database protects the invariant, and this turns a
/// violated invariant into an explainable 400 instead of a 500.
fn closed_set(value: &str, allowed: &[&'static str], field: &str) -> AppResult<String> {
    let normalized = value.trim().to_ascii_uppercase();
    if allowed.contains(&normalized.as_str()) {
        Ok(normalized)
    } else {
        Err(AppError::bad_request(format!(
            "{field} must be one of {}",
            allowed.join(", ")
        )))
    }
}

fn encode_cursor(row: &IncidentRow) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(format!("{}|{}", row.started_at.to_rfc3339(), row.incident_id).as_bytes())
}

fn decode_cursor(cursor: &str) -> AppResult<(DateTime<Utc>, Uuid)> {
    use base64::Engine;
    let invalid = || AppError::bad_request("invalid incident cursor");
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| invalid())?;
    let text = String::from_utf8(raw).map_err(|_| invalid())?;
    let (timestamp, id) = text.split_once('|').ok_or_else(invalid)?;
    let timestamp = DateTime::parse_from_rfc3339(timestamp)
        .map_err(|_| invalid())?
        .with_timezone(&Utc);
    let id = Uuid::parse_str(id).map_err(|_| invalid())?;
    Ok((timestamp, id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::postgres::PgConnectOptions;

    // Same convention as jobs.rs: skipping is reserved for "no database
    // configured and nobody asked for one". With OPSWEAVE_REQUIRE_TEST_DATABASE=1
    // a missing URL fails the run instead of reporting a green test that asserted
    // nothing.
    const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";

    fn database_required() -> bool {
        match std::env::var(REQUIRE_DATABASE_ENV) {
            Err(std::env::VarError::NotPresent) => false,
            Err(std::env::VarError::NotUnicode(_)) => {
                panic!("{REQUIRE_DATABASE_ENV} is set but is not valid UTF-8")
            }
            Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
                "" | "0" | "false" | "no" => false,
                "1" | "true" | "yes" => true,
                other => panic!("{REQUIRE_DATABASE_ENV} is set to {other:?}: use 1 to require the DB-backed tests"),
            },
        }
    }

    async fn test_pool() -> Option<PgPool> {
        let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(std::env::VarError::NotPresent) => {
                if database_required() {
                    panic!(
                        "{REQUIRE_DATABASE_ENV} is set but OPSWEAVE_TEST_DATABASE_URL is unset: \
                         skipping these tests would count as a failure"
                    );
                }
                eprintln!(
                    "skip: OPSWEAVE_TEST_DATABASE_URL is unset and {REQUIRE_DATABASE_ENV} is not 1"
                );
                return None;
            }
            Err(std::env::VarError::NotUnicode(_)) => {
                panic!("OPSWEAVE_TEST_DATABASE_URL is set but is not valid UTF-8")
            }
        };
        let options: PgConnectOptions = url.parse().unwrap_or_else(|error| {
            panic!("OPSWEAVE_TEST_DATABASE_URL is not a PostgreSQL URL: {error}")
        });
        let pool = PgPool::connect_with(options)
            .await
            .unwrap_or_else(|error| panic!("cannot connect to the test database: {error}"));
        crate::db::migrate(&pool)
            .await
            .unwrap_or_else(|error| panic!("the test database rejected the migrations: {error:#}"));
        Some(pool)
    }

    async fn seed_user(pool: &PgPool, role: &str) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.users (id,email,display_name,password_hash,role)
             VALUES ($1,$2,$3,'not-a-real-hash',$4)",
        )
        .bind(id)
        .bind(format!("incident-test-{id}@example.invalid"))
        .bind(format!("incident test {role}"))
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn cleanup(pool: &PgPool, users: &[Uuid]) {
        for user in users {
            let incidents = "SELECT incident_id FROM kernel.incidents WHERE owner=$1";
            let sql =
                format!("DELETE FROM kernel.incident_verdicts WHERE incident_id IN ({incidents})");
            sqlx::query(&sql).bind(user).execute(pool).await.unwrap();
            let sql =
                format!("DELETE FROM kernel.incident_evidence WHERE incident_id IN ({incidents})");
            sqlx::query(&sql).bind(user).execute(pool).await.unwrap();
            sqlx::query("DELETE FROM kernel.incidents WHERE owner=$1")
                .bind(user)
                .execute(pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM kernel.audit_events WHERE actor_id=$1")
                .bind(user.to_string())
                .execute(pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM kernel.users WHERE id=$1")
                .bind(user)
                .execute(pool)
                .await
                .unwrap();
        }
    }

    fn caller(user_id: Uuid) -> Caller {
        Caller {
            user_id,
            sees_all: false,
        }
    }

    fn admin_caller(user_id: Uuid) -> Caller {
        Caller {
            user_id,
            sees_all: true,
        }
    }

    fn incident_request(title: &str, native_id: Option<&str>) -> CreateIncidentRequest {
        CreateIncidentRequest {
            title: title.to_string(),
            severity: "MAJOR".to_string(),
            source: Some("API".to_string()),
            native_id: native_id.map(str::to_string),
            related_entity: Some("host:test-node".to_string()),
            started_at: Utc::now(),
        }
    }

    fn evidence_request(content_ref: &str) -> CreateEvidenceRequest {
        CreateEvidenceRequest {
            kind: "METRIC_SNAPSHOT".to_string(),
            source: "prometheus".to_string(),
            collected_at: Utc::now(),
            content_ref: content_ref.to_string(),
            trust: "SOURCE_ATTESTED".to_string(),
        }
    }

    fn verdict_request(verdict: &str) -> CreateVerdictRequest {
        CreateVerdictRequest {
            verdict: verdict.to_string(),
            rationale: "cpu saturation matches the reported window".to_string(),
        }
    }

    // -- pure validation -----------------------------------------------------

    #[test]
    fn closed_sets_reject_unknown_values_and_normalize_case() {
        assert_eq!(
            closed_set("major", SEVERITIES, "severity").unwrap(),
            "MAJOR"
        );
        assert_eq!(
            closed_set("  INCONCLUSIVE  ", VERDICT_VALUES, "verdict").unwrap(),
            "INCONCLUSIVE"
        );
        let error = closed_set("CRITICAL2", SEVERITIES, "severity").unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert!(error.message.contains("CRITICAL, MAJOR, MINOR, WARNING"));
        // A value the table CHECK would reject must never reach the database.
        assert!(closed_set("ZABBIX", SOURCES, "source").is_err());
        assert!(closed_set("AI_INFERENCE", EVIDENCE_TRUSTS, "trust").is_err());
    }

    #[test]
    fn bounded_counts_characters_not_bytes() {
        // Four CJK characters are twelve bytes: a byte-length check would reject
        // a title the database accepts.
        assert_eq!(
            bounded("  故障已确认  ", "title", 4, 200).unwrap(),
            "故障已确认"
        );
        assert!(bounded("abc", "title", 4, 200).is_err());
        assert!(bounded(&"a".repeat(201), "title", 4, 200).is_err());
        assert_eq!(
            optional_bounded(Some("   "), "nativeId", 200).unwrap(),
            None
        );
        assert!(optional_bounded(Some(&"a".repeat(201)), "nativeId", 200).is_err());
    }

    #[test]
    fn cursor_round_trips_and_rejects_garbage() {
        let row = IncidentRow {
            incident_id: Uuid::new_v4(),
            title: "t".to_string(),
            severity: "MAJOR".to_string(),
            status: "OPEN".to_string(),
            source: "API".to_string(),
            native_id: None,
            related_entity: None,
            started_at: Utc::now(),
            updated_at: Utc::now(),
            owner: Uuid::new_v4(),
            evidence_refs: sqlx::types::Json(Vec::new()),
            verdict_value: None,
            verdict_rationale: None,
            verdict_decided_by: None,
            verdict_decided_at: None,
        };
        let encoded = encode_cursor(&row);
        let (time, id) = decode_cursor(&encoded).unwrap();
        assert_eq!(id, row.incident_id);
        assert_eq!(time, row.started_at);
        assert_eq!(
            decode_cursor("not*base64").unwrap_err().status,
            StatusCode::BAD_REQUEST
        );
        assert!(decode_cursor("bm8tc2VwYXJhdG9y").is_err());
    }

    // -- database-backed -----------------------------------------------------

    #[tokio::test]
    async fn create_is_idempotent_on_the_source_native_key() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let me = caller(user);

        let (created, first) = insert_incident(
            &pool,
            me,
            incident_request("disk full on web-01", Some("native-1")),
        )
        .await
        .unwrap();
        assert!(created);
        assert_eq!(first.status, "OPEN");
        assert_eq!(first.owner, user);

        let (created_again, second) = insert_incident(
            &pool,
            me,
            incident_request("disk full on web-01", Some("native-1")),
        )
        .await
        .unwrap();
        assert!(
            !created_again,
            "a replayed create must not create a second row"
        );
        assert_eq!(second.id, first.id);

        let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM kernel.incidents WHERE owner=$1")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(rows, 1);

        let (manual, _) = insert_incident(&pool, me, incident_request("manual report", None))
            .await
            .unwrap();
        assert!(
            manual,
            "a manual incident has no natural key and is never deduplicated"
        );

        cleanup(&pool, &[user]).await;
    }

    #[tokio::test]
    async fn operator_scope_hides_other_owners_and_admin_sees_everything() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let operator_a = seed_user(&pool, "operator").await;
        let operator_b = seed_user(&pool, "operator").await;
        let admin = seed_user(&pool, "admin").await;

        let (_, mine) =
            insert_incident(&pool, caller(operator_a), incident_request("a only", None))
                .await
                .unwrap();
        let (_, theirs) =
            insert_incident(&pool, caller(operator_b), incident_request("b only", None))
                .await
                .unwrap();

        let (items, _) = query_incidents(
            &pool,
            caller(operator_a),
            IncidentListQuery {
                limit: Some(100),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(items.iter().all(|item| item.owner == operator_a));
        assert!(items.iter().any(|item| item.id == mine.id));

        // Out-of-scope single reads answer 404, exactly like require_job_access.
        let error = query_incident(&pool, caller(operator_a), theirs.id)
            .await
            .unwrap_err();
        assert_eq!(error.status, StatusCode::NOT_FOUND);
        assert_eq!(error.code, "INCIDENT_NOT_FOUND");

        let (admin_items, _) = query_incidents(
            &pool,
            admin_caller(admin),
            IncidentListQuery {
                limit: Some(100),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(admin_items.iter().any(|item| item.id == mine.id));
        assert!(admin_items.iter().any(|item| item.id == theirs.id));
        assert!(query_incident(&pool, admin_caller(admin), theirs.id)
            .await
            .is_ok());

        cleanup(&pool, &[operator_a, operator_b, admin]).await;
    }

    #[tokio::test]
    async fn evidence_replay_is_idempotent_and_moves_open_to_investigating() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("latency spike", None))
                .await
                .unwrap();

        let (created, first) = insert_evidence(
            &pool,
            caller(user),
            incident.id,
            evidence_request("sha256:metric-window-1"),
        )
        .await
        .unwrap();
        assert!(created);

        let (created_again, second) = insert_evidence(
            &pool,
            caller(user),
            incident.id,
            evidence_request("sha256:metric-window-1"),
        )
        .await
        .unwrap();
        assert!(
            !created_again,
            "identical evidence is one fact, not two rows"
        );
        assert_eq!(second.evidence_id, first.evidence_id);

        let after = query_incident(&pool, caller(user), incident.id)
            .await
            .unwrap();
        assert_eq!(after.status, "INVESTIGATING");
        assert_eq!(after.evidence_refs, vec![first.evidence_id]);
        assert_eq!(
            query_evidence(&pool, caller(user), incident.id)
                .await
                .unwrap()
                .len(),
            1
        );

        cleanup(&pool, &[user]).await;
    }

    #[tokio::test]
    async fn verdict_requires_evidence_and_is_write_once() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("oom kills", None))
                .await
                .unwrap();

        let error = insert_verdict(
            &pool,
            caller(user),
            incident.id,
            verdict_request("CONFIRMED"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_EVIDENCE_REQUIRED");

        let error = insert_verdict(&pool, caller(user), incident.id, verdict_request("MOSTLY"))
            .await
            .unwrap_err();
        assert_eq!(error.code, "INVALID_REQUEST");

        insert_evidence(
            &pool,
            caller(user),
            incident.id,
            evidence_request("sha256:oom-log"),
        )
        .await
        .unwrap();

        let verdict = insert_verdict(
            &pool,
            caller(user),
            incident.id,
            verdict_request("CONFIRMED"),
        )
        .await
        .unwrap();
        assert_eq!(verdict.verdict, "CONFIRMED");
        assert_eq!(verdict.decided_by, user);

        let after = query_incident(&pool, caller(user), incident.id)
            .await
            .unwrap();
        assert_eq!(after.status, "CONCLUDED");
        assert_eq!(after.human_verdict.as_ref().unwrap().verdict, "CONFIRMED");

        let error = insert_verdict(&pool, caller(user), incident.id, verdict_request("REFUTED"))
            .await
            .unwrap_err();
        assert_eq!(error.code, "INCIDENT_ALREADY_CONCLUDED");
        assert_eq!(error.status, StatusCode::CONFLICT);

        cleanup(&pool, &[user]).await;
    }

    #[tokio::test]
    async fn inconclusive_verdict_needs_no_evidence() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("unknown cause", None))
                .await
                .unwrap();

        let verdict = insert_verdict(
            &pool,
            caller(user),
            incident.id,
            verdict_request("INCONCLUSIVE"),
        )
        .await
        .unwrap();
        assert_eq!(verdict.verdict, "INCONCLUSIVE");
        let after = query_incident(&pool, caller(user), incident.id)
            .await
            .unwrap();
        assert_eq!(after.status, "CONCLUDED");

        cleanup(&pool, &[user]).await;
    }

    #[tokio::test]
    async fn closed_incident_accepts_no_evidence_and_no_verdict() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("old noise", None))
                .await
                .unwrap();
        // No D2 endpoint produces CLOSED (ADR section 3.3); a D3 closure is
        // simulated directly to prove the guard still holds.
        sqlx::query("UPDATE kernel.incidents SET status='CLOSED' WHERE incident_id=$1")
            .bind(incident.id)
            .execute(&pool)
            .await
            .unwrap();

        let error = insert_evidence(
            &pool,
            caller(user),
            incident.id,
            evidence_request("sha256:late"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_CLOSED");
        let error = insert_verdict(
            &pool,
            caller(user),
            incident.id,
            verdict_request("INCONCLUSIVE"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_CLOSED");

        cleanup(&pool, &[user]).await;
    }

    #[tokio::test]
    async fn list_pages_with_a_keyset_cursor_and_rejects_unknown_filters() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        for offset in 0..3 {
            let mut request = incident_request(&format!("paged incident {offset}"), None);
            request.started_at = Utc::now() - chrono::Duration::seconds(offset);
            insert_incident(&pool, caller(user), request).await.unwrap();
        }

        let (page1, cursor) = query_incidents(
            &pool,
            caller(user),
            IncidentListQuery {
                limit: Some(2),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(page1.len(), 2);
        let cursor = cursor.expect("a full page must advertise the next one");

        let (page2, cursor2) = query_incidents(
            &pool,
            caller(user),
            IncidentListQuery {
                limit: Some(2),
                cursor: Some(cursor),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(page2.len(), 1);
        assert!(cursor2.is_none());
        assert!(page1
            .iter()
            .all(|first| page2.iter().all(|second| first.id != second.id)));

        let error = query_incidents(
            &pool,
            caller(user),
            IncidentListQuery {
                status: Some("DONE".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INVALID_REQUEST");
        let error = query_incidents(
            &pool,
            caller(user),
            IncidentListQuery {
                cursor: Some("not*base64".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INVALID_REQUEST");

        cleanup(&pool, &[user]).await;
    }
}
