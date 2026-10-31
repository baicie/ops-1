//! G12 Phase E: a bounded, read-only AI investigator for one incident.
//!
//! This module implements docs/design/g12-ai/investigation-adr.md (ADR-G12-004) and
//! the wire format in contracts/openapi/investigation-v1.yaml. It adds no capability
//! the incident slice did not already have: every read it performs is the read an
//! operator could already make, under the operator's own predicate.
//!
//! The five rules this module exists to enforce, each with the mechanism that
//! enforces it rather than a comment that promises it:
//!
//!   E1  AI hypothesis is not human verdict. investigation_hypotheses.stance uses a
//!       vocabulary disjoint from incident_verdicts.verdict, there is no key, trigger
//!       or code path between the two tables, and every response says
//!       isHumanVerdict: false. Signing a verdict still requires POST .../verdict with
//!       an operator session; nothing here calls it.
//!   E2  Read-only, scoped, authorized by the backend. Each tool calls the SAME
//!       predicate the HTTP read endpoints use (query_incident / query_evidence /
//!       query_timeline / query_incidents), and every tool call re-reads the scope
//!       account's role from kernel.users first, so a demotion mid-run takes effect on
//!       the next call.
//!   E3  Bounded. Steps, tool calls, per-tool timeout, total deadline, token budget,
//!       retries, idempotent run id, cancellation, audit and usage recording are all
//!       columns of kernel.investigation_runs, so the bound a run was held to is
//!       readable afterwards.
//!   E4  Honest about what answered. The test adapter is a first-class provider kind,
//!       its runs are labelled TEST_FIXTURE on the wire and in the UI, and a real HTTP
//!       provider only exists when the deployment configures an endpoint, a model and
//!       a credential VARIABLE NAME. Without that, a real-model run is BLOCKED.
//!   E5  A human review of an investigation concludes nothing about the incident.
//!       investigation_human_reviews holds ACCEPTED or REJECTED and writes into
//!       incident_verdicts from nowhere.
//!
//! Deliberately absent: any tool that writes, any tool that runs a command or a query
//! the investigator supplied, any fetch of a caller-supplied URL, and any generic
//! scheduler. A run executes inside the request that starts it, which is why
//! kernel.pipeline_jobs is not reused (ADR-G12-004 section 6).

use crate::audit;
use crate::auth::AuthUser;
use crate::config::Config;
use crate::error::{AppError, AppResult};
use crate::incidents::{
    incident_status, query_evidence, query_incident, query_incidents, query_timeline,
    verify_stored_content, EvidenceView, IncidentListQuery, IncidentTimeline, IncidentView,
};
use crate::scope::DataScope;
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use opsweave_contracts::Role;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::types::Json as SqlJson;
use sqlx::{FromRow, PgPool};
use std::collections::{BTreeSet, HashMap};
use std::time::{Duration, Instant};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Closed value sets. Constants rather than SQL literals because the database CHECK
// constraints and the code that writes them must agree, and a set that only lived in
// SQL would stop being readable from Rust the moment a test needed it.
// ---------------------------------------------------------------------------

/// The provider the kernel always has. Never a model.
const TEST_FIXTURE_PROVIDER_ID: &str = "test-fixture-v1";
/// The one real provider kind. It exists only when the deployment configures it.
const HTTP_PROVIDER_ID: &str = "http-openai-compatible-v1";

const ADAPTER_TEST_FIXTURE: &str = "TEST_FIXTURE";
const ADAPTER_HTTP: &str = "HTTP_OPENAI_COMPATIBLE";

const TOOL_GET_INCIDENT: &str = "get_incident";
const TOOL_LIST_EVIDENCE: &str = "list_evidence";
const TOOL_READ_EVIDENCE: &str = "read_evidence";
const TOOL_GET_TIMELINE: &str = "get_incident_timeline";
const TOOL_GET_RELATED: &str = "get_related_context";

/// The complete tool surface. A call naming anything else is refused before it can
/// reach a query.
const TOOL_NAMES: &[&str] = &[
    TOOL_GET_INCIDENT,
    TOOL_LIST_EVIDENCE,
    TOOL_READ_EVIDENCE,
    TOOL_GET_TIMELINE,
    TOOL_GET_RELATED,
];

/// The predicates a tool may claim to have been authorized by. A successful invocation
/// cannot be stored without one (0020 CHECK constraint), so "the investigator read
/// something" always answers "under which authority".
const PREDICATE_INCIDENT_READ: &str = "INCIDENT_READ_PREDICATE";
const PREDICATE_EVIDENCE_CONTENT: &str = "EVIDENCE_CONTENT_FIXITY_CHECK";

const STANCES: &[&str] = &["SUPPORTED", "CONTRADICTED", "UNCERTAIN", "CONFLICTED"];
const CONFIDENCES: &[&str] = &["HIGH", "MEDIUM", "LOW"];
const REVIEW_DECISIONS: &[&str] = &["ACCEPTED", "REJECTED"];
const SCENARIOS: &[&str] = &[
    "AUTO",
    "CROSS_SCOPE_PROBE",
    "PACED_TOOL_LOOP",
    "BUDGET_TOOL_CALLS",
    "RELATED_CONTEXT",
];

const DEFAULT_MAX_STEPS: i64 = 8;
const DEFAULT_MAX_TOOL_CALLS: i64 = 12;
const DEFAULT_TOOL_TIMEOUT_MS: i64 = 2_000;
const DEFAULT_MAX_RETRIES: i64 = 1;
const DEFAULT_TOKEN_BUDGET: i64 = 20_000;
const DEFAULT_DEADLINE_SECONDS: i64 = 30;

const MAX_STEPS_LIMIT: i64 = 200;
const MAX_TOOL_CALLS_LIMIT: i64 = 500;
const MIN_TOOL_TIMEOUT_MS: i64 = 100;
const MAX_TOOL_TIMEOUT_MS: i64 = 60_000;
const MAX_RETRIES_LIMIT: i64 = 5;
const MAX_TOKEN_BUDGET: i64 = 4_000_000;
/// The total deadline cannot be turned into an unbounded request by a client.
const MAX_DEADLINE_SECONDS: i64 = 300;

const IDEMPOTENCY_KEY_MIN_CHARS: usize = 8;
const IDEMPOTENCY_KEY_MAX_CHARS: usize = 200;
const REVIEW_NOTE_MIN_CHARS: usize = 10;
const REVIEW_NOTE_MAX_CHARS: usize = 2000;

/// How many evidence rows one list_evidence call may hand to the investigator.
const TOOL_EVIDENCE_MAX_ROWS: usize = 25;
const TOOL_TIMELINE_MAX_EVENTS: i64 = 100;
/// Characters of an evidence body one read_evidence call may return. Characters, not
/// bytes, because the body is UTF-8 text and a byte cut can split a codepoint.
const TOOL_CONTENT_MAX_CHARS: usize = 4_000;
/// The largest payload recorded verbatim in the invocation ledger. 64 KiB is the phase's
/// own bound for a piece of evidence content, so a payload that quotes content fits and a
/// payload that has grown into an archive is recorded by length and digest only (G12 F,
/// migration 0021 §3). Characters, not bytes: the ledger stores text.
const RESULT_BODY_MAX_BYTES: usize = 65_536;
/// Hypotheses one run may record.
const TOOL_HYPOTHESIS_MAX: usize = 5;
const TOOL_CITATION_MAX_PER_ROLE: usize = 8;
/// How much of one tool call's result the transcript keeps. The transcript is what the
/// next turn is built from, and an unbounded transcript is an unbounded prompt.
const TRANSCRIPT_EVIDENCE_MAX_ROWS: usize = 40;

/// The fixture's per-step pacing. Its only purpose is to make cancellation and the
/// total deadline observable in an acceptance run: a fixture that answered instantly
/// would make "the operator cancelled it" untestable rather than tested. It changes no
/// fixture output.
const FIXTURE_PACING: Duration = Duration::from_millis(15);
/// Deterministic usage accounting for the fixture: prompt is a fixed base plus a
/// per-evidence-row charge, completion is fixed. Recorded as a measurement of the
/// fixture, never presented as a model's usage.
const FIXTURE_PROMPT_BASE_TOKENS: i64 = 120;
const FIXTURE_PROMPT_TOKENS_PER_EVIDENCE: i64 = 8;
const FIXTURE_COMPLETION_TOKENS: i64 = 60;

