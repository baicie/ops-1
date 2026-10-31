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
//!
//! G12 C adds the two operations the recorded lifecycle was missing - a controlled
//! CONCLUDED -> CLOSED and an ownership handover - plus the audit timeline the UI
//! reads. Both are argued in docs/design/g12-lifecycle/lifecycle-adr.md, and the
//! permission posture they inherit (rather than invent) is written down with
//! evidence in docs/design/g12-lifecycle/permission-model-decision.md.

use crate::audit::AuditEventView;
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
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
/// What the content read path selects out of kernel.incident_evidence_content:
/// (content type, body, verified byte length, recorded digest, retention horizon).
type StoredContent = (String, Vec<u8>, i32, String, DateTime<Utc>);
/// The evidence list's query window, as (since, until). Both are None or both are
/// Some; evidence_window enforces that before any SQL runs.
type EvidenceWindow = (Option<DateTime<Utc>>, Option<DateTime<Utc>>);
/// The two content types the Kernel stores and serves back verbatim. Exact match,
/// no charset parameter and no text/html: a content type the Kernel cannot serve
/// under its own security headers is a content type it does not accept
/// (docs/design/g12-evidence/evidence-content-adr.md §3.2).
const EVIDENCE_CONTENT_TYPES: &[&str] = &["text/plain", "application/json"];
/// Per-content byte bound. Bytes, not characters: the stored size is what costs,
/// and 64 KiB is a log excerpt or a JSON snapshot, not an archive.
const EVIDENCE_CONTENT_MAX_BYTES: usize = 65_536;
/// How many evidence rows one incident may hold. With the per-content bound this
/// is the total-size bound of a single incident (200 x 64 KiB, ~12.5 MiB).
const EVIDENCE_MAX_ROWS: i64 = 200;
/// The widest evidence query window the list endpoint accepts.
const EVIDENCE_QUERY_MAX_DAYS: i64 = 90;
/// How far ahead of the Kernel clock a collectedAt may sit. A future timestamp
/// makes "was this before or after the verdict" wrong forever, so it is refused
/// rather than stored and explained.
const COLLECTED_AT_FUTURE_SKEW_SECONDS: i64 = 300;
/// How old a collectedAt may be. Deliberately the same order as the 365-day
/// retention horizon: a claim older than that cannot correspond to content the
/// Kernel still serves.
const COLLECTED_AT_MAX_AGE_SECONDS: i64 = 400 * 86_400;
/// How long a closure note may be. Lower bound 4 because "fix" and "ok" are not
/// a reason; upper bound 1000 because this is a sentence, not a report.
const CLOSURE_NOTE_MIN_CHARS: usize = 4;
const CLOSURE_NOTE_MAX_CHARS: usize = 1000;
/// A handover reason is longer than a closure note on purpose: it is the only
/// place the transfer's justification survives, and the next owner has to be able
/// to understand why the incident is theirs.
const TRANSFER_REASON_MIN_CHARS: usize = 10;
const TRANSFER_REASON_MAX_CHARS: usize = 1000;
/// The client's idempotency key for a close. Bounded so a key is a key and not a
/// place to park a payload; long enough that a UUID or a ULID fits.
const CLOSURE_KEY_MIN_CHARS: usize = 8;
const CLOSURE_KEY_MAX_CHARS: usize = 200;
/// How many audit rows one timeline read may return. The page returns the NEWEST
/// `limit` events in chronological order and reports `truncated`, so a long-lived
/// incident loses its oldest events from the page rather than silently losing its
/// newest.
const TIMELINE_DEFAULT_EVENTS: i64 = 100;
const TIMELINE_MAX_EVENTS: i64 = 200;

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
    /// Where the content is claimed to live, for a submission that does not
    /// carry the bytes. Optional since 0018: a caller that supplies `content`
    /// gets a server-derived `sha256:<hex>` ref instead, and any value it sends
    /// here must be absent or exactly that one.
    #[serde(default)]
    pub content_ref: Option<String>,
    /// G12 B: the bytes themselves. Bounded, digested by the server over what it
    /// actually stored, stored write-once.
    #[serde(default)]
    pub content: Option<EvidenceContentRequest>,
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

/// The bytes of one evidence row, as submitted.
///
/// `body` is a JSON string, so it is valid UTF-8 by construction: this API stores
/// text, and a caller with binary evidence keeps using `contentRef` (which is the
/// Legacy reference semantics - the Kernel holds no bytes for it).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceContentRequest {
    /// text/plain or application/json, exact match.
    pub content_type: String,
    /// The content itself. Bounded by EVIDENCE_CONTENT_MAX_BYTES of UTF-8 bytes.
    pub body: String,
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
/// The body of POST /incidents/{id}/close.
///
/// expectedRevision is required rather than optional: a closure is a decision about
/// a record, and a decision taken about a record that has changed since it was read
/// is not the decision the operator made. There is deliberately no "force" flag -
/// a caller that wants to close over someone else's change has to re-read first.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseIncidentRequest {
    pub expected_revision: i64,
    /// Why the incident is over, in the closer's words.
    pub note: String,
    /// The client's own key for this close. Optional, and the only way a retried
    /// close is distinguishable from a second close: with a key, a replay of the
    /// closure that already happened answers 200; without one, the second call is a
    /// 409 and the operator is told the record is already closed.
    #[serde(default)]
    pub idempotency_key: Option<String>,
}

/// The body of POST /incidents/{id}/owner.
///
/// The five facts the handover records: who had it, who gets it, why, when, and
/// which version of the record this was decided against. Nothing about roles,
/// groups or tenancy travels with it (ADR-G12-003 §4).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferOwnerRequest {
    pub expected_revision: i64,
    pub to_owner: Uuid,
    pub reason: String,
}

/// What a completed handover answers with.
///
/// Deliberately NOT the incident: after a handover the transferring operator is, by
/// design, no longer allowed to read it (the owner column IS the operator read
/// scope). Answering with the incident would either leak a row the caller has just
/// lost access to, or have to be built as if the caller still had access. So the
/// answer is the handover itself.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerTransferView {
    pub incident_id: Uuid,
    pub previous_owner: Uuid,
    pub owner: Uuid,
    pub owner_assigned_at: DateTime<Utc>,
    pub reason: String,
    pub transferred_by: Uuid,
    pub transferred_at: DateTime<Utc>,
    /// The revision the incident holds after the handover, so a client can act on
    /// the new version without a round trip (and only for as long as it may read).
    pub revision: i64,
}

/// GET /incidents/{id}/timeline - the incident's own audit trail.
///
/// Scoped by the incident read predicate and not by the generic /api/v1/audit
/// filter: an operator must not be able to read the audit trail of an incident whose
/// record they cannot read.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncidentTimeline {
    pub items: Vec<AuditEventView>,
    /// True when the incident holds more audit rows than were returned. The page is
    /// then the newest `limit` events, oldest dropped, and it says so instead of
    /// looking complete.
    pub truncated: bool,
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

/// The evidence list's optional query window, on `collectedAt`.
///
/// There is no free-text search: this endpoint answers "which evidence rows of
/// this incident fall inside this window", and a missing window means all of
/// them (the pre-0018 behaviour). A window wider than
/// EVIDENCE_QUERY_MAX_DAYS is refused rather than served, because an unbounded
/// scan is a denial-of-service surface the caller chooses the cost of.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceListQuery {
    pub since: Option<String>,
    pub until: Option<String>,
}
/// The timeline read's only parameter. No free-text filter and no cursor: the
/// trail of one incident is bounded by the writes that endpoint set allows, so one
/// clamped page plus a `truncated` flag is the whole answer.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineQuery {
    pub limit: Option<u32>,
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
    /// When the current owner was assigned. Equal to createdAt for a row that has
    /// never been handed over.
    pub owner_assigned_at: DateTime<Utc>,
    /// G12 C: the version every lifecycle write arbitrates on. Bumped by a status
    /// transition, a closure and a handover; a client that writes with a stale one is
    /// told so (409) instead of overwriting a decision it never saw.
    pub revision: i64,
    /// When and by whom the incident was closed, and the closer's sentence. All three
    /// are NULL/absent unless status is CLOSED, and the database enforces that (0019
    /// incidents_closure_consistency_check) so a reader can treat them as the closure
    /// record rather than as hints.
    pub closed_at: Option<DateTime<Utc>>,
    pub closed_by: Option<Uuid>,
    pub closure_note: Option<String>,
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
    /// For a row with content this is the server-derived `sha256:<hex>` of the
    /// stored bytes; for a Legacy row it is whatever the submitter typed. The
    /// `content_status` field is what tells the two apart, not this one.
    pub content_ref: String,
    /// STORED | LEGACY_REFERENCE. Derived from the presence of a content row, so
    /// it cannot claim content the Kernel does not hold.
    pub content_status: String,
    /// The stored content type, or NULL for a Legacy reference.
    pub content_type: Option<String>,
    pub content_bytes: Option<i32>,
    /// sha256 the Kernel computed over the bytes it stored - never a client value.
    pub content_sha256: Option<String>,
    /// When the Kernel accepted the bytes (server clock).
    pub content_captured_at: Option<DateTime<Utc>>,
    /// capturedAt + 365 days. After this the content endpoint answers 410.
    pub content_retention_expires_at: Option<DateTime<Utc>>,
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
    owner_assigned_at: DateTime<Utc>,
    revision: i64,
    closed_at: Option<DateTime<Utc>>,
    closed_by: Option<Uuid>,
    closure_note: Option<String>,
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
            owner_assigned_at: self.owner_assigned_at,
            revision: self.revision,
            closed_at: self.closed_at,
            closed_by: self.closed_by,
            closure_note: self.closure_note,
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
    Query(query): Query<EvidenceListQuery>,
) -> AppResult<Json<EvidenceList>> {
    let caller = Caller::from_auth(&auth);
    let window = evidence_window(&query)?;
    let items = query_evidence(&state.db, caller, incident_id, window).await?;
    Ok(Json(EvidenceList { items }))
}

