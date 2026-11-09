//! G11 business slice: Incident -> Evidence -> Human Verdict.
//!
//! Authority, field minimality, the state machine, the permission matrix and the
//! concurrency rules are argued in docs/design/g11-incident/incident-adr.md; the
//! wire format is contracts/openapi/incident-v1.yaml. This module implements
//! those two documents and nothing else.
//!
//! Permission gates reuse the existing AuthUser::require_operator primitive, and
//! the verb they gate is decided separately from the rows it acts on: WHICH
//! workspaces a caller may read is membership data resolved per call in
//! crate::scope, and WHICH rows it sees inside them is a per-role rule. The
//! pre-D5 sentence that stood here - "admin and viewer read everything, an
//! operator reads only what it owns" - was one expression standing in for both
//! questions, and it is the accident G12 D5 removed.
//!
//! G12 C adds the two operations the recorded lifecycle was missing - a controlled
//! CONCLUDED -> CLOSED and an ownership handover - plus the audit timeline the UI
//! reads. Both are argued in docs/design/g12-lifecycle/lifecycle-adr.md, and the
//! permission posture they inherit (rather than invent) is written down with
//! evidence in docs/design/g12-lifecycle/permission-model-decision.md.

use crate::audit::AuditEventView;
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::scope::{self, DataScope};
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
/// G13-A.1: the signed workspace is part of the tuple. A v1 signature cannot
/// name a workspace, so it cannot authorize a new write; historical rows keep
/// the trust they were stored with and are never rewritten.
const ATTESTATION_VERSION: &str = "opsweave-evidence-attestation-v2";
const ATTESTATION_VERSION_V1: &str = "opsweave-evidence-attestation-v1";
/// What the content read path selects out of kernel.incident_evidence_content:
/// (content type, body, verified byte length, recorded digest, retention horizon).
/// pub(crate) so the investigator's read_evidence selects through the same alias: the
/// G12 F defect was that path declaring the body as String, which fails to decode a
/// bytea column on every row that has one. One alias, one decode.
pub(crate) type StoredContent = (String, Vec<u8>, i32, String, DateTime<Utc>);
/// The evidence list's query window, as (since, until). Both are None or both are
/// Some; evidence_window enforces that before any SQL runs.
pub(crate) type EvidenceWindow = (Option<DateTime<Utc>>, Option<DateTime<Utc>>);
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

/// The read predicate has one definition, in crate::scope; this module no longer
/// owns one.
///
/// G12 D5 (docs/design/g12-scope/d5-business-workspace-adr.md). The struct that
/// stood here carried `sees_all`, computed as `is_admin() || !can_operate()`.
/// That expression answered "which workspaces may this caller read" with an
/// attribute of a role, so a viewer read every incident on the platform while the
/// audit ledger - which asked its own question - told the same viewer that
/// INCIDENT events are visible only where it owns the subject. Membership is what
/// decides now, and it is resolved per call.
///
/// What remains in this module is the SHAPE of the report, because a field name is
/// part of this module's contract and a scope is not.
///
/// It is derived from the `RowPredicate` the query actually executed - not from the
/// caller and not from a second reading of the row rule. `narrowed_to` maps the
/// predicate's `Narrowing` through its wire name, and that match is exhaustive: a
/// narrowing added to the predicate has no wire name until someone writes one, so the
/// response cannot keep claiming "no owner narrowing" for a read that applies more.
fn scope_view(predicate: &scope::RowPredicate, workspace_count: usize) -> IncidentScopeView {
    IncidentScopeView {
        narrowed_to: predicate.narrowing().map(scope::Narrowing::wire_name),
        workspace_count,
    }
}

