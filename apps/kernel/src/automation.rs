//! G13-B1 slice 2: Automation Principal issuance and verification.
//!
//! ADR-018: the Kernel is the only issuer. A Node, authenticated by its control
//! credential, asks for a principal for one live instance and one READY source;
//! the Kernel resolves the workspace from `kernel.telemetry_sources`, never from
//! the request. The resulting `owa1` token is scoped to that workspace/source,
//! a closed operation set, a budget and at most five minutes.
//!
//! A token is checked against both its signature and the database row: a row
//! that was revoked, expired, or whose instance/node generation/still-live or
//! source READY state changed is refused even though the signature is valid.
//! Each allowed operation can be consumed once (`automation_principal_uses`),
//! so capturing a token does not let a caller replay the same state change.
//!
//! Slice 2 lands the issuance/verification primitives; the Event ingest and
//! evidence handlers that call `authenticate`/`consume_once` arrive in slices
//! 3-4. They are exercised by this module's tests now, so the public surface is
//! intentionally allowed to be unused by production call sites in this PR.
#![allow(dead_code)]

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::nodes::NodeRow;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use base64::Engine;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use sqlx::FromRow;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

pub const TOKEN_PREFIX: &str = "owa1";
pub const AUDIENCE: &str = "opsweave-kernel";
const MAX_TTL_SECONDS: i64 = 300;
const CLOCK_SKEW_SECONDS: i64 = 60;