/// GET /incidents/{id}/evidence/{evidenceId}/content - the stored bytes.
///
/// Four answers, deliberately distinct, because the UI has four different things
/// to say: the bytes (200), "this row is a reference and the Kernel holds no
/// bytes for it" (404 EVIDENCE_CONTENT_NOT_STORED), "the bytes exist but are past
/// their retention horizon" (410), and "the bytes no longer match the digest the
/// Kernel recorded" (500 EVIDENCE_CONTENT_INTEGRITY_FAILED). Out of scope and
/// nonexistent both answer 404 INCIDENT_NOT_FOUND from the shared predicate.
pub async fn read_evidence_content(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((incident_id, evidence_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Response> {
    let caller = Caller::from_auth(&auth);
    // The authorization gate, and the only one: the same predicate the metadata
    // list applies, so nothing can be read as content where its row is invisible.
    incident_status(&state.db, caller, incident_id).await?;

    let stored: Option<StoredContent> = sqlx::query_as(
        "SELECT c.content_type, c.body, c.content_bytes, c.sha256, c.retention_expires_at
         FROM kernel.incident_evidence_content c
         JOIN kernel.incident_evidence e ON e.evidence_id = c.evidence_id
         WHERE c.evidence_id=$1 AND e.incident_id=$2",
    )
    .bind(evidence_id)
    .bind(incident_id)
    .fetch_optional(&state.db)
    .await?;

    let Some((content_type, body, content_bytes, recorded_sha256, retention_expires_at)) = stored
    else {
        // Whether the row exists at all decides which absence this is. Answering
        // "not stored" for an id from another incident would confirm nothing, but
        // it would also be untrue about this one.
        let row_exists: Option<Uuid> = sqlx::query_scalar(
            "SELECT evidence_id FROM kernel.incident_evidence
              WHERE evidence_id=$1 AND incident_id=$2",
        )
        .bind(evidence_id)
        .bind(incident_id)
        .fetch_optional(&state.db)
        .await?;
        return Err(if row_exists.is_some() {
            AppError::new(
                StatusCode::NOT_FOUND,
                "EVIDENCE_CONTENT_NOT_STORED",
                "this evidence row is a Legacy reference: the Kernel stored a locator and holds no content for it, so there is nothing it could serve",
            )
        } else {
            AppError::new(
                StatusCode::NOT_FOUND,
                "EVIDENCE_NOT_FOUND",
                "no evidence row with this id belongs to this incident",
            )
        });
    };

    if retention_expires_at <= Utc::now() {
        return Err(AppError::new(
            StatusCode::GONE,
            "EVIDENCE_CONTENT_EXPIRED",
            format!(
                "this content reached its retention horizon at {} and is no longer served",
                retention_expires_at.to_rfc3339()
            ),
        ));
    }

    // Fixity, recomputed over the bytes in hand - never read back from the column
    // that says what they should be. A mismatch is not repaired and not served.
    let actual = verify_stored_content(evidence_id, content_bytes, &body, &recorded_sha256)?;

    let mut response = Response::new(Body::from(body));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        if content_type == "application/json" {
            HeaderValue::from_static("application/json; charset=utf-8")
        } else {
            HeaderValue::from_static("text/plain; charset=utf-8")
        },
    );
    // The content is untrusted by definition (a log excerpt, a pasted note, a
    // JSON blob a source produced). These three headers are what make a direct
    // visit to this URL harmless: no sniffing, no script, no subresource, and no
    // copy left behind after the row expires or the caller loses access.
    headers.insert(
        header::HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    for (name, value) in [
        ("x-evidence-digest", actual.as_str()),
        ("x-evidence-content-type", content_type.as_str()),
    ] {
        if let Ok(value) = HeaderValue::from_str(value) {
            headers.insert(header::HeaderName::from_static(name), value);
        }
    }
    headers.insert(
        header::HeaderName::from_static("x-evidence-bytes"),
        HeaderValue::from_str(&body_len_string(content_bytes))
            .unwrap_or_else(|_| HeaderValue::from_static("0")),
    );
    Ok(response)
}

/// The `X-Evidence-Bytes` value: the verified length, formatted once so the
/// header cannot carry a value the fixity check did not agree with.
fn body_len_string(content_bytes: i32) -> String {
    content_bytes.to_string()
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
/// POST /incidents/{id}/close - the only way an incident becomes CLOSED.
///
/// Four gates, in this order, and the order is the contract: the state gate comes
/// before the version gate, because "this is not concludable" is the real obstacle
/// and "your revision is stale" would misdescribe it.
///
///   1. the caller may operate at all (viewer: 403);
///   2. the incident is visible to the caller and in status CONCLUDED (else 409
///      INCIDENT_CLOSE_REQUIRES_CONCLUDED - there is no path from OPEN);
///   3. a signed Human Verdict exists (else 409 INCIDENT_CLOSE_REQUIRES_VERDICT);
///   4. expectedRevision still matches (else 409 INCIDENT_VERSION_CONFLICT).
///
/// Concurrency: the row is locked FOR UPDATE and the UPDATE itself is a
/// compare-and-set on (status, revision), so of two simultaneous closes exactly one
/// commits and one is told why it did not.
pub async fn close_incident(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(incident_id): Path<Uuid>,
    body: Bytes,
) -> AppResult<Json<IncidentView>> {
    auth.require_operator()?;
    let payload: CloseIncidentRequest = parse_json(body)?;
    let caller = Caller::from_auth(&auth);
    Ok(Json(
        close_incident_record(&state.db, caller, incident_id, payload).await?,
    ))
}

/// POST /incidents/{id}/owner - hand one live incident to another operator.
///
/// Authorization: the current owner (an operator acting inside its own scope) or a
/// role that sees all incidents (admin). A different operator gets 404, not 403: the
/// incident is not theirs to read either, so naming the refusal would confirm a
/// record they cannot see.
pub async fn transfer_owner(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(incident_id): Path<Uuid>,
    body: Bytes,
) -> AppResult<Json<OwnerTransferView>> {
    auth.require_operator()?;
    let payload: TransferOwnerRequest = parse_json(body)?;
    let caller = Caller::from_auth(&auth);
    Ok(Json(
        transfer_incident_owner(&state.db, caller, incident_id, payload).await?,
    ))
}

/// GET /incidents/{id}/timeline - what happened to this incident, in order.
pub async fn get_timeline(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(incident_id): Path<Uuid>,
    Query(query): Query<TimelineQuery>,
) -> AppResult<Json<IncidentTimeline>> {
    let caller = Caller::from_auth(&auth);
    let limit = i64::from(query.limit.unwrap_or(TIMELINE_DEFAULT_EVENTS as u32))
        .clamp(1, TIMELINE_MAX_EVENTS);
    Ok(Json(
        query_timeline(&state.db, caller, incident_id, limit).await?,
    ))
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
    check_collected_at(payload.collected_at)?;
    // G12 B: the bytes are checked and digested before any SQL runs, so the
    // digest stored beside them is a statement about exactly what will be written
    // (docs/design/g12-evidence/evidence-content-adr.md §1.5).
    let content = match payload.content.as_ref() {
        Some(content) => Some(prepare_content(content)?),
        None => None,
    };
    // Either the caller's Legacy locator, or the one the Kernel derived from the
    // bytes. A supplied ref that disagrees is refused, never silently replaced.
    let content_ref = match (content.as_ref(), payload.content_ref.as_deref()) {
        (Some(prepared), supplied) => match supplied.map(str::trim).filter(|value| !value.is_empty())
        {
            None => prepared.content_ref.clone(),
            Some(supplied) if supplied == prepared.content_ref => prepared.content_ref.clone(),
            Some(_) => return Err(content_ref_conflict(&prepared.content_ref)),
        },
        (None, Some(supplied)) => bounded(supplied, "contentRef", 2, 1000)?,
        (None, None) => {
            return Err(AppError::bad_request(
                "contentRef is required when content is absent: a Legacy reference is the only thing that can stand in for bytes the Kernel does not hold",
            ))
        }
    };
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
    // The per-incident row cap, checked inside the transaction. Two concurrent
    // writers can still land one row each past the cap - a cross-row maximum
    // cannot be expressed as a row-level constraint - so the bound is "200 plus
    // at most the number of concurrent writers", stated in the ADR rather than
    // pretended away with a distributed lock.
    let existing_rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM kernel.incident_evidence WHERE incident_id=$1")
            .bind(incident_id)
            .fetch_one(&mut *tx)
            .await?;
    if existing_rows >= EVIDENCE_MAX_ROWS {
        tx.rollback().await?;
        return Err(AppError::conflict(
            "INCIDENT_EVIDENCE_LIMIT",
            format!(
                "this incident already holds {existing_rows} evidence rows and the cap is {EVIDENCE_MAX_ROWS}; a verdict has to be concluded from the evidence that exists rather than from an unbounded append log"
            ),
        ));
    }
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

    // The bytes, in the same transaction as the row that points at them. A
    // content row without its evidence row would be unreachable, and an evidence
    // row whose content insert failed would be a reference to bytes that were
    // never written - the exact defect this phase exists to remove.
    // retention_expires_at is left to its column default so the horizon lives in
    // one place (the migration) instead of in a second Rust constant that drifts.
    if let Some(prepared) = &content {
        sqlx::query(
            "INSERT INTO kernel.incident_evidence_content
               (evidence_id,content_type,body,content_bytes,sha256)
             VALUES ($1,$2,$3,$4,$5)",
        )
        .bind(stored_id)
        .bind(&prepared.content_type)
        .bind(prepared.body.as_slice())
        .bind(prepared.body.len() as i32)
        .bind(&prepared.sha256)
        .execute(&mut *tx)
        .await?;
    }

    // T2: an incident becomes INVESTIGATING when the first evidence lands. A
    // conditional UPDATE keeps this a compare-and-set: a concurrent verdict that
    // already moved the incident to CONCLUDED is never silently reopened. The
    // revision moves with the status, because a client holding the previous one is
    // looking at a record that has changed (G12 C).
    sqlx::query(
        "UPDATE kernel.incidents
            SET status='INVESTIGATING', revision=revision+1, updated_at=now()
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
            // G12 B: whether this write brought bytes, and which bytes. The
            // digest is the server's, so the trail records a checkable fact.
            "contentStatus": content.as_ref().map_or("LEGACY_REFERENCE", |_| "STORED"),
            "contentSha256": content.as_ref().map(|prepared| prepared.sha256.clone()),
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
    window: EvidenceWindow,
) -> AppResult<Vec<EvidenceView>> {
    incident_status(db, caller, incident_id).await?;
    Ok(sqlx::query_as::<_, EvidenceView>(&format!(
        "{EVIDENCE_SELECT} WHERE e.incident_id=$1
           AND ($2::timestamptz IS NULL OR e.collected_at >= $2)
           AND ($3::timestamptz IS NULL OR e.collected_at <= $3)
         ORDER BY e.collected_at DESC, e.evidence_id DESC"
    ))
    .bind(incident_id)
    .bind(window.0)
    .bind(window.1)
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
        "UPDATE kernel.incidents
            SET status='CONCLUDED', revision=revision+1, updated_at=now()
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

// ---------------------------------------------------------------------------
// G12 C · The two lifecycle operations
//
// Both are one transaction that holds the incident row lock (FOR UPDATE) and then
// writes through a compare-and-set on (status, revision). Neither writes its audit
// row after the commit: audit_in_tx runs on the same transaction, so a closure that
// cannot be described is a closure that did not happen.
// ---------------------------------------------------------------------------

async fn close_incident_record(
    db: &PgPool,
    caller: Caller,
    incident_id: Uuid,
    payload: CloseIncidentRequest,
) -> AppResult<IncidentView> {
    let note = bounded(
        &payload.note,
        "note",
        CLOSURE_NOTE_MIN_CHARS,
        CLOSURE_NOTE_MAX_CHARS,
    )?;
    if payload.expected_revision < 1 {
        return Err(AppError::bad_request(
            "expectedRevision must be the revision you read, which is 1 or greater",
        ));
    }
    let key = match payload
        .idempotency_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => Some(bounded(
            value,
            "idempotencyKey",
            CLOSURE_KEY_MIN_CHARS,
            CLOSURE_KEY_MAX_CHARS,
        )?),
        None => None,
    };

    let mut tx = db.begin().await?;
    // The read that decides, under the row lock: two closers are serialized here, so
    // the second one observes the first closure instead of overwriting it.
    let current: Option<(String, i64, Option<String>)> = sqlx::query_as(
        "SELECT status, revision, closure_key FROM kernel.incidents
          WHERE incident_id=$1 AND ($2::boolean OR owner=$3) FOR UPDATE",
    )
    .bind(incident_id)
    .bind(caller.sees_all)
    .bind(caller.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((status, revision, stored_key)) = current else {
        tx.rollback().await?;
        return Err(incident_not_found());
    };

    if status == "CLOSED" {
        // A replay of THIS closure answers with the closure that already happened: a
        // client whose first attempt timed out has to be able to ask again without
        // being told its own successful write is a conflict. Any other close of a
        // closed incident is a second decision, and is refused.
        if let (Some(key), Some(stored)) = (key.as_deref(), stored_key.as_deref()) {
            if key == stored {
                tx.rollback().await?;
                return query_incident(db, caller, incident_id).await;
            }
        }
        tx.rollback().await?;
        return Err(already_closed());
    }
    // No shortcut: CLOSED is reachable only from CONCLUDED, and CONCLUDED is only
    // reachable through a signed verdict. The schema enforces the same rule (0019
    // trigger), so this is the explainable refusal in front of the durable one.
    if status != "CONCLUDED" {
        tx.rollback().await?;
        return Err(close_requires_concluded(&status));
    }
    let signed: Option<Uuid> =
        sqlx::query_scalar("SELECT incident_id FROM kernel.incident_verdicts WHERE incident_id=$1")
            .bind(incident_id)
            .fetch_optional(&mut *tx)
            .await?;
    if signed.is_none() {
        tx.rollback().await?;
        return Err(close_requires_verdict());
    }
    if revision != payload.expected_revision {
        tx.rollback().await?;
        return Err(version_conflict(
            "close",
            revision,
            payload.expected_revision,
        ));
    }

    let closed_at: Option<DateTime<Utc>> = sqlx::query_scalar(
        "UPDATE kernel.incidents
            SET status='CLOSED', closed_at=now(), closed_by=$2, closure_note=$3,
                closure_key=$4, revision=revision+1, updated_at=now()
          WHERE incident_id=$1 AND status='CONCLUDED' AND revision=$5
          RETURNING closed_at",
    )
    .bind(incident_id)
    .bind(caller.user_id)
    .bind(&note)
    .bind(key.as_deref())
    .bind(payload.expected_revision)
    .fetch_optional(&mut *tx)
    .await
    .map_err(closure_write_refusal)?;
    let Some(closed_at) = closed_at else {
        // The lock was held, so this is the compare-and-set doing its job rather than
        // a race we can still see: report it as a state conflict, which is what it
        // would be, and never as a closure that happened.
        tx.rollback().await?;
        return Err(AppError::conflict(
            "INCIDENT_STATE_CONFLICT",
            "the incident changed state while the closure was being recorded; reload before retrying",
        ));
    };
    audit_in_tx(
        &mut tx,
        "INCIDENT_CLOSED",
        caller.user_id,
        incident_id,
        "CLOSE",
        serde_json::json!({
            "closedAt": closed_at,
            "closureNote": &note,
            // The key is recorded so the trail itself explains why a repeated request
            // was answered 200: this is the closure it replayed.
            "idempotencyKey": key,
            "revisionFrom": payload.expected_revision,
            "revisionTo": payload.expected_revision + 1,
        }),
    )
    .await?;
    tx.commit().await?;

    // Re-read inside the caller's own scope. The closer is the owner here (or a role
    // that sees everything), so this cannot turn a successful close into a 404.
    query_incident(db, caller, incident_id).await
}

async fn transfer_incident_owner(
    db: &PgPool,
    caller: Caller,
    incident_id: Uuid,
    payload: TransferOwnerRequest,
) -> AppResult<OwnerTransferView> {
    let reason = bounded(
        &payload.reason,
        "reason",
        TRANSFER_REASON_MIN_CHARS,
        TRANSFER_REASON_MAX_CHARS,
    )?;
    if payload.expected_revision < 1 {
        return Err(AppError::bad_request(
            "expectedRevision must be the revision you read, which is 1 or greater",
        ));
    }

    let mut tx = db.begin().await?;
    let current: Option<(String, i64, Uuid)> = sqlx::query_as(
        "SELECT status, revision, owner FROM kernel.incidents
          WHERE incident_id=$1 AND ($2::boolean OR owner=$3) FOR UPDATE",
    )
    .bind(incident_id)
    .bind(caller.sees_all)
    .bind(caller.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((status, revision, previous_owner)) = current else {
        tx.rollback().await?;
        return Err(incident_not_found());
    };
    // A closed record is final: no handover, no evidence, no verdict. Ownership of a
    // closed incident is a historical fact, so reassigning it would rewrite history
    // rather than hand over live work.
    if status == "CLOSED" {
        tx.rollback().await?;
        return Err(closed_refuses_transfer());
    }
    if revision != payload.expected_revision {
        tx.rollback().await?;
        return Err(version_conflict(
            "transfer",
            revision,
            payload.expected_revision,
        ));
    }
    if payload.to_owner == previous_owner {
        tx.rollback().await?;
        return Err(AppError::conflict(
            "INCIDENT_OWNER_UNCHANGED",
            "that account already owns this incident; a handover must name a different owner",
        ));
    }
    // The authorization scope of the new owner, which is exactly what the handover
    // grants: the target must be a real, enabled account whose role can operate.
    // Assigning to a viewer would hand an incident to a role that cannot act on it;
    // assigning to a disabled account creates work nobody can pick up.
    let target: Option<(String, bool)> =
        sqlx::query_as("SELECT role, disabled FROM kernel.users WHERE id=$1")
            .bind(payload.to_owner)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((role, disabled)) = target else {
        tx.rollback().await?;
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "INCIDENT_OWNER_UNKNOWN",
            "the target owner is not an account the Kernel knows",
        ));
    };
    if disabled {
        tx.rollback().await?;
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "INCIDENT_OWNER_DISABLED",
            "the target account is disabled and could not act on the incident",
        ));
    }
    let eligible = role
        .parse::<opsweave_contracts::Role>()
        .map(|parsed| parsed.can_operate())
        .unwrap_or(false);
    if !eligible {
        tx.rollback().await?;
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "INCIDENT_OWNER_ROLE_INELIGIBLE",
            "only an operator or admin account can own an incident: a viewer could not act on it and would lose nothing by not being named",
        ));
    }

    let updated: Option<(i64, DateTime<Utc>)> = sqlx::query_as(
        "UPDATE kernel.incidents
            SET owner=$2, owner_assigned_at=now(), revision=revision+1, updated_at=now()
          WHERE incident_id=$1 AND revision=$3 AND status<>'CLOSED'
          RETURNING revision, owner_assigned_at",
    )
    .bind(incident_id)
    .bind(payload.to_owner)
    .bind(payload.expected_revision)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((revision_to, transferred_at)) = updated else {
        tx.rollback().await?;
        return Err(AppError::conflict(
            "INCIDENT_STATE_CONFLICT",
            "the incident changed while the handover was being recorded; reload before retrying",
        ));
    };
    audit_in_tx(
        &mut tx,
        "INCIDENT_OWNER_TRANSFERRED",
        caller.user_id,
        incident_id,
        "TRANSFER_OWNER",
        serde_json::json!({
            "fromOwner": previous_owner,
            "toOwner": payload.to_owner,
            "reason": &reason,
            "revisionFrom": payload.expected_revision,
            "revisionTo": revision_to,
        }),
    )
    .await?;
    tx.commit().await?;

    Ok(OwnerTransferView {
        incident_id,
        previous_owner,
        owner: payload.to_owner,
        owner_assigned_at: transferred_at,
        reason,
        transferred_by: caller.user_id,
        transferred_at,
        revision: revision_to,
    })
}

async fn query_timeline(
    db: &PgPool,
    caller: Caller,
    incident_id: Uuid,
    limit: i64,
) -> AppResult<IncidentTimeline> {
    // The authorization is the incident read predicate, not a filter on the audit
    // table: an operator cannot reach the trail of an incident it cannot read, even
    // though /api/v1/audit would happily answer with it.
    incident_status(db, caller, incident_id).await?;
    let subject = incident_id.to_string();
    let total: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM kernel.audit_events
          WHERE subject_type='INCIDENT' AND subject_id=$1",
    )
    .bind(&subject)
    .fetch_one(db)
    .await?;
    let mut items = sqlx::query_as::<_, AuditEventView>(
        "SELECT id, event_type, actor_type, actor_id, subject_type, subject_id,
                action, result, details, request_id, occurred_at
           FROM kernel.audit_events
          WHERE subject_type='INCIDENT' AND subject_id=$1
          ORDER BY occurred_at DESC, id DESC
          LIMIT $2",
    )
    .bind(&subject)
    .bind(limit)
    .fetch_all(db)
    .await?;
    // Newest-first is how the page is bounded; chronological is how a trail is read.
    // The reverse happens here so the client never has to know which direction the
    // LIMIT ran in.
    items.reverse();
    Ok(IncidentTimeline {
        items,
        truncated: total > limit,
    })
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
// G12 B · Evidence content: bounded bytes, a digest the Kernel computed over what
// it stored, and a read path that fails loudly instead of serving doubt.
// ---------------------------------------------------------------------------

/// A content payload that passed every check, ready to be stored in the same
/// transaction as the evidence row it belongs to.
struct PreparedContent {
    content_type: String,
    body: Vec<u8>,
    /// sha256 (lowercase hex) over `body` - computed here, over the bytes that are
    /// about to be written, and stored beside them.
    sha256: String,
    /// The locator the Kernel derives: `sha256:<hex>`. Since it is the digest of
    /// the stored bytes, the Phase A verdict snapshot (which binds contentRef)
    /// commits to the content transitively.
    content_ref: String,
}

/// sha256 (lowercase hex) over bytes in hand.
///
/// One implementation for both the write side (the bytes about to be stored) and
/// the read side (the bytes just read back), because two implementations of "the
/// digest" is exactly how a fixity check starts passing on corrupt data.
fn digest_of(body: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(body);
    hex::encode(hasher.finalize())
}

/// The fixity check, in one place so the read path and the tests agree on what
/// "the content is intact" means.
///
/// Returns the digest computed over `body` (the value that goes into the response
/// header), or an error naming both digests and both lengths. It never repairs
/// anything: a stored digest that no longer matches its bytes is a fact about the
/// database, and rewriting the digest would launder the tamper into a normal row.
fn verify_stored_content(
    evidence_id: Uuid,
    content_bytes: i32,
    body: &[u8],
    recorded_sha256: &str,
) -> AppResult<String> {
    let actual = digest_of(body);
    if actual == recorded_sha256 && body.len() == content_bytes.max(0) as usize {
        return Ok(actual);
    }
    tracing::error!(
        evidence_id = %evidence_id,
        recorded_sha256 = %recorded_sha256,
        actual_sha256 = %actual,
        recorded_bytes = content_bytes,
        actual_bytes = body.len(),
        "evidence content integrity check failed; refusing to serve the bytes"
    );
    Err(AppError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "EVIDENCE_CONTENT_INTEGRITY_FAILED",
        format!(
            "the stored bytes no longer match the digest recorded with them (recorded {recorded_sha256} over {content_bytes} bytes, computed {actual} over {} bytes); the Kernel does not serve content it cannot verify",
            body.len()
        ),
    ))
}

fn prepare_content(content: &EvidenceContentRequest) -> AppResult<PreparedContent> {
    let content_type = content.content_type.trim().to_ascii_lowercase();
    if !EVIDENCE_CONTENT_TYPES.contains(&content_type.as_str()) {
        return Err(AppError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "EVIDENCE_CONTENT_TYPE_UNSUPPORTED",
            format!(
                "contentType must be exactly one of {}; the Kernel serves content back verbatim and stores no type it cannot serve safely",
                EVIDENCE_CONTENT_TYPES.join(", ")
            ),
        ));
    }
    let body = content.body.as_bytes();
    if body.is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "EVIDENCE_CONTENT_EMPTY",
            "content.body is empty; an evidence row with no bytes is a Legacy reference, so omit content and send contentRef instead",
        ));
    }
    // Bytes, not characters: the stored size is what is bounded.
    if body.len() > EVIDENCE_CONTENT_MAX_BYTES {
        return Err(AppError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "EVIDENCE_CONTENT_TOO_LARGE",
            format!(
                "content.body is {} bytes and the Kernel stores at most {EVIDENCE_CONTENT_MAX_BYTES} bytes per evidence row; content is refused rather than truncated, because a truncated excerpt is a different piece of evidence",
                body.len()
            ),
        ));
    }
    let sha256 = digest_of(body);
    Ok(PreparedContent {
        content_type,
        content_ref: format!("sha256:{sha256}"),
        body: body.to_vec(),
        sha256,
    })
}