/// What the incident list will show this caller, sent beside the rows.
///
/// One field, naming the field this read was narrowed on. It exists so the copy that says
/// 'the incidents you own' is licensed by this payload instead of by the page's memory of
/// what the predicate used to be: a second narrowing would have to change this value, and the
/// sentence naming ownership would have to change with it rather than quietly keep claiming
/// the whole list.
///
/// There is no `seesAll` here, and removing it is the point of this struct. That boolean
/// answered "does this list hold everything?", which a read cannot answer: it is true only
/// relative to the predicate this route happens to apply, so a later narrowing on any other
/// column would leave it silently lying, and for a viewer it already did - `!can_operate()`
/// made it true by accident (section 3.4). A field may only say what it knows, and what this
/// read knows is which narrowing it applied.
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncidentScopeView {
    /// The field this read was narrowed on. 'owner' is the only value the current predicate
    /// produces; null means this read applied no owner narrowing, which is a statement about
    /// the read rather than a count of what exists.
    pub narrowed_to: Option<&'static str>,
    /// How many business workspaces bounded this read. Zero is the one value that
    /// explains an empty page completely: a caller that is a member of no workspace
    /// cannot be shown a row by any read in the kernel, whatever its role. It is a
    /// count of the bound this read applied - the caller's own grants - and not a
    /// count of what exists, which is the distinction
    /// docs/design/g12-scope/narrowed-reads.md section 3.0 draws.
    pub workspace_count: usize,
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
    /// The business workspace this incident is filed under. Optional only for a
    /// caller that is a member of exactly one, where the kernel has one answer and
    /// guessing is not guessing. It is validated against membership: naming a
    /// workspace you cannot enter is 404, not a grant.
    #[serde(default)]
    pub workspace_id: Option<Uuid>,
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
    /// G13-A.1 (v2): the workspace the adapter signed for, taken by the plugin
    /// from its persisted collection - never from the browser. It is covered by
    /// the signature; the Kernel then compares it with the incident's
    /// authoritative workspace. Absent means a v1 envelope, refused for new
    /// writes.
    #[serde(default)]
    pub workspace_id: Option<Uuid>,
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
    /// G12 E: exact-match filter on relatedEntity, added for get_related_context.
    ///
    /// It is a NARROWING filter and nothing else: the sees_all/owner predicate is still
    /// applied on the same query, so a caller cannot reach an incident it could not
    /// already list. It exists so the investigator's related-context tool reuses this
    /// query instead of writing a second, unaudited one.
    pub related_entity: Option<String>,
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

/// One page of incidents together with the row predicate that produced it.
///
/// The list response's scope is derived from this value rather than recomputed from
/// the caller, so the clause that ran and the narrowing that is reported are the same
/// value. A clause added to the predicate therefore has to be accounted for beside
/// the rows it changed instead of being invisible to the response.
#[derive(Debug)]
pub(crate) struct IncidentRead {
    pub(crate) items: Vec<IncidentView>,
    pub(crate) next_cursor: Option<String>,
    pub(crate) predicate: scope::RowPredicate,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncidentList {
    pub items: Vec<IncidentView>,
    pub next_cursor: Option<String>,
    /// The read these rows were produced under. Never optional: a response without it
    /// puts the browser back where it started, deciding from items alone.
    pub scope: IncidentScopeView,
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
    /// USER, AUTOMATION, or NULL for a row that predates the automation slices.
    pub origin: Option<String>,
    /// True when the row is waiting in the workspace automation queue: origin is
    /// AUTOMATION, the owner is still the non-login service user, and the status
    /// is OPEN or INVESTIGATING. Derived by the kernel from the same fields the
    /// claim route checks, so the affordance cannot outrun the authorization.
    pub claimable: bool,
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
    /// USER, AUTOMATION, or NULL for a row that predates 0026. Exposed because
    /// the detail page must know whether a row is an automation record before it
    /// can offer claim/release; the kernel, not the browser, decides.
    origin: Option<String>,
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
    /// Whether this row is waiting in the workspace automation queue: an
    /// automation incident that no person has claimed and that is still live.
    /// One definition, used by the detail/list payload and by the claim route's
    /// own preconditions, so the button and the handler cannot disagree.
    pub(crate) fn is_claimable(&self) -> bool {
        self.origin.as_deref() == Some("AUTOMATION")
            && self.owner.to_string() == crate::automation::AUTOMATION_USER_ID
            && matches!(self.status.as_str(), "OPEN" | "INVESTIGATING")
    }

    fn into_view(self) -> IncidentView {
        let claimable = self.is_claimable();
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
            origin: self.origin.clone(),
            claimable,
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
    let caller = DataScope::resolve(&state.db, &auth).await?;
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
    let caller = DataScope::resolve(&state.db, &auth).await?;
    let workspace_count = caller.workspace_count();
    let read = query_incidents(&state.db, caller, query).await?;
    Ok(Json(IncidentList {
        items: read.items,
        next_cursor: read.next_cursor,
        scope: scope_view(&read.predicate, workspace_count),
    }))
}

pub async fn get_incident(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(incident_id): Path<Uuid>,
) -> AppResult<Json<IncidentView>> {
    let caller = DataScope::resolve(&state.db, &auth).await?;
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
    let caller = DataScope::resolve(&state.db, &auth).await?;
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

/// The automation path into the same evidence writer. The caller has already
/// authenticated an `owa1` principal and verified that the incident belongs to
/// its workspace; this function re-checks the incident status because an
/// automation may not add evidence to a concluded/closed record.
pub(crate) async fn append_automation_evidence(
    state: &AppState,
    principal_id: Uuid,
    workspace_id: Uuid,
    incident_id: Uuid,
    evidence: serde_json::Value,
    lease: AutomationLeaseHandle,
) -> AppResult<Uuid> {
    // The receipt first: a retry after the Evidence committed but the Job did
    // not must return the committed effect, not collect or write again.
    if let Some(evidence_id) = committed_automation_evidence(&state.db, lease.job_id).await? {
        return Ok(evidence_id);
    }
    let row: Option<(Uuid, String)> =
        sqlx::query_as("SELECT workspace_id, status FROM kernel.incidents WHERE incident_id=$1")
            .bind(incident_id)
            .fetch_optional(&state.db)
            .await?;
    let Some((incident_workspace, status)) = row else {
        return Err(incident_not_found());
    };
    if incident_workspace != workspace_id {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "AUTOMATION_INCIDENT_FORBIDDEN",
            "the incident does not belong to this automation workspace",
        ));
    }
    match status.as_str() {
        "OPEN" | "INVESTIGATING" => {}
        "CONCLUDED" => {
            return Err(AppError::conflict(
                "INCIDENT_ALREADY_CONCLUDED",
                "an automation may not add evidence after a human verdict",
            ))
        }
        _ => {
            return Err(AppError::conflict(
                "INCIDENT_CLOSED",
                "this incident is closed and accepts no new evidence",
            ))
        }
    }
    let payload: CreateEvidenceRequest = serde_json::from_value(evidence).map_err(|error| {
        AppError::bad_request(format!("automation evidence is not valid: {error}"))
    })?;
    // `submitted_by` must reference a real kernel.users row; the non-login
    // service user satisfies that FK. The audit actor remains the principal.
    let caller = DataScope::for_automation(
        Uuid::parse_str(crate::automation::AUTOMATION_USER_ID).expect("service user id"),
        workspace_id,
    );
    let (_, view) = insert_evidence_as(
        &state.db,
        &state.config.evidence_adapters,
        caller,
        EvidenceActor {
            actor_type: "AUTOMATION",
            actor_id: principal_id,
            automation_job_id: Some(lease.job_id),
            lease: Some(lease),
        },
        incident_id,
        payload,
    )
    .await?;
    Ok(view.evidence_id)
}

/// The Evidence a job already committed, if any. This is the recovery read:
/// the evidence row carries the job identity, so "committed" and "receipt
/// written" are the same fact (ADR-G13-B1.6 §3.1).
pub(crate) async fn committed_automation_evidence(
    db: &PgPool,
    job_id: Uuid,
) -> AppResult<Option<Uuid>> {
    Ok(sqlx::query_scalar(
        "SELECT evidence_id FROM kernel.incident_evidence WHERE automation_job_id=$1",
    )
    .bind(job_id)
    .fetch_optional(db)
    .await?)
}

/// Add the automation Event to the incident's existing audit timeline. This is
/// what lets the current UI show Event -> Evidence -> Hypothesis -> Human
/// Verdict without a second timeline screen.
pub(crate) async fn audit_automation_event(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    principal_id: Uuid,
    incident_id: Uuid,
    details: serde_json::Value,
) -> AppResult<()> {
    audit_in_tx_as(
        tx,
        "INCIDENT_AUTOMATION_EVENT",
        "AUTOMATION",
        principal_id,
        incident_id,
        "AUTOMATION_EVENT",
        details,
    )
    .await
}

pub async fn list_evidence(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(incident_id): Path<Uuid>,
    Query(query): Query<EvidenceListQuery>,
) -> AppResult<Json<EvidenceList>> {
    let caller = DataScope::resolve(&state.db, &auth).await?;
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
    let caller = DataScope::resolve(&state.db, &auth).await?;
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
    let caller = DataScope::resolve(&state.db, &auth).await?;
    let verdict = insert_verdict(&state.db, caller, incident_id, payload).await?;
    Ok((StatusCode::CREATED, Json(verdict)))
}

pub async fn get_verdict(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(incident_id): Path<Uuid>,
) -> AppResult<Json<VerdictView>> {
    let caller = DataScope::resolve(&state.db, &auth).await?;
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
    let caller = DataScope::resolve(&state.db, &auth).await?;
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
    let caller = DataScope::resolve(&state.db, &auth).await?;
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
    let caller = DataScope::resolve(&state.db, &auth).await?;
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
    caller: DataScope,
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

    // Which workspace the row is filed under is decided here and validated against
    // the caller's own membership. A body naming a workspace the caller cannot
    // enter is refused with 404, never accepted: a caller that could state its own
    // scope would be granting itself one, which is the single thing this model must
    // not allow.
    let workspace_id = match payload.workspace_id {
        Some(named) if caller.may_enter(named) => named,
        Some(_) => return Err(workspace_not_found()),
        None => match caller.workspaces.as_slice() {
            [only] => *only,
            [] => {
                return Err(AppError::new(
                    StatusCode::FORBIDDEN,
                    "INCIDENT_WORKSPACE_FORBIDDEN",
                    "this account is not a member of any business workspace, so it has nowhere to file an incident; an administrator grants membership",
                ))
            }
            _ => {
                return Err(AppError::new(
                    StatusCode::BAD_REQUEST,
                    "INCIDENT_WORKSPACE_REQUIRED",
                    "name the workspaceId this incident belongs to: this account is a member of more than one business workspace and the kernel will not guess",
                ))
            }
        },
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
           started_at,owner,workspace_id)
        VALUES ($1,$2,$3,'OPEN',$4,$5,$6,$7,$8,$9)
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
    .bind(workspace_id)
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
    let existing: Option<(Uuid, Uuid, Uuid)> = sqlx::query_as(
        "SELECT incident_id, owner, workspace_id
           FROM kernel.incidents WHERE source=$1 AND native_id=$2",
    )
    .bind(&source)
    .bind(native_id.as_deref())
    .fetch_optional(db)
    .await?;
    let Some((existing, owner, existing_workspace)) = existing else {
        return Err(AppError::conflict(
            "INCIDENT_WRITE_CONFLICT",
            "a concurrent write changed this incident set; retry the request",
        ));
    };
    // Taken, and outside the caller's read scope. A POST create has no 404 to
    // give: that status would say the failure does not exist while refusing to
    // create it. The natural key came from the caller, so telling it the key is
    // taken reveals only what the caller already typed.
    if !caller.covers(existing_workspace, owner) {
        return Err(AppError::conflict(
            "INCIDENT_NATIVE_ID_TAKEN",
            "another user already reported this source/nativeId failure; it cannot be re-created or taken over",
        ));
    }
    Ok((false, query_incident(db, caller, existing).await?))
}

pub(crate) async fn query_incidents(
    db: &PgPool,
    caller: DataScope,
    query: IncidentListQuery,
) -> AppResult<IncidentRead> {
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
    let related_entity = match query
        .related_entity
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => Some(bounded(value, "relatedEntity filter", 3, 200)?),
        None => None,
    };
    let (cursor_time, cursor_id) = match query.cursor.as_deref() {
        Some(value) => {
            let (time, id) = decode_cursor(value)?;
            (Some(time), Some(id))
        }
        None => (None, None),
    };
    let predicate = caller.row_predicate("i", 1, 2, 10);
    let sql = format!(
        "{INCIDENT_SELECT}
         WHERE {}
           AND ($3::text IS NULL OR i.status=$3)
           AND ($4::text IS NULL OR i.severity=$4)
           AND ($5::timestamptz IS NULL OR (i.started_at,i.incident_id) < ($5,$6::uuid))
           AND ($8::uuid IS NULL OR i.owner=$8)
           AND ($9::text IS NULL OR i.related_entity=$9)
         ORDER BY i.started_at DESC, i.incident_id DESC
         LIMIT $7",
        predicate.sql()
    );
    let rows = sqlx::query_as::<_, IncidentRow>(&sql)
        .bind(&caller.workspaces)
        .bind(predicate.all_rows())
        .bind(status.as_deref())
        .bind(severity.as_deref())
        .bind(cursor_time)
        .bind(cursor_id)
        .bind(limit + 1)
        .bind(owner)
        .bind(related_entity.as_deref())
        .bind(caller.user_id)
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
    Ok(IncidentRead {
        items,
        next_cursor,
        predicate,
    })
}

pub(crate) async fn query_incident(
    db: &PgPool,
    caller: DataScope,
    incident_id: Uuid,
) -> AppResult<IncidentView> {
    let predicate = caller.row_predicate("i", 2, 3, 4);
    let sql = format!(
        "{INCIDENT_SELECT} WHERE i.incident_id=$1 AND {}",
        predicate.sql()
    );
    let row = sqlx::query_as::<_, IncidentRow>(&sql)
        .bind(incident_id)
        .bind(&caller.workspaces)
        .bind(predicate.all_rows())
        .bind(caller.user_id)
        .fetch_optional(db)
        .await?;
    row.map(IncidentRow::into_view)
        .ok_or_else(incident_not_found)
}

async fn insert_evidence(
    db: &PgPool,
    adapters: &HashMap<String, String>,
    caller: DataScope,
    incident_id: Uuid,
    payload: CreateEvidenceRequest,
) -> AppResult<(bool, EvidenceView)> {
    let actor = EvidenceActor {
        actor_type: "USER",
        actor_id: caller.user_id,
        automation_job_id: None,
        lease: None,
    };
    insert_evidence_as(db, adapters, caller, actor, incident_id, payload).await
}

/// The execution grant a worker holds when it asks to write an automation
/// effect. It is an internal handle: no header, body or client-supplied job id
/// can stand in for it (B1.8 Phase 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AutomationLeaseHandle {
    pub job_id: Uuid,
    pub lease_id: Uuid,
    pub fencing_token: i64,
}

