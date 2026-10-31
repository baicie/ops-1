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

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use std::collections::HashMap;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

const SEVERITIES: &[&str] = &["CRITICAL", "MAJOR", "MINOR", "WARNING"];
const STATUSES: &[&str] = &["OPEN", "INVESTIGATING", "CONCLUDED", "CLOSED"];
const SOURCES: &[&str] = &["MANUAL", "API"];
const EVIDENCE_KINDS: &[&str] = &[
    "METRIC_SNAPSHOT",
    "LOG_EXCERPT",
    "QUERY_RESULT",
    "OPERATOR_NOTE",
];
/// What a submitter is allowed to say about its own row. SOURCE_ATTESTED is
/// absent on purpose: it is the one value that means "the Kernel checked", and a
/// caller cannot perform that check on the Kernel's behalf.
const CLAIMABLE_TRUSTS: &[&str] = &["OPERATOR_ASSERTED", "UNVERIFIED"];
const VERDICT_VALUES: &[&str] = &["CONFIRMED", "REFUTED", "INCONCLUSIVE"];
/// An attestation older or newer than this is refused as a replay, so a
/// signature captured off the wire cannot be reused indefinitely.
const ATTESTATION_MAX_SKEW_SECONDS: i64 = 300;
/// The version tag inside every signed payload. Adding a field means a new tag.
const ATTESTATION_VERSION: &str = "opsweave-evidence-attestation-v1";

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
    /// The pre-0017 field, still parsed only so its rejection is a named 400
    /// with a stable code instead of a generic "unknown field" message. Its value
    /// is never read: no request body decides verifiedTrust (G12 A1).
    #[serde(default)]
    pub trust: Option<String>,
    /// What the submitter says about the row it is writing. Absent means
    /// OPERATOR_ASSERTED, which is what an authenticated operator's own
    /// submission actually is.
    #[serde(default)]
    pub claimed_trust: Option<String>,
    /// A source adapter's proof. Its presence is the only path to
    /// SOURCE_ATTESTED, and only after the signature verifies.
    #[serde(default)]
    pub attestation: Option<AttestationRequest>,
}

/// What an adapter has to present to vouch for a row.
///
/// The adapter holds a secret the Kernel was configured with
/// (OPSWEAVE_EVIDENCE_ADAPTERS); the signature proves possession of it. The
/// signed bytes are fixed by attestation_payload and documented in
/// contracts/openapi/incident-v1.yaml, because an adapter written in another
/// language has to reproduce them exactly.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttestationRequest {
    /// Which configured adapter is speaking. Also recorded as verifierIdentity.
    pub adapter_id: String,
    /// When the adapter signed. Bounded by ATTESTATION_MAX_SKEW_SECONDS.
    pub issued_at: DateTime<Utc>,
    /// base64url (no padding) HMAC-SHA256 over attestation_payload.
    pub signature: String,
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
    /// D3: the list page filters by owner. This narrows the caller's data scope; it
    /// can never widen it, because the sees_all/owner predicate is still applied.
    pub owner: Option<String>,
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
    /// A3: how many evidence rows the signing transaction actually read. This is
    /// the number the verdict stands on, not the number the incident holds now.
    pub considered_evidence_count: i32,
    /// sha256 (hex) over that set, or null when none was recorded.
    pub considered_evidence_digest: Option<String>,
    /// RECORDED | PRE_MIGRATION_UNRECORDED. The second value is a statement, not
    /// a placeholder: it says the considered set was never stored and stays
    /// unknown instead of being reconstructed from timestamps.
    pub snapshot_kind: String,
}

/// One evidence row, with the two trust concepts kept apart.
///
/// Before G12 A1 there was one field, populated from the request body, and it
/// was rendered as if the Kernel had checked. Now the reader is told both what
/// was claimed and what was established, and by which method.
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
    /// What the submitter said about its own row. Kept because it is a fact about
    /// the submission, and never because it decides anything.
    pub claimed_trust: String,
    /// What the Kernel established. The only field a reader or a verdict may
    /// treat as provenance.
    pub verified_trust: String,
    /// NONE | OPERATOR_IDENTITY | SOURCE_ADAPTER.
    pub verification_method: String,
    pub verified_at: Option<DateTime<Utc>>,
    /// The authenticated adapter that vouched, for SOURCE_ADAPTER rows.
    pub verifier_identity: Option<String>,
    /// Who submitted. Null for rows that predate submitted_by where the audit
    /// trail did not answer; never filled with a guess.
    pub submitted_by: Option<Uuid>,
    /// Why this row carries the verification it carries, when that needs saying
    /// (the 0017 downgrade note is the case that exists today).
    pub verification_note: Option<String>,
    /// When the row was recorded, which is separable from collectedAt.
    pub created_at: DateTime<Utc>,
    /// A3: true when this row was appended after the incident's verdict was
    /// signed, so it was never part of the set the signer weighed.
    pub after_verdict: bool,
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
    verdict_considered_count: Option<i32>,
    verdict_considered_digest: Option<String>,
    verdict_snapshot_kind: Option<String>,
}