// ---------------------------------------------------------------------------
// Wire shapes. contracts/openapi/investigation-v1.yaml is this document.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartInvestigationRequest {
    /// The client's key for this investigation. Required: a bounded, costly operation
    /// that a retry could silently run twice needs one from the caller, not a guess.
    pub idempotency_key: String,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub max_steps: Option<i64>,
    #[serde(default)]
    pub max_tool_calls: Option<i64>,
    #[serde(default)]
    pub tool_timeout_ms: Option<i64>,
    #[serde(default)]
    pub max_retries: Option<i64>,
    #[serde(default)]
    pub token_budget: Option<i64>,
    #[serde(default)]
    pub deadline_seconds: Option<i64>,
    /// Which deterministic fixture script to run. Refused for any provider that is not
    /// the fixture, because a scenario is a test-adapter concept and must not become a
    /// way to steer a real model.
    #[serde(default)]
    pub scenario: Option<String>,
    /// A fixture-only probe: the incident id the test adapter should pass to its tools.
    /// Its whole purpose is to let an acceptance run ask the tools for somebody else's
    /// incident and show them refusing. Refused unless the scenario is the probe.
    #[serde(default)]
    pub probe_incident_id: Option<Uuid>,
    /// The evidence id the probe should pass to read_evidence.
    #[serde(default)]
    pub probe_evidence_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewInvestigationRequest {
    pub decision: String,
    pub note: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetView {
    pub max_steps: i64,
    pub max_tool_calls: i64,
    pub tool_timeout_ms: i64,
    pub max_retries: i64,
    pub token_budget: i64,
    pub deadline_seconds: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageView {
    pub steps: i64,
    pub tool_calls: i64,
    pub retries: i64,
    pub hypotheses: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub cost_micros: i64,
    pub cost_basis: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CitationView {
    pub evidence_id: Uuid,
    pub role: String,
    pub kind: String,
    pub verified_trust: String,
    pub collected_at: DateTime<Utc>,
    pub content_status: String,
    pub invocation_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HypothesisView {
    pub hypothesis_id: Uuid,
    pub ordinal: i32,
    pub statement: String,
    /// SUPPORTED, CONTRADICTED, UNCERTAIN or CONFLICTED. Never CONFIRMED, REFUTED or
    /// INCONCLUSIVE: those are the human verdict's words and they are not reachable
    /// from here.
    pub stance: String,
    pub confidence: String,
    pub reasoning: String,
    pub uncertainty: Option<String>,
    pub gap_codes: Vec<String>,
    pub supporting_evidence: Vec<CitationView>,
    pub contradicting_evidence: Vec<CitationView>,
    /// Always false. Stated on the wire so a consumer that only reads JSON still knows
    /// this object is a hypothesis and not a conclusion somebody signed.
    pub is_human_verdict: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvocationView {
    pub invocation_id: Uuid,
    pub sequence: i32,
    pub attempt: i32,
    pub tool: String,
    pub arguments: Value,
    pub outcome: String,
    pub error_code: Option<String>,
    /// Why it failed, in the kernel's words. The UI renders the code (localized) and an
    /// auditor reads this, so the two are separate fields rather than one sentence.
    pub error_detail: Option<String>,
    pub authorization_predicate: Option<String>,
    pub scope_actor: Option<Uuid>,
    pub result_bytes: Option<i32>,
    pub evidence_refs: Vec<Uuid>,
    pub duration_ms: i32,
    pub started_at: DateTime<Utc>,
    pub finished_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewView {
    pub decision: String,
    pub note: String,
    pub reviewed_by: Uuid,
    pub reviewed_at: DateTime<Utc>,
    pub is_human_verdict: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvestigationRunView {
    pub run_id: Uuid,
    pub incident_id: Uuid,
    pub status: String,
    /// True when the row still says RUNNING although its total deadline has passed: an
    /// abandoned run is reported as abandoned instead of being called running.
    pub stale: bool,
    /// The discernible marker. A response produced by the deterministic test adapter
    /// says TEST_FIXTURE here, in adapterLabel, and in every hypothesis it carries, so a
    /// fixture's output cannot be mistaken for a model's.
    pub adapter: String,
    pub adapter_label: String,
    pub adapter_provider_id: String,
    pub adapter_model_id: Option<String>,
    /// True exactly when this run was answered by the test adapter.
    pub synthetic: bool,
    /// Always AI_HYPOTHESIS. The document's own statement of what it is.
    pub hypothesis_kind: String,
    /// Always false. Nothing this endpoint returns is a human verdict.
    pub is_human_verdict: bool,
    pub idempotency_key: String,
    /// True when this response is the run that already existed for the key, so the
    /// caller can tell a replay from a fresh investigation.
    pub idempotent_replay: bool,
    pub requested_by: Uuid,
    pub scope_user_id: Uuid,
    pub budget: BudgetView,
    pub usage: UsageView,
    pub stop_reason: Option<String>,
    pub detail: Option<String>,
    pub cancel_requested_at: Option<DateTime<Utc>>,
    pub cancel_requested_by: Option<Uuid>,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub deadline_at: DateTime<Utc>,
    pub hypotheses: Vec<HypothesisView>,
    pub tool_invocations: Vec<InvocationView>,
    pub review: Option<ReviewView>,
}

// ---------------------------------------------------------------------------
// The provider: an identity, not a credential.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, FromRow)]
struct ProviderRow {
    provider_id: String,
    kind: String,
    credential_env_var: Option<String>,
    base_url: Option<String>,
    model_id: Option<String>,
}

/// Resolve the provider a run may use, or refuse the run.
///
/// The requested id is never trusted to name a row: the fixture is the one seeded row,
/// and the real provider exists only if this deployment configured an endpoint, a model
/// and the NAME of the environment variable holding the secret. Anything else is
/// MODEL_PROVIDER_NOT_CONFIGURED, which is what makes a real-model E2E BLOCKED here
/// instead of silently answered by something else.
async fn resolve_provider(db: &PgPool, config: &Config, requested: &str) -> AppResult<ProviderRow> {
    if requested == TEST_FIXTURE_PROVIDER_ID {
        return sqlx::query_as::<_, ProviderRow>(
            "SELECT provider_id, kind, credential_env_var, base_url, model_id
               FROM kernel.investigation_model_providers WHERE provider_id=$1",
        )
        .bind(requested)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| {
            AppError::internal(format!(
                "provider {requested} is seeded by migration 0020 but is missing"
            ))
        });
    }
    if requested == HTTP_PROVIDER_ID {
        let Some(base_url) = config.investigation_http_base_url.as_deref() else {
            return Err(provider_not_configured(requested));
        };
        let Some(model_id) = config.investigation_http_model.as_deref() else {
            return Err(provider_not_configured(requested));
        };
        let Some(credential_env_var) = config.investigation_http_credential_env.as_deref() else {
            return Err(provider_not_configured(requested));
        };
        // The row is derived from deployment configuration, so it is upserted from it
        // and never from a request body. Only the variable NAME is stored.
        sqlx::query(
            "INSERT INTO kernel.investigation_model_providers
                 (provider_id, kind, display_name, credential_env_var, base_url, model_id, enabled)
             VALUES ($1,$2,$3,$4,$5,$6,true)
             ON CONFLICT (provider_id) DO UPDATE
                SET credential_env_var=EXCLUDED.credential_env_var,
                    base_url=EXCLUDED.base_url,
                    model_id=EXCLUDED.model_id,
                    enabled=true",
        )
        .bind(HTTP_PROVIDER_ID)
        .bind(ADAPTER_HTTP)
        .bind(config.investigation_http_display_name.as_str())
        .bind(credential_env_var)
        .bind(base_url)
        .bind(model_id)
        .execute(db)
        .await?;
        return sqlx::query_as::<_, ProviderRow>(
            "SELECT provider_id, kind, credential_env_var, base_url, model_id
               FROM kernel.investigation_model_providers WHERE provider_id=$1",
        )
        .bind(HTTP_PROVIDER_ID)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| provider_not_configured(requested));
    }
    Err(provider_not_configured(requested))
}

fn provider_not_configured(requested: &str) -> AppError {
    AppError::new(
        StatusCode::CONFLICT,
        "MODEL_PROVIDER_NOT_CONFIGURED",
        format!(
            "this kernel has no model provider {requested}: the only provider it always has is {TEST_FIXTURE_PROVIDER_ID} (a deterministic test fixture, not a model), and a real provider exists only when the deployment sets OPSWEAVE_INVESTIGATION_PROVIDER_BASE_URL, OPSWEAVE_INVESTIGATION_PROVIDER_MODEL and OPSWEAVE_INVESTIGATION_PROVIDER_CREDENTIAL_ENV"
        ),
    )
}

/// What answered a run.
enum Adapter {
    TestFixture,
    Http {
        base_url: String,
        model_id: String,
        credential_env_var: String,
    },
}

impl Adapter {
    fn from_provider(provider: &ProviderRow) -> AppResult<Self> {
        match provider.kind.as_str() {
            ADAPTER_TEST_FIXTURE => Ok(Adapter::TestFixture),
            ADAPTER_HTTP => {
                let (Some(base_url), Some(model_id), Some(credential_env_var)) = (
                    provider.base_url.clone(),
                    provider.model_id.clone(),
                    provider.credential_env_var.clone(),
                ) else {
                    return Err(provider_not_configured(&provider.provider_id));
                };
                Ok(Adapter::Http {
                    base_url,
                    model_id,
                    credential_env_var,
                })
            }
            other => Err(AppError::internal(format!(
                "provider {} has unknown kind {other}",
                provider.provider_id
            ))),
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Adapter::TestFixture => ADAPTER_TEST_FIXTURE,
            Adapter::Http { .. } => ADAPTER_HTTP,
        }
    }
}

// ---------------------------------------------------------------------------
// The tool layer.
// ---------------------------------------------------------------------------

/// A refused or failed tool call: what the invocation row records instead of a result.
#[derive(Debug)]
struct ToolFailure {
    /// REFUSED: an authorization predicate said no. ERROR: something broke.
    /// TIMEOUT: the per-tool timeout fired.
    outcome: &'static str,
    code: &'static str,
    message: String,
}

impl ToolFailure {
    fn refused(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            outcome: "REFUSED",
            code,
            message: message.into(),
        }
    }

    fn error(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            outcome: "ERROR",
            code,
            message: message.into(),
        }
    }

    fn timeout() -> Self {
        Self {
            outcome: "TIMEOUT",
            code: "TOOL_TIMEOUT",
            message: "the read did not finish inside the per-tool timeout".to_string(),
        }
    }

    fn invalid_argument(message: impl Into<String>) -> Self {
        Self::refused("TOOL_ARGUMENT_INVALID", message)
    }

    /// The sentence stored beside the code, bounded by the column.
    fn detail(&self) -> &str {
        let end = self
            .message
            .char_indices()
            .nth(999)
            .map(|(index, _)| index)
            .unwrap_or(self.message.len());
        &self.message[..end]
    }

    /// An AppError the shared predicate produced, kept with its own stable code so the
    /// investigator is told exactly what an HTTP caller would be told.
    fn from_predicate(error: &AppError) -> Self {
        if error.status == StatusCode::NOT_FOUND || error.status == StatusCode::FORBIDDEN {
            Self::refused(error.code, error.message.clone())
        } else {
            Self::error(error.code, error.message.clone())
        }
    }
}

#[derive(Debug)]
struct ToolOutcome {
    payload: Value,
    predicate: &'static str,
    evidence_refs: Vec<Uuid>,
    /// The retention horizon of the bytes this payload quotes, when it quotes bytes.
    /// read_evidence sets it from the content row it just read, so the copy the run keeps
    /// in its invocation record carries the same horizon as the row it came from (G12 F,
    /// migration 0021 §3). Everything else derives its payload from live rows and copies
    /// nothing, so it leaves this None.
    retention: Option<DateTime<Utc>>,
}

/// The run's authorized incident, as the tool layer sees it.
#[derive(Clone, Copy)]
struct ToolScope {
    /// The incident the investigation is about. A tool may read this one; a tool that
    /// names another incident still has to pass the predicate for it.
    incident_id: Uuid,
    /// The account whose authority the read is performed under, re-read per call.
    scope_user_id: Uuid,
}

/// Resolve the caller of one tool invocation from the database, now.
///
/// Deliberately not cached from the run's start: a scope account demoted, disabled or
/// deleted between two tool calls must stop being able to read on the next one, and the
/// only way to guarantee that is to ask the database at the moment of the read.
async fn scope_caller(db: &PgPool, scope_user_id: Uuid) -> Result<DataScope, ToolFailure> {
    let role: Option<String> = sqlx::query_scalar("SELECT role FROM kernel.users WHERE id=$1")
        .bind(scope_user_id)
        .fetch_optional(db)
        .await
        .map_err(|error| ToolFailure::error("TOOL_SCOPE_UNAVAILABLE", error.to_string()))?;
    let Some(role) = role else {
        return Err(ToolFailure::refused(
            "SCOPE_IDENTITY_UNAVAILABLE",
            "the account this investigation runs as no longer exists, so its reads are refused",
        ));
    };
    let role = role.parse::<Role>().map_err(|_| {
        ToolFailure::refused(
            "SCOPE_IDENTITY_UNAVAILABLE",
            "the account this investigation runs as has a role this kernel cannot interpret, so its reads are refused",
        )
    })?;
    // Membership is read here too, at the same instant and for the same reason: a
    // workspace the account was removed from between two tool calls must stop answering
    // on the next one. A run's stored scope_user_id names WHO acts; this line decides
    // what that account may read right now.
    DataScope::resolve_for(db, scope_user_id, role)
        .await
        .map_err(|error| ToolFailure::error("TOOL_SCOPE_UNAVAILABLE", error.to_string()))
}

/// Which incident a tool call is about. Absent means the run's own; anything present
/// must be a UUID, and it is then still subject to the predicate.
fn target_incident(arguments: &Value, scope: ToolScope) -> Result<Uuid, ToolFailure> {
    match arguments.get("incidentId") {
        None | Some(Value::Null) => Ok(scope.incident_id),
        Some(Value::String(raw)) => Uuid::parse_str(raw.trim())
            .map_err(|_| ToolFailure::invalid_argument("incidentId must be a UUID")),
        Some(_) => Err(ToolFailure::invalid_argument(
            "incidentId must be a UUID string",
        )),
    }
}

fn bounded_limit(arguments: &Value, default: i64, max: i64) -> Result<i64, ToolFailure> {
    match arguments.get("limit") {
        None | Some(Value::Null) => Ok(default),
        Some(value) => {
            let limit = value
                .as_i64()
                .ok_or_else(|| ToolFailure::invalid_argument("limit must be a number"))?;
            if limit < 1 || limit > max {
                return Err(ToolFailure::invalid_argument(format!(
                    "limit must be between 1 and {max}"
                )));
            }
            Ok(limit)
        }
    }
}

fn required_uuid(arguments: &Value, field: &str) -> Result<Uuid, ToolFailure> {
    match arguments.get(field) {
        Some(Value::String(raw)) => Uuid::parse_str(raw.trim())
            .map_err(|_| ToolFailure::invalid_argument(format!("{field} must be a UUID"))),
        Some(_) => Err(ToolFailure::invalid_argument(format!(
            "{field} must be a UUID string"
        ))),
        None => Err(ToolFailure::invalid_argument(format!(
            "{field} is required"
        ))),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn evidence_facts(view: &EvidenceView) -> Value {
    json!({
        "evidenceId": view.evidence_id,
        "kind": view.kind,
        "source": view.source,
        "collectedAt": view.collected_at,
        "claimedTrust": view.claimed_trust,
        "verifiedTrust": view.verified_trust,
        "verificationMethod": view.verification_method,
        "contentStatus": view.content_status,
    })
}

/// Execute one tool call.
async fn execute_tool(
    db: &PgPool,
    authorized_sources: &[String],
    scope: ToolScope,
    tool: &str,
    arguments: &Value,
) -> Result<ToolOutcome, ToolFailure> {
    if !TOOL_NAMES.contains(&tool) {
        return Err(ToolFailure::refused(
            "TOOL_NOT_AVAILABLE",
            format!(
                "{tool} is not one of the five read tools this investigator has ({}); the investigator cannot invent one",
                TOOL_NAMES.join(", ")
            ),
        ));
    }
    // One re-read of the scope account per invocation, before anything is read.
    let caller = scope_caller(db, scope.scope_user_id).await?;
    match tool {
        TOOL_GET_INCIDENT => {
            let target = target_incident(arguments, scope)?;
            let incident = query_incident(db, caller.clone(), target)
                .await
                .map_err(|error| ToolFailure::from_predicate(&error))?;
            Ok(ToolOutcome {
                payload: incident_payload(&incident),
                predicate: PREDICATE_INCIDENT_READ,
                evidence_refs: incident.evidence_refs.clone(),
                retention: None,
            })
        }
        TOOL_LIST_EVIDENCE => {
            let target = target_incident(arguments, scope)?;
            let limit = bounded_limit(
                arguments,
                TOOL_EVIDENCE_MAX_ROWS as i64,
                TOOL_EVIDENCE_MAX_ROWS as i64,
            )?;
            let rows = query_evidence(db, caller, target, (None, None))
                .await
                .map_err(|error| ToolFailure::from_predicate(&error))?;
            let kept: Vec<&EvidenceView> = rows.iter().take(limit as usize).collect();
            let refs: Vec<Uuid> = kept.iter().map(|row| row.evidence_id).collect();
            Ok(ToolOutcome {
                payload: json!({
                    "incidentId": target,
                    "totalRows": rows.len(),
                    "returnedRows": refs.len(),
                    "truncated": rows.len() > refs.len(),
                    "items": kept.iter().map(|row| evidence_facts(row)).collect::<Vec<_>>(),
                }),
                predicate: PREDICATE_INCIDENT_READ,
                evidence_refs: refs,
                retention: None,
            })
        }
        TOOL_READ_EVIDENCE => {
            let target = target_incident(arguments, scope)?;
            let wanted = required_uuid(arguments, "evidenceId")?;
            // The incident predicate first, exactly as GET .../evidence/{id}/content does.
            incident_status(db, caller.clone(), target)
                .await
                .map_err(|error| ToolFailure::from_predicate(&error))?;
            let rows = query_evidence(db, caller, target, (None, None))
                .await
                .map_err(|error| ToolFailure::from_predicate(&error))?;
            let Some(row) = rows.iter().find(|row| row.evidence_id == wanted) else {
                return Err(ToolFailure::refused(
                    "EVIDENCE_NOT_FOUND",
                    "no evidence row with this id belongs to the incident this investigation may read",
                ));
            };
            // G12 F (P1-1): the body column is bytea. Declaring it String made libpq
            // raise "mismatched types; Rust type String" on every row that HAS content,
            // so read_evidence failed 100% of the time for STORED evidence while the HTTP
            // read of the same bytes worked. incidents::StoredContent is that read's own
            // alias, so the two paths cannot disagree about the column types again.
            let stored: Option<crate::incidents::StoredContent> = sqlx::query_as(
                "SELECT c.content_type, c.body, c.content_bytes, c.sha256, c.retention_expires_at
                   FROM kernel.incident_evidence_content c
                  WHERE c.evidence_id=$1",
            )
            .bind(wanted)
            .fetch_optional(db)
            .await
            .map_err(|error| ToolFailure::error("TOOL_READ_FAILED", error.to_string()))?;
            let mut payload = evidence_facts(row);
            let Some((content_type, body, content_bytes, recorded_sha256, retention_expires_at)) =
                stored
            else {
                payload["content"] = Value::Null;
                payload["contentNote"] = json!(
                    "this row is a reference: the Kernel stored a locator and holds no content for it"
                );
                return Ok(ToolOutcome {
                    payload,
                    predicate: PREDICATE_EVIDENCE_CONTENT,
                    evidence_refs: vec![wanted],
                    retention: None,
                });
            };
            if retention_expires_at <= Utc::now() {
                return Err(ToolFailure::refused(
                    "EVIDENCE_CONTENT_EXPIRED",
                    "this evidence content reached its retention horizon and is no longer served",
                ));
            }
            // Fixity, recomputed over the bytes in hand. The second predicate this read
            // stands on, and the reason a tampered row is refused rather than quoted.
            let digest = verify_stored_content(wanted, content_bytes, &body, &recorded_sha256)
                .map_err(|error| ToolFailure::from_predicate(&error))?;
            // The bytes are UTF-8 by construction (the API stores the body of a JSON
            // string), and the digest above just proved these are the bytes that were
            // stored. A row that is not UTF-8 was hand-written into the column, so it is
            // reported as a failed read rather than quoted lossily: a lossy body would not
            // be the bytes the digest covers, and "the investigator read X" would be false.
            let body = match String::from_utf8(body) {
                Ok(body) => body,
                Err(error) => {
                    return Err(ToolFailure::error(
                        "TOOL_READ_FAILED",
                        format!("the stored bytes are not UTF-8 text: {error}"),
                    ))
                }
            };
            let (text, truncated) = truncate_chars(&body, TOOL_CONTENT_MAX_CHARS);
            payload["content"] = json!({
                "contentType": content_type,
                "body": text,
                "truncated": truncated,
                "sha256": digest,
                "bytes": content_bytes,
            });
            Ok(ToolOutcome {
                payload,
                predicate: PREDICATE_EVIDENCE_CONTENT,
                evidence_refs: vec![wanted],
                // The copy this run keeps inherits the horizon of the row it came from.
                retention: Some(retention_expires_at),
            })
        }
        TOOL_GET_TIMELINE => {
            let target = target_incident(arguments, scope)?;
            let limit = bounded_limit(arguments, 50, TOOL_TIMELINE_MAX_EVENTS)?;
            let timeline: IncidentTimeline = query_timeline(db, caller, target, limit)
                .await
                .map_err(|error| ToolFailure::from_predicate(&error))?;
            Ok(ToolOutcome {
                payload: json!({
                    "incidentId": target,
                    "truncated": timeline.truncated,
                    "events": timeline.items,
                }),
                predicate: PREDICATE_INCIDENT_READ,
                evidence_refs: Vec::new(),
                retention: None,
            })
        }
        _ => related_context(db, authorized_sources, caller, scope, arguments).await,
    }
}

/// get_related_context: a source the deployment authorised, read through the same
/// predicate GET /api/v1/incidents uses.
async fn related_context(
    db: &PgPool,
    authorized_sources: &[String],
    caller: DataScope,
    scope: ToolScope,
    arguments: &Value,
) -> Result<ToolOutcome, ToolFailure> {
    let target = target_incident(arguments, scope)?;
    let source_id = match arguments.get("sourceId") {
        Some(Value::String(raw)) if !raw.trim().is_empty() => raw.trim().to_string(),
        _ => {
            return Err(ToolFailure::invalid_argument(
                "sourceId is required and must name a configured source",
            ))
        }
    };
    // The source must be authorised on THIS deployment. An empty list means the tool is
    // not available at all, and answering with an empty page would be a fabricated
    // success for a source that was never read.
    if !authorized_sources
        .iter()
        .any(|allowed| allowed == &source_id)
    {
        return Err(ToolFailure::refused(
            "SOURCE_UNAVAILABLE",
            format!(
                "{source_id} is not an authorised related-context source on this deployment (OPSWEAVE_INVESTIGATION_RELATED_SOURCES); no data was read"
            ),
        ));
    }
    let declared: Option<(String, String)> = sqlx::query_as(
        "SELECT source_id, authorization_predicate
           FROM kernel.investigation_related_sources WHERE source_id=$1",
    )
    .bind(&source_id)
    .fetch_optional(db)
    .await
    .map_err(|error| ToolFailure::error("TOOL_READ_FAILED", error.to_string()))?;
    let Some((source_id, declared_predicate)) = declared else {
        return Err(ToolFailure::refused(
            "SOURCE_UNAVAILABLE",
            "this kernel has no such related-context source",
        ));
    };
    if source_id != "incident_index" {
        return Err(ToolFailure::refused(
            "SOURCE_UNAVAILABLE",
            "this kernel has no reader for that source",
        ));
    }
    // incident_index is the kernel's own incidents table. Its authorization is the very
    // predicate this row declares, and the query below applies it: the source can
    // narrow what the operator sees to one entity, never widen it.
    if declared_predicate != PREDICATE_INCIDENT_READ {
        return Err(ToolFailure::refused(
            "SOURCE_PREDICATE_UNKNOWN",
            "the declared authorization predicate of this source is not one this tool can apply",
        ));
    }
    let incident = query_incident(db, caller.clone(), target)
        .await
        .map_err(|error| ToolFailure::from_predicate(&error))?;
    let Some(entity) = incident.related_entity.clone() else {
        return Ok(ToolOutcome {
            payload: json!({
                "sourceId": source_id,
                "relatedEntity": Value::Null,
                "returnedRows": 0,
                "items": Vec::<Value>::new(),
                "note": "this incident declares no relatedEntity, so the index had nothing to look up: an empty page here means the query could not be aimed, not that nothing matched",
            }),
            predicate: PREDICATE_INCIDENT_READ,
            evidence_refs: Vec::new(),
            retention: None,
        });
    };
    let query = IncidentListQuery {
        related_entity: Some(entity.clone()),
        limit: Some(10),
        ..Default::default()
    };
    let (items, _cursor) = query_incidents(db, caller, query)
        .await
        .map_err(|error| ToolFailure::from_predicate(&error))?;
    Ok(ToolOutcome {
        payload: json!({
            "sourceId": source_id,
            "relatedEntity": entity,
            "authorizationPredicate": PREDICATE_INCIDENT_READ,
            "returnedRows": items.len(),
            "items": items.iter().map(incident_payload).collect::<Vec<_>>(),
        }),
        predicate: PREDICATE_INCIDENT_READ,
        evidence_refs: Vec::new(),
        retention: None,
    })
}

fn incident_payload(incident: &IncidentView) -> Value {
    json!({
        "incidentId": incident.id,
        "title": incident.title,
        "severity": incident.severity,
        "status": incident.status,
        "source": incident.source,
        "relatedEntity": incident.related_entity,
        "startedAt": incident.started_at,
        "updatedAt": incident.updated_at,
        "revision": incident.revision,
        "evidenceCount": incident.evidence_refs.len(),
        "hasHumanVerdict": incident.human_verdict.is_some(),
        "closedAt": incident.closed_at,
    })
}

/// Cut a body to at most max_chars characters without splitting a codepoint, and say
/// whether anything was dropped.
fn truncate_chars(body: &str, max_chars: usize) -> (String, bool) {
    let mut out = String::new();
    for (kept, character) in body.chars().enumerate() {
        if kept >= max_chars {
            return (out, true);
        }
        out.push(character);
    }
    (out, false)
}

// ---------------------------------------------------------------------------
// The model seam: one bounded turn at a time.
// ---------------------------------------------------------------------------

/// What a turn may decide. Two shapes and no others: ask for a read, or stop and state
/// hypotheses.
#[derive(Debug)]
enum ModelDecision {
    ToolCall { tool: String, arguments: Value },
    Final { hypotheses: Vec<ProposedHypothesis> },
}

#[derive(Debug)]
struct ProposedHypothesis {
    statement: String,
    stance: String,
    confidence: String,
    reasoning: String,
    uncertainty: Option<String>,
    gap_codes: Vec<String>,
    supporting: Vec<Uuid>,
    contradicting: Vec<Uuid>,
}

struct ModelTurn {
    decision: ModelDecision,
    prompt_tokens: i64,
    completion_tokens: i64,
}

#[derive(Debug)]
struct ModelFailure {
    code: &'static str,
    message: String,
}

/// Everything the investigator knows when the next turn is built. Bounded by
/// construction: at most TRANSCRIPT_EVIDENCE_MAX_ROWS rows and one line per invocation.
/// A fixture-only cross-scope probe: the ids every tool is asked for, so a run can be
/// made to reach outside its own incident and be refused in the record.
#[derive(Clone, Copy)]
struct Probe {
    incident_id: Uuid,
    evidence_id: Uuid,
}

#[derive(Default)]
struct Transcript {
    step: i64,
    probe: Option<Probe>,
    incident: Option<Value>,
    evidence: Vec<Value>,
    invoked: Vec<(String, String)>,
    refused: bool,
    failed: bool,
}

impl Transcript {
    fn absorb_invocation(&mut self, tool: &str, outcome: &str, payload: Option<&Value>) {
        self.invoked.push((tool.to_string(), outcome.to_string()));
        match outcome {
            "OK" => {}
            "REFUSED" => self.refused = true,
            _ => self.failed = true,
        }
        let Some(payload) = payload else { return };
        if self.incident.is_none() && payload.get("title").is_some() {
            self.incident = Some(payload.clone());
        }
        if let Some(items) = payload.get("items").and_then(Value::as_array) {
            for item in items {
                if self.evidence.len() >= TRANSCRIPT_EVIDENCE_MAX_ROWS {
                    break;
                }
                if item.get("evidenceId").is_some() && item.get("verifiedTrust").is_some() {
                    self.evidence.push(item.clone());
                }
            }
        }
    }
}

fn fixture_usage(transcript: &Transcript) -> (i64, i64) {
    let prompt = FIXTURE_PROMPT_BASE_TOKENS
        + FIXTURE_PROMPT_TOKENS_PER_EVIDENCE * transcript.evidence.len() as i64;
    (prompt, FIXTURE_COMPLETION_TOKENS)
}

/// The deterministic test adapter.
///
/// It is not a model and does not pretend to reason. It walks real reads in a fixed
/// order, then states one hypothesis whose stance, citations and reasoning are derived
/// ONLY from facts the reads actually returned. That is what makes it useful: the three
/// protocol cases E4 requires (evidence sufficient, evidence insufficient, evidence in
/// conflict) are produced by three different states of the real data, not by three
/// canned strings.
/// The five probes, in the order the cross-scope scenario runs them, each with the
/// arguments it must hand over. One list so the scenario cannot fall behind the tool set.
fn probe_calls(probe: Probe) -> Vec<(String, Value)> {
    vec![
        (
            TOOL_GET_INCIDENT.to_string(),
            json!({ "incidentId": probe.incident_id }),
        ),
        (
            TOOL_LIST_EVIDENCE.to_string(),
            json!({ "incidentId": probe.incident_id }),
        ),
        (
            TOOL_READ_EVIDENCE.to_string(),
            json!({ "incidentId": probe.incident_id, "evidenceId": probe.evidence_id }),
        ),
        (
            TOOL_GET_TIMELINE.to_string(),
            json!({ "incidentId": probe.incident_id }),
        ),
        (
            TOOL_GET_RELATED.to_string(),
            json!({ "incidentId": probe.incident_id, "sourceId": "incident_index" }),
        ),
    ]
}

fn fixture_decide(transcript: &Transcript, scenario: &str) -> ModelDecision {
    if scenario == "CROSS_SCOPE_PROBE" {
        let calls = probe_calls(transcript.probe.unwrap_or(Probe {
            incident_id: Uuid::nil(),
            evidence_id: Uuid::nil(),
        }));
        return match calls.get(transcript.invoked.len()) {
            Some((tool, arguments)) => ModelDecision::ToolCall {
                tool: tool.clone(),
                arguments: arguments.clone(),
            },
            None => ModelDecision::Final {
                hypotheses: vec![fixture_hypothesis(transcript)],
            },
        };
    }
    if scenario == "BUDGET_TOOL_CALLS" || scenario == "PACED_TOOL_LOOP" {
        // Never finalises: the tool-call budget, the deadline or a cancellation is what
        // has to stop this run.
        return ModelDecision::ToolCall {
            tool: TOOL_GET_INCIDENT.to_string(),
            arguments: json!({}),
        };
    }
    if transcript.incident.is_none() {
        return ModelDecision::ToolCall {
            tool: TOOL_GET_INCIDENT.to_string(),
            arguments: json!({}),
        };
    }
    if !transcript
        .invoked
        .iter()
        .any(|(tool, _)| tool == TOOL_LIST_EVIDENCE)
    {
        return ModelDecision::ToolCall {
            tool: TOOL_LIST_EVIDENCE.to_string(),
            arguments: json!({ "limit": TOOL_EVIDENCE_MAX_ROWS }),
        };
    }
    if scenario == "RELATED_CONTEXT"
        && !transcript
            .invoked
            .iter()
            .any(|(tool, _)| tool == TOOL_GET_RELATED)
    {
        return ModelDecision::ToolCall {
            tool: TOOL_GET_RELATED.to_string(),
            arguments: json!({ "sourceId": "incident_index" }),
        };
    }
    ModelDecision::Final {
        hypotheses: vec![fixture_hypothesis(transcript)],
    }
}

fn uuid_at(row: &Value, field: &str) -> Option<Uuid> {
    row.get(field)
        .and_then(Value::as_str)
        .and_then(|raw| Uuid::parse_str(raw).ok())
}

fn instant_at(row: &Value, field: &str) -> Option<DateTime<Utc>> {
    row.get(field)
        .and_then(Value::as_str)
        .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
        .map(|value| value.with_timezone(&Utc))
}

/// The single hypothesis the fixture states, built from the reads own output.
fn fixture_hypothesis(transcript: &Transcript) -> ProposedHypothesis {
    let incident = transcript.incident.clone().unwrap_or(Value::Null);
    let started_at = instant_at(&incident, "startedAt");
    let rows: Vec<&Value> = transcript.evidence.iter().collect();

    if rows.is_empty() {
        let gap = if transcript.refused {
            "TOOL_REFUSED"
        } else if transcript.failed {
            "TOOL_FAILED"
        } else {
            "NO_EVIDENCE_ROWS"
        };
        let why = if transcript.refused {
            "a read this investigation asked for was refused by the Kernel's scope predicate"
        } else if transcript.failed {
            "a read this investigation asked for failed"
        } else {
            "the reads returned no evidence rows for this incident"
        };
        return ProposedHypothesis {
            statement: format!(
                "No conclusion about the cause of this incident can be supported by the record: {why}."
            ),
            stance: "UNCERTAIN".to_string(),
            confidence: "LOW".to_string(),
            reasoning: "The investigator read the incident and its evidence. Returned evidence rows: 0. Without at least one row there is nothing to cite, and a hypothesis with no citation would be an assertion about the record that the record does not contain. The stance is UNCERTAIN rather than an empty answer so the protocol can state this instead of failing to."
                .to_string(),
            uncertainty: Some(
                "No evidence row was returned, so neither the timing nor the cause of this incident is established by anything this investigator read.".to_string(),
            ),
            gap_codes: vec![gap.to_string()],
            supporting: Vec::new(),
            contradicting: Vec::new(),
        };
    }

    // A conflict the data itself carries: a row collected BEFORE the incident's recorded
    // start contradicts the claim that this began at that instant.
    let mut early = Vec::new();
    let mut on_or_after = Vec::new();
    for row in &rows {
        let Some(collected) = instant_at(row, "collectedAt") else {
            continue;
        };
        let Some(id) = uuid_at(row, "evidenceId") else {
            continue;
        };
        match started_at {
            Some(started) if collected < started => early.push(id),
            _ => on_or_after.push(id),
        }
    }
    let started_label = started_at
        .map(|value| value.to_rfc3339())
        .unwrap_or_else(|| "an unreadable start time".to_string());

    if !early.is_empty() && !on_or_after.is_empty() {
        let supporting: Vec<Uuid> = on_or_after
            .iter()
            .copied()
            .take(TOOL_CITATION_MAX_PER_ROLE)
            .collect();
        let contradicting: Vec<Uuid> = early
            .iter()
            .copied()
            .take(TOOL_CITATION_MAX_PER_ROLE)
            .collect();
        return ProposedHypothesis {
            statement: format!(
                "The evidence record disagrees with itself about when this incident began: {} of {} evidence row(s) were collected before the recorded start ({started_label}), while {} were collected at or after it.",
                contradicting.len(),
                rows.len(),
                supporting.len()
            ),
            stance: "CONFLICTED".to_string(),
            confidence: "LOW".to_string(),
            reasoning: format!(
                "Each evidence row's collectedAt was compared with the incident's startedAt. {} row(s) precede it and are cited as contradicting; {} do not and are cited as supporting. The two groups cannot both describe a fault that started at one instant, so the conflict is reported instead of being resolved by preferring the larger group.",
                contradicting.len(),
                supporting.len()
            ),
            uncertainty: Some(
                "Which of the two groups is right cannot be decided from the rows alone: the earlier rows may predate the incident because they observe a precursor, or because the recorded start is wrong. A human has to say which.".to_string(),
            ),
            gap_codes: vec!["EVIDENCE_PREDATES_INCIDENT".to_string()],
            supporting,
            contradicting,
        };
    }

    let supporting: Vec<Uuid> = rows
        .iter()
        .filter_map(|row| uuid_at(row, "evidenceId"))
        .take(TOOL_CITATION_MAX_PER_ROLE)
        .collect();
    let kinds: BTreeSet<String> = rows
        .iter()
        .filter_map(|row| row.get("kind").and_then(Value::as_str).map(str::to_string))
        .collect();
    let unverified = rows
        .iter()
        .filter(|row| row.get("verifiedTrust").and_then(Value::as_str) == Some("UNVERIFIED"))
        .count();
    let mut gap_codes = Vec::new();
    if unverified > 0 {
        gap_codes.push("EVIDENCE_UNVERIFIED".to_string());
    }
    // G12 F (P1-2). Both of these used to be reported only in the no-rows branch, so a run
    // whose content read FAILED still said SUPPORTED / HIGH / gapCodes:[] and mentioned it
    // nowhere - a conclusion that overstated the part of the record it actually read. A
    // failed read is a hole in the record whether or not other reads returned rows.
    if transcript.refused {
        gap_codes.push("TOOL_REFUSED".to_string());
    }
    if transcript.failed {
        gap_codes.push("TOOL_FAILED".to_string());
    }
    // Said in words as well as in codes: the codes are a vocabulary the UI localizes, and
    // the model's own sentence is what a reader of the run sees first.
    let mut caveats: Vec<String> = Vec::new();
    if unverified > 0 {
        caveats.push(format!(
            "{unverified} of the cited row(s) carry no provenance the Kernel established, so their substance rests on whoever submitted them."
        ));
    }
    if transcript.refused {
        caveats.push(
            "At least one read this investigation asked for was refused, so the conclusion stands on a smaller part of the record than it asked for."
                .to_string(),
        );
    }
    if transcript.failed {
        caveats.push(
            "At least one read this investigation asked for failed inside the Kernel rather than being refused, so what that read would have contributed is unknown and the conclusion stands on a smaller part of the record than it asked for."
                .to_string(),
        );
    }
    ProposedHypothesis {
        statement: format!(
            "The record holds {} evidence row(s) ({}) for this incident, all collected at or after the recorded start ({started_label}), and none of them contradicts it.",
            rows.len(),
            kinds.into_iter().collect::<Vec<_>>().join(", ")
        ),
        stance: "SUPPORTED".to_string(),
        // HIGH is reserved for a conclusion drawn over an unbroken record: no unverified
        // row AND no read this run asked for that did not answer.
        confidence: if unverified == 0 && !transcript.refused && !transcript.failed {
            "HIGH"
        } else {
            "MEDIUM"
        }
        .to_string(),
        reasoning: format!(
            "{} evidence row(s) were read and {} are cited as supporting. Every row's collectedAt is at or after the incident's startedAt, so the timing in the record is consistent, and no row was found whose timestamp contradicts it. This is a statement about the shape of the record, not an interpretation of its content.",
            rows.len(),
            supporting.len()
        ),
        uncertainty: if caveats.is_empty() {
            None
        } else {
            Some(caveats.join(" "))
        },
        gap_codes,
        supporting,
        contradicting: Vec::new(),
    }
}

/// The JSON schema of every tool, handed to a real model and published in the contract.
fn tool_catalog() -> Value {
    json!([
        {
            "name": TOOL_GET_INCIDENT,
            "description": "Read the incident this investigation is about: title, severity, status, source, times, evidence count and whether a human verdict exists.",
            "arguments": {
                "type": "object",
                "additionalProperties": false,
                "properties": { "incidentId": { "type": "string", "format": "uuid" } }
            }
        },
        {
            "name": TOOL_LIST_EVIDENCE,
            "description": "List the evidence rows of the incident with their claimed and verified trust. Returns at most 25 rows and says when it truncated.",
            "arguments": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "incidentId": { "type": "string", "format": "uuid" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 25 }
                }
            }
        },
        {
            "name": TOOL_READ_EVIDENCE,
            "description": "Read one evidence row and, when the Kernel stored bytes for it, up to 4000 characters of its content with the digest the Kernel verified.",
            "arguments": {
                "type": "object",
                "additionalProperties": false,
                "required": ["evidenceId"],
                "properties": {
                    "incidentId": { "type": "string", "format": "uuid" },
                    "evidenceId": { "type": "string", "format": "uuid" }
                }
            }
        },
        {
            "name": TOOL_GET_TIMELINE,
            "description": "Read the incident's audit trail, oldest first, at most 100 events.",
            "arguments": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "incidentId": { "type": "string", "format": "uuid" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100 }
                }
            }
        },
        {
            "name": TOOL_GET_RELATED,
            "description": "Read a related-context source that this deployment authorised. With nothing configured it refuses with SOURCE_UNAVAILABLE rather than returning an empty page.",
            "arguments": {
                "type": "object",
                "additionalProperties": false,
                "required": ["sourceId"],
                "properties": {
                    "incidentId": { "type": "string", "format": "uuid" },
                    "sourceId": { "type": "string", "enum": ["incident_index"] }
                }
            }
        }
    ])
}

const SYSTEM_PROMPT: &str = "You are a read-only incident investigator. You may call exactly the five tools you are given. You must never state a conclusion that is not supported by an evidence id you actually received from a tool. When the evidence is insufficient, return a FINAL answer with stance UNCERTAIN and at least one gap code. When two evidence rows disagree, return stance CONFLICTED and cite both sides. You cannot write, cannot execute commands and cannot sign a verdict.";

async fn http_decide(
    http: &reqwest::Client,
    adapter: &Adapter,
    transcript: &Transcript,
    remaining: Duration,
) -> Result<ModelTurn, ModelFailure> {
    let Adapter::Http {
        base_url,
        model_id,
        credential_env_var,
    } = adapter
    else {
        return Err(ModelFailure {
            code: "MODEL_ADAPTER_MISMATCH",
            message: "the HTTP seam was asked to run a non-HTTP adapter".to_string(),
        });
    };
    // The secret is read from the environment variable the provider row NAMES. It is
    // never stored in the database, never logged, and never returned.
    let credential = std::env::var(credential_env_var.as_str()).map_err(|_| ModelFailure {
        code: "MODEL_CREDENTIAL_UNAVAILABLE",
        message: format!(
            "the provider is configured to read its credential from {credential_env_var}, which is not set in this kernel's environment"
        ),
    })?;
    let prompt = json!({
        "step": transcript.step,
        "incident": transcript.incident,
        "evidence": transcript.evidence,
        "invocations": transcript.invoked,
        "instructions": "Call one tool, or answer with FINAL. Answer JSON only.",
    });
    let body = json!({
        "model": model_id,
        "temperature": 0,
        "response_format": { "type": "json_object" },
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": prompt.to_string() },
        ],
        "tools": tool_catalog(),
    });
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let response = http
        .post(&url)
        .bearer_auth(credential)
        .json(&body)
        .timeout(remaining.max(Duration::from_millis(50)))
        .send()
        .await
        .map_err(|error| ModelFailure {
            code: "MODEL_REQUEST_FAILED",
            message: error.to_string(),
        })?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(ModelFailure {
            code: "MODEL_REQUEST_FAILED",
            message: format!("the provider answered {status}"),
        });
    }
    let parsed: Value = serde_json::from_str(&text).map_err(|error| ModelFailure {
        code: "MODEL_RESPONSE_INVALID",
        message: format!("the provider did not answer JSON: {error}"),
    })?;
    let content = parsed
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| ModelFailure {
            code: "MODEL_RESPONSE_INVALID",
            message: "the provider answered without choices[0].message.content".to_string(),
        })?;
    let decision: Value = serde_json::from_str(content).map_err(|error| ModelFailure {
        code: "MODEL_RESPONSE_INVALID",
        message: format!("the model's answer was not the JSON this kernel requires: {error}"),
    })?;
    let prompt_tokens = parsed
        .pointer("/usage/prompt_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let completion_tokens = parsed
        .pointer("/usage/completion_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    Ok(ModelTurn {
        decision: parse_model_decision(&decision)?,
        prompt_tokens,
        completion_tokens,
    })
}