/// Who is writing this row, and (for automation) which job's effect it is.
///
/// Grouped so the writer's argument list stays about the write; the job id is
/// the effect identity from ADR-G13-B1.6, never chosen by evidence content.
/// `lease` is present exactly when `actor_type == "AUTOMATION"`: the evidence
/// transaction locks the job and proves the caller still holds that generation
/// before it writes.
#[derive(Debug, Clone, Copy)]
struct EvidenceActor {
    actor_type: &'static str,
    actor_id: Uuid,
    automation_job_id: Option<Uuid>,
    lease: Option<AutomationLeaseHandle>,
}

/// The shared writer behind the user endpoint and the automation path. The
/// actor type is chosen by the caller of this function (an authenticated route),
/// never by evidence content.
async fn insert_evidence_as(
    db: &PgPool,
    adapters: &HashMap<String, String>,
    caller: DataScope,
    actor: EvidenceActor,
    incident_id: Uuid,
    payload: CreateEvidenceRequest,
) -> AppResult<(bool, EvidenceView)> {
    let automation_job_id = actor.automation_job_id;
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
    let workspace_id = incident_workspace(db, caller.clone(), incident_id).await?;
    let tuple = EvidenceTuple {
        incident_id,
        workspace_id,
        kind: &kind,
        source: &source,
        collected_at: payload.collected_at,
        content_ref: &content_ref,
    };
    let trust = resolve_evidence_trust(adapters, &tuple, &payload)?;

    // G13-A: an attestation is a statement about bytes the Kernel will store and
    // re-check. Accepting a Legacy contentRef alongside it would record
    // SOURCE_ATTESTED for a digest no stored content backs - the signature would
    // vouch for something the Kernel never saw. The refusal is after signature
    // verification so a forged attestation still gets its named 401 first.
    if payload.attestation.is_some() && content.is_none() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "EVIDENCE_ATTESTATION_REQUIRES_CONTENT",
            "an attested evidence row must carry content: the Kernel verifies the signature over a digest it derives from the stored bytes, not one the caller supplied",
        ));
    }

    let evidence_id = Uuid::new_v4();
    // Evidence, the OPEN -> INVESTIGATING transition and the audit row commit
    // together: rolled back after the transition, an audit failure would leave
    // the incident investigating evidence that this endpoint never accepted.
    let mut tx = db.begin().await?;
    // B1.8 Phase 2: an automation effect may only be created by the worker that
    // currently holds the job's execution grant. The job row is locked first
    // (the same lock finish_success/claim/reaper take), and the generation must
    // still be RUNNING with a live lease. A worker that lost the lease - because
    // another worker took over, or because it stalled past `lease_until` - is
    // refused atomically by the database, not by a caller-side pre-check.
    // Lock order is job -> incident in this path; no path takes incident -> job.
    if let Some(lease) = actor.lease {
        if actor.automation_job_id != Some(lease.job_id) {
            tx.rollback().await?;
            return Err(AppError::internal(
                "automation evidence lease does not name its job",
            ));
        }
        let live: Option<Uuid> = sqlx::query_scalar(
            "SELECT job_id FROM kernel.automation_jobs
              WHERE job_id=$1 AND lease_id=$2 AND fencing_token=$3
                AND status='RUNNING' AND lease_until > now()
              FOR UPDATE",
        )
        .bind(lease.job_id)
        .bind(lease.lease_id)
        .bind(lease.fencing_token)
        .fetch_optional(&mut *tx)
        .await?;
        if live.is_none() {
            tx.rollback().await?;
            return Err(AppError::conflict(
                "AUTOMATION_STALE_LEASE",
                "this worker no longer holds the job's execution grant; no evidence was written",
            ));
        }
    } else if actor.actor_type == "AUTOMATION" {
        tx.rollback().await?;
        return Err(AppError::internal(
            "automation evidence requires a lease handle",
        ));
    }
    // B1.8: the lifecycle decision is made under the SAME row lock the verdict
    // writer takes, inside the transaction that writes the evidence. The
    // earlier status read (append_automation_evidence) is a fast path, not the
    // authority: a Human Verdict that commits between that read and this write
    // must be observed here. Lock order is incident-then-evidence in both
    // writers, so the two serialize without a deadlock.
    //
    //   * CLOSED refuses every writer (the historical contract).
    //   * CONCLUDED refuses AUTOMATION writers: a verdict is a signed set, and
    //     evidence appended after it was never part of what the signer weighed.
    //     A HUMAN writer may still append after CONCLUDED (afterVerdict=true),
    //     which is the existing, separately specified behaviour.
    let locked: Option<(String, Uuid)> = sqlx::query_as(
        "SELECT status, workspace_id FROM kernel.incidents
          WHERE incident_id=$1 AND workspace_id = ANY($2::uuid[])
          FOR UPDATE",
    )
    .bind(incident_id)
    .bind(&caller.workspaces)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((status, locked_workspace)) = locked else {
        tx.rollback().await?;
        return Err(incident_not_found());
    };
    if locked_workspace != workspace_id {
        // The signed tuple names a workspace the authoritative row does not.
        // Refuse rather than store evidence under a binding that disagrees with
        // the incident; a concurrent move is not a product operation, so this
        // is a corruption guard, not a normal branch.
        tx.rollback().await?;
        return Err(incident_not_found());
    };
    if status == "CLOSED" {
        tx.rollback().await?;
        return Err(AppError::conflict(
            "INCIDENT_CLOSED",
            "this incident is closed and accepts no new evidence",
        ));
    }
    if status == "CONCLUDED" && actor.actor_type == "AUTOMATION" {
        tx.rollback().await?;
        return Err(AppError::conflict(
            "INCIDENT_ALREADY_CONCLUDED",
            "an automation may not add evidence after a human verdict: the signed set is what the verdict weighed",
        ));
    }
    // The per-incident row cap, checked inside the transaction and now under
    // the incident lock, so concurrent writers serialize and the cap is exact
    // rather than "cap plus the number of concurrent writers".
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
    // Two conflict targets, one meaning each (ADR-G13-B1.6 §3.2):
    //   * a job-scoped row is unique by its job; a second attempt of the same job
    //     loses to the first and reads it back, while a DIFFERENT job with the
    //     same content is a separate row (its own effect);
    //   * a row without a job keeps the historical tuple uniqueness.
    let inserted: Option<Uuid> = if automation_job_id.is_some() {
        sqlx::query_scalar(
            r#"
            INSERT INTO kernel.incident_evidence
              (evidence_id,incident_id,kind,source,collected_at,content_ref,claimed_trust,
               verified_trust,verification_method,verified_at,verifier_identity,submitted_by,
               automation_job_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
            ON CONFLICT (automation_job_id) WHERE automation_job_id IS NOT NULL DO NOTHING
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
        .bind(automation_job_id)
        .fetch_optional(&mut *tx)
        .await?
    } else {
        sqlx::query_scalar(
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
        .await?
    };

    let Some(stored_id) = inserted else {
        tx.rollback().await?;
        // A replay answers with the row that already exists - unchanged. That is
        // a security property, not only idempotency: presenting a valid
        // attestation for an already-stored UNVERIFIED row returns the stored
        // row, so a replay can never upgrade a settled trust value. For a job,
        // the identity is the job: the retry gets the effect that already
        // committed, whatever bytes this attempt collected.
        let existing = match automation_job_id {
            Some(job_id) => {
                let evidence_id: Option<Uuid> = sqlx::query_scalar(
                    "SELECT evidence_id FROM kernel.incident_evidence WHERE automation_job_id=$1",
                )
                .bind(job_id)
                .fetch_optional(db)
                .await?;
                match evidence_id {
                    Some(id) => Some(query_evidence_row(db, id).await?),
                    None => None,
                }
            }
            None => {
                sqlx::query_as::<_, EvidenceView>(&format!(
                    "{EVIDENCE_SELECT} WHERE e.incident_id=$1 AND e.kind=$2 AND e.source=$3
                 AND e.content_ref=$4"
                ))
                .bind(incident_id)
                .bind(&kind)
                .bind(&source)
                .bind(&content_ref)
                .fetch_optional(db)
                .await?
            }
        };
        let existing = existing.ok_or_else(|| {
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
    audit_in_tx_as(
        &mut tx,
        "INCIDENT_EVIDENCE_ADDED",
        actor.actor_type,
        actor.actor_id,
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

pub(crate) async fn query_evidence(
    db: &PgPool,
    caller: DataScope,
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
    caller: DataScope,
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
    let predicate = caller.row_predicate("i", 2, 3, 4);
    let status: Option<String> = sqlx::query_scalar(&format!(
        "SELECT status FROM kernel.incidents i
          WHERE i.incident_id=$1 AND {} FOR UPDATE",
        predicate.sql()
    ))
    .bind(incident_id)
    .bind(&caller.workspaces)
    .bind(predicate.all_rows())
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
    caller: DataScope,
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
    let predicate = caller.row_predicate("i", 2, 3, 4);
    let current: Option<(String, i64, Option<String>)> = sqlx::query_as(&format!(
        "SELECT status, revision, closure_key FROM kernel.incidents i
          WHERE i.incident_id=$1 AND {} FOR UPDATE",
        predicate.sql()
    ))
    .bind(incident_id)
    .bind(&caller.workspaces)
    .bind(predicate.all_rows())
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
    caller: DataScope,
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
    let predicate = caller.row_predicate("i", 2, 3, 4);
    let current: Option<(String, i64, Uuid, Uuid)> = sqlx::query_as(&format!(
        "SELECT status, revision, owner, workspace_id FROM kernel.incidents i
          WHERE i.incident_id=$1 AND {} FOR UPDATE",
        predicate.sql()
    ))
    .bind(incident_id)
    .bind(&caller.workspaces)
    .bind(predicate.all_rows())
    .bind(caller.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((status, revision, previous_owner, workspace_id)) = current else {
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
    // An owner that cannot enter the incident's workspace could not read what it was given,
    // and no write from it would ever reach the record: a handover that names such an
    // account strands the row. Membership, not role, is the second condition - the same
    // separation this phase makes everywhere else.
    let target_is_member: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM kernel.business_workspace_members
                         WHERE workspace_id=$1 AND user_id=$2)",
    )
    .bind(workspace_id)
    .bind(payload.to_owner)
    .fetch_one(&mut *tx)
    .await?;
    if !target_is_member {
        tx.rollback().await?;
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "INCIDENT_OWNER_NOT_IN_WORKSPACE",
            "the target account is not a member of this incident's business workspace, so it could not read the record it would own",
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

pub(crate) async fn query_timeline(
    db: &PgPool,
    caller: DataScope,
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

async fn query_verdict(
    db: &PgPool,
    caller: DataScope,
    incident_id: Uuid,
) -> AppResult<VerdictView> {
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

pub(crate) async fn incident_status(
    db: &PgPool,
    caller: DataScope,
    incident_id: Uuid,
) -> AppResult<String> {
    let predicate = caller.row_predicate("i", 2, 3, 4);
    sqlx::query_scalar(&format!(
        "SELECT status FROM kernel.incidents i
          WHERE i.incident_id=$1 AND {}",
        predicate.sql()
    ))
    .bind(incident_id)
    .bind(&caller.workspaces)
    .bind(predicate.all_rows())
    .bind(caller.user_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(incident_not_found)
}

/// The incident's workspace, read through the same predicate as every other
/// incident read. This is the authoritative value the attestation must match;
/// the request body never supplies it.
async fn incident_workspace(db: &PgPool, caller: DataScope, incident_id: Uuid) -> AppResult<Uuid> {
    let predicate = caller.row_predicate("i", 2, 3, 4);
    sqlx::query_scalar(&format!(
        "SELECT workspace_id FROM kernel.incidents i
          WHERE i.incident_id=$1 AND {}",
        predicate.sql()
    ))
    .bind(incident_id)
    .bind(&caller.workspaces)
    .bind(predicate.all_rows())
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
#[derive(Clone, Copy)]
struct EvidenceTuple<'a> {
    incident_id: Uuid,
    /// The incident's workspace, read by the Kernel from the trusted record.
    workspace_id: Uuid,
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
    let matches = |payload: &str| -> bool {
        let Ok(mut mac) = HmacSha256::new_from_slice(secret.as_bytes()) else {
            return false;
        };
        mac.update(payload.as_bytes());
        use base64::Engine;
        let expected =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        constant_time_eq(expected.as_bytes(), attestation.signature.trim().as_bytes())
    };

    // v2: the workspace in the envelope is signed. Construct the payload with
    // that value, verify the signature, and only then compare it with the
    // incident's authoritative workspace. A caller that edits the field breaks
    // the signature; a plugin that honestly signed another workspace gets a
    // named refusal rather than a row in the wrong business scope.
    if let Some(signed_workspace) = attestation.workspace_id {
        let signed = EvidenceTuple {
            workspace_id: signed_workspace,
            ..*tuple
        };
        let payload = attestation_payload(adapter_id, &signed, attestation.issued_at)?;
        if matches(&payload) {
            if signed_workspace != tuple.workspace_id {
                return Err(AppError::new(
                    StatusCode::FORBIDDEN,
                    "EVIDENCE_WORKSPACE_MISMATCH",
                    "the adapter signed this evidence for a different workspace than the incident's; the row is refused rather than filed across the business boundary",
                ));
            }
            return Ok(());
        }
    }

    // A valid v1 signature is recognised so the refusal names the reason. v1
    // does not bind a workspace, so it cannot authorize a new write; the
    // historical rows it produced keep their stored trust and are untouched.
    let v1 = attestation_payload_v1(adapter_id, tuple, attestation.issued_at)?;
    if matches(&v1) {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "EVIDENCE_ATTESTATION_VERSION_UNSUPPORTED",
            "this is a valid v1 attestation, but v1 does not bind a workspace and is no longer accepted for new evidence; historical rows are unchanged and adapters must sign v2",
        ));
    }
    Err(AppError::new(
        StatusCode::UNAUTHORIZED,
        "EVIDENCE_ATTESTATION_INVALID",
        "the attestation signature does not cover this evidence tuple under this adapter's secret",
    ))
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
    workspace_id: String,
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
        workspace_id: tuple.workspace_id.to_string(),
        incident_id: tuple.incident_id.to_string(),
        kind: tuple.kind,
        source: tuple.source,
        collected_at_unix: tuple.collected_at.timestamp(),
        content_ref: tuple.content_ref,
        issued_at_unix: issued_at.timestamp(),
    })
    .map_err(AppError::internal)
}

/// The v1 payload, kept only so a v1 envelope can be recognised and refused with
/// a named error instead of a generic "invalid signature". No new write is
/// authorized by this format.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttestationClaimsV1<'a> {
    v: &'a str,
    adapter_id: &'a str,
    incident_id: String,
    kind: &'a str,
    source: &'a str,
    collected_at_unix: i64,
    content_ref: &'a str,
    issued_at_unix: i64,
}

fn attestation_payload_v1(
    adapter_id: &str,
    tuple: &EvidenceTuple<'_>,
    issued_at: DateTime<Utc>,
) -> AppResult<String> {
    serde_json::to_string(&AttestationClaimsV1 {
        v: ATTESTATION_VERSION_V1,
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
pub(crate) fn verify_stored_content(
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
       i.owner_assigned_at, i.origin, i.revision, i.closed_at, i.closed_by, i.closure_note,
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
    audit_in_tx_as(
        tx,
        event_type,
        "USER",
        actor_id,
        incident_id,
        action,
        details,
    )
    .await
}

async fn audit_in_tx_as(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    event_type: &str,
    actor_type: &str,
    actor_id: Uuid,
    incident_id: Uuid,
    action: &str,
    details: serde_json::Value,
) -> AppResult<()> {
    sqlx::query(
        r#"
        INSERT INTO kernel.audit_events
          (id, event_type, actor_type, actor_id, subject_type, subject_id, action, result, details, request_id, occurred_at)
        VALUES ($1,$2,$3,$4,'INCIDENT',$5,$6,'ACCEPTED',$7,NULL,$8)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(event_type)
    .bind(actor_type)
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
/// See `workspaces::workspace_not_found`: the constructor lives in Core.
pub(crate) use crate::workspaces::workspace_not_found;
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

// B2.2 (module structure): the test suite of this module is 5.6k lines, which is
// two thirds of the file. `include!` keeps it in the same module scope - every
// `use super::*` and private item keeps resolving exactly as before - while the
// production file becomes readable on its own. This is a move, not a rewrite.
#[cfg(test)]
include!("incidents_tests.rs");