/// Refuses a supplied contentRef that disagrees with the bytes being stored.
fn content_ref_conflict(derived: &str) -> AppError {
    AppError::new(
        StatusCode::BAD_REQUEST,
        "EVIDENCE_CONTENT_REF_CONFLICT",
        format!(
            "content was supplied, so the Kernel derives contentRef from the bytes it stored ({derived}); a supplied contentRef must be absent or exactly that value - a digest the caller computed is not evidence the Kernel checked anything"
        ),
    )
}

/// The capture window's claim half: collectedAt is the submitter's statement
/// about when the source saw this, and a claim the clock cannot coexist with is
/// refused rather than stored and explained later.
fn check_collected_at(collected_at: DateTime<Utc>) -> AppResult<()> {
    let now = Utc::now();
    let ahead = (collected_at - now).num_seconds();
    if ahead > COLLECTED_AT_FUTURE_SKEW_SECONDS {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "EVIDENCE_COLLECTED_AT_IN_FUTURE",
            format!(
                "collectedAt is {ahead}s ahead of the Kernel clock (at most {COLLECTED_AT_FUTURE_SKEW_SECONDS}s of skew is accepted); a future timestamp makes every before/after comparison against a verdict wrong"
            ),
        ));
    }
    let age = (now - collected_at).num_seconds();
    if age > COLLECTED_AT_MAX_AGE_SECONDS {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "EVIDENCE_COLLECTED_AT_TOO_OLD",
            format!(
                "collectedAt is {age}s in the past, which is older than the {COLLECTED_AT_MAX_AGE_SECONDS}s horizon this Kernel accepts: content that old is past its retention and cannot be verified"
            ),
        ));
    }
    Ok(())
}