/// Validate a model's decision against the closed vocabulary. A model that answers with
/// a stance this kernel does not have is told so rather than having its answer coerced
/// into a valid one.
fn parse_model_decision(value: &Value) -> Result<ModelDecision, ModelFailure> {
    let action = value
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| ModelFailure {
            code: "MODEL_RESPONSE_INVALID",
            message: "a decision must carry action TOOL_CALL or FINAL".to_string(),
        })?;
    match action {
        "TOOL_CALL" => {
            let tool = value
                .get("tool")
                .and_then(Value::as_str)
                .ok_or_else(|| ModelFailure {
                    code: "MODEL_RESPONSE_INVALID",
                    message: "a TOOL_CALL decision must carry tool".to_string(),
                })?;
            Ok(ModelDecision::ToolCall {
                tool: tool.to_string(),
                arguments: value.get("arguments").cloned().unwrap_or_else(|| json!({})),
            })
        }
        "FINAL" => {
            let raw = value
                .get("hypotheses")
                .and_then(Value::as_array)
                .ok_or_else(|| ModelFailure {
                    code: "MODEL_RESPONSE_INVALID",
                    message: "a FINAL decision must carry hypotheses".to_string(),
                })?;
            let mut hypotheses = Vec::new();
            for item in raw.iter().take(TOOL_HYPOTHESIS_MAX) {
                let statement = item
                    .get("statement")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let stance = item
                    .get("stance")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let confidence = item
                    .get("confidence")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !STANCES.contains(&stance) || !CONFIDENCES.contains(&confidence) {
                    return Err(ModelFailure {
                        code: "MODEL_RESPONSE_INVALID",
                        message: format!(
                            "stance must be one of {} and confidence one of {}; the model answered {stance:?}/{confidence:?}, and a hypothesis is not coerced into a valid one",
                            STANCES.join(", "),
                            CONFIDENCES.join(", ")
                        ),
                    });
                }
                hypotheses.push(ProposedHypothesis {
                    statement: statement.to_string(),
                    stance: stance.to_string(),
                    confidence: confidence.to_string(),
                    reasoning: item
                        .get("reasoning")
                        .and_then(Value::as_str)
                        .unwrap_or("the model gave no reasoning")
                        .to_string(),
                    uncertainty: item
                        .get("uncertainty")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    gap_codes: item
                        .get("gapCodes")
                        .and_then(Value::as_array)
                        .map(|codes| {
                            codes
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect()
                        })
                        .unwrap_or_default(),
                    supporting: uuid_list(item.get("supportingEvidence")),
                    contradicting: uuid_list(item.get("contradictingEvidence")),
                });
            }
            Ok(ModelDecision::Final { hypotheses })
        }
        other => Err(ModelFailure {
            code: "MODEL_RESPONSE_INVALID",
            message: format!("action must be TOOL_CALL or FINAL, not {other}"),
        }),
    }
}