impl IncidentRow {
    fn into_view(self) -> IncidentView {
        let human_verdict = match (
            self.verdict_value,
            self.verdict_rationale,
            self.verdict_decided_by,
            self.verdict_decided_at,
            self.verdict_considered_count,
            self.verdict_snapshot_kind,
        ) {
            (
                Some(verdict),
                Some(rationale),
                Some(decided_by),
                Some(decided_at),
                Some(considered_evidence_count),
                Some(snapshot_kind),
            ) => Some(VerdictView {
                incident_id: self.incident_id,
                verdict,
                rationale,
                decided_by,
                decided_at,
                considered_evidence_count,
                considered_evidence_digest: self.verdict_considered_digest,
                snapshot_kind,
            }),
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
    // No audit call here: the audit row is written inside insert_incident's
    // transaction, so a failed audit cannot leave a committed incident behind.
    let (created, incident) = insert_incident(&state.db, caller, payload).await?;
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
    // The adapter secret set travels with the call instead of being read from a
    // global, so a test can hand in its own adapters and prove a forged
    // attestation is refused without depending on the process environment.
    let (created, evidence) = insert_evidence(
        &state.db,
        &state.config.evidence_adapters,
        caller,
        incident_id,
        payload,
    )
    .await?;
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
    // The row and the audit row that attests it share one transaction. Written
    // after the commit instead, a failed audit insert turns into a 5xx over a
    // committed incident: the client retries and is told the incident exists.
    let mut tx = db.begin().await?;
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
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(id) = created {
        audit_in_tx(
            &mut tx,
            "INCIDENT_CREATED",
            caller.user_id,
            id,
            "CREATE",
            serde_json::json!({
                "severity": severity,
                "source": source,
                "nativeId": native_id,
            }),
        )
        .await?;
        tx.commit().await?;
        return Ok((true, query_incident(db, caller, id).await?));
    }
    tx.rollback().await?;

    // A conflicting insert can only mean the natural key already exists.
    // Re-read it instead of telling the caller to retry: a replay must be
    // answered, not rejected.
    let existing: Option<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT incident_id, owner FROM kernel.incidents WHERE source=$1 AND native_id=$2",
    )
    .bind(&source)
    .bind(native_id.as_deref())
    .fetch_optional(db)
    .await?;
    let Some((existing, owner)) = existing else {
        return Err(AppError::conflict(
            "INCIDENT_WRITE_CONFLICT",
            "a concurrent write changed this incident set; retry the request",
        ));
    };
    // Taken, and outside the caller's read scope. A POST create has no 404 to
    // give: that status would say the failure does not exist while refusing to
    // create it. The natural key came from the caller, so telling it the key is
    // taken reveals only what the caller already typed.
    if !caller.sees_all && owner != caller.user_id {
        return Err(AppError::conflict(
            "INCIDENT_NATIVE_ID_TAKEN",
            "another user already reported this source/nativeId failure; it cannot be re-created or taken over",
        ));
    }
    Ok((false, query_incident(db, caller, existing).await?))
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
    let owner = match query
        .owner
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => Some(
            Uuid::parse_str(value)
                .map_err(|_| AppError::bad_request("owner filter must be a user UUID"))?,
        ),
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
           AND ($8::uuid IS NULL OR i.owner=$8)
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
        .bind(owner)
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
    adapters: &HashMap<String, String>,
    caller: Caller,
    incident_id: Uuid,
    payload: CreateEvidenceRequest,
) -> AppResult<(bool, EvidenceView)> {
    let kind = closed_set(&payload.kind, EVIDENCE_KINDS, "kind")?;
    let source = bounded(&payload.source, "source", 2, 200)?;
    let content_ref = bounded(&payload.content_ref, "contentRef", 2, 1000)?;
    // G12 A1: the trust of this row is decided here, before any SQL runs, and
    // nothing in the request body can set verified_trust except a signature the
    // Kernel can check. The pre-0017 body field is refused, not migrated.
    let tuple = EvidenceTuple {
        incident_id,
        kind: &kind,
        source: &source,
        collected_at: payload.collected_at,
        content_ref: &content_ref,
    };
    let trust = resolve_evidence_trust(adapters, &tuple, &payload)?;

    let status = incident_status(db, caller, incident_id).await?;
    if status == "CLOSED" {
        return Err(AppError::conflict(
            "INCIDENT_CLOSED",
            "this incident is closed and accepts no new evidence",
        ));
    }

    let evidence_id = Uuid::new_v4();
    // Evidence, the OPEN -> INVESTIGATING transition and the audit row commit
    // together: rolled back after the transition, an audit failure would leave
    // the incident investigating evidence that this endpoint never accepted.
    let mut tx = db.begin().await?;
    let inserted: Option<Uuid> = sqlx::query_scalar(
        r#"
        INSERT INTO kernel.incident_evidence
          (evidence_id,incident_id,kind,source,collected_at,content_ref,claimed_trust,
           verified_trust,verification_method,verified_at,verifier_identity,submitted_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT DO NOTHING
        RETURNING evidence_id
        "#,
    )
    .bind(evidence_id)
    .bind(incident_id)
    .bind(&kind)
    .bind(&source)
    .bind(payload.collected_at)
    .bind(&content_ref)
    .bind(&trust.claimed)
    .bind(&trust.verified)
    .bind(trust.method)
    .bind(trust.verified_at)
    .bind(trust.verifier_identity.as_deref())
    .bind(caller.user_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(stored_id) = inserted else {
        tx.rollback().await?;
        // A replay answers with the row that already exists - unchanged. That is
        // a security property, not only idempotency: presenting a valid
        // attestation for an already-stored UNVERIFIED row returns the stored
        // row, so a replay can never upgrade a settled trust value.
        let existing = sqlx::query_as::<_, EvidenceView>(&format!(
            "{EVIDENCE_SELECT} WHERE e.incident_id=$1 AND e.kind=$2 AND e.source=$3
             AND e.content_ref=$4"
        ))
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
    .execute(&mut *tx)
    .await?;
    audit_in_tx(
        &mut tx,
        "INCIDENT_EVIDENCE_ADDED",
        caller.user_id,
        incident_id,
        "ADD_EVIDENCE",
        serde_json::json!({
            "evidenceId": stored_id,
            "kind": &kind,
            // The audit row records both concepts, so an investigator reading the
            // trail later can see what was claimed and what was established.
            "claimedTrust": &trust.claimed,
            "verifiedTrust": &trust.verified,
            "verificationMethod": trust.method,
            "verifierIdentity": trust.verifier_identity,
        }),
    )
    .await?;
    tx.commit().await?;

    let evidence = query_evidence_row(db, stored_id).await?;
    Ok((true, evidence))
}

async fn query_evidence(
    db: &PgPool,
    caller: Caller,
    incident_id: Uuid,
) -> AppResult<Vec<EvidenceView>> {
    incident_status(db, caller, incident_id).await?;
    Ok(sqlx::query_as::<_, EvidenceView>(&format!(
        "{EVIDENCE_SELECT} WHERE e.incident_id=$1
         ORDER BY e.collected_at DESC, e.evidence_id DESC"
    ))
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
    // A3: freeze the set this verdict stands on, read inside the transaction that
    // writes the verdict. Counting rows at read time instead would let evidence
    // appended after signing be reported as if the signer had weighed it.
    let considered: Vec<(Uuid, String, String, String, String)> = sqlx::query_as(
        "SELECT evidence_id, kind, source, content_ref, verified_trust
         FROM kernel.incident_evidence WHERE incident_id=$1 ORDER BY evidence_id",
    )
    .bind(incident_id)
    .fetch_all(&mut *tx)
    .await?;
    if requires_evidence && considered.is_empty() {
        return Err(AppError::conflict(
            "INCIDENT_EVIDENCE_REQUIRED",
            "CONFIRMED and REFUTED need at least one evidence row; use INCONCLUSIVE when evidence is missing",
        ));
    }
    let snapshot: Vec<(Uuid, String)> = considered
        .iter()
        .map(|(id, kind, source, content_ref, verified)| {
            (
                *id,
                evidence_row_digest(*id, kind, source, content_ref, verified),
            )
        })
        .collect();
    let considered_digest = considered_set_digest(&snapshot);
    let view = sqlx::query_as::<_, VerdictView>(
        r#"
        INSERT INTO kernel.incident_verdicts
          (incident_id,verdict,rationale,decided_by,
           considered_evidence_count,considered_evidence_digest,snapshot_kind)
        VALUES ($1,$2,$3,$4,$5,$6,'RECORDED')
        RETURNING incident_id,verdict,rationale,decided_by,decided_at,
                  considered_evidence_count,considered_evidence_digest,snapshot_kind
        "#,
    )
    .bind(incident_id)
    .bind(&verdict)
    .bind(&rationale)
    .bind(caller.user_id)
    .bind(snapshot.len() as i32)
    .bind(&considered_digest)
    .fetch_one(&mut *tx)
    .await?;
    // The per-row snapshots. Written after the verdict row so the foreign key
    // holds, and in the same transaction so a verdict can never be committed
    // with a partially recorded considered set.
    for (evidence_id, digest) in &snapshot {
        sqlx::query(
            "INSERT INTO kernel.incident_verdict_evidence (incident_id,evidence_id,evidence_digest)
             VALUES ($1,$2,$3)",
        )
        .bind(incident_id)
        .bind(*evidence_id)
        .bind(digest)
        .execute(&mut *tx)
        .await?;
    }
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
    // Inside the transaction: a verdict that cannot be audited is a verdict that
    // was never recorded, and the status CAS above rolls back with it.
    audit_in_tx(
        &mut tx,
        "INCIDENT_VERDICT_RECORDED",
        caller.user_id,
        incident_id,
        "RECORD_VERDICT",
        serde_json::json!({
            "verdict": &view.verdict,
            "consideredEvidenceCount": view.considered_evidence_count,
            "consideredEvidenceDigest": &view.considered_evidence_digest,
        }),
    )
    .await?;
    tx.commit().await?;
    Ok(view)
}

async fn query_verdict(db: &PgPool, caller: Caller, incident_id: Uuid) -> AppResult<VerdictView> {
    incident_status(db, caller, incident_id).await?;
    sqlx::query_as::<_, VerdictView>(&format!(
        "SELECT {VERDICT_COLUMNS} FROM kernel.incident_verdicts WHERE incident_id=$1"
    ))
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

async fn query_evidence_row(db: &PgPool, evidence_id: Uuid) -> AppResult<EvidenceView> {
    sqlx::query_as::<_, EvidenceView>(&format!("{EVIDENCE_SELECT} WHERE e.evidence_id=$1"))
        .bind(evidence_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| {
            AppError::internal(format!(
                "evidence {evidence_id} was committed but cannot be read back"
            ))
        })
}

// ---------------------------------------------------------------------------
// G12 A1 · What the Kernel is allowed to conclude about one evidence row
//
// The defect: verified provenance used to be a request field. POST
// {"trust":"SOURCE_ATTESTED"} produced a row indistinguishable from one a
// connector vouched for, and the two had the same column, the same JSON field
// and the same badge. Splitting the concept fixes the read side; this block
// fixes the write side, and it is the only place verified_trust is decided.
// ---------------------------------------------------------------------------

/// The tuple an attestation binds: the fields that make one evidence row itself.
///
/// One struct rather than a run of &str parameters, because both the signer and
/// the verifier have to cover every field, and a loose argument list is exactly
/// how one of them gets a field the other forgets.
struct EvidenceTuple<'a> {
    incident_id: Uuid,
    kind: &'a str,
    source: &'a str,
    collected_at: DateTime<Utc>,
    content_ref: &'a str,
}

/// The Kernel's conclusion about one evidence row, settled before any SQL runs.
struct EvidenceTrust {
    claimed: String,
    verified: String,
    method: &'static str,
    verified_at: Option<DateTime<Utc>>,
    verifier_identity: Option<String>,
}

/// The claimed/verified split, decided from the request and the adapter set.
///
/// Three outcomes and no fourth:
///   * a signed, fresh attestation from a configured adapter -> SOURCE_ATTESTED;
///   * no attestation at all -> the caller's claim, which can be at most
///     OPERATOR_ASSERTED (the caller is an authenticated operator: that much the
///     Kernel did verify);
///   * anything that asks to be taken on its word for attestation -> 400/401.
fn resolve_evidence_trust(
    adapters: &HashMap<String, String>,
    tuple: &EvidenceTuple<'_>,
    payload: &CreateEvidenceRequest,
) -> AppResult<EvidenceTrust> {
    // Refused rather than reinterpreted: until this release the value in this
    // field was what granted attestation, so silently mapping it onto a claim
    // would keep a "looks like it worked" path alive for old clients.
    if payload.trust.is_some() {
        return Err(trust_not_self_assertable());
    }
    let claimed = match payload.claimed_trust.as_deref() {
        Some(raw) => {
            if raw.trim().eq_ignore_ascii_case("SOURCE_ATTESTED") {
                return Err(trust_not_self_assertable());
            }
            closed_set(raw, CLAIMABLE_TRUSTS, "claimedTrust")?
        }
        // An operator submitting its own note is asserting it; that is the
        // truthful default rather than the most flattering one.
        None => "OPERATOR_ASSERTED".to_string(),
    };

    let Some(attestation) = payload.attestation.as_ref() else {
        let verified = claimed.clone();
        let verified_at = (verified == "OPERATOR_ASSERTED").then(Utc::now);
        return Ok(EvidenceTrust {
            claimed,
            verified,
            method: if verified_at.is_some() {
                "OPERATOR_IDENTITY"
            } else {
                "NONE"
            },
            verified_at,
            verifier_identity: None,
        });
    };

    let adapter_id = bounded(&attestation.adapter_id, "attestation.adapterId", 1, 100)?;
    verify_attestation(adapters, &adapter_id, attestation, tuple)?;
    Ok(EvidenceTrust {
        claimed,
        verified: "SOURCE_ATTESTED".to_string(),
        method: "SOURCE_ADAPTER",
        verified_at: Some(Utc::now()),
        verifier_identity: Some(adapter_id),
    })
}

/// Checks that the adapter exists, that its signature is fresh and that the
/// signature covers exactly this evidence tuple.
///
/// A failure here is a 401, never a downgrade to UNVERIFIED: an unverifiable
/// attestation is an attempt to claim provenance the caller cannot prove, and
/// storing the row anyway would bury it in the evidence table as if it were an
/// ordinary note.
fn verify_attestation(
    adapters: &HashMap<String, String>,
    adapter_id: &str,
    attestation: &AttestationRequest,
    tuple: &EvidenceTuple<'_>,
) -> AppResult<()> {
    let Some(secret) = adapters.get(adapter_id) else {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "EVIDENCE_ADAPTER_UNKNOWN",
            "no configured source adapter answers to this adapterId, so its attestation cannot be checked",
        ));
    };
    let skewed = (Utc::now() - attestation.issued_at).num_seconds().abs();
    if skewed > ATTESTATION_MAX_SKEW_SECONDS {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "EVIDENCE_ATTESTATION_STALE",
            format!(
                "this attestation is {skewed}s away from the Kernel clock; a signature is accepted for {ATTESTATION_MAX_SKEW_SECONDS}s either side so it cannot be replayed"
            ),
        ));
    }
    let payload = attestation_payload(adapter_id, tuple, attestation.issued_at)?;
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|_| AppError::internal("evidence adapter secret is not a usable HMAC key"))?;
    mac.update(payload.as_bytes());
    use base64::Engine;
    let expected =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    if !constant_time_eq(expected.as_bytes(), attestation.signature.trim().as_bytes()) {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "EVIDENCE_ATTESTATION_INVALID",
            "the attestation signature does not cover this evidence tuple under this adapter's secret",
        ));
    }
    Ok(())
}