/// The evidence list's query window, validated before any SQL runs.
///
/// Both ends or neither: a half-bounded window would make the scan bound depend
/// on the Kernel clock at read time, which is a cheaper rule to explain and to
/// test than "the open end is bounded by now".
fn evidence_window(query: &EvidenceListQuery) -> AppResult<EvidenceWindow> {
    let parse = |raw: Option<&str>, field: &str| -> AppResult<Option<DateTime<Utc>>> {
        let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        DateTime::parse_from_rfc3339(raw)
            .map(|value| Some(value.with_timezone(&Utc)))
            .map_err(|_| window_invalid(&format!("{field} is not an RFC 3339 instant")))
    };
    let since = parse(query.since.as_deref(), "since")?;
    let until = parse(query.until.as_deref(), "until")?;
    match (since, until) {
        (None, None) => Ok((None, None)),
        (Some(since), Some(until)) => {
            if since > until {
                return Err(window_invalid("since is after until"));
            }
            if (until - since).num_days() > EVIDENCE_QUERY_MAX_DAYS {
                return Err(window_invalid(&format!(
                    "the window is wider than the {EVIDENCE_QUERY_MAX_DAYS}-day maximum"
                )));
            }
            Ok((Some(since), Some(until)))
        }
        _ => Err(window_invalid(
            "since and until must be supplied together: a half-bounded window has no fixed width",
        )),
    }
}