fn uuid_list(value: Option<&Value>) -> Vec<Uuid> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|raw| Uuid::parse_str(raw.trim()).ok())
                .take(TOOL_CITATION_MAX_PER_ROLE)
                .collect()
        })
        .unwrap_or_default()
}

/// One turn, bounded by the per-tool timeout: a provider that never answers must cost
/// one timeout, not the whole request.
async fn decide_turn(
    adapter: &Adapter,
    http: &reqwest::Client,
    transcript: &Transcript,
    scenario: &str,
    timeout: Duration,
    remaining: Duration,
) -> Result<ModelTurn, ModelFailure> {
    let budget = timeout.min(remaining.max(Duration::from_millis(50)));
    match adapter {
        Adapter::TestFixture => {
            let (prompt, completion) = fixture_usage(transcript);
            Ok(ModelTurn {
                decision: fixture_decide(transcript, scenario),
                prompt_tokens: prompt,
                completion_tokens: completion,
            })
        }
        Adapter::Http { .. } => {
            tokio::time::timeout(budget, http_decide(http, adapter, transcript, budget))
                .await
                .unwrap_or_else(|_| {
                    Err(ModelFailure {
                        code: "MODEL_TIMEOUT",
                        message: format!(
                            "the provider did not answer inside {} ms",
                            budget.as_millis()
                        ),
                    })
                })
        }
    }
}

// ---------------------------------------------------------------------------
// The bounded loop.
// ---------------------------------------------------------------------------

struct Budget {
    max_steps: i64,
    max_tool_calls: i64,
    tool_timeout: Duration,
    max_retries: i64,
    token_budget: i64,
    deadline_seconds: i64,
    deadline: Instant,
    deadline_at: DateTime<Utc>,
}

#[derive(Default, Clone, Copy)]
struct Spent {
    steps: i64,
    tool_calls: i64,
    retries: i64,
    prompt_tokens: i64,
    completion_tokens: i64,
    hypotheses: i64,
    cost_micros: i64,
    /// How the cost was derived. Decided once, by the adapter that answered, so a
    /// fixture cannot claim a price and a model cannot pretend it answered for free.
    cost_basis: &'static str,
}

impl Spent {
    fn tokens(&self) -> i64 {
        self.prompt_tokens + self.completion_tokens
    }
}

/// Wrap a tool read in its own timeout. One helper so the per-tool limit is enforced in
/// exactly one place, and so a test can prove that limit without inventing a slow
/// database.
async fn run_bounded<F, T>(timeout: Duration, work: F) -> Result<T, ToolFailure>
where
    F: std::future::Future<Output = Result<T, ToolFailure>>,
{
    tokio::time::timeout(timeout, work)
        .await
        .unwrap_or_else(|_| Err(ToolFailure::timeout()))
}

struct RunOutcome {
    status: &'static str,
    stop_reason: &'static str,
    detail: Option<String>,
}

/// Terminate: write the status, the reason, the final counters and the audit row in one
/// transaction, so a run can never be read as SUCCEEDED with a RUNNING row's counters or
/// finished without its audit.
async fn finish_run(
    db: &PgPool,
    run_id: Uuid,
    incident_id: Uuid,
    actor: Uuid,
    outcome: &RunOutcome,
    spent: Spent,
) -> AppResult<()> {
    let mut tx = db.begin().await?;
    sqlx::query(
        "UPDATE kernel.investigation_runs
            SET status=$2, stop_reason=$3, detail=$4, finished_at=clock_timestamp(),
                steps_used=$5, tool_calls_used=$6, retries_used=$7,
                prompt_tokens=$8, completion_tokens=$9, tokens_used=$10,
                hypotheses_used=$11, cost_micros=$12, cost_basis=$13
          WHERE run_id=$1",
    )
    .bind(run_id)
    .bind(outcome.status)
    .bind(outcome.stop_reason)
    .bind(outcome.detail.as_deref())
    .bind(spent.steps)
    .bind(spent.tool_calls)
    .bind(spent.retries)
    .bind(spent.prompt_tokens)
    .bind(spent.completion_tokens)
    .bind(spent.tokens())
    .bind(spent.hypotheses)
    .bind(spent.cost_micros)
    .bind(spent.cost_basis)
    .execute(&mut *tx)
    .await?;
    audit::record_in_tx(
        &mut tx,
        "INVESTIGATION_FINISHED",
        "USER",
        &actor.to_string(),
        "INCIDENT",
        &incident_id.to_string(),
        "FINISH_INVESTIGATION",
        // audit_events.result has its own closed set (ACCEPTED, CONFIRMED, REJECTED,
        // UNKNOWN) and says whether the recorded ACTION was accepted, not how the run
        // ended. The run's outcome is in details.status, where a reader looks for it.
        "ACCEPTED",
        json!({
            "runId": run_id,
            "status": outcome.status,
            "stopReason": outcome.stop_reason,
            "steps": spent.steps,
            "toolCalls": spent.tool_calls,
            "retries": spent.retries,
            "tokens": spent.tokens(),
        }),
        None,
    )
    .await
    .map_err(|error| {
        tracing::error!(error = %error, run_id = %run_id, "investigation finish audit failed");
        AppError::internal(error)
    })?;
    tx.commit().await?;
    Ok(())
}

/// What a run may say about money.
///
/// The fixture runs on the kernel's own CPU and its tokens are counted, not billed, so
/// it reports TEST_FIXTURE_NO_COST. A real provider reports NO_COST unless this
/// deployment declared a price: this kernel cannot know a price it was not told, and
/// inventing one would be fabricating a cost.
fn cost_basis_for(adapter: &Adapter, price_configured: bool) -> &'static str {
    match adapter {
        Adapter::TestFixture => "TEST_FIXTURE_NO_COST",
        Adapter::Http { .. } => {
            if price_configured {
                "CONFIGURED_PRICE"
            } else {
                "NO_COST"
            }
        }
    }
}

/// Progress is written after every step, so an abandoned run still says how far it got.
async fn persist_progress(db: &PgPool, run_id: Uuid, spent: Spent) -> AppResult<()> {
    sqlx::query(
        "UPDATE kernel.investigation_runs
            SET steps_used=$2, tool_calls_used=$3, retries_used=$4,
                prompt_tokens=$5, completion_tokens=$6, tokens_used=$7,
                hypotheses_used=$8, cost_micros=$9
          WHERE run_id=$1",
    )
    .bind(run_id)
    .bind(spent.steps)
    .bind(spent.tool_calls)
    .bind(spent.retries)
    .bind(spent.prompt_tokens)
    .bind(spent.completion_tokens)
    .bind(spent.tokens())
    .bind(spent.hypotheses)
    .bind(spent.cost_micros)
    .execute(db)
    .await?;
    Ok(())
}

async fn cancel_requested(db: &PgPool, run_id: Uuid) -> AppResult<bool> {
    let requested: Option<bool> = sqlx::query_scalar(
        "SELECT cancel_requested_at IS NOT NULL FROM kernel.investigation_runs WHERE run_id=$1",
    )
    .bind(run_id)
    .fetch_optional(db)
    .await?;
    Ok(requested.unwrap_or(false))
}

struct RunInput {
    run_id: Uuid,
    incident_id: Uuid,
    scope_user_id: Uuid,
    requested_by: Uuid,
    budget: Budget,
}

/// Everything one executed run needs, so the loop signature stays readable.
struct RunContext<'a> {
    state: &'a AppState,
    config: &'a Config,
    input: RunInput,
    adapter: Adapter,
    scenario: String,
    probe: Option<Probe>,
}

fn remaining(budget: &Budget) -> Duration {
    budget.deadline.saturating_duration_since(Instant::now())
}

fn parse_body<T: DeserializeOwned>(body: Bytes) -> AppResult<T> {
    serde_json::from_slice(&body)
        .map_err(|error| AppError::bad_request(format!("invalid request body: {error}")))
}

fn clamp_limit(
    requested: Option<i64>,
    default: i64,
    min: i64,
    max: i64,
    field: &str,
) -> AppResult<i64> {
    let value = requested.unwrap_or(default);
    if value < min || value > max {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "INVESTIGATION_LIMIT_INVALID",
            format!("{field} must be between {min} and {max}; a limit outside that range is refused rather than clamped, because a silently clamped budget is not the budget the caller asked for"),
        ));
    }
    Ok(value)
}

impl Budget {
    fn from_request(payload: &StartInvestigationRequest) -> AppResult<Self> {
        let max_steps = clamp_limit(
            payload.max_steps,
            DEFAULT_MAX_STEPS,
            1,
            MAX_STEPS_LIMIT,
            "maxSteps",
        )?;
        let max_tool_calls = clamp_limit(
            payload.max_tool_calls,
            DEFAULT_MAX_TOOL_CALLS,
            1,
            MAX_TOOL_CALLS_LIMIT,
            "maxToolCalls",
        )?;
        let tool_timeout_ms = clamp_limit(
            payload.tool_timeout_ms,
            DEFAULT_TOOL_TIMEOUT_MS,
            MIN_TOOL_TIMEOUT_MS,
            MAX_TOOL_TIMEOUT_MS,
            "toolTimeoutMs",
        )?;
        let max_retries = clamp_limit(
            payload.max_retries,
            DEFAULT_MAX_RETRIES,
            0,
            MAX_RETRIES_LIMIT,
            "maxRetries",
        )?;
        let token_budget = clamp_limit(
            payload.token_budget,
            DEFAULT_TOKEN_BUDGET,
            1,
            MAX_TOKEN_BUDGET,
            "tokenBudget",
        )?;
        let deadline_seconds = clamp_limit(
            payload.deadline_seconds,
            DEFAULT_DEADLINE_SECONDS,
            1,
            MAX_DEADLINE_SECONDS,
            "deadlineSeconds",
        )?;
        Ok(Self {
            max_steps,
            max_tool_calls,
            tool_timeout: Duration::from_millis(tool_timeout_ms as u64),
            max_retries,
            token_budget,
            deadline_seconds,
            deadline: Instant::now() + Duration::from_secs(deadline_seconds as u64),
            deadline_at: Utc::now() + ChronoDuration::seconds(deadline_seconds),
        })
    }
}

fn bounded_key(raw: &str) -> AppResult<String> {
    let key = raw.trim().to_string();
    let length = key.chars().count();
    if !(IDEMPOTENCY_KEY_MIN_CHARS..=IDEMPOTENCY_KEY_MAX_CHARS).contains(&length) {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "INVESTIGATION_IDEMPOTENCY_KEY_INVALID",
            format!(
                "idempotencyKey must be between {IDEMPOTENCY_KEY_MIN_CHARS} and {IDEMPOTENCY_KEY_MAX_CHARS} characters: a retried start must be answered with the run it repeats, not with a second budget"
            ),
        ));
    }
    Ok(key)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// POST /api/v1/incidents/{id}/investigations
pub async fn start_investigation(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(incident_id): Path<Uuid>,
    body: Bytes,
) -> AppResult<(StatusCode, Json<InvestigationRunView>)> {
    auth.require_operator()?;
    let payload: StartInvestigationRequest = parse_body(body)?;
    let key = bounded_key(&payload.idempotency_key)?;
    let budget = Budget::from_request(&payload)?;
    let requested_provider = payload
        .provider_id
        .clone()
        .unwrap_or_else(|| state.config.investigation_default_provider.clone());
    let provider = resolve_provider(&state.db, &state.config, &requested_provider).await?;
    let adapter = Adapter::from_provider(&provider)?;
    let scenario = payload
        .scenario
        .clone()
        .unwrap_or_else(|| "AUTO".to_string());
    if !SCENARIOS.contains(&scenario.as_str()) {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "INVESTIGATION_SCENARIO_INVALID",
            format!("scenario must be one of {}", SCENARIOS.join(", ")),
        ));
    }
    // The probe ids exist only to exercise a refusal, so they are refused for anything
    // but the probe scenario and cannot linger on a real run.
    let probe = match (payload.probe_incident_id, payload.probe_evidence_id) {
        (Some(incident_id), Some(evidence_id)) => Some(Probe {
            incident_id,
            evidence_id,
        }),
        (None, None) => None,
        _ => {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                "INVESTIGATION_PROBE_INCOMPLETE",
                "probeIncidentId and probeEvidenceId must be supplied together: a probe of one thing is not a probe of a refusal",
            ))
        }
    };
    match (&scenario, probe) {
        (_, None) if scenario == "CROSS_SCOPE_PROBE" => {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                "INVESTIGATION_PROBE_INCOMPLETE",
                "scenario CROSS_SCOPE_PROBE requires probeIncidentId and probeEvidenceId: without them there is nothing outside the run's own incident to be refused",
            ))
        }
        (s, Some(_)) if s != "CROSS_SCOPE_PROBE" => {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                "INVESTIGATION_PROBE_NOT_APPLICABLE",
                "probeIncidentId and probeEvidenceId are only meaningful for scenario CROSS_SCOPE_PROBE",
            ))
        }
        _ => {}
    }
    if scenario != "AUTO" && !matches!(adapter, Adapter::TestFixture) {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "INVESTIGATION_SCENARIO_NOT_APPLICABLE",
            "scenario selects a deterministic fixture script; it is refused for any provider that is not the test fixture, so it can never be used to steer a real model",
        ));
    }
    // The incident predicate, before a single row is written: an investigation may only
    // exist for an incident its requester may read.
    let caller = DataScope::resolve(&state.db, &auth).await?;
    incident_status(&state.db, caller, incident_id).await?;

    let new_run_id = Uuid::new_v4();
    let mut tx = state.db.begin().await?;
    let inserted = sqlx::query(
        "INSERT INTO kernel.investigation_runs
             (run_id, incident_id, idempotency_key, status, provider_id, adapter_kind,
              scope_user_id, requested_by, max_steps, max_tool_calls, tool_timeout_ms,
              max_retries, token_budget, deadline_at)
         VALUES ($1,$2,$3,'RUNNING',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (incident_id, idempotency_key) DO NOTHING",
    )
    .bind(new_run_id)
    .bind(incident_id)
    .bind(&key)
    .bind(&provider.provider_id)
    .bind(adapter.kind())
    .bind(auth.user_id)
    .bind(auth.user_id)
    .bind(budget.max_steps)
    .bind(budget.max_tool_calls)
    .bind(budget.tool_timeout.as_millis() as i64)
    .bind(budget.max_retries)
    .bind(budget.token_budget)
    .bind(budget.deadline_at)
    .execute(&mut *tx)
    .await?;
    let replay = inserted.rows_affected() == 0;
    let run_id = if replay {
        sqlx::query_scalar(
            "SELECT run_id FROM kernel.investigation_runs WHERE incident_id=$1 AND idempotency_key=$2",
        )
        .bind(incident_id)
        .bind(&key)
        .fetch_one(&mut *tx)
        .await?
    } else {
        audit::record_in_tx(
            &mut tx,
            "INVESTIGATION_STARTED",
            "USER",
            &auth.user_id.to_string(),
            "INCIDENT",
            &incident_id.to_string(),
            "START_INVESTIGATION",
            "ACCEPTED",
            json!({
                "runId": new_run_id,
                "providerId": provider.provider_id,
                "adapterKind": adapter.kind(),
                "synthetic": matches!(adapter, Adapter::TestFixture),
                "maxSteps": budget.max_steps,
                "maxToolCalls": budget.max_tool_calls,
                "toolTimeoutMs": budget.tool_timeout.as_millis() as i64,
                "maxRetries": budget.max_retries,
                "tokenBudget": budget.token_budget,
                "deadlineAt": budget.deadline_at,
            }),
            None,
        )
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "investigation start audit failed; nothing was spent");
            AppError::internal(error)
        })?;
        new_run_id
    };
    tx.commit().await?;

    if !replay {
        let context = RunContext {
            state: &state,
            config: &state.config,
            input: RunInput {
                run_id,
                incident_id,
                scope_user_id: auth.user_id,
                requested_by: auth.user_id,
                budget,
            },
            adapter,
            scenario,
            probe,
        };
        run_loop(context).await?;
    }
    let view = load_run(&state.db, incident_id, run_id, replay).await?;
    Ok((
        if replay {
            StatusCode::OK
        } else {
            StatusCode::CREATED
        },
        Json(view),
    ))
}