const ALLOWED_OPS: &[&str] = &["EVENT_INGEST", "SOURCE_COLLECT", "EVIDENCE_APPEND"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationClaims {
    pub v: u8,
    pub kind: String,
    pub principal_id: Uuid,
    pub plugin_id: String,
    pub instance_id: Uuid,
    pub node_id: Uuid,
    pub node_generation: i64,
    pub workspace_id: Uuid,
    pub source_id: Uuid,
    pub allowed_ops: Vec<String>,
    pub event_id: Option<Uuid>,
    pub incident_id: Option<Uuid>,
    pub budget: Value,
    pub issued_at: i64,
    pub expires_at: i64,
    pub jti: Uuid,
    pub audience: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueAutomationPrincipalRequest {
    pub instance_id: Uuid,
    pub source_id: Uuid,
    pub allowed_ops: Vec<String>,
    #[serde(default)]
    pub event_id: Option<Uuid>,
    #[serde(default)]
    pub incident_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueAutomationPrincipalResponse {
    pub token: String,
    pub principal_id: Uuid,
    pub expires_at: DateTime<Utc>,
    pub workspace_id: Uuid,
    pub source_id: Uuid,
    pub allowed_ops: Vec<String>,
    pub budget: Value,
}

#[derive(Debug, Clone, FromRow)]
pub struct PrincipalRow {
    pub principal_id: Uuid,
    pub plugin_id: String,
    pub instance_id: Uuid,
    pub node_id: Uuid,
    pub node_generation: i64,
    pub workspace_id: Uuid,
    pub source_id: Uuid,
    pub allowed_ops: Vec<String>,
    pub event_id: Option<Uuid>,
    pub incident_id: Option<Uuid>,
    pub budget: Value,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub jti: Uuid,
    pub revoked_at: Option<DateTime<Utc>>,
}

/// An authenticated automation caller. It is deliberately not `AuthUser` and
/// has no `require_operator`; the only verbs it can perform are the operations
/// recorded on its row.
#[derive(Debug, Clone)]
pub struct AutomationPrincipal {
    pub row: PrincipalRow,
    pub claims: AutomationClaims,
}

impl AutomationPrincipal {
    pub fn principal_id(&self) -> Uuid {
        self.row.principal_id
    }

    pub fn require_op(&self, operation: &str) -> AppResult<()> {
        if self.row.allowed_ops.iter().any(|op| op == operation) {
            Ok(())
        } else {
            Err(AppError::new(
                StatusCode::FORBIDDEN,
                "AUTOMATION_OPERATION_FORBIDDEN",
                format!("this principal may not perform {operation}"),
            ))
        }
    }

    /// Consume one operation of this principal. A second call for the same
    /// operation is a replay, even with a valid signature.
    pub async fn consume_once(&self, state: &AppState, operation: &str) -> AppResult<()> {
        self.require_op(operation)?;
        let inserted = sqlx::query(
            "INSERT INTO kernel.automation_principal_uses (principal_id, operation)
             VALUES ($1,$2) ON CONFLICT DO NOTHING",
        )
        .bind(self.row.principal_id)
        .bind(operation)
        .execute(&state.db)
        .await?;
        if inserted.rows_affected() == 0 {
            return Err(AppError::conflict(
                "AUTOMATION_REPLAY",
                "this automation operation was already consumed",
            ));
        }
        Ok(())
    }
}

fn signing_key(state: &AppState, plugin_id: &str) -> Vec<u8> {
    let mut mac =
        HmacSha256::new_from_slice(&state.cursor_secret).expect("HMAC accepts any key length");
    mac.update(b"automation-principal:");
    mac.update(plugin_id.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn sign(state: &AppState, claims: &AutomationClaims) -> AppResult<String> {
    let payload = serde_json::to_vec(claims).map_err(AppError::from)?;
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload);
    let mut mac = HmacSha256::new_from_slice(&signing_key(state, &claims.plugin_id))
        .map_err(|_| AppError::internal("automation signing key is invalid"))?;
    mac.update(encoded.as_bytes());
    let signature =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Ok(format!("{TOKEN_PREFIX}.{encoded}.{signature}"))
}

fn decode_payload(token: &str) -> AppResult<(AutomationClaims, String, String)> {
    let mut parts = token.split('.');
    let prefix = parts.next();
    let encoded = parts.next();
    let signature = parts.next();
    if prefix != Some(TOKEN_PREFIX)
        || encoded.is_none()
        || signature.is_none()
        || parts.next().is_some()
    {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "AUTOMATION_PRINCIPAL_INVALID",
            "malformed automation token",
        ));
    }
    let encoded = encoded.unwrap_or_default().to_string();
    let signature = signature.unwrap_or_default().to_string();
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&encoded)
        .map_err(|_| {
            AppError::new(
                StatusCode::UNAUTHORIZED,
                "AUTOMATION_PRINCIPAL_INVALID",
                "invalid automation token payload",
            )
        })?;
    let claims: AutomationClaims = serde_json::from_slice(&payload).map_err(|_| {
        AppError::new(
            StatusCode::UNAUTHORIZED,
            "AUTOMATION_PRINCIPAL_INVALID",
            "invalid automation token claims",
        )
    })?;
    Ok((claims, encoded, signature))
}

fn verify(state: &AppState, token: &str) -> AppResult<AutomationClaims> {
    let (claims, encoded, signature) = decode_payload(token)?;
    if claims.v != 1 || claims.kind != "automation" || claims.audience != AUDIENCE {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "AUTOMATION_PRINCIPAL_INVALID",
            "invalid automation token version or audience",
        ));
    }
    let mut mac = HmacSha256::new_from_slice(&signing_key(state, &claims.plugin_id))
        .map_err(|_| AppError::internal("automation signing key is invalid"))?;
    mac.update(encoded.as_bytes());
    let expected =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    if expected != signature {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "AUTOMATION_PRINCIPAL_INVALID",
            "invalid automation token signature",
        ));
    }
    let now = Utc::now().timestamp();
    if claims.expires_at <= now {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "AUTOMATION_PRINCIPAL_EXPIRED",
            "the automation principal has expired",
        ));
    }
    if claims.issued_at > now + CLOCK_SKEW_SECONDS {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "AUTOMATION_PRINCIPAL_INVALID",
            "issued_at is in the future",
        ));
    }
    Ok(claims)
}