fn window_invalid(detail: &str) -> AppError {
    AppError::new(
        StatusCode::BAD_REQUEST,
        "INCIDENT_EVIDENCE_WINDOW_INVALID",
        format!("{detail}; supply since and until as RFC 3339 UTC instants within {EVIDENCE_QUERY_MAX_DAYS} days of each other"),
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
       i.owner_assigned_at, i.revision, i.closed_at, i.closed_by, i.closure_note,
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
       CASE WHEN c.evidence_id IS NULL THEN 'LEGACY_REFERENCE' ELSE 'STORED' END
         AS content_status,
       c.content_type, c.content_bytes, c.sha256 AS content_sha256,
       c.captured_at AS content_captured_at,
       c.retention_expires_at AS content_retention_expires_at,
       CASE
         WHEN v.incident_id IS NULL THEN false
         WHEN v.snapshot_kind = 'RECORDED' THEN NOT EXISTS (
           SELECT 1 FROM kernel.incident_verdict_evidence s
           WHERE s.incident_id = e.incident_id AND s.evidence_id = e.evidence_id
         )
         ELSE e.created_at > v.decided_at
       END AS after_verdict
FROM kernel.incident_evidence e
LEFT JOIN kernel.incident_verdicts v ON v.incident_id = e.incident_id
LEFT JOIN kernel.incident_evidence_content c ON c.evidence_id = e.evidence_id"#;

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
/// A closure of a record that is already closed, by a request that is not a replay
/// of the closure that happened (no key, or a different one).
fn already_closed() -> AppError {
    AppError::conflict(
        "INCIDENT_ALREADY_CLOSED",
        "this incident is already closed; the closure on record stands",
    )
}

/// Every write path's answer to a closed incident. One shared refusal so the four
/// write endpoints (evidence, verdict, close, transfer) cannot describe the same
/// state four different ways.
fn closed_refuses_transfer() -> AppError {
    AppError::conflict(
        "INCIDENT_CLOSED",
        "this incident is closed and accepts no handover: ownership of a closed record is history, not live work",
    )
}

/// The no-shortcut refusal: CLOSED is reachable only from CONCLUDED.
fn close_requires_concluded(status: &str) -> AppError {
    AppError::conflict(
        "INCIDENT_CLOSE_REQUIRES_CONCLUDED",
        format!(
            "this incident is {status}, so it cannot be closed; CLOSED is reachable only from CONCLUDED, and CONCLUDED is what recording a Human Verdict does"
        ),
    )
}

/// The verdict gate. Reached when the status says CONCLUDED but no signed verdict
/// exists - a state the schema's trigger also refuses to close through.
fn close_requires_verdict() -> AppError {
    AppError::conflict(
        "INCIDENT_CLOSE_REQUIRES_VERDICT",
        "this incident has no Human Verdict, so closing it would record a conclusion nobody signed; record the verdict first",
    )
}

/// A stale expectedRevision. The message names both versions because the client's
/// only useful next action is to re-read and decide again.
fn version_conflict(operation: &str, current: i64, expected: i64) -> AppError {
    AppError::conflict(
        "INCIDENT_VERSION_CONFLICT",
        format!(
            "this incident is at revision {current} and the {operation} was decided against revision {expected}; re-read it and repeat the decision"
        ),
    )
}

/// A closure refused by the schema rather than by this handler.
///
/// The handler checks the same two rules first, so reaching this means the durable
/// guard is stricter than the code above it - exactly the case where a generic 500
/// would hide an invariant. It is translated back into the 409 the client can act
/// on, and anything else stays a 500.
fn closure_write_refusal(error: sqlx::Error) -> AppError {
    let text = error.to_string();
    if text.contains("no human verdict") {
        return close_requires_verdict();
    }
    if text.contains("cannot be closed from status") {
        return close_requires_concluded("not CONCLUDED");
    }
    if text.contains("cannot return to") {
        return AppError::conflict(
            "INCIDENT_ALREADY_CLOSED",
            "a closed incident cannot be reopened: a closure is final",
        );
    }
    AppError::internal(error)
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
            // G12 C: incidents.closed_by, incident_evidence.submitted_by and
            // incident_verdicts.decided_by are all foreign keys onto kernel.users, and a
            // handover deliberately separates the account that acted from the account
            // that owns the row. So the set deleted here is every incident one of these
            // accounts touched - as owner, as the closer of record, as a submitter or as
            // the signer - before the accounts themselves go.
            let incidents = "
                SELECT i.incident_id FROM kernel.incidents i
                 WHERE i.owner=$1 OR i.closed_by=$1
                    OR EXISTS (SELECT 1 FROM kernel.incident_evidence e
                                WHERE e.incident_id=i.incident_id AND e.submitted_by=$1)
                    OR EXISTS (SELECT 1 FROM kernel.incident_verdicts v
                                WHERE v.incident_id=i.incident_id AND v.decided_by=$1)";
            // G12 B: content rows cannot be deleted on their own (the write-once
            // trigger refuses), and they are not left behind either: the foreign
            // key cascades from the evidence row, which is the one delete the
            // trigger allows. So this cleanup deletes evidence and the bytes follow
            // - no test has to switch a lock off to clean up after itself.
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
            content_ref: Some(content_ref.to_string()),
            content: None,
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
            content_ref: Some(bound.content_ref.to_string()),
            content: None,
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
    fn close_request(revision: i64, note: &str) -> CloseIncidentRequest {
        CloseIncidentRequest {
            expected_revision: revision,
            note: note.to_string(),
            idempotency_key: None,
        }
    }

    fn keyed_close_request(revision: i64, note: &str, key: &str) -> CloseIncidentRequest {
        CloseIncidentRequest {
            expected_revision: revision,
            note: note.to_string(),
            idempotency_key: Some(key.to_string()),
        }
    }

    fn transfer_request(revision: i64, to_owner: Uuid, reason: &str) -> TransferOwnerRequest {
        TransferOwnerRequest {
            expected_revision: revision,
            to_owner,
            reason: reason.to_string(),
        }
    }

    /// An incident walked to CONCLUDED through the same data paths the endpoints
    /// call: one evidence row, then a signed verdict. No test may reach CONCLUDED by
    /// writing the status, because then it would be proving a state the product
    /// cannot produce.
    async fn concluded_incident(pool: &PgPool, user: Uuid, title: &str) -> IncidentView {
        let (_, incident) = insert_incident(pool, caller(user), incident_request(title, None))
            .await
            .unwrap();
        insert_evidence(
            pool,
            &no_adapters(),
            caller(user),
            incident.id,
            evidence_request(&format!("sha256:{}", Uuid::new_v4().simple())),
        )
        .await
        .unwrap();
        insert_verdict(
            pool,
            caller(user),
            incident.id,
            verdict_request("CONFIRMED"),
        )
        .await
        .unwrap();
        query_incident(pool, caller(user), incident.id)
            .await
            .unwrap()
    }

    /// The same walk, one step further: the closure, through close_incident_record.
    async fn closed_incident(pool: &PgPool, user: Uuid, title: &str) -> IncidentView {
        let concluded = concluded_incident(pool, user, title).await;
        close_incident_record(
            pool,
            caller(user),
            concluded.id,
            close_request(concluded.revision, "resolved: the node came back"),
        )
        .await
        .unwrap()
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
            owner_assigned_at: Utc::now(),
            revision: 1,
            closed_at: None,
            closed_by: None,
            closure_note: None,
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
            query_evidence(&pool, caller(user), incident.id, (None, None))
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

    // -----------------------------------------------------------------------
    // G12 C1 - the controlled CONCLUDED -> CLOSED.
    //
    // Every test here walks the incident through the real data paths (evidence,
    // verdict, close) rather than writing status='CLOSED' by hand: a test that
    // injects the state it is testing proves the guard around a state the product
    // cannot produce.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn closing_a_concluded_incident_records_the_closure_and_its_audit() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let concluded = concluded_incident(&pool, user, "disk full on node-7").await;
        assert_eq!(concluded.status, "CONCLUDED");
        assert!(concluded.closed_at.is_none());
        let revision_before = concluded.revision;

        let closed = close_incident_record(
            &pool,
            caller(user),
            concluded.id,
            close_request(revision_before, "root cause was log rotation; fixed"),
        )
        .await
        .unwrap();

        assert_eq!(closed.status, "CLOSED");
        assert_eq!(closed.closed_by, Some(user));
        assert_eq!(
            closed.closure_note.as_deref(),
            Some("root cause was log rotation; fixed")
        );
        assert!(closed.closed_at.is_some());
        assert_eq!(
            closed.revision,
            revision_before + 1,
            "a closure is a change to the record, so the version moves with it"
        );
        // The verdict is untouched by the closure: it is what the closure stands on,
        // not a step that gets rewritten.
        assert!(closed.human_verdict.is_some());
        assert_eq!(audit_rows(&pool, concluded.id, "INCIDENT_CLOSED").await, 1);

        cleanup(&pool, &[user]).await;
    }
    /// The direct jump the state machine must not have.
    #[tokio::test]
    async fn an_open_or_investigating_incident_cannot_jump_straight_to_closed() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, open) =
            insert_incident(&pool, caller(user), incident_request("never triaged", None))
                .await
                .unwrap();

        // OPEN -> CLOSED, refused with the reason and the current status.
        let error = close_incident_record(
            &pool,
            caller(user),
            open.id,
            close_request(open.revision, "closing without investigating"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(error.code, "INCIDENT_CLOSE_REQUIRES_CONCLUDED");
        assert!(
            error.message.contains("OPEN"),
            "the refusal must say which status refused it: {}",
            error.message
        );

        // INVESTIGATING -> CLOSED, same refusal: evidence is not a conclusion.
        insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            open.id,
            evidence_request("sha256:first-look"),
        )
        .await
        .unwrap();
        let investigating = query_incident(&pool, caller(user), open.id).await.unwrap();
        assert_eq!(investigating.status, "INVESTIGATING");
        let error = close_incident_record(
            &pool,
            caller(user),
            open.id,
            close_request(investigating.revision, "still closing without a verdict"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_CLOSE_REQUIRES_CONCLUDED");

        // Neither refusal wrote anything.
        let after = query_incident(&pool, caller(user), open.id).await.unwrap();
        assert_eq!(after.status, "INVESTIGATING");
        assert!(after.closed_at.is_none());
        assert_eq!(after.revision, investigating.revision);
        assert_eq!(audit_rows(&pool, open.id, "INCIDENT_CLOSED").await, 0);

        cleanup(&pool, &[user]).await;
    }

    /// A closure stands on a signed verdict, in the handler AND in the schema.
    #[tokio::test]
    async fn closing_without_a_signed_verdict_is_refused_twice_over() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("concluded by hand", None),
        )
        .await
        .unwrap();
        // The only way to be CONCLUDED without a verdict is a hand-written UPDATE.
        sqlx::query("UPDATE kernel.incidents SET status='CONCLUDED' WHERE incident_id=$1")
            .bind(incident.id)
            .execute(&pool)
            .await
            .unwrap();

        let error = close_incident_record(
            &pool,
            caller(user),
            incident.id,
            close_request(1, "nothing was signed here"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(error.code, "INCIDENT_CLOSE_REQUIRES_VERDICT");

        // And the schema refuses the same closure one layer down, so a bug in the
        // handler cannot close an unsigned incident either.
        let direct = sqlx::query(
            "UPDATE kernel.incidents
                SET status='CLOSED', closed_at=now(), closed_by=$2 WHERE incident_id=$1",
        )
        .bind(incident.id)
        .bind(user)
        .execute(&pool)
        .await;
        let message = direct
            .expect_err("the schema must refuse a closure with no signed verdict")
            .to_string();
        assert!(
            message.contains("no human verdict"),
            "unexpected database refusal: {message}"
        );

        cleanup(&pool, &[user]).await;
    }
    /// Two operators closing the same incident at the same instant.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn two_simultaneous_closes_produce_exactly_one_closure() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let concluded = concluded_incident(&pool, user, "flapping link").await;
        let revision = concluded.revision;

        let (first, second) = tokio::join!(
            close_incident_record(
                &pool,
                caller(user),
                concluded.id,
                close_request(revision, "closed by the first caller"),
            ),
            close_incident_record(
                &pool,
                caller(user),
                concluded.id,
                close_request(revision, "closed by the second caller"),
            ),
        );

        let succeeded = [&first, &second]
            .iter()
            .filter(|result| result.is_ok())
            .count();
        assert_eq!(
            succeeded, 1,
            "exactly one close may win: first={first:?} second={second:?}"
        );
        let loser = match (first, second) {
            (Err(error), _) => error,
            (_, Err(error)) => error,
            _ => unreachable!("the assertion above already proved one close failed"),
        };
        assert_eq!(loser.status, StatusCode::CONFLICT);
        assert!(
            matches!(
                loser.code,
                "INCIDENT_ALREADY_CLOSED" | "INCIDENT_VERSION_CONFLICT" | "INCIDENT_STATE_CONFLICT"
            ),
            "the losing close must be told why, not handed a 500: {}",
            loser.code
        );

        // One closure of record: one audit row, one closed_at.
        assert_eq!(audit_rows(&pool, concluded.id, "INCIDENT_CLOSED").await, 1);
        let row: (i64, i64) = sqlx::query_as(
            "SELECT count(*), count(DISTINCT closed_at::text)::bigint FROM kernel.incidents
              WHERE incident_id=$1 AND status='CLOSED'",
        )
        .bind(concluded.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row, (1, 1));

        cleanup(&pool, &[user]).await;
    }

    /// Idempotency: a retried close is the closure that happened; a second close is
    /// a second decision and is refused.
    #[tokio::test]
    async fn a_retried_close_is_answered_with_the_closure_it_repeats() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let concluded = concluded_incident(&pool, user, "cache stampede").await;
        let revision = concluded.revision;
        let key = format!("close-{}", Uuid::new_v4().simple());

        let first = close_incident_record(
            &pool,
            caller(user),
            concluded.id,
            keyed_close_request(revision, "fixed by warming the cache", &key),
        )
        .await
        .unwrap();
        let replay = close_incident_record(
            &pool,
            caller(user),
            concluded.id,
            keyed_close_request(
                revision,
                "a second note that must not replace the first",
                &key,
            ),
        )
        .await
        .unwrap();

        assert_eq!(replay.status, "CLOSED");
        assert_eq!(
            replay.closed_at, first.closed_at,
            "a replay must answer with the closure of record, not with a new one"
        );
        assert_eq!(
            replay.closure_note, first.closure_note,
            "the replay must not rewrite the reason the first close recorded"
        );
        assert_eq!(
            replay.revision, first.revision,
            "a replay changes nothing, so the version does not move either"
        );
        assert_eq!(audit_rows(&pool, concluded.id, "INCIDENT_CLOSED").await, 1);

        // A different key is a second closure attempt, not a retry.
        let error = close_incident_record(
            &pool,
            caller(user),
            concluded.id,
            keyed_close_request(
                first.revision,
                "closing it again on purpose",
                "a-different-key",
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(error.code, "INCIDENT_ALREADY_CLOSED");

        // And a caller with no key at all cannot claim a retry.
        let error = close_incident_record(
            &pool,
            caller(user),
            concluded.id,
            close_request(first.revision, "closing it again with no key"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_ALREADY_CLOSED");

        cleanup(&pool, &[user]).await;
    }

    /// The closure and the audit row that describes it are one transaction.
    #[tokio::test]
    async fn a_failed_audit_rolls_the_closure_back() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let concluded = concluded_incident(&pool, user, "io error burst").await;
        let revision = concluded.revision;

        let probe = refuse_audit(&pool, "INCIDENT_CLOSED", user).await;
        let refused = close_incident_record(
            &pool,
            caller(user),
            concluded.id,
            close_request(revision, "closing while the audit table refuses"),
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

        let after = query_incident(&pool, caller(user), concluded.id)
            .await
            .unwrap();
        assert_eq!(
            after.status, "CONCLUDED",
            "a closure without its audit row must not exist"
        );
        assert!(after.closed_at.is_none());
        assert_eq!(after.revision, revision);

        // The same request succeeds once the audit can be written, which is what
        // makes the previous 500 a rollback rather than a poisoned state.
        let closed = close_incident_record(
            &pool,
            caller(user),
            concluded.id,
            close_request(revision, "retried after the audit table recovered"),
        )
        .await
        .unwrap();
        assert_eq!(closed.status, "CLOSED");
        assert_eq!(audit_rows(&pool, concluded.id, "INCIDENT_CLOSED").await, 1);

        cleanup(&pool, &[user]).await;
    }

    /// After CLOSED: every write is refused, and there is no way back.
    #[tokio::test]
    async fn a_closed_incident_refuses_every_write_and_cannot_be_reopened() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let other = seed_user(&pool, "operator").await;
        let closed = closed_incident(&pool, user, "old noise").await;
        assert_eq!(closed.status, "CLOSED");

        for (code, error) in [
            (
                "INCIDENT_CLOSED",
                insert_evidence(
                    &pool,
                    &no_adapters(),
                    caller(user),
                    closed.id,
                    evidence_request("sha256:late"),
                )
                .await
                .unwrap_err(),
            ),
            (
                "INCIDENT_CLOSED",
                insert_verdict(
                    &pool,
                    caller(user),
                    closed.id,
                    verdict_request("INCONCLUSIVE"),
                )
                .await
                .unwrap_err(),
            ),
            (
                "INCIDENT_ALREADY_CLOSED",
                close_incident_record(
                    &pool,
                    caller(user),
                    closed.id,
                    close_request(closed.revision, "closing it a second time"),
                )
                .await
                .unwrap_err(),
            ),
        ] {
            assert_eq!(error.code, code, "unexpected refusal: {}", error.message);
        }

        // A handover of a closed record is refused too: ownership of history is not
        // live work, and reassigning it would rewrite who was accountable.
        let error = transfer_incident_owner(
            &pool,
            caller(user),
            closed.id,
            transfer_request(closed.revision, other, "handing over a closed record"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_CLOSED");

        // No reopening, not even by hand: the schema refuses the status move.
        let reopened =
            sqlx::query("UPDATE kernel.incidents SET status='INVESTIGATING' WHERE incident_id=$1")
                .bind(closed.id)
                .execute(&pool)
                .await;
        let message = reopened
            .expect_err("a closed incident must not return to another status")
            .to_string();
        assert!(
            message.contains("cannot return to"),
            "unexpected database refusal: {message}"
        );

        // The worst case the rule names: delete the verdict, then try to reopen. The
        // verdict is gone (no endpoint can do this; a table owner just did), and the
        // incident is STILL closed.
        sqlx::query("DELETE FROM kernel.incident_verdicts WHERE incident_id=$1")
            .bind(closed.id)
            .execute(&pool)
            .await
            .unwrap();
        let reopened =
            sqlx::query("UPDATE kernel.incidents SET status='CONCLUDED' WHERE incident_id=$1")
                .bind(closed.id)
                .execute(&pool)
                .await;
        let message = reopened
            .expect_err("deleting the verdict must not reopen a closed incident")
            .to_string();
        assert!(
            message.contains("cannot return to"),
            "unexpected database refusal: {message}"
        );
        let status: String =
            sqlx::query_scalar("SELECT status FROM kernel.incidents WHERE incident_id=$1")
                .bind(closed.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "CLOSED");

        cleanup(&pool, &[user, other]).await;
    }
    // -----------------------------------------------------------------------
    // G12 C2 - the ownership handover.
    //
    // The owner column IS the operator read predicate (jobs.rs:1883), so a handover
    // is not a bookkeeping change: it moves who can read and write the incident. Every
    // test below therefore asserts the READ scope as well as the write scope, before
    // and after, for both accounts.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn a_handover_moves_the_read_and_write_scope_between_the_two_operators() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let old_owner = seed_user(&pool, "operator").await;
        let new_owner = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(old_owner),
            incident_request("shift change", None),
        )
        .await
        .unwrap();
        insert_evidence(
            &pool,
            &no_adapters(),
            caller(old_owner),
            incident.id,
            evidence_request("sha256:old-owner-note"),
        )
        .await
        .unwrap();

        // --- before the handover -------------------------------------------
        // Old owner: reads the record and its trail, and can write.
        let before = query_incident(&pool, caller(old_owner), incident.id)
            .await
            .unwrap();
        assert_eq!(before.owner, old_owner);
        assert!(query_timeline(&pool, caller(old_owner), incident.id, 50)
            .await
            .is_ok());
        // New owner: nothing. Not a 403 - a 404, because the record is not theirs to
        // know about.
        for error in [
            query_incident(&pool, caller(new_owner), incident.id)
                .await
                .unwrap_err(),
            query_timeline(&pool, caller(new_owner), incident.id, 50)
                .await
                .unwrap_err(),
        ] {
            assert_eq!(error.status, StatusCode::NOT_FOUND);
            assert_eq!(error.code, "INCIDENT_NOT_FOUND");
        }
        // ... and their LIST does not contain it, which is the scope that matters when
        // nobody asks for a specific id.
        let listed = query_incidents(&pool, caller(new_owner), IncidentListQuery::default())
            .await
            .unwrap()
            .0;
        assert!(!listed.iter().any(|view| view.id == incident.id));

        // --- the handover ---------------------------------------------------
        let handover = transfer_incident_owner(
            &pool,
            caller(old_owner),
            incident.id,
            transfer_request(
                before.revision,
                new_owner,
                "night shift takes over; the pager is with them",
            ),
        )
        .await
        .unwrap();
        assert_eq!(handover.previous_owner, old_owner);
        assert_eq!(handover.owner, new_owner);
        assert_eq!(handover.transferred_by, old_owner);
        assert_eq!(handover.transferred_at, handover.owner_assigned_at);
        assert_eq!(
            handover.revision,
            before.revision + 1,
            "a handover is a change to the record"
        );
        assert_eq!(
            handover.reason,
            "night shift takes over; the pager is with them"
        );
        assert_eq!(
            audit_rows(&pool, incident.id, "INCIDENT_OWNER_TRANSFERRED").await,
            1
        );

        // --- after the handover --------------------------------------------
        // Old owner: loses both scopes, with the same 404 as any other stranger.
        let error = query_incident(&pool, caller(old_owner), incident.id)
            .await
            .unwrap_err();
        assert_eq!(error.code, "INCIDENT_NOT_FOUND");
        assert_eq!(
            insert_evidence(
                &pool,
                &no_adapters(),
                caller(old_owner),
                incident.id,
                evidence_request("sha256:old-owner-after"),
            )
            .await
            .unwrap_err()
            .code,
            "INCIDENT_NOT_FOUND"
        );
        // New owner: reads it, reads the trail, can write, and is the accountable
        // party from now on.
        let after = query_incident(&pool, caller(new_owner), incident.id)
            .await
            .unwrap();
        assert_eq!(after.owner, new_owner);
        assert_eq!(after.owner_assigned_at, handover.owner_assigned_at);
        assert!(
            insert_evidence(
                &pool,
                &no_adapters(),
                caller(new_owner),
                incident.id,
                evidence_request("sha256:new-owner-note"),
            )
            .await
            .unwrap()
            .0
        );
        let trail = query_timeline(&pool, caller(new_owner), incident.id, 50)
            .await
            .unwrap();
        assert!(trail
            .items
            .iter()
            .any(|event| event.event_type == "INCIDENT_OWNER_TRANSFERRED"));
        let listed = query_incidents(&pool, caller(new_owner), IncidentListQuery::default())
            .await
            .unwrap()
            .0;
        assert!(listed.iter().any(|view| view.id == incident.id));

        cleanup(&pool, &[old_owner, new_owner]).await;
    }
    #[tokio::test]
    async fn a_handover_requires_the_current_revision() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let target = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(owner),
            incident_request("stale handover", None),
        )
        .await
        .unwrap();
        // Something moved the record after the caller read it: the evidence append
        // bumps the revision, exactly as a concurrent reader would see.
        insert_evidence(
            &pool,
            &no_adapters(),
            caller(owner),
            incident.id,
            evidence_request("sha256:moved"),
        )
        .await
        .unwrap();

        let error = transfer_incident_owner(
            &pool,
            caller(owner),
            incident.id,
            transfer_request(
                incident.revision,
                target,
                "handing over on a version I no longer hold",
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(error.code, "INCIDENT_VERSION_CONFLICT");

        // The owner did not move, and no handover was recorded.
        let unchanged = query_incident(&pool, caller(owner), incident.id)
            .await
            .unwrap();
        assert_eq!(unchanged.owner, owner);
        assert_eq!(
            audit_rows(&pool, incident.id, "INCIDENT_OWNER_TRANSFERRED").await,
            0
        );

        // Re-reading fixes it: the retry with the current revision succeeds.
        let handover = transfer_incident_owner(
            &pool,
            caller(owner),
            incident.id,
            transfer_request(
                unchanged.revision,
                target,
                "retried against the revision I just read",
            ),
        )
        .await
        .unwrap();
        assert_eq!(handover.owner, target);

        cleanup(&pool, &[owner, target]).await;
    }
    #[tokio::test]
    async fn a_handover_refuses_an_ineligible_target_and_a_no_op() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let viewer = seed_user(&pool, "viewer").await;
        let retired = seed_user(&pool, "operator").await;
        sqlx::query("UPDATE kernel.users SET disabled=true WHERE id=$1")
            .bind(retired)
            .execute(&pool)
            .await
            .unwrap();
        let (_, incident) = insert_incident(
            &pool,
            caller(owner),
            incident_request("target checks", None),
        )
        .await
        .unwrap();
        let revision = incident.revision;

        // A viewer reads every incident, so naming one as owner would give the handover
        // no accountable party: nobody could act on the work.
        let error = transfer_incident_owner(
            &pool,
            caller(owner),
            incident.id,
            transfer_request(revision, viewer, "handing it to someone who cannot act"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_OWNER_ROLE_INELIGIBLE");

        // A disabled account cannot pick work up.
        let error = transfer_incident_owner(
            &pool,
            caller(owner),
            incident.id,
            transfer_request(revision, retired, "handing it to a disabled account"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_OWNER_DISABLED");

        // An id that is not an account.
        let error = transfer_incident_owner(
            &pool,
            caller(owner),
            incident.id,
            transfer_request(revision, Uuid::new_v4(), "handing it to nobody at all"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_OWNER_UNKNOWN");

        // A handover to the account that already owns it records nothing.
        let error = transfer_incident_owner(
            &pool,
            caller(owner),
            incident.id,
            transfer_request(revision, owner, "handing it to the account that has it"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_OWNER_UNCHANGED");

        // None of the four refusals changed the record.
        let unchanged = query_incident(&pool, caller(owner), incident.id)
            .await
            .unwrap();
        assert_eq!(unchanged.owner, owner);
        assert_eq!(unchanged.revision, revision);
        assert_eq!(
            audit_rows(&pool, incident.id, "INCIDENT_OWNER_TRANSFERRED").await,
            0
        );

        cleanup(&pool, &[owner, viewer, retired]).await;
    }
    /// Who may close or hand over: the current owner, or a role that sees every
    /// incident. The stranger's refusal is a 404 and not a 403, because the record is
    /// not theirs to know about.
    #[tokio::test]
    async fn only_the_owner_or_a_role_that_sees_everything_may_close_or_hand_over() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let stranger = seed_user(&pool, "operator").await;
        let admin = seed_user(&pool, "admin").await;
        let concluded = concluded_incident(&pool, owner, "scope of authority").await;

        let error = close_incident_record(
            &pool,
            caller(stranger),
            concluded.id,
            close_request(concluded.revision, "closing someone else's incident"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::NOT_FOUND);
        assert_eq!(error.code, "INCIDENT_NOT_FOUND");

        let error = transfer_incident_owner(
            &pool,
            caller(stranger),
            concluded.id,
            transfer_request(
                concluded.revision,
                stranger,
                "taking an incident I cannot see",
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_NOT_FOUND");

        // An admin may do both, because sees_all is the same predicate that lets it
        // read the record in the first place.
        let handover = transfer_incident_owner(
            &pool,
            admin_caller(admin),
            concluded.id,
            transfer_request(
                concluded.revision,
                stranger,
                "reassigning to the operator who is actually on call",
            ),
        )
        .await
        .unwrap();
        assert_eq!(handover.owner, stranger);
        let moved = query_incident(&pool, caller(stranger), concluded.id)
            .await
            .unwrap();
        let closed = close_incident_record(
            &pool,
            admin_caller(admin),
            concluded.id,
            close_request(moved.revision, "closed by the incident commander"),
        )
        .await
        .unwrap();
        assert_eq!(closed.status, "CLOSED");
        assert_eq!(
            closed.closed_by,
            Some(admin),
            "the closer of record is the account that closed it, not the owner"
        );
        assert_eq!(closed.owner, stranger, "closing does not move ownership");

        cleanup(&pool, &[owner, stranger, admin]).await;
    }
    /// The trail is the incident's, not the platform's.
    #[tokio::test]
    async fn the_timeline_is_scoped_like_the_incident_and_read_in_order() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let stranger = seed_user(&pool, "operator").await;
        let closed = closed_incident(&pool, owner, "trail order").await;

        let trail = query_timeline(&pool, caller(owner), closed.id, 50)
            .await
            .unwrap();
        assert!(!trail.truncated);
        let kinds: Vec<&str> = trail
            .items
            .iter()
            .map(|event| event.event_type.as_str())
            .collect();
        assert_eq!(
            kinds,
            vec![
                "INCIDENT_CREATED",
                "INCIDENT_EVIDENCE_ADDED",
                "INCIDENT_VERDICT_RECORDED",
                "INCIDENT_CLOSED",
            ],
            "the trail must be the writes that happened, in the order they happened"
        );
        assert!(trail
            .items
            .windows(2)
            .all(|pair| pair[0].occurred_at <= pair[1].occurred_at));
        // The closure event carries the reason, so the trail answers why and not only
        // when.
        let closure = trail.items.last().unwrap();
        assert_eq!(
            closure
                .details
                .get("closureNote")
                .and_then(|value| value.as_str()),
            Some("resolved: the node came back")
        );
        assert_eq!(
            closure.actor_id,
            owner.to_string(),
            "the trail names the account that closed it"
        );

        // A bounded page is the NEWEST events, in order, and says it is truncated.
        let page = query_timeline(&pool, caller(owner), closed.id, 2)
            .await
            .unwrap();
        assert!(page.truncated);
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[1].event_type, "INCIDENT_CLOSED");
        assert_eq!(page.items[0].event_type, "INCIDENT_VERDICT_RECORDED");

        // Not visible to a stranger, exactly like the record itself.
        let error = query_timeline(&pool, caller(stranger), closed.id, 50)
            .await
            .unwrap_err();
        assert_eq!(error.code, "INCIDENT_NOT_FOUND");

        cleanup(&pool, &[owner, stranger]).await;
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
        moved.content_ref = Some("sha256:moved-ref".to_string());
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
    /// The server-side 403 the read-only UI note is NOT allowed to replace.
    ///
    /// The browser explains, before submission, that a viewer cannot close or hand
    /// over; that explanation is presentation. This test drives the real axum
    /// handlers with a real viewer AuthUser and proves the kernel refuses the write
    /// whatever the form did or did not show.
    #[tokio::test]
    async fn viewer_is_refused_at_the_handler_for_close_and_handover() {
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
        let concluded = concluded_incident(&pool, owner, "read only viewer").await;

        let state = AppState::new(
            crate::config::Config::from_env(),
            pool.clone(),
            vec![9_u8; 32],
        )
        .expect("test AppState");

        let as_role = |role: Role, id: Uuid| AuthUser {
            user_id: id,
            email: format!("{id}@example.invalid"),
            display_name: "role matrix c".to_string(),
            role,
            session_id: Uuid::new_v4(),
            csrf_token: "csrf".to_string(),
            via_cookie: true,
        };

        let send = |user: AuthUser, path: String, body: String| {
            let state = state.clone();
            async move {
                use axum::middleware;
                let router = axum::Router::new()
                    .route(
                        "/api/v1/incidents/{incident_id}/close",
                        post(close_incident),
                    )
                    .route(
                        "/api/v1/incidents/{incident_id}/owner",
                        post(transfer_owner),
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
                let response = router
                    .oneshot(
                        Request::builder()
                            .method("POST")
                            .uri(path)
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
        };

        let close_body = serde_json::json!({
            "expectedRevision": concluded.revision,
            "note": "a viewer trying to close an incident",
            "idempotencyKey": "viewer-close-1",
        })
        .to_string();
        let (status, body) = send(
            as_role(Role::Viewer, viewer),
            format!("/api/v1/incidents/{}/close", concluded.id),
            close_body.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "body was {body}");
        assert!(body.contains("FORBIDDEN"), "body was {body}");

        let transfer_body = serde_json::json!({
            "expectedRevision": concluded.revision,
            "toOwner": viewer,
            "reason": "a viewer trying to take an incident",
        })
        .to_string();
        let (status, body) = send(
            as_role(Role::Viewer, viewer),
            format!("/api/v1/incidents/{}/owner", concluded.id),
            transfer_body,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "body was {body}");

        // Neither refusal wrote anything: the incident is still CONCLUDED, still
        // owned by the operator, and the viewer closed nothing.
        let untouched = query_incident(&pool, caller(owner), concluded.id)
            .await
            .unwrap();
        assert_eq!(untouched.status, "CONCLUDED");
        assert_eq!(untouched.owner, owner);
        assert_eq!(audit_rows(&pool, concluded.id, "INCIDENT_CLOSED").await, 0);

        cleanup(&pool, &[owner, viewer]).await;
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
        let before = query_evidence(&pool, caller(user), incident.id, (None, None))
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

        let rows = query_evidence(&pool, caller(user), incident.id, (None, None))
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

        let rows = query_evidence(&pool, caller(user), incident.id, (None, None))
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

    // -- G12 B: evidence content ---------------------------------------------
    //
    // What these tests can and cannot prove is worth stating. They run against a
    // real PostgreSQL and a real schema, so the triggers, CHECK constraints and
    // digest arithmetic are real. They call the data layer, not the HTTP surface,
    // so the wire-level proof (headers, status codes, a browser) lives in
    // tests/acceptance/g12_evidence_content.sh and
    // tests/ui/g12-evidence-content.spec.ts. Neither replaces the other: a unit
    // test cannot see a response header, and an HTTP test cannot corrupt a row
    // through the trigger.

    /// A submission that carries its bytes instead of a reference.
    fn content_request(content_type: &str, body: &str) -> CreateEvidenceRequest {
        let mut payload = evidence_request("sha256:placeholder");
        payload.content_ref = None;
        payload.content = Some(EvidenceContentRequest {
            content_type: content_type.to_string(),
            body: body.to_string(),
        });
        payload
    }

    /// The positive path: the digest beside the bytes is the Kernel's own, computed
    /// over exactly what it stored, and the locator is derived from it.
    #[tokio::test]
    async fn content_is_digested_by_the_server_over_the_bytes_it_stored() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("content digest", None),
        )
        .await
        .unwrap();

        // Multi-byte on purpose: the digest is over bytes, and a character-count
        // implementation would still produce a "correct looking" row.
        let body = "2026-10-31T05:00:00Z ERROR upstream=db-1 msg=\"连接被重置\"";
        let (created, row) = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            content_request("text/plain", body),
        )
        .await
        .unwrap();
        assert!(created);
        assert_eq!(row.content_status, "STORED");
        assert_eq!(row.content_type.as_deref(), Some("text/plain"));
        assert_eq!(row.content_bytes, Some(body.len() as i32));
        assert_eq!(
            row.content_sha256.as_deref(),
            Some(digest_of(body.as_bytes()).as_str())
        );
        // The caller chose nothing here: the locator is the server's digest.
        assert_eq!(
            row.content_ref,
            format!("sha256:{}", digest_of(body.as_bytes()))
        );

        let captured = row.content_captured_at.expect("content rows are dated");
        let expires = row
            .content_retention_expires_at
            .expect("the retention horizon is stored, not recomputed per reader");
        assert_eq!((expires - captured).num_days(), 365);

        cleanup(&pool, &[user]).await;
    }

    /// A digest the caller computed is not a check the Kernel performed. It is
    /// refused, and nothing is stored.
    #[tokio::test]
    async fn a_client_computed_digest_is_refused_rather_than_believed() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("digest claim", None))
                .await
                .unwrap();

        let mut payload = content_request("text/plain", "the real bytes");
        payload.content_ref = Some(format!("sha256:{}", "0".repeat(64)));
        let error = insert_evidence(&pool, &no_adapters(), caller(user), incident.id, payload)
            .await
            .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_CONTENT_REF_CONFLICT");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);

        let evidence_rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        let content_rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence_content c
               JOIN kernel.incident_evidence e ON e.evidence_id = c.evidence_id
              WHERE e.incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(evidence_rows, 0, "a refused write stores no evidence row");
        assert_eq!(content_rows, 0, "a refused write stores no content row");

        // The same request with the digest the server would derive is accepted: the
        // rule is "must agree with the stored bytes", not "must not be sent".
        let mut agreed = content_request("text/plain", "the real bytes");
        agreed.content_ref = Some(format!("sha256:{}", digest_of(b"the real bytes")));
        let (_, row) = insert_evidence(&pool, &no_adapters(), caller(user), incident.id, agreed)
            .await
            .unwrap();
        assert_eq!(row.content_status, "STORED");

        cleanup(&pool, &[user]).await;
    }

    /// Size, encoding and content type are refused before any SQL runs, and the
    /// bound is in bytes so 30k CJK characters are over it.
    #[tokio::test]
    async fn content_limits_are_refused_before_anything_is_stored() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("content limits", None),
        )
        .await
        .unwrap();

        let empty = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            content_request("text/plain", ""),
        )
        .await
        .unwrap_err();
        assert_eq!(empty.code, "EVIDENCE_CONTENT_EMPTY");

        // HTML is refused by type, which is the first of the two defences; the
        // second is that nothing is ever rendered as markup.
        let html = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            content_request("text/html", "<script>alert(1)</script>"),
        )
        .await
        .unwrap_err();
        assert_eq!(html.code, "EVIDENCE_CONTENT_TYPE_UNSUPPORTED");
        assert_eq!(html.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);

        // A charset parameter is not the same value: the Kernel stores what it can
        // serve, and it serves a fixed charset.
        let charset = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            content_request("text/plain; charset=utf-16", "hello"),
        )
        .await
        .unwrap_err();
        assert_eq!(charset.code, "EVIDENCE_CONTENT_TYPE_UNSUPPORTED");

        let too_big = "x".repeat(EVIDENCE_CONTENT_MAX_BYTES + 1);
        let error = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            content_request("text/plain", &too_big),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_CONTENT_TOO_LARGE");
        assert_eq!(error.status, StatusCode::PAYLOAD_TOO_LARGE);

        // 30k characters, 90k bytes: a character-based bound would accept this.
        let wide = "景".repeat(30_000);
        let error = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            content_request("text/plain", &wide),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_CONTENT_TOO_LARGE");

        let rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(rows, 0, "every refusal left the incident empty");

        // Exactly at the bound is accepted, because the bound is the bound.
        let exact = "y".repeat(EVIDENCE_CONTENT_MAX_BYTES);
        let (_, row) = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            content_request("application/json", &exact),
        )
        .await
        .unwrap();
        assert_eq!(row.content_bytes, Some(EVIDENCE_CONTENT_MAX_BYTES as i32));
        assert_eq!(row.content_type.as_deref(), Some("application/json"));

        cleanup(&pool, &[user]).await;
    }

    /// A row without bytes keeps working, and says what it is.
    #[tokio::test]
    async fn a_reference_without_bytes_reads_as_a_legacy_reference() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("legacy ref", None))
                .await
                .unwrap();

        let (_, row) = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            evidence_request("s3://bucket/2026/10/31/excerpt.log"),
        )
        .await
        .unwrap();
        assert_eq!(row.content_status, "LEGACY_REFERENCE");
        assert_eq!(row.content_ref, "s3://bucket/2026/10/31/excerpt.log");
        assert_eq!(row.content_type, None);
        assert_eq!(row.content_bytes, None);
        assert_eq!(row.content_sha256, None);
        assert_eq!(row.content_captured_at, None);
        assert_eq!(row.content_retention_expires_at, None);

        // Neither bytes nor a reference: there is nothing to record, and the
        // refusal says so instead of inventing an empty string.
        let mut neither = evidence_request("sha256:unused");
        neither.content_ref = None;
        let error = insert_evidence(&pool, &no_adapters(), caller(user), incident.id, neither)
            .await
            .unwrap_err();
        assert_eq!(error.code, "INVALID_REQUEST");
        assert!(error.message.contains("contentRef is required"));

        cleanup(&pool, &[user]).await;
    }

    /// Fixity is a comparison against bytes in hand, and the recorded length is a
    /// second witness so rewriting the digest does not launder a shorter body.
    #[test]
    fn stored_content_is_verified_against_the_bytes_in_hand() {
        let id = Uuid::new_v4();
        let body = b"2026-10-31T05:00:00Z INFO heartbeat ok";
        let digest = digest_of(body);
        assert_eq!(
            verify_stored_content(id, body.len() as i32, body, &digest).unwrap(),
            digest
        );

        let mut tampered = body.to_vec();
        tampered[0] = b'9';
        let error = verify_stored_content(id, body.len() as i32, &tampered, &digest).unwrap_err();
        assert_eq!(error.code, "EVIDENCE_CONTENT_INTEGRITY_FAILED");
        assert_eq!(error.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(error.message.contains(&digest));
        assert!(error.message.contains(&digest_of(&tampered)));

        // Truncated, digest untouched.
        let error = verify_stored_content(id, body.len() as i32, &body[..4], &digest).unwrap_err();
        assert_eq!(error.code, "EVIDENCE_CONTENT_INTEGRITY_FAILED");

        // Digest rewritten to match the tampered bytes: the recorded length is the
        // witness that catches it.
        let error = verify_stored_content(
            id,
            body.len() as i32,
            &tampered[..body.len() - 1],
            &digest_of(&tampered[..body.len() - 1]),
        )
        .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_CONTENT_INTEGRITY_FAILED");

        // Length rewritten too: nothing left to compare, and that is fine - the
        // stored row cannot be rewritten at all (see the trigger test below).
        assert!(verify_stored_content(id, body.len() as i32, body, &digest).is_ok());
    }

    /// The capture window's claim half is bounded by the Kernel clock.
    #[test]
    fn collected_at_outside_the_clock_window_is_refused() {
        assert!(check_collected_at(Utc::now()).is_ok());
        assert!(check_collected_at(
            Utc::now() + chrono::Duration::seconds(COLLECTED_AT_FUTURE_SKEW_SECONDS)
        )
        .is_ok());

        let error = check_collected_at(
            Utc::now() + chrono::Duration::seconds(COLLECTED_AT_FUTURE_SKEW_SECONDS + 60),
        )
        .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_COLLECTED_AT_IN_FUTURE");

        let error = check_collected_at(
            Utc::now() - chrono::Duration::seconds(COLLECTED_AT_MAX_AGE_SECONDS + 60),
        )
        .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_COLLECTED_AT_TOO_OLD");
    }

    /// The list's query window: both ends, in order, and no wider than the bound.
    #[test]
    fn the_evidence_query_window_is_whole_and_bounded() {
        let open = evidence_window(&EvidenceListQuery::default()).unwrap();
        assert_eq!(open, (None, None), "no window means every row, as before");

        let window = evidence_window(&EvidenceListQuery {
            since: Some("2026-10-01T00:00:00Z".to_string()),
            until: Some("2026-10-15T00:00:00Z".to_string()),
        })
        .unwrap();
        assert!(window.0.is_some() && window.1.is_some());

        for (since, until, why) in [
            (Some("2026-10-01T00:00:00Z"), None, "half bounded"),
            (None, Some("2026-10-01T00:00:00Z"), "half bounded"),
            (
                Some("2026-10-15T00:00:00Z"),
                Some("2026-10-01T00:00:00Z"),
                "inverted",
            ),
            (
                Some("2026-01-01T00:00:00Z"),
                Some("2026-10-01T00:00:00Z"),
                "too wide",
            ),
            (Some("yesterday"), Some("today"), "unparseable"),
        ] {
            let error = evidence_window(&EvidenceListQuery {
                since: since.map(str::to_string),
                until: until.map(str::to_string),
            })
            .unwrap_err();
            assert_eq!(error.code, "INCIDENT_EVIDENCE_WINDOW_INVALID", "{why}");
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
        }
    }

    /// The per-incident cap, which is what bounds the total stored content.
    #[tokio::test]
    async fn an_incident_refuses_more_evidence_than_its_cap() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(&pool, caller(user), incident_request("row cap", None))
            .await
            .unwrap();
        // The cap counts rows, not writes: filling it in one statement is the same
        // situation as 200 separate submissions.
        sqlx::query(
            "INSERT INTO kernel.incident_evidence
               (evidence_id,incident_id,kind,source,collected_at,content_ref,claimed_trust)
             SELECT gen_random_uuid(), $1, 'OPERATOR_NOTE', 'MANUAL', now(),
                    'bulk-'||g, 'UNVERIFIED'
               FROM generate_series(1,$2) g",
        )
        .bind(incident.id)
        .bind(EVIDENCE_MAX_ROWS)
        .execute(&pool)
        .await
        .unwrap();

        let error = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            evidence_request("sha256:one-too-many"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_EVIDENCE_LIMIT");
        assert_eq!(error.status, StatusCode::CONFLICT);

        let rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(rows, EVIDENCE_MAX_ROWS, "the refused row was not stored");

        cleanup(&pool, &[user]).await;
    }

    /// Write-once is a property of the data, not of the handlers: a direct UPDATE
    /// or DELETE is refused by the database, and the row survives both attempts.
    #[tokio::test]
    async fn stored_content_cannot_be_rewritten_even_with_sql() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("write once", None))
                .await
                .unwrap();
        let body = "original bytes";
        let (_, row) = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            content_request("text/plain", body),
        )
        .await
        .unwrap();

        let update = sqlx::query(
            "UPDATE kernel.incident_evidence_content SET body='rewritten'::bytea
              WHERE evidence_id=$1",
        )
        .bind(row.evidence_id)
        .execute(&pool)
        .await;
        let error = update.expect_err("the write-once trigger must refuse an UPDATE");
        assert!(
            error.to_string().contains("write-once"),
            "the refusal names the rule: {error}"
        );

        let delete =
            sqlx::query("DELETE FROM kernel.incident_evidence_content WHERE evidence_id=$1")
                .bind(row.evidence_id)
                .execute(&pool)
                .await;
        let error = delete.expect_err("the write-once trigger must refuse a DELETE");
        assert!(error.to_string().contains("write-once"));

        // And the bytes are exactly what they were.
        let stored: (Vec<u8>, String, i32) = sqlx::query_as(
            "SELECT body, sha256, content_bytes FROM kernel.incident_evidence_content
              WHERE evidence_id=$1",
        )
        .bind(row.evidence_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stored.0, body.as_bytes());
        assert_eq!(stored.1, digest_of(body.as_bytes()));
        assert_eq!(
            verify_stored_content(row.evidence_id, stored.2, &stored.0, &stored.1).unwrap(),
            stored.1
        );

        cleanup(&pool, &[user]).await;
    }
}