/// The exact bytes an adapter signs.
///
/// JSON with a fixed key order, because the alternative - a separator-joined
/// string - lets a newline inside source or contentRef move the field boundary
/// and make two different tuples sign identically. Escaping removes that.
///
/// camelCase because the published contract says so (incident-v1.yaml,
/// components.schemas.Attestation) and every other field on this API is
/// camelCase. Without rename_all serde would emit adapter_id/collected_at_unix
/// and an adapter written from the contract would produce a signature this
/// Kernel silently rejects - a mistake an in-process test cannot see, because
/// both sides would be wrong the same way.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttestationClaims<'a> {
    v: &'a str,
    adapter_id: &'a str,
    incident_id: String,
    kind: &'a str,
    source: &'a str,
    collected_at_unix: i64,
    content_ref: &'a str,
    issued_at_unix: i64,
}

fn attestation_payload(
    adapter_id: &str,
    tuple: &EvidenceTuple<'_>,
    issued_at: DateTime<Utc>,
) -> AppResult<String> {
    serde_json::to_string(&AttestationClaims {
        v: ATTESTATION_VERSION,
        adapter_id,
        incident_id: tuple.incident_id.to_string(),
        kind: tuple.kind,
        source: tuple.source,
        collected_at_unix: tuple.collected_at.timestamp(),
        content_ref: tuple.content_ref,
        issued_at_unix: issued_at.timestamp(),
    })
    .map_err(AppError::internal)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0_u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn trust_not_self_assertable() -> AppError {
    AppError::new(
        StatusCode::BAD_REQUEST,
        "EVIDENCE_TRUST_NOT_SELF_ASSERTABLE",
        "trust is the Kernel's verdict, not a request field: send claimedTrust (OPERATOR_ASSERTED or UNVERIFIED), and obtain SOURCE_ATTESTED only by presenting a signed attestation from a configured source adapter",
    )
}

// ---------------------------------------------------------------------------
// G12 A3 · The set a verdict stands on
// ---------------------------------------------------------------------------

/// sha256 (hex) of one evidence row's identity and content at signing time.
/// Length prefixes keep concatenation unambiguous; the digest is what makes a
/// later edit to a contentRef detectable even though the id is unchanged.
fn evidence_row_digest(
    evidence_id: Uuid,
    kind: &str,
    source: &str,
    content_ref: &str,
    verified_trust: &str,
) -> String {
    let mut hasher = Sha256::new();
    for part in [kind, source, content_ref, verified_trust] {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part.as_bytes());
    }
    hasher.update(evidence_id.as_bytes());
    hex::encode(hasher.finalize())
}