/// Issue a principal for a live instance and a READY source.
///
/// The caller is a Node authenticated by its own credential. The request cannot
/// choose a workspace: it is read from the registry row for `sourceId`.
pub async fn issue(
    state: &AppState,
    node: &NodeRow,
    request: IssueAutomationPrincipalRequest,
) -> AppResult<IssueAutomationPrincipalResponse> {
    if request.allowed_ops.is_empty() || request.allowed_ops.len() > ALLOWED_OPS.len() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "AUTOMATION_SCOPE_INVALID",
            "allowedOps must name between one and three operations",
        ));
    }
    let mut ops = request.allowed_ops.clone();
    ops.sort();
    ops.dedup();
    if ops.len() != request.allowed_ops.len()
        || ops.iter().any(|op| !ALLOWED_OPS.contains(&op.as_str()))
    {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "AUTOMATION_SCOPE_INVALID",
            "allowedOps contains an unknown or duplicate operation",
        ));
    }
    if ops.iter().any(|op| {
        !matches!(
            op.as_str(),
            "EVENT_INGEST" | "SOURCE_COLLECT" | "EVIDENCE_APPEND"
        )
    }) {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "AUTOMATION_SCOPE_INVALID",
            "verdict, close, binding and workspace operations are not automation operations",
        ));
    }

    let instance: Option<(Uuid, String)> = sqlx::query_as(
        r#"
        SELECT i.id, d.plugin_id
        FROM kernel.plugin_instances i
        JOIN kernel.plugin_deployments d ON d.id=i.deployment_id
        WHERE i.id=$1 AND i.node_id=$2 AND i.desired_action='START'
        "#,
    )
    .bind(request.instance_id)
    .bind(node.id)
    .fetch_optional(&state.db)
    .await?;
    let Some((instance_id, plugin_id)) = instance else {
        return Err(AppError::not_found("instance is not assigned to this node"));
    };

    let source: Option<(Uuid, String, String)> = sqlx::query_as(
        "SELECT workspace_id, plugin_id, state FROM kernel.telemetry_sources WHERE source_id=$1",
    )
    .bind(request.source_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((workspace_id, source_plugin, source_state)) = source else {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "AUTOMATION_SOURCE_NOT_REGISTERED",
            "the source is not in the Kernel registry",
        ));
    };
    if source_plugin != plugin_id {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "EVENT_SOURCE_FORBIDDEN",
            "the source belongs to another plugin",
        ));
    }
    if source_state != "READY" {
        return Err(AppError::conflict(
            "AUTOMATION_SOURCE_NOT_READY",
            format!("the source is {source_state}, not READY"),
        ));
    }

    if let Some(event_id) = request.event_id {
        let matched: Option<Uuid> = sqlx::query_scalar(
            "SELECT event_id FROM kernel.telemetry_events
              WHERE event_id=$1 AND workspace_id=$2 AND source_id=$3",
        )
        .bind(event_id)
        .bind(workspace_id)
        .bind(request.source_id)
        .fetch_optional(&state.db)
        .await?;
        if matched.is_none() {
            return Err(AppError::new(
                StatusCode::FORBIDDEN,
                "EVENT_SOURCE_FORBIDDEN",
                "the event does not belong to this workspace/source",
            ));
        }
    }
    if let Some(incident_id) = request.incident_id {
        let matched: Option<Uuid> = sqlx::query_scalar(
            "SELECT incident_id FROM kernel.incidents
              WHERE incident_id=$1 AND workspace_id=$2 AND source_id=$3",
        )
        .bind(incident_id)
        .bind(workspace_id)
        .bind(request.source_id)
        .fetch_optional(&state.db)
        .await?;
        if matched.is_none() {
            return Err(AppError::new(
                StatusCode::FORBIDDEN,
                "AUTOMATION_INCIDENT_FORBIDDEN",
                "the incident does not belong to this workspace/source",
            ));
        }
    }

    let now = Utc::now();
    let expires_at = now + ChronoDuration::seconds(MAX_TTL_SECONDS);
    // Server-owned budget: a caller cannot raise it.
    let budget = json!({
        "events": 8,
        "collections": 8,
        "evidenceBytes": 1_048_576,
        "windowSeconds": MAX_TTL_SECONDS,
    });
    let principal_id = Uuid::new_v4();
    let jti = Uuid::new_v4();
    let node_generation = node.generation;
    let claims = AutomationClaims {
        v: 1,
        kind: "automation".into(),
        principal_id,
        plugin_id: plugin_id.clone(),
        instance_id,
        node_id: node.id,
        node_generation,
        workspace_id,
        source_id: request.source_id,
        allowed_ops: ops.clone(),
        event_id: request.event_id,
        incident_id: request.incident_id,
        budget: budget.clone(),
        issued_at: now.timestamp(),
        expires_at: expires_at.timestamp(),
        jti,
        audience: AUDIENCE.into(),
    };
    let token = sign(state, &claims)?;

    sqlx::query(
        "INSERT INTO kernel.automation_principals
             (principal_id,plugin_id,instance_id,node_id,node_generation,workspace_id,source_id,
              allowed_ops,event_id,incident_id,budget,issued_at,expires_at,jti)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
    )
    .bind(principal_id)
    .bind(&plugin_id)
    .bind(instance_id)
    .bind(node.id)
    .bind(node_generation)
    .bind(workspace_id)
    .bind(request.source_id)
    .bind(&ops)
    .bind(request.event_id)
    .bind(request.incident_id)
    .bind(&budget)
    .bind(now)
    .bind(expires_at)
    .bind(jti)
    .execute(&state.db)
    .await?;

    Ok(IssueAutomationPrincipalResponse {
        token,
        principal_id,
        expires_at,
        workspace_id,
        source_id: request.source_id,
        allowed_ops: ops,
        budget,
    })
}