/// GET /api/v1/incidents/{id}/investigations - the run history, newest first.
pub async fn list_investigations(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(incident_id): Path<Uuid>,
) -> AppResult<Json<Vec<InvestigationRunView>>> {
    let caller = DataScope::resolve(&state.db, &auth).await?;
    incident_status(&state.db, caller, incident_id).await?;
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT run_id FROM kernel.investigation_runs
          WHERE incident_id=$1 ORDER BY started_at DESC, run_id DESC LIMIT 20",
    )
    .bind(incident_id)
    .fetch_all(&state.db)
    .await?;
    let mut items = Vec::with_capacity(ids.len());
    for run_id in ids {
        items.push(load_run(&state.db, incident_id, run_id, false).await?);
    }
    Ok(Json(items))
}

/// GET /api/v1/incidents/{id}/investigations/{runId}
pub async fn get_investigation(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((incident_id, run_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<InvestigationRunView>> {
    let caller = DataScope::resolve(&state.db, &auth).await?;
    incident_status(&state.db, caller, incident_id).await?;
    Ok(Json(load_run(&state.db, incident_id, run_id, false).await?))
}

/// POST /api/v1/incidents/{id}/investigations/{runId}/cancel
///
/// Cancellation is cooperative and observed between steps, so the response says what it
/// is: a request that has been recorded. The run's own status is what a reader must
/// trust, and the loop is what sets it.
pub async fn cancel_investigation(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((incident_id, run_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<InvestigationRunView>> {
    auth.require_operator()?;
    let caller = DataScope::resolve(&state.db, &auth).await?;
    incident_status(&state.db, caller, incident_id).await?;
    let mut tx = state.db.begin().await?;
    let updated = sqlx::query(
        "UPDATE kernel.investigation_runs
            SET cancel_requested_at=clock_timestamp(), cancel_requested_by=$3
          WHERE run_id=$1 AND incident_id=$2 AND cancel_requested_at IS NULL AND status='RUNNING'",
    )
    .bind(run_id)
    .bind(incident_id)
    .bind(auth.user_id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() == 0 {
        let status: Option<String> = sqlx::query_scalar(
            "SELECT status FROM kernel.investigation_runs WHERE run_id=$1 AND incident_id=$2",
        )
        .bind(run_id)
        .bind(incident_id)
        .fetch_optional(&mut *tx)
        .await?;
        return Err(match status.as_deref() {
            None => {
                AppError::not_found("no investigation run with this id belongs to this incident")
            }
            Some("RUNNING") => AppError::conflict(
                "INVESTIGATION_ALREADY_CANCELLED",
                "cancellation for this run has already been requested",
            ),
            Some(_) => AppError::conflict(
                "INVESTIGATION_NOT_RUNNING",
                "this run has already finished, so there is nothing to cancel",
            ),
        });
    }
    audit::record_in_tx(
        &mut tx,
        "INVESTIGATION_CANCELLED",
        "USER",
        &auth.user_id.to_string(),
        "INCIDENT",
        &incident_id.to_string(),
        "CANCEL_INVESTIGATION",
        "ACCEPTED",
        json!({ "runId": run_id }),
        None,
    )
    .await
    .map_err(AppError::internal)?;
    tx.commit().await?;
    Ok(Json(load_run(&state.db, incident_id, run_id, false).await?))
}

/// POST /api/v1/incidents/{id}/investigations/{runId}/review
///
/// A human saying whether the investigation's reasoning is usable. This endpoint does
/// not, and cannot, conclude the incident: it writes investigation_human_reviews, whose
/// vocabulary is ACCEPTED or REJECTED, and nothing in this module touches
/// kernel.incident_verdicts.
pub async fn review_investigation(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((incident_id, run_id)): Path<(Uuid, Uuid)>,
    body: Bytes,
) -> AppResult<Json<InvestigationRunView>> {
    auth.require_operator()?;
    let payload: ReviewInvestigationRequest = parse_body(body)?;
    let decision = payload.decision.trim().to_ascii_uppercase();
    if !REVIEW_DECISIONS.contains(&decision.as_str()) {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "INVESTIGATION_REVIEW_DECISION_INVALID",
            format!(
                "decision must be one of {}; CONFIRMED, REFUTED and INCONCLUSIVE are the human verdict's words and a review of an investigation is not a verdict",
                REVIEW_DECISIONS.join(", ")
            ),
        ));
    }
    let note = payload.note.trim().to_string();
    let length = note.chars().count();
    if !(REVIEW_NOTE_MIN_CHARS..=REVIEW_NOTE_MAX_CHARS).contains(&length) {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "INVESTIGATION_REVIEW_NOTE_INVALID",
            format!(
                "note must be between {REVIEW_NOTE_MIN_CHARS} and {REVIEW_NOTE_MAX_CHARS} characters"
            ),
        ));
    }
    let caller = DataScope::resolve(&state.db, &auth).await?;
    incident_status(&state.db, caller, incident_id).await?;
    let status: Option<String> = sqlx::query_scalar(
        "SELECT status FROM kernel.investigation_runs WHERE run_id=$1 AND incident_id=$2",
    )
    .bind(run_id)
    .bind(incident_id)
    .fetch_optional(&state.db)
    .await?;
    match status.as_deref() {
        None => {
            return Err(AppError::not_found(
                "no investigation run with this id belongs to this incident",
            ))
        }
        Some("RUNNING") => {
            return Err(AppError::conflict(
                "INVESTIGATION_NOT_FINISHED",
                "a review of a run that has not finished would be a review of nothing",
            ))
        }
        Some(_) => {}
    }
    let mut tx = state.db.begin().await?;
    let inserted = sqlx::query(
        "INSERT INTO kernel.investigation_human_reviews (run_id, decision, note, reviewed_by)
         VALUES ($1,$2,$3,$4) ON CONFLICT (run_id) DO NOTHING",
    )
    .bind(run_id)
    .bind(&decision)
    .bind(&note)
    .bind(auth.user_id)
    .execute(&mut *tx)
    .await?;
    if inserted.rows_affected() == 0 {
        return Err(AppError::conflict(
            "INVESTIGATION_ALREADY_REVIEWED",
            "this investigation has already been reviewed; a second opinion is a second run",
        ));
    }
    audit::record_in_tx(
        &mut tx,
        "INVESTIGATION_REVIEWED",
        "USER",
        &auth.user_id.to_string(),
        "INCIDENT",
        &incident_id.to_string(),
        "REVIEW_INVESTIGATION",
        "ACCEPTED",
        json!({ "runId": run_id, "decision": decision, "affectsHumanVerdict": false }),
        None,
    )
    .await
    .map_err(AppError::internal)?;
    tx.commit().await?;
    Ok(Json(load_run(&state.db, incident_id, run_id, false).await?))
}

// ---------------------------------------------------------------------------
// Reads: assemble the response document.
// ---------------------------------------------------------------------------

#[derive(Debug, FromRow)]
struct RunRow {
    run_id: Uuid,
    incident_id: Uuid,
    idempotency_key: String,
    status: String,
    provider_id: String,
    adapter_kind: String,
    scope_user_id: Uuid,
    requested_by: Uuid,
    max_steps: i64,
    max_tool_calls: i64,
    tool_timeout_ms: i64,
    max_retries: i64,
    token_budget: i64,
    deadline_at: DateTime<Utc>,
    steps_used: i64,
    tool_calls_used: i64,
    retries_used: i64,
    prompt_tokens: i64,
    completion_tokens: i64,
    tokens_used: i64,
    cost_micros: i64,
    cost_basis: String,
    hypotheses_used: i64,
    stop_reason: Option<String>,
    detail: Option<String>,
    cancel_requested_at: Option<DateTime<Utc>>,
    cancel_requested_by: Option<Uuid>,
    started_at: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
    stale: bool,
    provider_model_id: Option<String>,
}

const RUN_SELECT: &str = "SELECT r.run_id, r.incident_id, r.idempotency_key, r.status,
       r.provider_id, r.adapter_kind, r.scope_user_id, r.requested_by,
       r.max_steps, r.max_tool_calls, r.tool_timeout_ms, r.max_retries,
       r.token_budget, r.deadline_at, r.steps_used, r.tool_calls_used,
       r.retries_used, r.prompt_tokens, r.completion_tokens, r.tokens_used,
       r.cost_micros, r.cost_basis, r.hypotheses_used, r.stop_reason, r.detail,
       r.cancel_requested_at, r.cancel_requested_by, r.started_at, r.finished_at,
       (r.status = 'RUNNING' AND r.deadline_at < clock_timestamp()) AS stale,
       p.model_id AS provider_model_id
  FROM kernel.investigation_runs r
  JOIN kernel.investigation_model_providers p ON p.provider_id = r.provider_id
 WHERE r.run_id=$1 AND r.incident_id=$2";

/// How a run is labelled. Derived from adapter_kind, which the database will not let
/// drift from the provider it names, so the label cannot be chosen by a caller.
fn adapter_label(kind: &str) -> String {
    match kind {
        ADAPTER_TEST_FIXTURE => {
            "TEST_FIXTURE - deterministic test adapter output, not a model's conclusion".to_string()
        }
        ADAPTER_HTTP => "HTTP_OPENAI_COMPATIBLE - answered by the configured model".to_string(),
        other => format!("{other} - unknown adapter kind"),
    }
}

async fn load_run(
    db: &PgPool,
    incident_id: Uuid,
    run_id: Uuid,
    replay: bool,
) -> AppResult<InvestigationRunView> {
    let row = sqlx::query_as::<_, RunRow>(RUN_SELECT)
        .bind(run_id)
        .bind(incident_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| {
            AppError::not_found("no investigation run with this id belongs to this incident")
        })?;
    let hypotheses = load_hypotheses(db, run_id).await?;
    let invocations = load_invocations(db, run_id).await?;
    let review = load_review(db, run_id).await?;
    // Rounded UP: deadline_at is computed a few microseconds before the row's
    // started_at is stamped, so a plain truncation would report a one second deadline as
    // zero. The number a reader needs is the ceiling, not the elapsed floor.
    let deadline_millis = (row.deadline_at - row.started_at).num_milliseconds().max(0);
    let deadline_seconds = (deadline_millis + 999) / 1000;
    Ok(InvestigationRunView {
        run_id: row.run_id,
        incident_id: row.incident_id,
        status: row.status,
        stale: row.stale,
        adapter: row.adapter_kind.clone(),
        adapter_label: adapter_label(&row.adapter_kind),
        adapter_provider_id: row.provider_id,
        adapter_model_id: row.provider_model_id,
        synthetic: row.adapter_kind == ADAPTER_TEST_FIXTURE,
        hypothesis_kind: "AI_HYPOTHESIS".to_string(),
        is_human_verdict: false,
        idempotency_key: row.idempotency_key,
        idempotent_replay: replay,
        requested_by: row.requested_by,
        scope_user_id: row.scope_user_id,
        budget: BudgetView {
            max_steps: row.max_steps,
            max_tool_calls: row.max_tool_calls,
            tool_timeout_ms: row.tool_timeout_ms,
            max_retries: row.max_retries,
            token_budget: row.token_budget,
            deadline_seconds,
        },
        usage: UsageView {
            steps: row.steps_used,
            tool_calls: row.tool_calls_used,
            retries: row.retries_used,
            hypotheses: row.hypotheses_used,
            prompt_tokens: row.prompt_tokens,
            completion_tokens: row.completion_tokens,
            total_tokens: row.tokens_used,
            cost_micros: row.cost_micros,
            cost_basis: row.cost_basis,
        },
        stop_reason: row.stop_reason,
        detail: row.detail,
        cancel_requested_at: row.cancel_requested_at,
        cancel_requested_by: row.cancel_requested_by,
        started_at: row.started_at,
        finished_at: row.finished_at,
        deadline_at: row.deadline_at,
        hypotheses,
        tool_invocations: invocations,
        review,
    })
}

#[derive(Debug, FromRow)]
struct HypothesisRow {
    hypothesis_id: Uuid,
    ordinal: i32,
    statement: String,
    stance: String,
    confidence: String,
    reasoning: String,
    uncertainty: Option<String>,
    gap_codes: SqlJson<Vec<String>>,
}

type CitationRow = (
    Uuid,
    String,
    String,
    String,
    DateTime<Utc>,
    String,
    Option<Uuid>,
);

async fn load_hypotheses(db: &PgPool, run_id: Uuid) -> AppResult<Vec<HypothesisView>> {
    let rows = sqlx::query_as::<_, HypothesisRow>(
        "SELECT hypothesis_id, ordinal, statement, stance, confidence, reasoning,
                uncertainty, gap_codes
           FROM kernel.investigation_hypotheses WHERE run_id=$1 ORDER BY ordinal",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let citations = sqlx::query_as::<_, CitationRow>(
            "SELECT e.evidence_id, c.role, e.kind, e.verified_trust, e.collected_at,
                    CASE WHEN x.evidence_id IS NULL THEN 'LEGACY_REFERENCE' ELSE 'STORED' END,
                    c.invocation_id
               FROM kernel.investigation_hypothesis_evidence c
               JOIN kernel.incident_evidence e ON e.evidence_id = c.evidence_id
               LEFT JOIN kernel.incident_evidence_content x ON x.evidence_id = e.evidence_id
              WHERE c.hypothesis_id=$1
              ORDER BY c.role, e.collected_at DESC",
        )
        .bind(row.hypothesis_id)
        .fetch_all(db)
        .await?;
        let mut supporting = Vec::new();
        let mut contradicting = Vec::new();
        for (
            evidence_id,
            role,
            kind,
            verified_trust,
            collected_at,
            content_status,
            invocation_id,
        ) in citations
        {
            let view = CitationView {
                evidence_id,
                role: role.clone(),
                kind,
                verified_trust,
                collected_at,
                content_status,
                invocation_id,
            };
            if role == "CONTRADICTING" {
                contradicting.push(view);
            } else {
                supporting.push(view);
            }
        }
        out.push(HypothesisView {
            hypothesis_id: row.hypothesis_id,
            ordinal: row.ordinal,
            statement: row.statement,
            stance: row.stance,
            confidence: row.confidence,
            reasoning: row.reasoning,
            uncertainty: row.uncertainty,
            gap_codes: row.gap_codes.0,
            supporting_evidence: supporting,
            contradicting_evidence: contradicting,
            is_human_verdict: false,
        });
    }
    Ok(out)
}

#[derive(Debug, FromRow)]
struct InvocationRow {
    invocation_id: Uuid,
    sequence: i32,
    attempt: i32,
    tool_name: String,
    arguments: Value,
    outcome: String,
    error_code: Option<String>,
    error_detail: Option<String>,
    authorization_predicate: Option<String>,
    scope_actor: Option<Uuid>,
    result_bytes: Option<i32>,
    evidence_refs: SqlJson<Vec<Uuid>>,
    duration_ms: i32,
    started_at: DateTime<Utc>,
    finished_at: DateTime<Utc>,
}

async fn load_invocations(db: &PgPool, run_id: Uuid) -> AppResult<Vec<InvocationView>> {
    let rows = sqlx::query_as::<_, InvocationRow>(
        "SELECT invocation_id, sequence, attempt, tool_name, arguments, outcome,
                error_code, error_detail, authorization_predicate, scope_actor, result_bytes,
                evidence_refs, duration_ms, started_at, finished_at
           FROM kernel.investigation_tool_invocations
          WHERE run_id=$1 ORDER BY sequence, attempt",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| InvocationView {
            invocation_id: row.invocation_id,
            sequence: row.sequence,
            attempt: row.attempt,
            tool: row.tool_name,
            arguments: row.arguments,
            outcome: row.outcome,
            error_code: row.error_code,
            error_detail: row.error_detail,
            authorization_predicate: row.authorization_predicate,
            scope_actor: row.scope_actor,
            result_bytes: row.result_bytes,
            evidence_refs: row.evidence_refs.0,
            duration_ms: row.duration_ms,
            started_at: row.started_at,
            finished_at: row.finished_at,
        })
        .collect())
}