/// sha256 (hex) over the whole considered set, ordered by evidence id so the
/// digest depends on the set and not on the order rows happened to arrive in.
fn considered_set_digest(snapshot: &[(Uuid, String)]) -> String {
    let mut ordered: Vec<&(Uuid, String)> = snapshot.iter().collect();
    ordered.sort_by_key(|(id, _)| *id);
    let mut hasher = Sha256::new();
    for (id, digest) in ordered {
        hasher.update(id.as_bytes());
        hasher.update(digest.as_bytes());
    }
    hex::encode(hasher.finalize())
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
       v.decided_at AS verdict_decided_at,
       v.considered_evidence_count AS verdict_considered_count,
       v.considered_evidence_digest AS verdict_considered_digest,
       v.snapshot_kind AS verdict_snapshot_kind
FROM kernel.incidents i
LEFT JOIN kernel.incident_verdicts v ON v.incident_id = i.incident_id"#;

/// One evidence projection, used by the list, the single-row read and the replay
/// branch of the insert, so the three can never disagree about what an evidence
/// row contains.
///
/// afterVerdict is derived here rather than stored: the stored fact is the
/// signed snapshot (kernel.incident_verdict_evidence), and a boolean column
/// would be a second copy of it that could drift. For a verdict signed before
/// 0017 there is no snapshot, so the only defensible answer is the recorded
/// timestamps, and the verdict itself reports snapshotKind =
/// PRE_MIGRATION_UNRECORDED so the reader knows which rule produced the answer.
const EVIDENCE_SELECT: &str = r#"
SELECT e.evidence_id, e.incident_id, e.kind, e.source, e.collected_at, e.content_ref,
       e.claimed_trust, e.verified_trust, e.verification_method, e.verified_at,
       e.verifier_identity, e.submitted_by, e.verification_note, e.created_at,
       CASE
         WHEN v.incident_id IS NULL THEN false
         WHEN v.snapshot_kind = 'RECORDED' THEN NOT EXISTS (
           SELECT 1 FROM kernel.incident_verdict_evidence s
           WHERE s.incident_id = e.incident_id AND s.evidence_id = e.evidence_id
         )
         ELSE e.created_at > v.decided_at
       END AS after_verdict
FROM kernel.incident_evidence e
LEFT JOIN kernel.incident_verdicts v ON v.incident_id = e.incident_id"#;

/// The verdict projection, in one place for the same reason.
const VERDICT_COLUMNS: &str = "incident_id,verdict,rationale,decided_by,decided_at,
       considered_evidence_count,considered_evidence_digest,snapshot_kind";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// The audit row that attests one incident write, inserted on the caller's
/// transaction instead of the pool.
///
/// audit::record is pool-bound, so it can only run after the business write has
/// already committed; that ordering is what turns a failed audit into a 5xx over
/// a row that exists. This helper exists so create/evidence/verdict can write the
/// row and its audit row in one transaction. If audit::record ever learns to take
/// a transaction, delete this and call it.
async fn audit_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    event_type: &str,
    actor_id: Uuid,
    incident_id: Uuid,
    action: &str,
    details: serde_json::Value,
) -> AppResult<()> {
    sqlx::query(
        r#"
        INSERT INTO kernel.audit_events
          (id, event_type, actor_type, actor_id, subject_type, subject_id, action, result, details, request_id, occurred_at)
        VALUES ($1,$2,'USER',$3,'INCIDENT',$4,$5,'ACCEPTED',$6,NULL,$7)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(event_type)
    .bind(actor_id.to_string())
    .bind(incident_id.to_string())
    .bind(action)
    .bind(details)
    .bind(Utc::now())
    .execute(&mut **tx)
    .await
    .map_err(|error| {
        tracing::error!(error = %error, "incident audit write failed; rolling the write back");
        audit_write_failed()
    })?;
    Ok(())
}

/// Says what actually happened: the write was rolled back, so retrying is
/// meaningful and the client must not treat the call as half-applied.
fn audit_write_failed() -> AppError {
    let mut error = AppError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "AUDIT_WRITE_FAILED",
        "the audit record for this write could not be stored, so the write was rolled back and did not take effect",
    );
    error.retryable = true;
    error
}

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

    /// A plain operator submission: no attestation, so at most OPERATOR_ASSERTED.
    /// The pre-G12 version of this helper asked for SOURCE_ATTESTED in the body,
    /// which is exactly the defect - it is kept out of the fixtures on purpose.
    fn evidence_request(content_ref: &str) -> CreateEvidenceRequest {
        CreateEvidenceRequest {
            kind: "METRIC_SNAPSHOT".to_string(),
            source: "prometheus".to_string(),
            collected_at: Utc::now(),
            content_ref: content_ref.to_string(),
            trust: None,
            claimed_trust: None,
            attestation: None,
        }
    }

    /// The adapter set a test hands to insert_evidence. Empty unless a test is
    /// exercising the attested path, so no test proves attestation by accident.
    fn no_adapters() -> HashMap<String, String> {
        HashMap::new()
    }

    const ADAPTER_ID: &str = "zabbix-main";
    const ADAPTER_SECRET: &str = "adapter-secret-for-tests";

    fn adapters() -> HashMap<String, String> {
        let mut map = HashMap::new();
        map.insert(ADAPTER_ID.to_string(), ADAPTER_SECRET.to_string());
        map
    }

    /// The tuple a test signs over, kept in one place so a test cannot sign one
    /// set of fields and submit another by accident.
    fn tuple<'a>(
        incident_id: Uuid,
        kind: &'a str,
        source: &'a str,
        content_ref: &'a str,
        collected_at: DateTime<Utc>,
    ) -> EvidenceTuple<'a> {
        EvidenceTuple {
            incident_id,
            kind,
            source,
            collected_at,
            content_ref,
        }
    }

    /// Builds the attestation an honest adapter would send for this tuple.
    fn attested_request(
        bound: &EvidenceTuple<'_>,
        adapter_id: &str,
        secret: &str,
        issued_at: DateTime<Utc>,
    ) -> CreateEvidenceRequest {
        let payload = attestation_payload(adapter_id, bound, issued_at).unwrap();
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(payload.as_bytes());
        use base64::Engine;
        let signature =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        CreateEvidenceRequest {
            kind: bound.kind.to_string(),
            source: bound.source.to_string(),
            collected_at: bound.collected_at,
            content_ref: bound.content_ref.to_string(),
            trust: None,
            claimed_trust: None,
            attestation: Some(AttestationRequest {
                adapter_id: adapter_id.to_string(),
                issued_at,
                signature,
            }),
        }
    }

    /// Golden vector for the signed payload.
    ///
    /// The in-process attestation tests cannot catch a key-format mistake: both
    /// sides call attestation_payload, so both would be wrong the same way. This
    /// asserts the literal bytes an adapter written from the contract produces.
    #[test]
    fn attestation_payload_matches_the_published_golden_vector() {
        let bound = tuple(
            Uuid::parse_str("b17265e7-3ac8-4877-bad4-40c4d2df4a87").unwrap(),
            "METRIC_SNAPSHOT",
            "zabbix:probe",
            "sha256:probe-1",
            DateTime::parse_from_rfc3339("2026-10-31T05:17:24Z")
                .unwrap()
                .with_timezone(&Utc),
        );
        let issued_at = DateTime::parse_from_rfc3339("2026-10-31T05:17:24Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            attestation_payload("zabbix-main", &bound, issued_at).unwrap(),
            concat!(
                r#"{"v":"opsweave-evidence-attestation-v1","adapterId":"zabbix-main","#,
                r#""incidentId":"b17265e7-3ac8-4877-bad4-40c4d2df4a87","#,
                r#""kind":"METRIC_SNAPSHOT","source":"zabbix:probe","#,
                r#""collectedAtUnix":1793423844,"contentRef":"sha256:probe-1","#,
                r#""issuedAtUnix":1793423844}"#
            )
        );
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
        assert!(closed_set("AI_INFERENCE", CLAIMABLE_TRUSTS, "claimedTrust").is_err());
        // G12 A1: the claimable set is strictly smaller than the stored set. A
        // caller can never name the one value that means "the Kernel checked".
        assert!(!CLAIMABLE_TRUSTS.contains(&"SOURCE_ATTESTED"));
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
            verdict_considered_count: None,
            verdict_considered_digest: None,
            verdict_snapshot_kind: None,
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

    /// D3 added an `owner` list filter for the UI. The rule it must not break is the one the
    /// role predicate already enforces: a filter narrows what the caller may read, it never
    /// reaches past that scope. An operator asking for another owner's id gets an empty page,
    /// not their rows; an admin asking for the same id gets them.
    #[tokio::test]
    async fn owner_filter_narrows_the_scope_and_never_widens_it() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let operator = seed_user(&pool, "operator").await;
        let other = seed_user(&pool, "operator").await;
        let admin = seed_user(&pool, "admin").await;

        let (_, mine) = insert_incident(
            &pool,
            caller(operator),
            incident_request("owner filter mine", None),
        )
        .await
        .unwrap();
        let (_, theirs) = insert_incident(
            &pool,
            caller(other),
            incident_request("owner filter theirs", None),
        )
        .await
        .unwrap();

        let (own_rows, _) = query_incidents(
            &pool,
            caller(operator),
            IncidentListQuery {
                owner: Some(operator.to_string()),
                limit: Some(100),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(own_rows.iter().any(|item| item.id == mine.id));
        assert!(own_rows.iter().all(|item| item.owner == operator));

        let (their_rows, _) = query_incidents(
            &pool,
            caller(operator),
            IncidentListQuery {
                owner: Some(other.to_string()),
                limit: Some(100),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(
            their_rows.is_empty(),
            "an operator must not read another owner's rows by filtering for them"
        );

        let (admin_rows, _) = query_incidents(
            &pool,
            admin_caller(admin),
            IncidentListQuery {
                owner: Some(other.to_string()),
                limit: Some(100),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(admin_rows.iter().any(|item| item.id == theirs.id));

        let error = query_incidents(
            &pool,
            caller(operator),
            IncidentListQuery {
                owner: Some("not-a-uuid".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INVALID_REQUEST");

        cleanup(&pool, &[operator, other, admin]).await;
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
            &no_adapters(),
            caller(user),
            incident.id,
            evidence_request("sha256:metric-window-1"),
        )
        .await
        .unwrap();
        assert!(created);

        let (created_again, second) = insert_evidence(
            &pool,
            &no_adapters(),
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
            &no_adapters(),
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
            &no_adapters(),
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

    // -- audit, transaction order and create replay ---------------------------

    /// Makes kernel.audit_events reject one actor's rows of one event type, so the
    /// rollback path is exercised by a real constraint failure rather than a mock.
    /// Scoped to a freshly seeded user so concurrent tests keep their audits.
    async fn refuse_audit(pool: &PgPool, event_type: &str, actor: Uuid) -> String {
        let name = format!("g11_audit_probe_{}", Uuid::new_v4().simple());
        sqlx::query(&format!(
            "ALTER TABLE kernel.audit_events ADD CONSTRAINT {name} CHECK (
               NOT (event_type='{event_type}' AND actor_id='{actor}'))"
        ))
        .execute(pool)
        .await
        .unwrap();
        name
    }

    async fn allow_audit(pool: &PgPool, name: &str) {
        sqlx::query(&format!(
            "ALTER TABLE kernel.audit_events DROP CONSTRAINT {name}"
        ))
        .execute(pool)
        .await
        .unwrap();
    }

    async fn audit_rows(pool: &PgPool, incident_id: Uuid, event_type: &str) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM kernel.audit_events WHERE subject_id=$1 AND event_type=$2",
        )
        .bind(incident_id.to_string())
        .bind(event_type)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    /// The defect this replaced: audit written after the commit, so a failed audit
    /// answered 5xx over a verdict the database had already accepted.
    #[tokio::test]
    async fn a_failed_audit_rolls_the_verdict_back() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("oom kills", None))
                .await
                .unwrap();
        insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            evidence_request("sha256:oom-log"),
        )
        .await
        .unwrap();

        let probe = refuse_audit(&pool, "INCIDENT_VERDICT_RECORDED", user).await;
        let refused = insert_verdict(
            &pool,
            caller(user),
            incident.id,
            verdict_request("CONFIRMED"),
        )
        .await;
        allow_audit(&pool, &probe).await;

        let error = refused.unwrap_err();
        assert_eq!(error.code, "AUDIT_WRITE_FAILED");
        assert_eq!(error.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(
            error.retryable,
            "nothing was persisted, so telling the client to retry is honest"
        );

        let verdicts: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_verdicts WHERE incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            verdicts, 0,
            "the verdict must not survive the audit that failed to describe it"
        );
        let status: String =
            sqlx::query_scalar("SELECT status FROM kernel.incidents WHERE incident_id=$1")
                .bind(incident.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            status, "INVESTIGATING",
            "the CONCLUDED transition commits with the audit row or not at all"
        );

        let verdict = insert_verdict(
            &pool,
            caller(user),
            incident.id,
            verdict_request("CONFIRMED"),
        )
        .await
        .unwrap();
        assert_eq!(verdict.verdict, "CONFIRMED");
        assert_eq!(
            audit_rows(&pool, incident.id, "INCIDENT_VERDICT_RECORDED").await,
            1
        );

        cleanup(&pool, &[user]).await;
    }

    #[tokio::test]
    async fn a_failed_audit_rolls_the_incident_back_and_frees_the_natural_key() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let native_id = format!("native-audit-{}", Uuid::new_v4().simple());

        let probe = refuse_audit(&pool, "INCIDENT_CREATED", user).await;
        let refused = insert_incident(
            &pool,
            caller(user),
            incident_request("header flipped", Some(&native_id)),
        )
        .await;
        allow_audit(&pool, &probe).await;

        let error = refused.unwrap_err();
        assert_eq!(error.code, "AUDIT_WRITE_FAILED");

        let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM kernel.incidents WHERE owner=$1")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(rows, 0, "a rolled-back create leaves no incident behind");

        // Rolled back means the natural key is free: had the row committed without
        // its audit row, this retry would be answered as a replay of a write the
        // caller was told had failed.
        let (created, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("header flipped", Some(&native_id)),
        )
        .await
        .unwrap();
        assert!(created);
        assert_eq!(audit_rows(&pool, incident.id, "INCIDENT_CREATED").await, 1);

        cleanup(&pool, &[user]).await;
    }

    #[tokio::test]
    async fn a_failed_audit_rolls_the_evidence_and_the_state_change_back() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("first evidence", None),
        )
        .await
        .unwrap();

        let probe = refuse_audit(&pool, "INCIDENT_EVIDENCE_ADDED", user).await;
        let refused = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            evidence_request("sha256:first"),
        )
        .await;
        allow_audit(&pool, &probe).await;

        assert_eq!(refused.unwrap_err().code, "AUDIT_WRITE_FAILED");
        let evidence: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(evidence, 0, "evidence and its audit row commit together");
        let status: String =
            sqlx::query_scalar("SELECT status FROM kernel.incidents WHERE incident_id=$1")
                .bind(incident.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            status, "OPEN",
            "a rejected evidence write must not leave the incident INVESTIGATING"
        );

        cleanup(&pool, &[user]).await;
    }

    /// A POST create answered 404 for a natural key another operator owns: the
    /// status claimed the failure did not exist while refusing to create it.
    #[tokio::test]
    async fn a_native_key_owned_by_another_operator_answers_409_not_404() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let operator_a = seed_user(&pool, "operator").await;
        let operator_b = seed_user(&pool, "operator").await;
        let admin = seed_user(&pool, "admin").await;
        let native_id = format!("native-taken-{}", Uuid::new_v4().simple());

        let (_, first) = insert_incident(
            &pool,
            caller(operator_a),
            incident_request("disk full on web-01", Some(&native_id)),
        )
        .await
        .unwrap();

        let error = insert_incident(
            &pool,
            caller(operator_b),
            incident_request("disk full on web-01", Some(&native_id)),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_NATIVE_ID_TAKEN");
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert!(
            !error.message.contains(&first.id.to_string()),
            "the refusal must not hand another operator's incident id to the caller"
        );

        let rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incidents WHERE source='API' AND native_id=$1",
        )
        .bind(&native_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(rows, 1, "the refused create must not add a second row");
        let owner: Uuid = sqlx::query_scalar(
            "SELECT owner FROM kernel.incidents WHERE source='API' AND native_id=$1",
        )
        .bind(&native_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(owner, operator_a, "ownership must not move on a replay");

        // An admin can read that row, so the same request stays a documented replay.
        let (created, seen) = insert_incident(
            &pool,
            admin_caller(admin),
            incident_request("disk full on web-01", Some(&native_id)),
        )
        .await
        .unwrap();
        assert!(!created);
        assert_eq!(seen.id, first.id);

        cleanup(&pool, &[operator_a, operator_b, admin]).await;
    }

    // -----------------------------------------------------------------------
    // G12 A1 - the negative tests. Every test below asserts both the refusal AND
    // that nothing was written: a rejection that still stores the row is the same
    // defect wearing a different status code.
    // -----------------------------------------------------------------------

    /// The pre-0017 request field. Refused as a field, not reinterpreted as a
    /// claim: a client that still sends it must learn the field moved, because
    /// until this release its value was what granted attestation.
    #[tokio::test]
    async fn a_body_trust_field_is_refused_and_writes_nothing() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("body trust", None))
                .await
                .unwrap();

        for requested in ["SOURCE_ATTESTED", "OPERATOR_ASSERTED", "UNVERIFIED"] {
            let mut payload = evidence_request("sha256:body-trust");
            payload.trust = Some(requested.to_string());
            let error = insert_evidence(&pool, &no_adapters(), caller(user), incident.id, payload)
                .await
                .unwrap_err();
            assert_eq!(
                error.code, "EVIDENCE_TRUST_NOT_SELF_ASSERTABLE",
                "trust={requested} must be refused as a request field"
            );
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
        }

        let rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(rows, 0, "a refused evidence write must not store a row");

        cleanup(&pool, &[user]).await;
    }

    /// The new field is a claim, and the claim set excludes the one value that
    /// means "the Kernel checked".
    #[tokio::test]
    async fn a_caller_cannot_claim_attested_trust() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("claim attested", None),
        )
        .await
        .unwrap();

        let mut payload = evidence_request("sha256:claim-attested");
        payload.claimed_trust = Some("source_attested".to_string());
        let error = insert_evidence(&pool, &no_adapters(), caller(user), incident.id, payload)
            .await
            .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_TRUST_NOT_SELF_ASSERTABLE");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);

        let mut payload = evidence_request("sha256:claim-bogus");
        payload.claimed_trust = Some("AI_INFERENCE".to_string());
        let error = insert_evidence(&pool, &no_adapters(), caller(user), incident.id, payload)
            .await
            .unwrap_err();
        assert_eq!(error.code, "INVALID_REQUEST");

        let rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(rows, 0);

        cleanup(&pool, &[user]).await;
    }

    /// What an operator's own submission actually earns: the Kernel verified the
    /// identity of the operator, and nothing more.
    #[tokio::test]
    async fn an_operator_submission_is_verified_as_operator_identity_only() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("operator only", None))
                .await
                .unwrap();

        let (created, row) = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            evidence_request("sha256:operator-row"),
        )
        .await
        .unwrap();
        assert!(created);
        assert_eq!(row.claimed_trust, "OPERATOR_ASSERTED");
        assert_eq!(row.verified_trust, "OPERATOR_ASSERTED");
        assert_eq!(row.verification_method, "OPERATOR_IDENTITY");
        assert!(row.verified_at.is_some(), "an operator verdict is dated");
        assert_eq!(
            row.verifier_identity, None,
            "no adapter vouched, so no adapter identity is claimed"
        );
        assert_eq!(row.submitted_by, Some(user));
        assert_eq!(row.verification_note, None);
        assert!(!row.after_verdict);

        let mut payload = evidence_request("sha256:self-declared");
        payload.claimed_trust = Some("UNVERIFIED".to_string());
        let (_, row) = insert_evidence(&pool, &no_adapters(), caller(user), incident.id, payload)
            .await
            .unwrap();
        assert_eq!(row.claimed_trust, "UNVERIFIED");
        assert_eq!(row.verified_trust, "UNVERIFIED");
        assert_eq!(row.verification_method, "NONE");
        assert_eq!(row.verified_at, None);

        cleanup(&pool, &[user]).await;
    }

    /// The positive path: a configured adapter's signature is the only thing that
    /// produces SOURCE_ATTESTED, and it records who vouched and how.
    #[tokio::test]
    async fn a_valid_adapter_attestation_is_the_only_path_to_attested_trust() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("attested row", None))
                .await
                .unwrap();

        let collected_at = Utc::now();
        let issued_at = Utc::now();
        let payload = attested_request(
            &tuple(
                incident.id,
                "METRIC_SNAPSHOT",
                "zabbix",
                "sha256:attested-1",
                collected_at,
            ),
            ADAPTER_ID,
            ADAPTER_SECRET,
            issued_at,
        );
        let (created, row) =
            insert_evidence(&pool, &adapters(), caller(user), incident.id, payload)
                .await
                .unwrap();
        assert!(created);
        assert_eq!(row.verified_trust, "SOURCE_ATTESTED");
        assert_eq!(row.verification_method, "SOURCE_ADAPTER");
        assert_eq!(row.verifier_identity.as_deref(), Some(ADAPTER_ID));
        assert!(row.verified_at.is_some());
        assert_eq!(row.submitted_by, Some(user));
        // The claim is not silently upgraded to match the verdict: they answer
        // different questions and are stored separately.
        assert_eq!(row.claimed_trust, "OPERATOR_ASSERTED");

        cleanup(&pool, &[user]).await;
    }

    /// Four ways an attestation can be wrong. All four are refused, none of them
    /// degrades to UNVERIFIED: an unverifiable attestation is an attempt to claim
    /// provenance, and storing it as an ordinary row would bury it.
    #[tokio::test]
    async fn forged_and_stale_attestations_are_refused_and_write_nothing() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("forged attempt", None),
        )
        .await
        .unwrap();

        let collected_at = Utc::now();
        let issued_at = Utc::now();
        let build =
            |content_ref: &str, adapter_id: &str, secret: &str, issued_at: DateTime<Utc>| {
                attested_request(
                    &tuple(
                        incident.id,
                        "METRIC_SNAPSHOT",
                        "prometheus",
                        content_ref,
                        collected_at,
                    ),
                    adapter_id,
                    secret,
                    issued_at,
                )
            };

        // (a) right adapter, wrong secret.
        let error = insert_evidence(
            &pool,
            &adapters(),
            caller(user),
            incident.id,
            build(
                "sha256:forged-signature",
                ADAPTER_ID,
                "not-the-secret",
                issued_at,
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_ATTESTATION_INVALID");
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);

        // (b) an adapter the Kernel does not know.
        let error = insert_evidence(
            &pool,
            &adapters(),
            caller(user),
            incident.id,
            build(
                "sha256:unknown-adapter",
                "zabbix-impostor",
                ADAPTER_SECRET,
                issued_at,
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_ADAPTER_UNKNOWN");
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);

        // (c) a genuine signature over a different tuple, replayed onto this one:
        // the signature binds contentRef, so moving it invalidates the proof.
        let mut moved = build("sha256:original-ref", ADAPTER_ID, ADAPTER_SECRET, issued_at);
        moved.content_ref = "sha256:moved-ref".to_string();
        let error = insert_evidence(&pool, &adapters(), caller(user), incident.id, moved)
            .await
            .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_ATTESTATION_INVALID");

        // (d) a genuine signature captured and replayed later.
        let stale_at = Utc::now() - chrono::Duration::seconds(ATTESTATION_MAX_SKEW_SECONDS + 60);
        let error = insert_evidence(
            &pool,
            &adapters(),
            caller(user),
            incident.id,
            build("sha256:stale", ADAPTER_ID, ADAPTER_SECRET, stale_at),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_ATTESTATION_STALE");

        let rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(rows, 0, "not one of the four attempts may leave a row");

        // And with no adapter configured at all, even a correct-looking
        // attestation proves nothing.
        let error = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            build("sha256:no-adapters", ADAPTER_ID, ADAPTER_SECRET, issued_at),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_ADAPTER_UNKNOWN");

        cleanup(&pool, &[user]).await;
    }

    /// A replay answers with the stored row, so it cannot be used to upgrade a
    /// settled UNVERIFIED/OPERATOR_ASSERTED row into an attested one.
    #[tokio::test]
    async fn a_replay_cannot_upgrade_a_settled_trust() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("replay upgrade", None),
        )
        .await
        .unwrap();

        let (created, first) = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            evidence_request("sha256:settled"),
        )
        .await
        .unwrap();
        assert!(created);
        assert_eq!(first.verified_trust, "OPERATOR_ASSERTED");

        let issued_at = Utc::now();
        let upgrade = attested_request(
            &tuple(
                incident.id,
                "METRIC_SNAPSHOT",
                "prometheus",
                "sha256:settled",
                first.collected_at,
            ),
            ADAPTER_ID,
            ADAPTER_SECRET,
            issued_at,
        );
        let (created_again, second) =
            insert_evidence(&pool, &adapters(), caller(user), incident.id, upgrade)
                .await
                .unwrap();
        assert!(!created_again, "the identical tuple is one row, not two");
        assert_eq!(second.evidence_id, first.evidence_id);
        assert_eq!(
            second.verified_trust, "OPERATOR_ASSERTED",
            "a replay must not raise the trust of the row it answers with"
        );
        assert_eq!(second.verification_method, "OPERATOR_IDENTITY");

        cleanup(&pool, &[user]).await;
    }

    /// HTTP-level role matrix. The handler gate is the authority, so this drives
    /// the real axum handler with a real AuthUser per role instead of trusting
    /// that require_operator() is called.
    #[tokio::test]
    async fn viewer_is_refused_at_the_handler_and_operator_and_admin_are_not() {
        use axum::body::Body;
        use axum::http::Request;
        use axum::routing::post;
        use opsweave_contracts::Role;
        use tower::ServiceExt;

        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let viewer = seed_user(&pool, "viewer").await;
        let admin = seed_user(&pool, "admin").await;
        let (_, incident) =
            insert_incident(&pool, caller(owner), incident_request("role matrix", None))
                .await
                .unwrap();

        let state = AppState::new(
            crate::config::Config::from_env(),
            pool.clone(),
            vec![7_u8; 32],
        )
        .expect("test AppState");

        async fn post_as(
            state: AppState,
            user: AuthUser,
            incident_id: Uuid,
            ref_name: &str,
        ) -> (StatusCode, String) {
            use axum::middleware;
            let router = axum::Router::new()
                .route(
                    "/api/v1/incidents/{incident_id}/evidence",
                    post(append_evidence),
                )
                .layer(middleware::from_fn(
                    move |mut request: axum::extract::Request, next: middleware::Next| {
                        let user = user.clone();
                        async move {
                            request.extensions_mut().insert(user);
                            next.run(request).await
                        }
                    },
                ))
                .with_state(state);
            let body = serde_json::json!({
                "kind": "OPERATOR_NOTE",
                "source": "operator:role-matrix",
                "collectedAt": Utc::now().to_rfc3339(),
                "contentRef": ref_name,
            })
            .to_string();
            let response = router
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(format!("/api/v1/incidents/{incident_id}/evidence"))
                        .header("content-type", "application/json")
                        .body(Body::from(body))
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

        let as_role = |role: Role, id: Uuid| AuthUser {
            user_id: id,
            email: format!("{id}@example.invalid"),
            display_name: "role matrix".to_string(),
            role,
            session_id: Uuid::new_v4(),
            csrf_token: "csrf".to_string(),
            via_cookie: true,
        };

        let (status, body) = post_as(
            state.clone(),
            as_role(Role::Viewer, viewer),
            incident.id,
            "note:viewer",
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "body was {body}");
        assert!(body.contains("FORBIDDEN"));

        let (status, body) = post_as(
            state.clone(),
            as_role(Role::Operator, owner),
            incident.id,
            "note:operator",
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "body was {body}");
        assert!(
            body.contains("\"verifiedTrust\":\"OPERATOR_ASSERTED\""),
            "body was {body}"
        );

        let (status, body) = post_as(
            state.clone(),
            as_role(Role::Admin, admin),
            incident.id,
            "note:admin",
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "body was {body}");

        // Not one of the three writes produced attestation, whatever the role.
        let attested: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence
              WHERE incident_id=$1 AND (verified_trust='SOURCE_ATTESTED'
                 OR claimed_trust='SOURCE_ATTESTED')",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(attested, 0);

        cleanup(&pool, &[owner, viewer, admin]).await;
    }

    /// Second gate: even a hand-written INSERT cannot mint attestation. The
    /// handler is the first gate, this constraint is the one that survives a bug
    /// in the handler.
    #[tokio::test]
    async fn the_database_refuses_a_hand_written_attested_row() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(&pool, caller(user), incident_request("db gate", None))
            .await
            .unwrap();

        let direct = sqlx::query(
            "INSERT INTO kernel.incident_evidence
               (evidence_id,incident_id,kind,source,collected_at,content_ref,
                claimed_trust,verified_trust)
             VALUES ($1,$2,'LOG_EXCERPT','syslog',now(),'sha256:hand-written',
                     'SOURCE_ATTESTED','SOURCE_ATTESTED')",
        )
        .bind(Uuid::new_v4())
        .bind(incident.id)
        .execute(&pool)
        .await;
        let error = direct.expect_err("the schema must refuse SOURCE_ATTESTED without an adapter");
        let message = error.to_string();
        assert!(
            message.contains("incident_evidence_attestation_requires_adapter")
                || message.contains("incident_evidence_verification_check"),
            "unexpected database refusal: {message}"
        );

        let rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(rows, 0);

        cleanup(&pool, &[user]).await;
    }

    // -----------------------------------------------------------------------
    // G12 A3 - the evidence set a verdict stands on.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn a_verdict_freezes_the_evidence_set_it_considered() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("freeze the set", None),
        )
        .await
        .unwrap();

        for reference in ["sha256:considered-1", "sha256:considered-2"] {
            insert_evidence(
                &pool,
                &no_adapters(),
                caller(user),
                incident.id,
                evidence_request(reference),
            )
            .await
            .unwrap();
        }
        let before = query_evidence(&pool, caller(user), incident.id)
            .await
            .unwrap();
        assert!(before.iter().all(|row| !row.after_verdict));

        let verdict = insert_verdict(
            &pool,
            caller(user),
            incident.id,
            verdict_request("CONFIRMED"),
        )
        .await
        .unwrap();
        assert_eq!(verdict.considered_evidence_count, 2);
        assert_eq!(verdict.snapshot_kind, "RECORDED");
        let digest = verdict
            .considered_evidence_digest
            .clone()
            .expect("a recorded snapshot has a digest");
        assert_eq!(digest.len(), 64);
        assert!(digest.chars().all(|c| c.is_ascii_hexdigit()));

        // The capability is preserved: CONCLUDED still accepts evidence.
        let (created, late) = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            evidence_request("sha256:after-signing"),
        )
        .await
        .unwrap();
        assert!(created, "CONCLUDED must still accept evidence");
        assert!(
            late.after_verdict,
            "evidence added after signing was never before the signer"
        );

        let rows = query_evidence(&pool, caller(user), incident.id)
            .await
            .unwrap();
        let late_rows: Vec<_> = rows.iter().filter(|row| row.after_verdict).collect();
        assert_eq!(late_rows.len(), 1);
        assert_eq!(late_rows[0].evidence_id, late.evidence_id);
        let considered: Vec<_> = rows.iter().filter(|row| !row.after_verdict).collect();
        assert_eq!(considered.len(), 2);

        // The signed facts did not move when the evidence set did.
        let re_read = query_verdict(&pool, caller(user), incident.id)
            .await
            .unwrap();
        assert_eq!(re_read.considered_evidence_count, 2);
        assert_eq!(
            re_read.considered_evidence_digest.as_deref(),
            Some(digest.as_str())
        );
        assert_eq!(re_read.snapshot_kind, "RECORDED");
        let incident_view = query_incident(&pool, caller(user), incident.id)
            .await
            .unwrap();
        let human = incident_view.human_verdict.unwrap();
        assert_eq!(human.considered_evidence_count, 2);
        assert_eq!(
            human.considered_evidence_digest.as_deref(),
            Some(digest.as_str())
        );

        // Same set, same digest; the value is a function of the set only.
        let snapshot: Vec<(Uuid, String)> = considered
            .iter()
            .map(|row| {
                (
                    row.evidence_id,
                    evidence_row_digest(
                        row.evidence_id,
                        &row.kind,
                        &row.source,
                        &row.content_ref,
                        &row.verified_trust,
                    ),
                )
            })
            .collect();
        assert_eq!(considered_set_digest(&snapshot), digest);

        cleanup(&pool, &[user]).await;
    }

    /// A verdict signed before 0017 has no recorded set. It says so, and the
    /// after-verdict flag falls back to the only thing left - the timestamps -
    /// instead of pretending a reconstruction is a record.
    #[tokio::test]
    async fn a_pre_migration_verdict_reports_an_unknown_considered_set() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("legacy verdict", None),
        )
        .await
        .unwrap();
        insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            evidence_request("sha256:legacy-considered"),
        )
        .await
        .unwrap();
        insert_verdict(
            &pool,
            caller(user),
            incident.id,
            verdict_request("CONFIRMED"),
        )
        .await
        .unwrap();

        // Rewrite the row into the shape 0017 produces for a pre-existing
        // verdict: no snapshot, no digest, no count.
        sqlx::query("DELETE FROM kernel.incident_verdict_evidence WHERE incident_id=$1")
            .bind(incident.id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE kernel.incident_verdicts
                SET snapshot_kind='PRE_MIGRATION_UNRECORDED',
                    considered_evidence_count=0,
                    considered_evidence_digest=NULL
              WHERE incident_id=$1",
        )
        .bind(incident.id)
        .execute(&pool)
        .await
        .unwrap();

        let verdict = query_verdict(&pool, caller(user), incident.id)
            .await
            .unwrap();
        assert_eq!(verdict.snapshot_kind, "PRE_MIGRATION_UNRECORDED");
        assert_eq!(verdict.considered_evidence_count, 0);
        assert_eq!(
            verdict.considered_evidence_digest, None,
            "an unrecorded set must not be given a digest it never had"
        );

        // Evidence collected before the verdict stays on the signer's side of it.
        sqlx::query(
            "INSERT INTO kernel.incident_evidence
               (evidence_id,incident_id,kind,source,collected_at,content_ref,claimed_trust,
                verified_trust,verification_method,verified_at,submitted_by)
             VALUES ($1,$2,'LOG_EXCERPT','syslog',now(),'sha256:legacy-late','UNVERIFIED',
                     'UNVERIFIED','NONE',NULL,$3)",
        )
        .bind(Uuid::new_v4())
        .bind(incident.id)
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();

        let rows = query_evidence(&pool, caller(user), incident.id)
            .await
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert!(
            rows.iter().any(|row| row.after_verdict),
            "a row recorded after a legacy verdict is flagged by its timestamp"
        );
        assert!(
            rows.iter().any(|row| !row.after_verdict),
            "the row the signer could see is not flagged"
        );

        cleanup(&pool, &[user]).await;
    }
}