/// `POST /internal/v1/nodes/{node_id}/automation-principals`
///
/// The Node credential is the only caller: a plugin has no way to ask for a
/// principal, and the request cannot name a workspace.
pub async fn issue_handler(
    State(state): State<AppState>,
    Path(node_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<IssueAutomationPrincipalRequest>,
) -> AppResult<Json<IssueAutomationPrincipalResponse>> {
    let node = crate::nodes::authenticate_node(&state, node_id, &headers).await?;
    Ok(Json(issue(&state, &node, request).await?))
}

/// Authenticate an `owa1` bearer token and re-check the live database state.
///
/// A valid signature is not enough: revocation, expiry, node generation,
/// instance liveness and source READY are all evaluated on every call.
pub async fn authenticate(state: &AppState, headers: &HeaderMap) -> AppResult<AutomationPrincipal> {
    let token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::new(
                StatusCode::UNAUTHORIZED,
                "AUTOMATION_PRINCIPAL_INVALID",
                "automation principal required",
            )
        })?;
    let claims = verify(state, token)?;
    let row = sqlx::query_as::<_, PrincipalRow>(
        "SELECT principal_id,plugin_id,instance_id,node_id,node_generation,workspace_id,source_id,
                allowed_ops,event_id,incident_id,budget,issued_at,expires_at,jti,revoked_at
           FROM kernel.automation_principals WHERE principal_id=$1",
    )
    .bind(claims.principal_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        AppError::new(
            StatusCode::UNAUTHORIZED,
            "AUTOMATION_PRINCIPAL_INVALID",
            "the principal no longer exists",
        )
    })?;

    if row.revoked_at.is_some() {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "AUTOMATION_PRINCIPAL_REVOKED",
            "the principal was revoked",
        ));
    }
    if row.jti != claims.jti
        || row.plugin_id != claims.plugin_id
        || row.instance_id != claims.instance_id
        || row.node_id != claims.node_id
        || row.node_generation != claims.node_generation
        || row.workspace_id != claims.workspace_id
        || row.source_id != claims.source_id
        || row.allowed_ops != claims.allowed_ops
    {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "AUTOMATION_PRINCIPAL_INVALID",
            "the token does not match the stored principal",
        ));
    }

    let current_generation: Option<i64> = sqlx::query_scalar(
        "SELECT generation FROM kernel.nodes WHERE id=$1 AND revoked_at IS NULL",
    )
    .bind(claims.node_id)
    .fetch_optional(&state.db)
    .await?;
    if current_generation != Some(claims.node_generation) {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "AUTOMATION_INSTANCE_STALE",
            "the node generation changed",
        ));
    }

    let live: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT i.id FROM kernel.plugin_instances i
        JOIN kernel.plugin_deployments d ON d.id=i.deployment_id
        WHERE i.id=$1 AND i.node_id=$2 AND d.plugin_id=$3 AND i.desired_action='START'
        "#,
    )
    .bind(claims.instance_id)
    .bind(claims.node_id)
    .bind(&claims.plugin_id)
    .fetch_optional(&state.db)
    .await?;
    if live.is_none() {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "AUTOMATION_INSTANCE_STALE",
            "the instance is no longer live on this node",
        ));
    }

    let source: Option<(String, Uuid, String)> = sqlx::query_as(
        "SELECT state, workspace_id, plugin_id FROM kernel.telemetry_sources WHERE source_id=$1",
    )
    .bind(claims.source_id)
    .fetch_optional(&state.db)
    .await?;
    match source {
        Some((state_value, workspace_id, plugin_id))
            if state_value == "READY"
                && workspace_id == claims.workspace_id
                && plugin_id == claims.plugin_id => {}
        _ => {
            return Err(AppError::new(
                StatusCode::FORBIDDEN,
                "AUTOMATION_SOURCE_NOT_READY",
                "the source is no longer READY for this principal",
            ))
        }
    }

    Ok(AutomationPrincipal { row, claims })
}