async fn load_review(db: &PgPool, run_id: Uuid) -> AppResult<Option<ReviewView>> {
    let row = sqlx::query_as::<_, (String, String, Uuid, DateTime<Utc>)>(
        "SELECT decision, note, reviewed_by, reviewed_at
           FROM kernel.investigation_human_reviews WHERE run_id=$1",
    )
    .bind(run_id)
    .fetch_optional(db)
    .await?;
    Ok(
        row.map(|(decision, note, reviewed_by, reviewed_at)| ReviewView {
            decision,
            note,
            reviewed_by,
            reviewed_at,
            is_human_verdict: false,
        }),
    )
}

// ---------------------------------------------------------------------------
// The loop's own writes.
// ---------------------------------------------------------------------------

struct InvocationRecord<'a> {
    run_id: Uuid,
    sequence: i32,
    attempt: i32,
    tool: &'a str,
    arguments: &'a Value,
    outcome: &'a str,
    error_code: Option<&'a str>,
    error_detail: Option<&'a str>,
    predicate: Option<&'a str>,
    scope_actor: Option<Uuid>,
    /// The payload, so the digest beside it can be recomputed later. G12 F (P1-6): 0020
    /// recorded result_digest and result_bytes and then dropped the payload, which made
    /// the digest a claim nobody could check. It is the EXACT serialized text that was
    /// hashed - text, not jsonb, because jsonb normalizes the bytes and the digest would
    /// then be over something the row cannot reproduce. None when the payload is larger
    /// than RESULT_BODY_MAX_BYTES; in that case the row still says how many bytes there
    /// were and what they digested to, and says nothing it cannot support.
    result_body: Option<&'a str>,
    result_bytes: Option<i32>,
    result_digest: Option<&'a str>,
    /// The retention horizon of the content this payload quotes, copied from
    /// kernel.incident_evidence_content so the copy carries the same limit as its source.
    /// None when the payload quotes no retained bytes.
    result_retention: Option<DateTime<Utc>>,
    evidence_refs: &'a [Uuid],
    started_at: DateTime<Utc>,
    finished_at: DateTime<Utc>,
    duration_ms: i32,
}

async fn record_invocation(db: &PgPool, record: InvocationRecord<'_>) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO kernel.investigation_tool_invocations
             (invocation_id, run_id, sequence, attempt, tool_name, arguments, outcome,
              error_code, error_detail, authorization_predicate, scope_actor, result_body,
              result_bytes, result_digest, result_retention_expires_at, evidence_refs,
              started_at, finished_at, duration_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)",
    )
    .bind(Uuid::new_v4())
    .bind(record.run_id)
    .bind(record.sequence)
    .bind(record.attempt)
    .bind(record.tool)
    .bind(record.arguments.clone())
    .bind(record.outcome)
    .bind(record.error_code)
    .bind(record.error_detail)
    .bind(record.predicate)
    .bind(record.scope_actor)
    .bind(record.result_body)
    .bind(record.result_bytes)
    .bind(record.result_digest)
    .bind(record.result_retention)
    .bind(SqlJson(record.evidence_refs.to_vec()))
    .bind(record.started_at)
    .bind(record.finished_at)
    .bind(record.duration_ms)
    .execute(db)
    .await?;
    Ok(())
}