/// `POST /api/v1/automation-principals/{principal_id}/revoke` — admin only.
pub async fn revoke_handler(
    State(state): State<AppState>,
    Path(principal_id): Path<Uuid>,
    auth: AuthUser,
) -> AppResult<StatusCode> {
    auth.require_admin()?;
    revoke(&state, principal_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Admin/operator revocation of one principal. Idempotent; records nothing when
/// the id does not exist so the caller cannot probe.
pub async fn revoke(state: &AppState, principal_id: Uuid) -> AppResult<()> {
    sqlx::query(
        "UPDATE kernel.automation_principals SET revoked_at=now()
          WHERE principal_id=$1 AND revoked_at IS NULL",
    )
    .bind(principal_id)
    .execute(&state.db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::postgres::PgConnectOptions;
    use sqlx::PgPool;

    const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";

    fn database_required() -> bool {
        match std::env::var(REQUIRE_DATABASE_ENV) {
            Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
                "0" | "false" | "no" => false,
                "1" | "true" | "yes" => true,
                other => panic!("{REQUIRE_DATABASE_ENV} is set to {other:?}: use 1 to require the DB-backed tests"),
            },
            Err(_) => false,
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

    #[tokio::test]
    async fn a_token_is_bound_to_its_stored_principal_and_operation() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let state = crate::state::AppState::new(
            crate::config::Config::from_env(),
            pool.clone(),
            b"automation-test-cursor".to_vec(),
        )
        .unwrap();
        let (node, instance_id, source_id, workspace_id) = seed(&pool).await;
        let issued = issue(
            &state,
            &node,
            IssueAutomationPrincipalRequest {
                instance_id,
                source_id,
                allowed_ops: vec!["EVENT_INGEST".into()],
                event_id: None,
                incident_id: None,
            },
        )
        .await
        .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            format!("Bearer {}", issued.token).parse().unwrap(),
        );
        let principal = authenticate(&state, &headers).await.unwrap();
        assert_eq!(principal.claims.workspace_id, workspace_id);
        assert!(principal.require_op("EVENT_INGEST").is_ok());
        assert!(principal.require_op("EVIDENCE_APPEND").is_err());
        principal
            .consume_once(&state, "EVENT_INGEST")
            .await
            .unwrap();
        let replay = principal
            .consume_once(&state, "EVENT_INGEST")
            .await
            .unwrap_err();
        assert_eq!(replay.code, "AUTOMATION_REPLAY");

        revoke(&state, principal.principal_id()).await.unwrap();
        let revoked = authenticate(&state, &headers).await.unwrap_err();
        assert!(revoked.code.contains("AUTOMATION_PRINCIPAL_REVOKED"));
        cleanup(&pool, node.id, instance_id, source_id).await;
    }

    #[tokio::test]
    async fn a_stale_generation_or_disabled_source_invalidates_the_token() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let state = crate::state::AppState::new(
            crate::config::Config::from_env(),
            pool.clone(),
            b"automation-test-cursor".to_vec(),
        )
        .unwrap();
        let (node, instance_id, source_id, _) = seed(&pool).await;
        let issued = issue(
            &state,
            &node,
            IssueAutomationPrincipalRequest {
                instance_id,
                source_id,
                allowed_ops: vec!["SOURCE_COLLECT".into()],
                event_id: None,
                incident_id: None,
            },
        )
        .await
        .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            format!("Bearer {}", issued.token).parse().unwrap(),
        );
        assert!(authenticate(&state, &headers).await.is_ok());

        sqlx::query("UPDATE kernel.nodes SET generation=generation+1 WHERE id=$1")
            .bind(node.id)
            .execute(&pool)
            .await
            .unwrap();
        let stale = authenticate(&state, &headers).await.unwrap_err();
        assert_eq!(stale.code, "AUTOMATION_INSTANCE_STALE", "{stale:?}");

        sqlx::query("UPDATE kernel.nodes SET generation=$2 WHERE id=$1")
            .bind(node.id)
            .bind(node.generation)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE kernel.telemetry_sources SET state='DISABLED' WHERE source_id=$1")
            .bind(source_id)
            .execute(&pool)
            .await
            .unwrap();
        let disabled = authenticate(&state, &headers).await.unwrap_err();
        assert_eq!(disabled.code, "AUTOMATION_SOURCE_NOT_READY", "{disabled:?}");

        cleanup(&pool, node.id, instance_id, source_id).await;
    }

    #[tokio::test]
    async fn unknown_or_forbidden_operations_are_refused_at_issuance() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let state = crate::state::AppState::new(
            crate::config::Config::from_env(),
            pool.clone(),
            b"automation-test-cursor".to_vec(),
        )
        .unwrap();
        let (node, instance_id, source_id, _) = seed(&pool).await;
        for ops in [
            vec!["VERDICT_WRITE".to_string()],
            vec!["EVENT_INGEST".into(), "EVENT_INGEST".into()],
            Vec::new(),
        ] {
            let error = issue(
                &state,
                &node,
                IssueAutomationPrincipalRequest {
                    instance_id,
                    source_id,
                    allowed_ops: ops,
                    event_id: None,
                    incident_id: None,
                },
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, "AUTOMATION_SCOPE_INVALID", "{error:?}");
        }
        cleanup(&pool, node.id, instance_id, source_id).await;
    }

    async fn seed(pool: &PgPool) -> (NodeRow, Uuid, Uuid, Uuid) {
        let node = NodeRow {
            id: Uuid::new_v4(),
            name: format!("automation-node-{}", Uuid::new_v4()),
            control_token_hash: "hash".into(),
            data_token: "data".into(),
            generation: 7,
            os: "linux".into(),
            arch: "arm64".into(),
            labels: json!({}),
            capabilities: json!({}),
            status: "READY".into(),
            last_seen_at: Some(Utc::now()),
            data_endpoint: None,
            runtime_adapter_version: None,
            resource_snapshot: None,
            enrolled_at: Utc::now(),
            revoked_at: None,
            cert_expires_at: None,
        };
        sqlx::query(
            "INSERT INTO kernel.nodes (id,name,control_token_hash,data_token,generation,os,arch,status,last_seen_at,enrolled_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'READY',now(),now())",
        )
        .bind(node.id)
        .bind(&node.name)
        .bind(&node.control_token_hash)
        .bind(&node.data_token)
        .bind(node.generation)
        .bind(&node.os)
        .bind(&node.arch)
        .execute(pool)
        .await
        .unwrap();

        let workspace_id = crate::scope::legacy_workspace();
        let source_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.telemetry_sources
                 (source_id,workspace_id,plugin_id,secret_ref,endpoint,tls_policy,state)
             VALUES ($1,$2,'zabbix-source','secretref:zabbix/main','https://zabbix.example/api_jsonrpc.php','VERIFY','READY')",
        )
        .bind(source_id)
        .bind(workspace_id)
        .execute(pool)
        .await
        .unwrap();

        let package_id = Uuid::new_v4();
        let version = format!("0.0.1-{}", &package_id.to_string()[..8]);
        sqlx::query(
            "INSERT INTO kernel.plugin_packages
                 (package_id,plugin_id,version,schema_version,publisher,manifest,
                  artifact_digest,bundle_digest,payload_digest,status,signature_state)
             VALUES ($1,'zabbix-source',$2,'1.1','test','{}'::jsonb,$3,$4,$5,'INSTALLED','VERIFIED')",
        )
        .bind(package_id)
        .bind(&version)
        .bind(format!("artifact-{package_id}"))
        .bind(format!("bundle-{package_id}"))
        .bind(format!("payload-{package_id}"))
        .execute(pool)
        .await
        .unwrap();
        let deployment_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.plugin_deployments
                 (id,plugin_id,package_id,version,desired_replicas,generation,placement,resources,status)
             VALUES ($1,'zabbix-source',$2,$3,1,1,'{}'::jsonb,'{}'::jsonb,'ACTIVE')",
        )
        .bind(deployment_id)
        .bind(package_id)
        .bind(&version)
        .execute(pool)
        .await
        .unwrap();
        let instance_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.plugin_instances
                 (id,deployment_id,node_id,slot,deployment_generation,desired_action,state)
             VALUES ($1,$2,$3,1,1,'START','READY')",
        )
        .bind(instance_id)
        .bind(deployment_id)
        .bind(node.id)
        .execute(pool)
        .await
        .unwrap();
        (node, instance_id, source_id, workspace_id)
    }

    async fn cleanup(pool: &PgPool, node: Uuid, instance: Uuid, source: Uuid) {
        let deployment: Option<(Uuid,)> =
            sqlx::query_as("SELECT deployment_id FROM kernel.plugin_instances WHERE id=$1")
                .bind(instance)
                .fetch_optional(pool)
                .await
                .unwrap_or(None);
        let _ = sqlx::query("DELETE FROM kernel.automation_principals WHERE instance_id=$1")
            .bind(instance)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM kernel.plugin_instances WHERE id=$1")
            .bind(instance)
            .execute(pool)
            .await;
        if let Some((deployment_id,)) = deployment {
            let package: Option<(Uuid,)> =
                sqlx::query_as("SELECT package_id FROM kernel.plugin_deployments WHERE id=$1")
                    .bind(deployment_id)
                    .fetch_optional(pool)
                    .await
                    .unwrap_or(None);
            let _ = sqlx::query("DELETE FROM kernel.plugin_deployments WHERE id=$1")
                .bind(deployment_id)
                .execute(pool)
                .await;
            if let Some((package_id,)) = package {
                let _ = sqlx::query("DELETE FROM kernel.plugin_packages WHERE package_id=$1")
                    .bind(package_id)
                    .execute(pool)
                    .await;
            }
        }
        let _ = sqlx::query("DELETE FROM kernel.telemetry_sources WHERE source_id=$1")
            .bind(source)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM kernel.nodes WHERE id=$1")
            .bind(node)
            .execute(pool)
            .await;
    }
}