/// Persist one hypothesis and its citations.
///
/// A citation that does not belong to this incident is refused by the database (0020
/// investigation_citation_guard). This function therefore does not filter citations it
/// believes to be invalid: it lets the guard speak, so a run whose model cited something
/// foreign fails loudly instead of quietly dropping the citation.
async fn record_hypothesis(
    db: &PgPool,
    run_id: Uuid,
    ordinal: i32,
    adapter_kind: &str,
    proposed: &ProposedHypothesis,
    invocation_by_evidence: &HashMap<Uuid, Uuid>,
) -> AppResult<()> {
    let hypothesis_id = Uuid::new_v4();
    let statement = proposed.statement.trim();
    if statement.chars().count() < 12 {
        return Err(AppError::internal(
            "a hypothesis must state something; the investigator produced an empty one",
        ));
    }
    let mut tx = db.begin().await?;
    sqlx::query(
        "INSERT INTO kernel.investigation_hypotheses
             (hypothesis_id, run_id, ordinal, statement, stance, confidence,
              reasoning, uncertainty, gap_codes, adapter_kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    )
    .bind(hypothesis_id)
    .bind(run_id)
    .bind(ordinal)
    .bind(statement)
    .bind(&proposed.stance)
    .bind(&proposed.confidence)
    .bind(proposed.reasoning.trim())
    .bind(proposed.uncertainty.as_deref())
    .bind(SqlJson(proposed.gap_codes.clone()))
    .bind(adapter_kind)
    .execute(&mut *tx)
    .await?;
    for (role, ids) in [
        ("SUPPORTING", &proposed.supporting),
        ("CONTRADICTING", &proposed.contradicting),
    ] {
        for evidence_id in ids.iter().take(TOOL_CITATION_MAX_PER_ROLE) {
            sqlx::query(
                "INSERT INTO kernel.investigation_hypothesis_evidence
                     (hypothesis_id, evidence_id, role, invocation_id)
                 VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            )
            .bind(hypothesis_id)
            .bind(evidence_id)
            .bind(role)
            .bind(invocation_by_evidence.get(evidence_id).copied())
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// The loop.
// ---------------------------------------------------------------------------

async fn run_loop(context: RunContext<'_>) -> AppResult<()> {
    let RunContext {
        state,
        config,
        input,
        adapter,
        scenario,
        probe,
    } = context;
    let db = &state.db;
    let run_id = input.run_id;
    let incident_id = input.incident_id;
    let budget = input.budget;
    let scope = ToolScope {
        incident_id,
        scope_user_id: input.scope_user_id,
    };
    let mut spent = Spent {
        cost_basis: cost_basis_for(
            &adapter,
            config.investigation_price_micros_per_mtok.is_some(),
        ),
        ..Default::default()
    };
    let mut transcript = Transcript {
        probe,
        ..Default::default()
    };
    let mut sequence: i32 = 0;
    let mut invocation_by_evidence: HashMap<Uuid, Uuid> = HashMap::new();
    let mut written_hypotheses = 0i64;

    loop {
        // ---- pre-flight limits, in the order they can fire ---------------------
        if cancel_requested(db, run_id).await? {
            spent.hypotheses = written_hypotheses;
            return finish_run(
                db,
                run_id,
                incident_id,
                input.requested_by,
                &RunOutcome {
                    status: "CANCELLED",
                    stop_reason: "CANCELLED",
                    detail: Some(format!(
                        "an operator cancelled this investigation after {} step(s) and {} tool call(s); whatever it had read is recorded and no conclusion was reached",
                        spent.steps, spent.tool_calls
                    )),
                },
                spent,
            )
            .await;
        }
        if Instant::now() >= budget.deadline {
            spent.hypotheses = written_hypotheses;
            return finish_run(
                db,
                run_id,
                incident_id,
                input.requested_by,
                &RunOutcome {
                    status: "EXPIRED",
                    stop_reason: "DEADLINE",
                    detail: Some(format!(
                        "the total deadline of {} s passed after {} step(s); the run stopped there and its reads are recorded",
                        budget.deadline_seconds, spent.steps
                    )),
                },
                spent,
            )
            .await;
        }
        if spent.tokens() >= budget.token_budget {
            spent.hypotheses = written_hypotheses;
            return finish_run(
                db,
                run_id,
                incident_id,
                input.requested_by,
                &RunOutcome {
                    status: "BUDGET_EXHAUSTED",
                    stop_reason: "TOKEN_BUDGET",
                    detail: Some(format!(
                        "the token budget of {} was reached ({} used) at a turn boundary; a turn's usage is only known once it has been answered, so the spend may exceed the budget by at most that last turn",
                        budget.token_budget,
                        spent.tokens()
                    )),
                },
                spent,
            )
            .await;
        }
        if spent.steps >= budget.max_steps {
            spent.hypotheses = written_hypotheses;
            return finish_run(
                db,
                run_id,
                incident_id,
                input.requested_by,
                &RunOutcome {
                    status: "BUDGET_EXHAUSTED",
                    stop_reason: "STEP_BUDGET",
                    detail: Some(format!(
                        "the step budget of {} was reached; {} tool call(s) had run, and the transcript below is what the investigator actually saw",
                        budget.max_steps, spent.tool_calls
                    )),
                },
                spent,
            )
            .await;
        }

        // ---- one turn ----------------------------------------------------------
        spent.steps += 1;
        transcript.step = spent.steps;
        persist_progress(db, run_id, spent).await?;
        if scenario == "PACED_TOOL_LOOP" {
            tokio::time::sleep(FIXTURE_PACING).await;
        }
        let turn = match decide_turn(
            &adapter,
            &state.http,
            &transcript,
            &scenario,
            budget.tool_timeout,
            remaining(&budget),
        )
        .await
        {
            Ok(turn) => turn,
            Err(failure) => {
                spent.hypotheses = written_hypotheses;
                return finish_run(
                    db,
                    run_id,
                    incident_id,
                    input.requested_by,
                    &RunOutcome {
                        status: "FAILED",
                        stop_reason: "PROVIDER_ERROR",
                        detail: Some(format!(
                            "{}: {} (nothing usable was produced after {} step(s))",
                            failure.code, failure.message, spent.steps
                        )),
                    },
                    spent,
                )
                .await;
            }
        };
        spent.prompt_tokens += turn.prompt_tokens;
        spent.completion_tokens += turn.completion_tokens;

        match turn.decision {
            ModelDecision::ToolCall { tool, arguments } => {
                if spent.tool_calls >= budget.max_tool_calls {
                    spent.hypotheses = written_hypotheses;
                    return finish_run(
                        db,
                        run_id,
                        incident_id,
                        input.requested_by,
                        &RunOutcome {
                            status: "BUDGET_EXHAUSTED",
                            stop_reason: "TOOL_CALL_BUDGET",
                            detail: Some(format!(
                                "the tool-call budget of {} was reached while the investigator was still asking to read",
                                budget.max_tool_calls
                            )),
                        },
                        spent,
                    )
                    .await;
                }
                sequence += 1;
                spent.tool_calls += 1;
                let mut attempt = 1i64;
                loop {
                    let started_at = Utc::now();
                    let began = Instant::now();
                    let outcome = run_bounded(
                        budget.tool_timeout,
                        execute_tool(
                            db,
                            &config.investigation_related_sources,
                            scope,
                            &tool,
                            &arguments,
                        ),
                    )
                    .await;
                    let duration_ms = began.elapsed().as_millis().min(i32::MAX as u128) as i32;
                    let finished_at = Utc::now();
                    match outcome {
                        Ok(result) => {
                            let body = result.payload.to_string();
                            let digest = sha256_hex(body.as_bytes());
                            // The exact bytes, kept when they fit, so the digest next to
                            // them can be recomputed instead of believed.
                            let kept_body = if body.len() <= RESULT_BODY_MAX_BYTES {
                                Some(body.as_str())
                            } else {
                                None
                            };
                            record_invocation(
                                db,
                                InvocationRecord {
                                    run_id,
                                    sequence,
                                    attempt: attempt as i32,
                                    tool: &tool,
                                    arguments: &arguments,
                                    outcome: "OK",
                                    error_code: None,
                                    error_detail: None,
                                    predicate: Some(result.predicate),
                                    scope_actor: Some(input.scope_user_id),
                                    result_body: kept_body,
                                    result_bytes: Some(body.len().min(i32::MAX as usize) as i32),
                                    result_digest: Some(&digest),
                                    result_retention: result.retention,
                                    evidence_refs: &result.evidence_refs,
                                    started_at,
                                    finished_at,
                                    duration_ms,
                                },
                            )
                            .await?;
                            let invocation_id: Uuid = sqlx::query_scalar(
                                "SELECT invocation_id FROM kernel.investigation_tool_invocations
                                  WHERE run_id=$1 AND sequence=$2 AND attempt=$3",
                            )
                            .bind(run_id)
                            .bind(sequence)
                            .bind(attempt as i32)
                            .fetch_one(db)
                            .await?;
                            for evidence_id in &result.evidence_refs {
                                invocation_by_evidence.insert(*evidence_id, invocation_id);
                            }
                            transcript.absorb_invocation(&tool, "OK", Some(&result.payload));
                            break;
                        }
                        Err(failure) => {
                            let retryable = failure.outcome != "REFUSED";
                            record_invocation(
                                db,
                                InvocationRecord {
                                    run_id,
                                    sequence,
                                    attempt: attempt as i32,
                                    tool: &tool,
                                    arguments: &arguments,
                                    outcome: failure.outcome,
                                    error_code: Some(failure.code),
                                    error_detail: Some(failure.detail()),
                                    predicate: None,
                                    scope_actor: None,
                                    result_body: None,
                                    result_bytes: None,
                                    result_digest: None,
                                    result_retention: None,
                                    evidence_refs: &[],
                                    started_at,
                                    finished_at,
                                    duration_ms,
                                },
                            )
                            .await?;
                            if retryable && attempt <= budget.max_retries {
                                attempt += 1;
                                spent.retries += 1;
                                persist_progress(db, run_id, spent).await?;
                                continue;
                            }
                            transcript.absorb_invocation(&tool, failure.outcome, None);
                            break;
                        }
                    }
                }
                persist_progress(db, run_id, spent).await?;
            }
            ModelDecision::Final { hypotheses } => {
                let adapter_kind = adapter.kind();
                for proposed in hypotheses.iter().take(TOOL_HYPOTHESIS_MAX) {
                    written_hypotheses += 1;
                    record_hypothesis(
                        db,
                        run_id,
                        written_hypotheses as i32,
                        adapter_kind,
                        proposed,
                        &invocation_by_evidence,
                    )
                    .await?;
                }
                let any_failed: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM kernel.investigation_tool_invocations
                                     WHERE run_id=$1 AND outcome <> 'OK')",
                )
                .bind(run_id)
                .fetch_one(db)
                .await?;
                spent.hypotheses = written_hypotheses;
                let (status, detail) = if any_failed {
                    (
                        "PARTIAL",
                        Some(
                            "the investigator reached a conclusion, but at least one read it asked for was refused, failed or timed out; the hypotheses stand on the reads that did succeed and say so through their gap codes"
                                .to_string(),
                        ),
                    )
                } else {
                    ("SUCCEEDED", None)
                };
                return finish_run(
                    db,
                    run_id,
                    incident_id,
                    input.requested_by,
                    &RunOutcome {
                        status,
                        stop_reason: "FINAL_ANSWER",
                        detail,
                    },
                    spent,
                )
                .await;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
//
// Two kinds, and the split is deliberate:
//
//   * pure tests over the fixture and the argument layer, which need no database;
//   * database-backed tests, which prove the guarantees that only the schema can
//     make - a citation of another incident's evidence, an adapter kind that
//     disagrees with its provider, a hypothesis that tries to speak the verdict's
//     vocabulary, a review that must not become a verdict - plus the per-tool
//     authorization refusals, which need real rows to refuse.
//
// The full request/response loop, the ten budget overruns and cancellation are
// exercised over real HTTP by tests/acceptance/g12_ai_investigator.sh; a unit test
// with a mocked pool would prove the mock.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::postgres::PgConnectOptions;

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
                other => panic!(
                    "{REQUIRE_DATABASE_ENV} is set to {other:?}: use 1 to require the DB-backed tests"
                ),
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
        .bind(format!("investigation-test-{id}@example.invalid"))
        .bind(format!("investigation test {role}"))
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
        // Since D5 an account reads a business row only through workspace membership, and
        // a tool call re-reads that membership per call. A fixture without this row would
        // be proving the tool refuses everything, which is not what these tests are about.
        join_workspace(pool, crate::scope::legacy_workspace(), id).await;
        id
    }

    async fn join_workspace(pool: &PgPool, workspace: Uuid, user: Uuid) {
        sqlx::query(
            "INSERT INTO kernel.business_workspace_members (workspace_id,user_id)
             VALUES ($1,$2) ON CONFLICT DO NOTHING",
        )
        .bind(workspace)
        .bind(user)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn seed_incident(
        pool: &PgPool,
        owner: Uuid,
        related_entity: Option<&str>,
        started_at: DateTime<Utc>,
    ) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.incidents
                 (incident_id,title,severity,status,source,related_entity,started_at,owner,
                  workspace_id)
             VALUES ($1,$2,'MAJOR','OPEN','MANUAL',$3,$4,$5,$6)",
        )
        .bind(id)
        .bind(format!("investigation test incident {id}"))
        .bind(related_entity)
        .bind(started_at)
        .bind(owner)
        .bind(crate::scope::legacy_workspace())
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn seed_evidence(
        pool: &PgPool,
        incident_id: Uuid,
        collected_at: DateTime<Utc>,
        kind: &str,
        source: &str,
        verified_trust: &str,
    ) -> Uuid {
        let id = Uuid::new_v4();
        let (method, verified_at, verifier) = match verified_trust {
            "SOURCE_ATTESTED" => (
                "SOURCE_ADAPTER",
                Some(collected_at),
                Some("test-adapter".to_string()),
            ),
            "OPERATOR_ASSERTED" => ("OPERATOR_IDENTITY", Some(collected_at), None),
            _ => ("NONE", None, None),
        };
        sqlx::query(
            "INSERT INTO kernel.incident_evidence
                 (evidence_id, incident_id, kind, source, collected_at, content_ref,
                  claimed_trust, verified_trust, verification_method, verified_at, verifier_identity)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        )
        .bind(id)
        .bind(incident_id)
        .bind(kind)
        .bind(source)
        .bind(collected_at)
        .bind(format!("test-ref-{id}"))
        .bind(verified_trust)
        .bind(verified_trust)
        .bind(method)
        .bind(verified_at)
        .bind(verifier)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn seed_run(pool: &PgPool, incident_id: Uuid, scope_user: Uuid) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.investigation_runs
                 (run_id, incident_id, idempotency_key, status, provider_id, adapter_kind,
                  scope_user_id, requested_by, max_steps, max_tool_calls, tool_timeout_ms,
                  max_retries, token_budget, deadline_at)
             VALUES ($1,$2,$3,'RUNNING','test-fixture-v1','TEST_FIXTURE',$4,$4,8,12,2000,1,20000,now() + interval '30 seconds')",
        )
        .bind(id)
        .bind(incident_id)
        .bind(format!("test-key-{id}"))
        .bind(scope_user)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn seed_hypothesis(pool: &PgPool, run_id: Uuid) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.investigation_hypotheses
                 (hypothesis_id, run_id, ordinal, statement, stance, confidence, reasoning,
                  adapter_kind)
             VALUES ($1,$2,1,'a test hypothesis about the record','SUPPORTED','LOW',
                     'a test reasoning sentence','TEST_FIXTURE')",
        )
        .bind(id)
        .bind(run_id)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    /// Order matters, and the order is a fact about the schema rather than a test
    /// detail: a citation of an evidence row is ON DELETE RESTRICT (as the 0017 verdict
    /// snapshot is), so an incident cannot be deleted while a hypothesis still cites its
    /// evidence. Deleting the runs first cascades hypotheses and citations away, which is
    /// what lets the incident go.
    async fn cleanup(pool: &PgPool, users: &[Uuid]) {
        for user in users {
            let _ = sqlx::query(
                "DELETE FROM kernel.investigation_runs
                  WHERE scope_user_id=$1 OR requested_by=$1
                     OR incident_id IN (SELECT incident_id FROM kernel.incidents WHERE owner=$1)",
            )
            .bind(user)
            .execute(pool)
            .await;
            let _ = sqlx::query("DELETE FROM kernel.incidents WHERE owner=$1")
                .bind(user)
                .execute(pool)
                .await;
            let _ = sqlx::query("DELETE FROM kernel.users WHERE id=$1")
                .bind(user)
                .execute(pool)
                .await;
        }
    }

    // -----------------------------------------------------------------------
    // E4: the three protocol cases, from three states of real data.
    // -----------------------------------------------------------------------

    fn transcript_with(
        incident_started: DateTime<Utc>,
        rows: &[(Uuid, DateTime<Utc>, &str)],
    ) -> Transcript {
        Transcript {
            incident: Some(json!({
                "incidentId": Uuid::new_v4(),
                "title": "a test incident",
                "startedAt": incident_started,
            })),
            evidence: rows
                .iter()
                .map(|(id, collected, trust)| {
                    json!({
                        "evidenceId": id,
                        "kind": "LOG_EXCERPT",
                        "collectedAt": collected,
                        "verifiedTrust": trust,
                    })
                })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn the_fixture_is_deterministic() {
        let started = DateTime::parse_from_rfc3339("2026-10-01T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let rows = [(
            Uuid::new_v4(),
            started + ChronoDuration::minutes(5),
            "OPERATOR_ASSERTED",
        )];
        let a = transcript_with(started, &rows);
        let b = transcript_with(started, &rows);
        let first = fixture_hypothesis(&a);
        let second = fixture_hypothesis(&b);
        assert_eq!(first.stance, second.stance);
        assert_eq!(first.statement, second.statement);
        assert_eq!(first.supporting, second.supporting);
        assert_eq!(first.confidence, second.confidence);
    }

    #[test]
    fn no_evidence_is_uncertainty_with_a_gap_and_no_citation() {
        let started = Utc::now();
        let transcript = transcript_with(started, &[]);
        let hypothesis = fixture_hypothesis(&transcript);
        assert_eq!(hypothesis.stance, "UNCERTAIN");
        assert_eq!(hypothesis.confidence, "LOW");
        assert!(hypothesis.supporting.is_empty());
        assert!(hypothesis.contradicting.is_empty());
        assert_eq!(hypothesis.gap_codes, vec!["NO_EVIDENCE_ROWS".to_string()]);
        assert!(hypothesis
            .uncertainty
            .as_deref()
            .unwrap()
            .contains("neither the timing nor the cause"));
    }

    #[test]
    fn a_refused_read_is_uncertainty_that_names_the_refusal() {
        let started = Utc::now();
        let mut transcript = transcript_with(started, &[]);
        transcript.refused = true;
        let hypothesis = fixture_hypothesis(&transcript);
        assert_eq!(hypothesis.stance, "UNCERTAIN");
        assert_eq!(hypothesis.gap_codes, vec!["TOOL_REFUSED".to_string()]);
    }

    #[test]
    fn a_row_collected_before_the_start_is_cited_as_a_contradiction() {
        let started = DateTime::parse_from_rfc3339("2026-10-01T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let early = Uuid::new_v4();
        let late = Uuid::new_v4();
        let rows = [
            (
                early,
                started - ChronoDuration::hours(2),
                "OPERATOR_ASSERTED",
            ),
            (
                late,
                started + ChronoDuration::minutes(3),
                "OPERATOR_ASSERTED",
            ),
        ];
        let hypothesis = fixture_hypothesis(&transcript_with(started, &rows));
        assert_eq!(hypothesis.stance, "CONFLICTED");
        assert_eq!(hypothesis.contradicting, vec![early]);
        assert_eq!(hypothesis.supporting, vec![late]);
        assert_eq!(
            hypothesis.gap_codes,
            vec!["EVIDENCE_PREDATES_INCIDENT".to_string()]
        );
    }

    #[test]
    fn rows_at_or_after_the_start_support_without_claiming_a_verdict() {
        let started = Utc::now();
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let rows = [
            (first, started, "OPERATOR_ASSERTED"),
            (
                second,
                started + ChronoDuration::minutes(1),
                "SOURCE_ATTESTED",
            ),
        ];
        let hypothesis = fixture_hypothesis(&transcript_with(started, &rows));
        assert_eq!(hypothesis.stance, "SUPPORTED");
        assert_eq!(hypothesis.confidence, "HIGH");
        assert_eq!(hypothesis.supporting, vec![first, second]);
        assert!(hypothesis.contradicting.is_empty());
        assert!(hypothesis.gap_codes.is_empty());
        // The words a human verdict uses are not reachable from a hypothesis.
        for verdict_word in ["CONFIRMED", "REFUTED", "INCONCLUSIVE"] {
            assert_ne!(hypothesis.stance, verdict_word);
        }
    }

    #[test]
    fn unverified_rows_lower_confidence_and_are_named() {
        let started = Utc::now();
        let row = Uuid::new_v4();
        let hypothesis =
            fixture_hypothesis(&transcript_with(started, &[(row, started, "UNVERIFIED")]));
        assert_eq!(hypothesis.stance, "SUPPORTED");
        assert_eq!(hypothesis.confidence, "MEDIUM");
        assert_eq!(
            hypothesis.gap_codes,
            vec!["EVIDENCE_UNVERIFIED".to_string()]
        );
    }

    // -----------------------------------------------------------------------
    // E3: the per-tool timeout fires instead of hanging.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn a_tool_that_exceeds_its_timeout_is_reported_as_a_timeout() {
        let outcome = run_bounded(Duration::from_millis(20), async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            Ok::<u8, ToolFailure>(1)
        })
        .await;
        let failure = outcome.expect_err("a slow read must not succeed");
        assert_eq!(failure.outcome, "TIMEOUT");
        assert_eq!(failure.code, "TOOL_TIMEOUT");
    }

    #[tokio::test]
    async fn a_fast_tool_passes_through_its_bound() {
        let outcome = run_bounded(Duration::from_secs(5), async { Ok::<u8, ToolFailure>(7) }).await;
        assert_eq!(outcome.ok(), Some(7));
    }

    #[test]
    fn truncation_cuts_characters_and_never_splits_one() {
        let body = "ab\u{1f600}cd";
        let (kept, truncated) = truncate_chars(body, 4);
        assert_eq!(kept, "ab\u{1f600}c");
        assert!(truncated);
        let (whole, nothing_dropped) = truncate_chars(body, 10);
        assert_eq!(whole, body);
        assert!(!nothing_dropped);
    }

    #[test]
    fn a_tool_the_investigator_invented_is_not_in_the_catalogue() {
        assert!(!TOOL_NAMES.contains(&"run_shell"));
        assert!(!TOOL_NAMES.contains(&"sql"));
        assert!(!TOOL_NAMES.contains(&"http_get"));
        assert_eq!(TOOL_NAMES.len(), 5);
        let catalog = tool_catalog();
        let names: Vec<&str> = catalog
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool.get("name").and_then(Value::as_str).unwrap())
            .collect();
        assert_eq!(names.len(), TOOL_NAMES.len());
        for name in TOOL_NAMES {
            assert!(names.contains(name), "the catalogue must publish {name}");
        }
    }

    // -----------------------------------------------------------------------
    // E2: the tool layer refuses every read of an incident another operator owns.
    //
    // One test over all five tools, because a per-tool test would let a new tool be
    // added without this refusal ever being asked of it.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn every_tool_refuses_an_incident_another_operator_owns() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let stranger = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let mine = seed_incident(&pool, owner, Some("entity-mine"), started).await;
        let theirs = seed_incident(&pool, stranger, Some("entity-theirs"), started).await;
        let their_evidence =
            seed_evidence(&pool, theirs, started, "LOG_EXCERPT", "agent", "UNVERIFIED").await;
        let scope = ToolScope {
            incident_id: mine,
            scope_user_id: owner,
        };
        let sources = vec!["incident_index".to_string()];

        // Positive control first: the tools must work on the incident the run owns, or
        // the refusals below would only prove that everything fails.
        let own = execute_tool(&pool, &sources, scope, TOOL_GET_INCIDENT, &json!({}))
            .await
            .expect("reading its own incident must work");
        assert_eq!(own.predicate, PREDICATE_INCIDENT_READ);

        let attempts: Vec<(&str, Value)> = vec![
            (TOOL_GET_INCIDENT, json!({ "incidentId": theirs })),
            (TOOL_LIST_EVIDENCE, json!({ "incidentId": theirs })),
            (
                TOOL_READ_EVIDENCE,
                json!({ "incidentId": theirs, "evidenceId": their_evidence }),
            ),
            (TOOL_GET_TIMELINE, json!({ "incidentId": theirs })),
            (
                TOOL_GET_RELATED,
                json!({ "incidentId": theirs, "sourceId": "incident_index" }),
            ),
        ];
        assert_eq!(attempts.len(), 5, "all five tools must be covered");
        for (tool, arguments) in attempts {
            let result = execute_tool(&pool, &sources, scope, tool, &arguments).await;
            let failure = result.err().unwrap_or_else(|| {
                panic!("{tool} read an incident another operator owns and did not refuse")
            });
            assert_eq!(
                failure.outcome, "REFUSED",
                "{tool} must be refused, not broken"
            );
            assert_eq!(
                failure.code, "INCIDENT_NOT_FOUND",
                "{tool} must refuse with the same code the HTTP read endpoint gives"
            );
        }

        cleanup(&pool, &[owner, stranger]).await;
    }

    #[tokio::test]
    async fn an_evidence_id_from_another_incident_is_refused_even_with_the_right_incident() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let mine = seed_incident(&pool, owner, None, started).await;
        let other = seed_incident(&pool, owner, None, started).await;
        let other_evidence =
            seed_evidence(&pool, other, started, "LOG_EXCERPT", "agent", "UNVERIFIED").await;
        let scope = ToolScope {
            incident_id: mine,
            scope_user_id: owner,
        };
        let failure = execute_tool(
            &pool,
            &[],
            scope,
            TOOL_READ_EVIDENCE,
            &json!({ "incidentId": mine, "evidenceId": other_evidence }),
        )
        .await
        .expect_err("an evidence id from another incident must not read");
        assert_eq!(failure.code, "EVIDENCE_NOT_FOUND");
        assert_eq!(failure.outcome, "REFUSED");

        cleanup(&pool, &[owner]).await;
    }

    #[tokio::test]
    async fn a_handover_mid_run_takes_the_next_read_away() {
        let Some(pool) = test_pool().await else {
            return;
        };
        // The scope account is re-read on every call, and the incident predicate is
        // applied again on every call. A handover between two calls is the cheapest way
        // to prove both at once: nothing about the run changes, and the second read is
        // refused.
        let owner = seed_user(&pool, "operator").await;
        let successor = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        let scope = ToolScope {
            incident_id: incident,
            scope_user_id: owner,
        };
        execute_tool(&pool, &[], scope, TOOL_GET_INCIDENT, &json!({}))
            .await
            .expect("the first read must work");
        sqlx::query("UPDATE kernel.incidents SET owner=$2 WHERE incident_id=$1")
            .bind(incident)
            .bind(successor)
            .execute(&pool)
            .await
            .unwrap();
        let failure = execute_tool(&pool, &[], scope, TOOL_GET_INCIDENT, &json!({}))
            .await
            .expect_err("after the handover the former owner must not read it");
        assert_eq!(failure.code, "INCIDENT_NOT_FOUND");

        cleanup(&pool, &[owner, successor]).await;
    }

    /// The D5 counterpart of the handover test above: membership, not ownership, is what
    /// the next tool call answers with.
    ///
    /// A run's `scope_user_id` is fixed for its lifetime, but what that account may
    /// READ is not: `scope_caller` re-resolves the workspace set from the database at
    /// the instant of each call. So a membership revoked while a run is in flight takes the
    /// next read away, and nothing about the run has to be reloaded or cancelled for that
    /// to happen.
    #[tokio::test]
    async fn a_membership_revocation_mid_run_takes_the_next_read_away() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        let scope = ToolScope {
            incident_id: incident,
            scope_user_id: owner,
        };
        execute_tool(&pool, &[], scope, TOOL_GET_INCIDENT, &json!({}))
            .await
            .expect("the first read must work");
        // Exactly what DELETE /api/v1/business-workspaces/{id}/members/{user} writes.
        sqlx::query("DELETE FROM kernel.business_workspace_members WHERE user_id=$1")
            .bind(owner)
            .execute(&pool)
            .await
            .unwrap();
        let failure = execute_tool(&pool, &[], scope, TOOL_GET_INCIDENT, &json!({}))
            .await
            .expect_err("after the revocation the next read must be refused");
        // The same 404 the HTTP route gives: "not yours" and "not there" are one answer.
        assert_eq!(failure.code, "INCIDENT_NOT_FOUND");

        cleanup(&pool, &[owner]).await;
    }

    /// An account that is a member of no workspace reads no business row through a tool,
    /// whatever its role - the case a viewer without a grant is in, and the reason the
    /// empty list is explained by a count rather than by silence.
    #[tokio::test]
    async fn a_tool_call_from_an_account_in_no_workspace_reads_nothing() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        sqlx::query("DELETE FROM kernel.business_workspace_members WHERE user_id=$1")
            .bind(owner)
            .execute(&pool)
            .await
            .unwrap();
        let scope = ToolScope {
            incident_id: incident,
            scope_user_id: owner,
        };
        let failure = execute_tool(&pool, &[], scope, TOOL_GET_INCIDENT, &json!({}))
            .await
            .expect_err("no membership means no readable business row");
        assert_eq!(failure.code, "INCIDENT_NOT_FOUND");

        cleanup(&pool, &[owner]).await;
    }

    #[tokio::test]
    async fn the_related_context_source_must_be_authorised_before_anything_is_read() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, Some("shared-entity"), started).await;
        let scope = ToolScope {
            incident_id: incident,
            scope_user_id: owner,
        };
        // Nothing configured: the shipped posture.
        let failure = execute_tool(
            &pool,
            &[],
            scope,
            TOOL_GET_RELATED,
            &json!({ "sourceId": "incident_index" }),
        )
        .await
        .expect_err("an unauthorised source must refuse rather than answer an empty page");
        assert_eq!(failure.code, "SOURCE_UNAVAILABLE");
        assert_eq!(failure.outcome, "REFUSED");

        // Configured: it reads, and it reads only through the incident predicate.
        let sources = vec!["incident_index".to_string()];
        let outcome = execute_tool(
            &pool,
            &sources,
            scope,
            TOOL_GET_RELATED,
            &json!({ "sourceId": "incident_index" }),
        )
        .await
        .expect("an authorised source must read");
        assert_eq!(outcome.predicate, PREDICATE_INCIDENT_READ);
        assert_eq!(outcome.payload["relatedEntity"], json!("shared-entity"));

        cleanup(&pool, &[owner]).await;
    }

    #[tokio::test]
    async fn the_incident_index_narrows_the_scope_and_never_widens_it() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let stranger = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        // Same relatedEntity, three incidents, two owners. The tool must return the two
        // the caller may read and neither of the stranger's.
        let mine = seed_incident(&pool, owner, Some("shared-component"), started).await;
        let peer = seed_incident(&pool, owner, Some("shared-component"), started).await;
        let theirs = seed_incident(&pool, stranger, Some("shared-component"), started).await;
        let sources = vec!["incident_index".to_string()];
        let scope = ToolScope {
            incident_id: mine,
            scope_user_id: owner,
        };
        let outcome = execute_tool(
            &pool,
            &sources,
            scope,
            TOOL_GET_RELATED,
            &json!({ "sourceId": "incident_index" }),
        )
        .await
        .expect("an authorised source must read");
        let ids: Vec<String> = outcome.payload["items"]
            .as_array()
            .expect("items must be an array")
            .iter()
            .filter_map(|item| item.get("incidentId").and_then(Value::as_str))
            .map(str::to_string)
            .collect();
        assert!(
            ids.contains(&mine.to_string()),
            "the incident itself must be in its own index page"
        );
        assert!(
            ids.contains(&peer.to_string()),
            "a peer incident of the same owner must be visible"
        );
        assert!(
            !ids.contains(&theirs.to_string()),
            "another operator's incident must not be reachable through the index"
        );
        cleanup(&pool, &[owner, stranger]).await;
    }

    #[tokio::test]
    async fn an_unknown_scope_account_cannot_be_substituted() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let failure = scope_caller(&pool, Uuid::new_v4())
            .await
            .expect_err("an account that does not exist must not become a caller");
        assert_eq!(failure.code, "SCOPE_IDENTITY_UNAVAILABLE");
        assert_eq!(failure.outcome, "REFUSED");
    }

    // -----------------------------------------------------------------------
    // The schema's own guarantees. These are the ones a handler cannot forget,
    // because they are enforced by the database the handler writes to.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn a_hypothesis_cannot_cite_evidence_from_another_incident() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        let other = seed_incident(&pool, owner, None, started).await;
        let foreign_evidence =
            seed_evidence(&pool, other, started, "LOG_EXCERPT", "agent", "UNVERIFIED").await;
        let run = seed_run(&pool, incident, owner).await;
        let hypothesis = seed_hypothesis(&pool, run).await;
        let error = sqlx::query(
            "INSERT INTO kernel.investigation_hypothesis_evidence
                 (hypothesis_id, evidence_id, role) VALUES ($1,$2,'SUPPORTING')",
        )
        .bind(hypothesis)
        .bind(foreign_evidence)
        .execute(&pool)
        .await
        .expect_err("the database must refuse a citation of another incident's evidence");
        assert!(
            error.to_string().contains("cannot cite"),
            "expected the citation guard, got: {error}"
        );

        // And the same row, cited for the incident it belongs to, is accepted.
        sqlx::query("DELETE FROM kernel.incidents WHERE incident_id=$1")
            .bind(other)
            .execute(&pool)
            .await
            .unwrap();
        let own_evidence = seed_evidence(
            &pool,
            incident,
            started,
            "OPERATOR_NOTE",
            "operator",
            "UNVERIFIED",
        )
        .await;
        sqlx::query(
            "INSERT INTO kernel.investigation_hypothesis_evidence
                 (hypothesis_id, evidence_id, role) VALUES ($1,$2,'SUPPORTING')",
        )
        .bind(hypothesis)
        .bind(own_evidence)
        .execute(&pool)
        .await
        .expect("the incident's own evidence must be citable");

        cleanup(&pool, &[owner]).await;
    }

    #[tokio::test]
    async fn a_hypothesis_cannot_speak_the_verdict_vocabulary() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        let run = seed_run(&pool, incident, owner).await;
        for verdict_word in ["CONFIRMED", "REFUTED", "INCONCLUSIVE"] {
            let error = sqlx::query(
                "INSERT INTO kernel.investigation_hypotheses
                     (hypothesis_id, run_id, ordinal, statement, stance, confidence, reasoning,
                      adapter_kind)
                 VALUES ($1,$2,9,'a hypothesis that claims to be a verdict',$3,'LOW',
                         'this must be refused','TEST_FIXTURE')",
            )
            .bind(Uuid::new_v4())
            .bind(run)
            .bind(verdict_word)
            .execute(&pool)
            .await
            .err()
            .unwrap_or_else(|| panic!("{verdict_word} must not be a hypothesis stance"));
            assert!(
                error
                    .to_string()
                    .contains("investigation_hypotheses_stance_check")
                    || error.to_string().contains("check constraint"),
                "expected the stance CHECK constraint, got: {error}"
            );
        }
        cleanup(&pool, &[owner]).await;
    }

    #[tokio::test]
    async fn an_uncertain_hypothesis_must_say_what_is_missing() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        let run = seed_run(&pool, incident, owner).await;
        let error = sqlx::query(
            "INSERT INTO kernel.investigation_hypotheses
                 (hypothesis_id, run_id, ordinal, statement, stance, confidence, reasoning,
                  adapter_kind)
             VALUES ($1,$2,2,'a hypothesis with no gap declared','UNCERTAIN','LOW',
                     'this must be refused','TEST_FIXTURE')",
        )
        .bind(Uuid::new_v4())
        .bind(run)
        .execute(&pool)
        .await
        .expect_err("UNCERTAIN without a gap code must be refused");
        assert!(
            error
                .to_string()
                .contains("investigation_uncertain_has_gap_check")
                || error.to_string().contains("check constraint"),
            "expected the gap CHECK constraint, got: {error}"
        );
        cleanup(&pool, &[owner]).await;
    }

    #[tokio::test]
    async fn a_run_cannot_be_relabelled_as_a_different_adapter() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        let run = seed_run(&pool, incident, owner).await;
        sqlx::query(
            "INSERT INTO kernel.investigation_model_providers
                 (provider_id, kind, display_name, credential_env_var, base_url, model_id, enabled)
             VALUES ('http-openai-compatible-v1','HTTP_OPENAI_COMPATIBLE','test provider',
                     'OPSWEAVE_TEST_MODEL_KEY','https://provider.invalid','test-model',true)
             ON CONFLICT (provider_id) DO NOTHING",
        )
        .execute(&pool)
        .await
        .unwrap();
        let error = sqlx::query(
            "UPDATE kernel.investigation_runs SET provider_id='http-openai-compatible-v1' WHERE run_id=$1",
        )
        .bind(run)
        .execute(&pool)
        .await
        .expect_err("a run must not be able to claim a provider whose kind it does not match");
        assert!(
            error
                .to_string()
                .contains("which is not what that provider is"),
            "expected the adapter guard, got: {error}"
        );
        cleanup(&pool, &[owner]).await;
    }

    #[tokio::test]
    async fn a_human_review_of_an_investigation_creates_no_verdict() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        let run = seed_run(&pool, incident, owner).await;
        sqlx::query(
            "INSERT INTO kernel.investigation_human_reviews (run_id, decision, note, reviewed_by)
             VALUES ($1,'ACCEPTED','the reasoning is usable for triage',$2)",
        )
        .bind(run)
        .bind(owner)
        .execute(&pool)
        .await
        .expect("a review is recordable");
        let verdicts: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_verdicts WHERE incident_id=$1",
        )
        .bind(incident)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(verdicts, 0, "a review must not become a verdict");
        let status: String =
            sqlx::query_scalar("SELECT status FROM kernel.incidents WHERE incident_id=$1")
                .bind(incident)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "OPEN", "a review must not move the incident either");
        // The review's vocabulary cannot express a verdict, and vice versa.
        let error = sqlx::query(
            "INSERT INTO kernel.investigation_human_reviews (run_id, decision, note, reviewed_by)
             VALUES ($1,'CONFIRMED','this is a verdict word and must be refused',$2)",
        )
        .bind(run)
        .bind(owner)
        .execute(&pool)
        .await
        .expect_err("CONFIRMED must not be a review decision");
        assert!(
            error.to_string().contains("decision_check")
                || error.to_string().contains("check constraint"),
            "expected the decision CHECK constraint, got: {error}"
        );
        cleanup(&pool, &[owner]).await;
    }

    /// G12 F (P1-3): "no UPDATE path" was a statement about the handler, and 0020 wrote
    /// it as if it were a statement about the table - an UPDATE ... SET decision changed
    /// a human's review. Migration 0021 makes it a statement about the table.
    #[tokio::test]
    async fn a_human_review_cannot_be_rewritten_in_place() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        let run = seed_run(&pool, incident, owner).await;
        sqlx::query(
            "INSERT INTO kernel.investigation_human_reviews (run_id, decision, note, reviewed_by)
             VALUES ($1,'ACCEPTED','the reasoning is usable for triage',$2)",
        )
        .bind(run)
        .bind(owner)
        .execute(&pool)
        .await
        .expect("a first review is recordable");

        let rewrite = sqlx::query(
            "UPDATE kernel.investigation_human_reviews SET decision='REJECTED' WHERE run_id=$1",
        )
        .bind(run)
        .execute(&pool)
        .await
        .expect_err("a review is write-once: the database must refuse the rewrite");
        let message = rewrite.to_string();
        assert!(
            message.contains("write-once") || message.contains("restrict"),
            "expected the immutability trigger, got: {message}"
        );

        let decision: String = sqlx::query_scalar(
            "SELECT decision FROM kernel.investigation_human_reviews WHERE run_id=$1",
        )
        .bind(run)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            decision, "ACCEPTED",
            "the review that was written is the one that stands"
        );

        cleanup(&pool, &[owner]).await;
    }

    #[tokio::test]
    async fn a_token_budget_overrun_is_recorded_as_a_measurement_not_clamped() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        let run = seed_run(&pool, incident, owner).await;
        sqlx::query(
            "UPDATE kernel.investigation_runs
                SET token_budget=200, prompt_tokens=180, completion_tokens=60, tokens_used=240
              WHERE run_id=$1",
        )
        .bind(run)
        .execute(&pool)
        .await
        .expect("a spend past the budget is storable: it is a measurement, not a promise");
        let recorded: i64 =
            sqlx::query_scalar("SELECT tokens_used FROM kernel.investigation_runs WHERE run_id=$1")
                .bind(run)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(recorded, 240);
        cleanup(&pool, &[owner]).await;
    }

    // -----------------------------------------------------------------------
    // G12 F (P1-1 / P1-7): a STORED evidence row is actually read, byte for byte.
    //
    // The defect these tests exist for was invisible to CI because nothing ever
    // drove read_evidence at a row that had bytes: the tool declared the bytea
    // column as String, so every such read failed with a libpq decode error while
    // the HTTP read of the same bytes worked. A test that only counts invocations
    // and outcomes cannot see the difference between "the tool ran" and "the tool
    // returned the bytes that were submitted", so this one compares the bytes.
    // -----------------------------------------------------------------------

    /// The fixture the two P1-1 tests share: an incident owned by an operator, one
    /// evidence row whose content is STORED, and the bytes the caller submitted.
    async fn stored_evidence(pool: &PgPool, body: &str) -> (Uuid, Uuid, Uuid) {
        let owner = seed_user(pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(pool, owner, None, started).await;
        let evidence = seed_evidence(
            pool,
            incident,
            started + ChronoDuration::minutes(5),
            "LOG_EXCERPT",
            "g12f-stored",
            "OPERATOR_ASSERTED",
        )
        .await;
        sqlx::query(
            "INSERT INTO kernel.incident_evidence_content
               (evidence_id,content_type,body,content_bytes,sha256)
             VALUES ($1,'text/plain',$2,$3,$4)",
        )
        .bind(evidence)
        .bind(body.as_bytes())
        .bind(body.len() as i32)
        .bind(sha256_hex(body.as_bytes()))
        .execute(pool)
        .await
        .unwrap();
        (owner, incident, evidence)
    }

    #[tokio::test]
    async fn read_evidence_returns_the_bytes_that_were_submitted() {
        const BODY: &str = "node-7 kernel: oom_kill process=cadvisor-x memory=1.9Gi";
        let Some(pool) = test_pool().await else {
            return;
        };
        let (owner, incident, evidence) = stored_evidence(&pool, BODY).await;
        let scope = ToolScope {
            incident_id: incident,
            scope_user_id: owner,
        };

        let outcome = execute_tool(
            &pool,
            &[],
            scope,
            TOOL_READ_EVIDENCE,
            &json!({ "incidentId": incident, "evidenceId": evidence }),
        )
        .await
        .expect("a read of the caller's own STORED content must not fail");

        assert_eq!(outcome.predicate, PREDICATE_EVIDENCE_CONTENT);
        assert_eq!(
            outcome.payload["content"]["body"],
            serde_json::json!(BODY),
            "the bytes the tool returns must be the bytes that were submitted"
        );
        assert_eq!(
            outcome.payload["content"]["bytes"],
            serde_json::json!(BODY.len())
        );
        assert_eq!(
            outcome.payload["content"]["sha256"],
            serde_json::json!(sha256_hex(BODY.as_bytes())),
            "the digest in the payload is recomputed over the bytes in hand"
        );
        assert_eq!(
            outcome.payload["content"]["truncated"],
            serde_json::json!(false)
        );

        cleanup(&pool, &[owner]).await;
    }

    /// The second half of P1-7: a read that FAILS has to reach the hypothesis. The
    /// fixture's own statement of the record must not claim more than it read.
    #[test]
    fn a_failed_read_with_rows_cited_is_named_in_gaps_and_lowers_confidence() {
        let started = Utc::now();
        let row = Uuid::new_v4();
        let mut transcript = transcript_with(
            started,
            &[(row, started + ChronoDuration::minutes(1), "SOURCE_ATTESTED")],
        );
        transcript.failed = true;
        let hypothesis = fixture_hypothesis(&transcript);
        assert!(
            hypothesis.gap_codes.contains(&"TOOL_FAILED".to_string()),
            "a failed read must appear in gapCodes even when other reads returned rows, got {:?}",
            hypothesis.gap_codes
        );
        assert_ne!(
            hypothesis.confidence, "HIGH",
            "a conclusion over a record with a failed read is not a high-confidence one"
        );
        let uncertainty = hypothesis
            .uncertainty
            .as_deref()
            .expect("a run with a failed read must state an uncertainty");
        assert!(
            uncertainty.contains("failed inside the Kernel"),
            "the uncertainty must say a read failed, got: {uncertainty}"
        );
    }

    /// A refusal and a failure can both happen in one run, and both have to survive: the
    /// old code reported one or the other, never both.
    #[test]
    fn a_refused_and_a_failed_read_are_both_reported() {
        let started = Utc::now();
        let row = Uuid::new_v4();
        let mut transcript = transcript_with(started, &[(row, started, "OPERATOR_ASSERTED")]);
        transcript.refused = true;
        transcript.failed = true;
        let hypothesis = fixture_hypothesis(&transcript);
        assert!(hypothesis.gap_codes.contains(&"TOOL_REFUSED".to_string()));
        assert!(hypothesis.gap_codes.contains(&"TOOL_FAILED".to_string()));
    }

    /// G12 F (P1-6): the payload is kept as the exact bytes the digest covers, so a later
    /// reader can recompute the digest instead of believing it. This is the property 0020
    /// only appeared to have.
    #[tokio::test]
    async fn a_recorded_payload_makes_its_digest_recomputable() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        let run = seed_run(&pool, incident, owner).await;
        let payload = r#"{"content":{"body":"disk full on node-7","bytes":19},"evidenceId":"00000000-0000-0000-0000-000000000001"}"#;
        let digest = sha256_hex(payload.as_bytes());
        let horizon = Utc::now() + ChronoDuration::days(7);
        let started_at = Utc::now();
        record_invocation(
            &pool,
            InvocationRecord {
                run_id: run,
                sequence: 1,
                attempt: 1,
                tool: TOOL_READ_EVIDENCE,
                arguments: &json!({}),
                outcome: "OK",
                error_code: None,
                error_detail: None,
                predicate: Some(PREDICATE_EVIDENCE_CONTENT),
                scope_actor: Some(owner),
                result_body: Some(payload),
                result_bytes: Some(payload.len() as i32),
                result_digest: Some(&digest),
                result_retention: Some(horizon),
                evidence_refs: &[],
                started_at,
                finished_at: started_at,
                duration_ms: 1,
            },
        )
        .await
        .expect("a recorded payload is storable");

        let (stored, stored_digest, stored_horizon): (String, String, Option<DateTime<Utc>>) =
            sqlx::query_as(
                "SELECT result_body, result_digest, result_retention_expires_at
                   FROM kernel.investigation_tool_invocations WHERE run_id=$1",
            )
            .bind(run)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            sha256_hex(stored.as_bytes()),
            stored_digest,
            "the digest must be recomputable from what was stored"
        );
        assert_eq!(
            stored, payload,
            "the stored text is the exact bytes that were hashed"
        );
        assert_eq!(
            stored_horizon.map(|value| value.timestamp()),
            Some(horizon.timestamp()),
            "the copy carries the horizon of the content it quotes"
        );

        // And a body without the digest and length that describe it is not a record.
        let orphan = sqlx::query(
            "INSERT INTO kernel.investigation_tool_invocations
               (invocation_id, run_id, sequence, attempt, tool_name, arguments, outcome,
                error_code, authorization_predicate, scope_actor, result_body,
                evidence_refs, started_at, finished_at, duration_ms)
             VALUES ($1,$2,2,1,'read_evidence','{}'::jsonb,'OK',NULL,'P',NULL,'{}','[]'::jsonb,now(),now(),1)",
        )
        .bind(Uuid::new_v4())
        .bind(run)
        .execute(&pool)
        .await
        .expect_err("a retained payload must carry its digest and length");
        assert!(
            orphan.to_string().contains("result_body_check")
                || orphan.to_string().contains("check constraint"),
            "expected the pairing constraint, got: {orphan}"
        );

        cleanup(&pool, &[owner]).await;
    }
}
