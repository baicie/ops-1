use crate::audit;
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use chrono::{Duration as ChronoDuration, Utc};
use hmac::{Hmac, Mac};
use opsweave_contracts::{ManifestV11, Role};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use sqlx::FromRow;
use std::time::Duration;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;
const TOKEN_PREFIX: &str = "oww1";
const MAX_CAPABILITY_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityGrantView {
    pub id: Uuid,
    pub name: String,
    pub major: i64,
    pub consumer_plugin_id: String,
    pub provider_plugin_id: Option<String>,
    pub scope: Value,
    pub state: String,
    pub expires_at: Option<chrono::DateTime<Utc>>,
    pub created_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGrantRequest {
    pub name: String,
    pub major: i64,
    pub consumer_plugin_id: String,
    pub provider_plugin_id: Option<String>,
    pub scope: Vec<String>,
    pub expires_at: Option<chrono::DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadTokenRequest {
    pub instance_id: Uuid,
    #[serde(default)]
    pub service_plugin_id: Option<String>,
    pub capability_name: String,
    pub capability_major: i64,
    pub audience: String,
    pub scope: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadTokenResponse {
    pub token: String,
    pub expires_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceEnvironmentResponse {
    pub env: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkloadClaims {
    v: u8,
    sub: String,
    plugin_id: String,
    instance_id: Uuid,
    node_id: Uuid,
    node_generation: i64,
    capability_name: String,
    capability_major: i64,
    audience: String,
    scope: Vec<String>,
    issued_at: i64,
    expires_at: i64,
    jti: Uuid,
}

type LiveInstanceRow = (
    String,
    i64,
    Option<chrono::DateTime<Utc>>,
    String,
    Option<chrono::DateTime<Utc>>,
);

#[derive(Debug, Clone, FromRow)]
struct ProviderRow {
    instance_id: Uuid,
    plugin_id: String,
    version: String,
    generation: i64,
    manifest: Value,
    data_endpoint: String,
    data_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityResolution {
    pub name: String,
    pub major: i64,
    pub provider_plugin_id: String,
    pub provider_version: String,
    pub activation_revision: i64,
    pub api_digest: String,
    pub execution_mode: &'static str,
    pub status: &'static str,
}

pub async fn list_grants(
    State(state): State<AppState>,
    auth: AuthUser,
) -> AppResult<Json<Vec<CapabilityGrantView>>> {
    require_operator(&auth)?;
    let rows = sqlx::query_as::<_, CapabilityGrantView>(
        "SELECT id,name,major::bigint,consumer_plugin_id,provider_plugin_id,scope,state,expires_at,created_at FROM kernel.capability_grants ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

pub async fn create_grant(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(payload): Json<CreateGrantRequest>,
) -> AppResult<(StatusCode, Json<CapabilityGrantView>)> {
    require_operator(&auth)?;
    validate_capability_name(&payload.name)?;
    if payload.major < 1 || payload.scope.is_empty() || payload.scope.len() > 32 {
        return Err(AppError::bad_request("invalid capability grant"));
    }
    if payload.consumer_plugin_id.trim().is_empty() {
        return Err(AppError::bad_request("consumerPluginId is required"));
    }
    let provider = resolve_provider(&state, &payload.name, payload.major).await?;
    if let Some(requested) = &payload.provider_plugin_id {
        if requested != &provider.plugin_id {
            return Err(AppError::conflict(
                "PROVIDER_MISMATCH",
                format!("requested provider {requested} is not the selected provider"),
            ));
        }
    }
    let id = Uuid::new_v4();
    let row = sqlx::query_as::<_, CapabilityGrantView>(
        r#"
        INSERT INTO kernel.capability_grants
          (id,name,major,consumer_plugin_id,provider_plugin_id,scope,state,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',$7)
        ON CONFLICT (consumer_plugin_id,name,major) DO UPDATE
          SET provider_plugin_id=EXCLUDED.provider_plugin_id,
              scope=EXCLUDED.scope,
              state='ACTIVE',
              expires_at=EXCLUDED.expires_at,
              revoked_at=NULL
        RETURNING id,name,major::bigint,consumer_plugin_id,provider_plugin_id,scope,state,expires_at,created_at
        "#,
    )
    .bind(id)
    .bind(&payload.name)
    .bind(payload.major)
    .bind(&payload.consumer_plugin_id)
    .bind(&payload.provider_plugin_id)
    .bind(serde_json::to_value(&payload.scope).map_err(AppError::from)?)
    .bind(payload.expires_at)
    .fetch_one(&state.db)
    .await?;
    audit::record(
        &state.db,
        "capability.granted",
        "USER",
        &auth.user_id.to_string(),
        "capability",
        &format!("{}:{}", payload.name, payload.major),
        "capability.grant",
        "CONFIRMED",
        serde_json::json!({
            "consumerPluginId": payload.consumer_plugin_id,
            "providerPluginId": provider.plugin_id,
            "scope": payload.scope,
        }),
        None,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(row)))
}

pub async fn revoke_grant(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(grant_id): Path<Uuid>,
) -> AppResult<StatusCode> {
    require_operator(&auth)?;
    let result = sqlx::query(
        "UPDATE kernel.capability_grants SET state='REVOKED', revoked_at=now() WHERE id=$1 AND state='ACTIVE'",
    )
    .bind(grant_id)
    .execute(&state.db)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found(
            "capability grant not found or already revoked",
        ));
    }
    audit::record(
        &state.db,
        "capability.revoked",
        "USER",
        &auth.user_id.to_string(),
        "capability_grant",
        &grant_id.to_string(),
        "capability.revoke",
        "CONFIRMED",
        serde_json::json!({}),
        None,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn resolve(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path((name, major)): Path<(String, i64)>,
) -> AppResult<Json<CapabilityResolution>> {
    validate_capability_name(&name)?;
    let provider = resolve_provider(&state, &name, major).await?;
    Ok(Json(CapabilityResolution {
        name,
        major,
        provider_plugin_id: provider.plugin_id,
        provider_version: provider.version,
        activation_revision: provider.generation,
        api_digest: opsweave_bundle::sha256_digest(&opsweave_contracts::canonical_json(
            &provider
                .manifest
                .get("provides")
                .cloned()
                .unwrap_or(Value::Null),
        )),
        execution_mode: "sync",
        status: "AVAILABLE",
    }))
}

pub async fn issue_workload_token(
    State(state): State<AppState>,
    Path(node_id): Path<Uuid>,
    headers: HeaderMap,
    Json(payload): Json<WorkloadTokenRequest>,
) -> AppResult<Json<WorkloadTokenResponse>> {
    let node = crate::nodes::authenticate_node(&state, node_id, &headers).await?;
    if payload.audience.trim().is_empty() || payload.scope.is_empty() {
        return Err(AppError::bad_request("audience and scope are required"));
    }
    validate_capability_name(&payload.capability_name)?;
    let expected_audience = format!("plugin:{}", payload.capability_name);
    if payload.audience != expected_audience {
        return Err(AppError::bad_request(
            "audience must be plugin:<capability-name>",
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
    .bind(payload.instance_id)
    .bind(node.id)
    .fetch_optional(&state.db)
    .await?;
    let Some((instance_id, plugin_id)) = instance else {
        return Err(AppError::not_found("instance is not assigned to this node"));
    };
    let plugin_id = match payload.service_plugin_id.as_deref() {
        None => plugin_id,
        Some("opsweave.pipeline.worker") => "opsweave.pipeline.worker".to_string(),
        Some(_) => {
            return Err(AppError::forbidden(
                "only the pipeline worker service principal may be requested",
            ));
        }
    };
    // B2.1a: a workLOAD gets its workspace from the Kernel, never from the
    // request. For the pipeline worker that is the workspace of the job it
    // currently holds a live lease for - the instance is recorded on the lease,
    // the Kernel wrote both rows, and the worker cannot name a different one.
    // Without a live lease there is no workspace, and a token minted with no
    // `workspace:<uuid>` entry reaches no data: the Catalog answers a workload
    // with zero workspaces exactly as it answers one with no scope.
    let mut scope = payload.scope;
    if plugin_id == "opsweave.pipeline.worker" {
        let leased_workspace: Option<Uuid> = sqlx::query_scalar(
            r#"
            SELECT j.workspace_id
            FROM kernel.pipeline_job_leases l
            JOIN kernel.pipeline_jobs j ON j.job_id = l.job_id
            WHERE l.instance_id = $1
              AND l.status = 'ACTIVE'
              AND l.expires_at > now()
              AND j.workspace_id IS NOT NULL
            ORDER BY l.acquired_at DESC
            LIMIT 1
            "#,
        )
        .bind(instance_id)
        .fetch_optional(&state.db)
        .await?;
        if let Some(workspace_id) = leased_workspace {
            scope.push(format!("workspace:{workspace_id}"));
        }
    }
    let expires_at = Utc::now() + ChronoDuration::seconds(state.config.workload_token_seconds);
    let claims = WorkloadClaims {
        v: 1,
        sub: instance_id.to_string(),
        plugin_id,
        instance_id,
        node_id: node.id,
        node_generation: node.generation,
        capability_name: payload.capability_name,
        capability_major: payload.capability_major,
        audience: payload.audience,
        scope,
        issued_at: Utc::now().timestamp(),
        expires_at: expires_at.timestamp(),
        jti: Uuid::new_v4(),
    };
    let token = sign_claims(&state, &claims)?;
    Ok(Json(WorkloadTokenResponse { token, expires_at }))
}

pub async fn refresh_workload_token(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<WorkloadTokenResponse>> {
    let token =
        bearer(&headers).ok_or_else(|| AppError::unauthorized("workload token required"))?;
    // Refresh deliberately accepts an expired token, but only inside a bounded
    // grace window and only after re-checking the current instance/node state.
    let claims = verify_claims_with_key_allow_expired(&state.cursor_secret, &token)?;
    if claims.audience != format!("plugin:{}", claims.capability_name) {
        return Err(AppError::forbidden("workload token audience is invalid"));
    }
    if claims
        .expires_at
        .saturating_add(state.config.workload_token_refresh_grace_seconds)
        < Utc::now().timestamp()
    {
        return Err(AppError::unauthorized(
            "workload token refresh window expired",
        ));
    }
    let live: Option<LiveInstanceRow> = sqlx::query_as(
        r#"
        SELECT i.state, n.generation, n.revoked_at, n.status, n.last_seen_at
        FROM kernel.plugin_instances i
        JOIN kernel.nodes n ON n.id=i.node_id
        WHERE i.id=$1 AND i.node_id=$2 AND i.desired_action='START'
        "#,
    )
    .bind(claims.instance_id)
    .bind(claims.node_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((instance_state, node_generation, revoked_at, node_status, last_seen_at)) = live
    else {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "WORKLOAD_IDENTITY_REVOKED",
            "workload instance is no longer assigned to the node",
        ));
    };
    let stale = last_seen_at.is_none_or(|seen| {
        seen < Utc::now() - ChronoDuration::seconds(state.config.node_stale_seconds)
    });
    if !workload_identity_is_live(
        &instance_state,
        revoked_at.is_some(),
        &node_status,
        stale,
        node_generation,
        claims.node_generation,
    ) {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "WORKLOAD_IDENTITY_REVOKED",
            "workload instance or node is no longer active",
        ));
    }
    let grant: Option<(Value, Option<String>)> = sqlx::query_as(
        "SELECT scope, provider_plugin_id FROM kernel.capability_grants WHERE consumer_plugin_id=$1 AND name=$2 AND major=$3 AND state='ACTIVE' AND (expires_at IS NULL OR expires_at > now())",
    )
    .bind(&claims.plugin_id)
    .bind(&claims.capability_name)
    .bind(claims.capability_major)
    .fetch_optional(&state.db)
    .await?;
    let Some((grant_scope, _)) = grant else {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "CAPABILITY_FORBIDDEN",
            "no active grant",
        ));
    };
    let granted: Vec<String> = serde_json::from_value(grant_scope).unwrap_or_default();
    // `workspace:<uuid>` entries are not capability scopes and are not covered by
    // the grant: they are the Kernel's own statement of which workspace this
    // workload may act in, written at mint time from the job's lease. A refresh
    // keeps them only because it re-derives nothing the worker supplied.
    if !claims
        .scope
        .iter()
        .filter(|scope| !scope.starts_with("workspace:"))
        .all(|scope| granted.contains(scope))
    {
        return Err(AppError::forbidden(
            "CAPABILITY_FORBIDDEN: scope is no longer granted",
        ));
    }
    let expires_at = Utc::now() + ChronoDuration::seconds(state.config.workload_token_seconds);
    let refreshed = WorkloadClaims {
        v: 1,
        sub: claims.sub,
        plugin_id: claims.plugin_id,
        instance_id: claims.instance_id,
        node_id: claims.node_id,
        node_generation: claims.node_generation,
        capability_name: claims.capability_name,
        capability_major: claims.capability_major,
        audience: claims.audience,
        scope: claims.scope,
        issued_at: Utc::now().timestamp(),
        expires_at: expires_at.timestamp(),
        jti: Uuid::new_v4(),
    };
    let token = sign_claims(&state, &refreshed)?;
    Ok(Json(WorkloadTokenResponse { token, expires_at }))
}

/// The secret-bearing part of an instance environment.
///
/// Pure so it can be tested without a database: the isolation rule is that a
/// plugin receives exactly its own secret map and, if one adapter is assigned to
/// it, exactly that adapter's signing key. A plugin with no assignment receives
/// no adapter credential; a plugin with two assignments receives neither, which
/// is a configuration error that fails closed rather than picking one.
pub(crate) fn secret_environment(
    plugin_secrets: &std::collections::HashMap<
        String,
        std::collections::HashMap<String, std::collections::HashMap<String, String>>,
    >,
    adapter_plugins: &std::collections::HashMap<String, String>,
    adapters: &std::collections::HashMap<String, String>,
    credential_bindings: &std::collections::HashMap<
        String,
        std::collections::HashMap<
            String,
            std::collections::HashMap<String, crate::config::CredentialBinding>,
        >,
    >,
    allow_insecure_source_endpoints: bool,
    plugin_id: &str,
) -> std::collections::BTreeMap<String, String> {
    let mut env = std::collections::BTreeMap::new();
    if let Some(secrets) = plugin_secrets.get(plugin_id) {
        if let Ok(encoded) = serde_json::to_string(secrets) {
            env.insert("OPSWEAVE_PLUGIN_SECRETS".into(), encoded);
        }
    }
    if let Some(bindings) = credential_bindings.get(plugin_id) {
        if let Ok(encoded) = serde_json::to_string(bindings) {
            env.insert("OPSWEAVE_PLUGIN_CREDENTIAL_BINDINGS".into(), encoded);
        }
    }
    if allow_insecure_source_endpoints {
        env.insert(
            "OPSWEAVE_ALLOW_INSECURE_SOURCE_ENDPOINTS".into(),
            "1".into(),
        );
    }
    let assigned: Vec<&String> = adapter_plugins
        .iter()
        .filter(|(_, plugin)| plugin.as_str() == plugin_id)
        .map(|(adapter, _)| adapter)
        .collect();
    if assigned.len() == 1 {
        let adapter_id = assigned[0];
        if let Some(secret) = adapters.get(adapter_id) {
            env.insert("OPSWEAVE_EVIDENCE_ADAPTER_ID".into(), adapter_id.clone());
            env.insert("OPSWEAVE_EVIDENCE_ADAPTER_SECRET".into(), secret.clone());
        }
    } else if assigned.len() > 1 {
        tracing::warn!(plugin = %plugin_id, "more than one evidence adapter is assigned to this plugin; none is delivered");
    }
    env
}

pub async fn instance_environment(
    State(state): State<AppState>,
    Path((node_id, instance_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> AppResult<Json<InstanceEnvironmentResponse>> {
    let node = crate::nodes::authenticate_node(&state, node_id, &headers).await?;
    let row: Option<(String, Value, i64)> = sqlx::query_as(
        r#"
        SELECT d.plugin_id, p.manifest, n.generation
        FROM kernel.plugin_instances i
        JOIN kernel.plugin_deployments d ON d.id=i.deployment_id
        JOIN kernel.plugin_packages p ON p.package_id=d.package_id
        JOIN kernel.nodes n ON n.id=i.node_id
        WHERE i.id=$1 AND i.node_id=$2 AND i.desired_action='START'
        "#,
    )
    .bind(instance_id)
    .bind(node.id)
    .fetch_optional(&state.db)
    .await?;
    let Some((plugin_id, manifest_value, node_generation)) = row else {
        return Err(AppError::not_found("instance is not assigned to this node"));
    };
    let mut env = std::collections::BTreeMap::new();
    env.insert(
        "OPSWEAVE_KERNEL_URL".into(),
        state.config.plugin_kernel_url.clone(),
    );
    env.insert(
        "OPSWEAVE_CALLER_CONTEXT_KEY".into(),
        hex::encode(context_key(&state, &plugin_id)),
    );
    if !state.config.plugin_source_allowed_hosts.trim().is_empty() {
        env.insert(
            "OPSWEAVE_ALLOW_PRIVATE_SOURCE_HOSTS".into(),
            state.config.plugin_source_allowed_hosts.clone(),
        );
    }
    if let Some(credential) = sqlx::query_scalar::<_, String>(
        "SELECT credential_ref FROM kernel.plugin_storage_bindings WHERE plugin_id=$1 AND state='READY'",
    )
    .bind(&plugin_id)
    .fetch_optional(&state.db)
    .await?
    {
        env.insert("OPSWEAVE_PLUGIN_DATABASE_URL".into(), credential);
    }
    env.extend(secret_environment(
        &state.config.plugin_secrets,
        &state.config.evidence_adapter_plugins,
        &state.config.evidence_adapters,
        &state.config.plugin_credential_bindings,
        state.config.allow_insecure_source_endpoints,
        &plugin_id,
    ));
    // Public verification key only. The plugin cannot mint `owa2`; the private
    // seed is derived from the Kernel cursor secret and never leaves the Kernel.
    env.insert(
        "OPSWEAVE_AUTOMATION_PUBLIC_KEY".into(),
        crate::automation::public_key_hex(&state),
    );
    if let Ok(manifest) = serde_json::from_value::<ManifestV11>(manifest_value) {
        let mut tokens = serde_json::Map::new();
        for required in &manifest.requires {
            let grant: Option<Value> = sqlx::query_scalar(
                "SELECT scope FROM kernel.capability_grants WHERE consumer_plugin_id=$1 AND name=$2 AND major=$3 AND state='ACTIVE' AND (expires_at IS NULL OR expires_at > now())",
            )
            .bind(&plugin_id)
            .bind(&required.name)
            .bind(required.major)
            .fetch_optional(&state.db)
            .await?;
            let Some(scope_value) = grant else { continue };
            let mut scope: Vec<String> = serde_json::from_value(scope_value).unwrap_or_default();
            // B2.1a: a grant may name `workspace:*`, meaning "every business
            // workspace in this deployment". It exists for the cross-workspace
            // service plugins (an integration runs against whatever source the
            // operator filed, in whatever workspace), which cannot enumerate
            // workspace ids in a static grant and must not choose one per call.
            //
            // Expanded HERE, at mint time, from the database: the token then
            // carries concrete workspace ids, so the provider filters on data
            // rather than trusting a pattern. A deployment adds a workspace and
            // the next mint covers it; no grant edit is needed.
            if scope.iter().any(|entry| entry == "workspace:*") {
                scope.retain(|entry| entry != "workspace:*");
                let all: Vec<Uuid> = sqlx::query_scalar(
                    "SELECT workspace_id FROM kernel.business_workspaces ORDER BY workspace_id",
                )
                .fetch_all(&state.db)
                .await?;
                scope.extend(all.into_iter().map(|id| format!("workspace:{id}")));
            }
            let expires_at =
                Utc::now() + ChronoDuration::seconds(state.config.workload_token_seconds);
            let claims = WorkloadClaims {
                v: 1,
                sub: instance_id.to_string(),
                plugin_id: plugin_id.clone(),
                instance_id,
                node_id: node.id,
                node_generation,
                capability_name: required.name.clone(),
                capability_major: required.major,
                audience: format!("plugin:{}", required.name),
                scope,
                issued_at: Utc::now().timestamp(),
                expires_at: expires_at.timestamp(),
                jti: Uuid::new_v4(),
            };
            tokens.insert(
                required.name.clone(),
                Value::String(sign_claims(&state, &claims)?),
            );
        }
        env.insert(
            "OPSWEAVE_CAPABILITY_TOKENS".into(),
            serde_json::to_string(&tokens).map_err(AppError::from)?,
        );
    }
    Ok(Json(InstanceEnvironmentResponse { env }))
}

pub const CATALOG_SERVICE_PLUGIN: &str = "opsweave.kernel.catalog";

/// Kernel-side, read-only Catalog metadata call. It uses a distinct service
/// principal and the normal Capability provider/grant/scope checks; it never
/// reads plugin tables and never reuses a user or Node credential.
///
/// `workspaces` is the membership set the call acts within (B2.1a). It is
/// delivered as `workspace:<uuid>` grant entries, which the Catalog enforces as a
/// filter. An empty set reaches no dataset at all, which is the correct answer
/// for a caller that belongs to no workspace: the Kernel does not silently widen
/// its own service principal to "everything" because a request had no scope.
pub async fn service_catalog_get(
    state: &AppState,
    path: &str,
    workspaces: &[Uuid],
) -> AppResult<Value> {
    let name = "data.catalog.v1";
    let major = 1i64;
    let provider = resolve_provider(state, name, major).await?;
    let (node_id, node_generation): (Uuid, i64) = sqlx::query_as(
        "SELECT i.node_id, n.generation FROM kernel.plugin_instances i JOIN kernel.nodes n ON n.id=i.node_id WHERE i.id=$1",
    )
    .bind(provider.instance_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::unavailable("CATALOG_UNAVAILABLE", "Catalog provider instance is not live"))?;
    let now = Utc::now();
    let claims = WorkloadClaims {
        v: 1,
        sub: format!("service:{}", Uuid::new_v4()),
        plugin_id: CATALOG_SERVICE_PLUGIN.to_string(),
        instance_id: provider.instance_id,
        node_id,
        node_generation,
        capability_name: name.to_string(),
        capability_major: major,
        audience: format!("plugin:{name}"),
        scope: {
            // The service principal's own capability scope plus the caller's
            // workspace placement. The Catalog filters on the latter, so a
            // service call can never see a dataset the acting user could not.
            let mut scope = vec!["dataset:read".to_string()];
            scope.extend(workspaces.iter().map(|id| format!("workspace:{id}")));
            scope
        },
        issued_at: now.timestamp(),
        expires_at: (now + ChronoDuration::seconds(60)).timestamp(),
        jti: Uuid::new_v4(),
    };
    let token = sign_claims(state, &claims)?;
    let url = format!(
        "{}/api/v1/capabilities/{name}/{major}/{}",
        state.config.public_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    );
    let response = state
        .http
        .get(url)
        .bearer_auth(token)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| {
            AppError::unavailable("CATALOG_UNAVAILABLE", "Catalog metadata request failed")
        })?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|_| {
        AppError::unavailable(
            "CATALOG_INVALID_RESPONSE",
            "Catalog metadata response is not JSON",
        )
    })?;
    if !status.is_success() {
        return Err(AppError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "CATALOG_UNAVAILABLE",
            format!("Catalog metadata query failed with {status}"),
        ));
    }
    let _ = audit::record(
        &state.db,
        "capability.service_invoke",
        "WORKLOAD",
        CATALOG_SERVICE_PLUGIN,
        "capability",
        name,
        "catalog.metadata.read",
        "ACCEPTED",
        json!({"path": path, "provider": provider.plugin_id}),
        None,
    )
    .await;
    Ok(body)
}

pub async fn invoke(
    State(state): State<AppState>,
    Path((name, major, path)): Path<(String, i64, String)>,
    method: Method,
    uri: axum::http::Uri,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    validate_capability_name(&name)?;
    let token =
        bearer(&headers).ok_or_else(|| AppError::unauthorized("workload token required"))?;
    let claims = verify_claims(&state, &token)?;
    if claims.capability_name != name || claims.capability_major != major {
        return Err(AppError::forbidden(
            "workload token is for a different capability",
        ));
    }
    if claims.audience != format!("plugin:{name}") {
        return Err(AppError::forbidden("workload token audience is invalid"));
    }
    let live: Option<LiveInstanceRow> = sqlx::query_as(
        r#"
        SELECT i.state, n.generation, n.revoked_at, n.status, n.last_seen_at
        FROM kernel.plugin_instances i
        JOIN kernel.nodes n ON n.id=i.node_id
        WHERE i.id=$1 AND i.node_id=$2 AND i.desired_action='START'
        "#,
    )
    .bind(claims.instance_id)
    .bind(claims.node_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((instance_state, node_generation, revoked_at, node_status, last_seen_at)) = live
    else {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "WORKLOAD_IDENTITY_REVOKED",
            "workload instance is no longer assigned to the node",
        ));
    };
    let stale = last_seen_at.is_none_or(|seen| {
        seen < Utc::now() - ChronoDuration::seconds(state.config.node_stale_seconds)
    });
    if !workload_identity_is_live(
        &instance_state,
        revoked_at.is_some(),
        &node_status,
        stale,
        node_generation,
        claims.node_generation,
    ) {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "WORKLOAD_IDENTITY_REVOKED",
            "workload instance or node is no longer active",
        ));
    }
    let grant: Option<(String, Value, Option<String>)> = sqlx::query_as(
        "SELECT consumer_plugin_id, scope, provider_plugin_id FROM kernel.capability_grants WHERE consumer_plugin_id=$1 AND name=$2 AND major=$3 AND state='ACTIVE' AND (expires_at IS NULL OR expires_at > now())",
    )
    .bind(&claims.plugin_id)
    .bind(&name)
    .bind(major)
    .fetch_optional(&state.db)
    .await?;
    let Some((_, grant_scope, bound_provider)) = grant else {
        let _ = audit::record(
            &state.db,
            "capability.denied",
            "WORKLOAD",
            &claims.plugin_id,
            "capability",
            &format!("{name}:{major}"),
            "capability.invoke",
            "REJECTED",
            serde_json::json!({"reason": "no active grant"}),
            None,
        )
        .await;
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "CAPABILITY_FORBIDDEN",
            "no active grant",
        ));
    };
    let granted: Vec<String> = serde_json::from_value(grant_scope).unwrap_or_default();
    // `workspace:<uuid>` is a Kernel-written placement claim, not a capability
    // scope, so the grant does not (and must not) enumerate it. It is still
    // carried to the provider, which is the only place that can enforce it.
    if !claims
        .scope
        .iter()
        .filter(|scope| !scope.starts_with("workspace:"))
        .all(|scope| granted.contains(scope))
    {
        return Err(AppError::forbidden(
            "CAPABILITY_FORBIDDEN: scope is not granted",
        ));
    }
    let provider = resolve_provider(&state, &name, major).await?;
    if !provider_matches_grant(bound_provider.as_deref(), &provider.plugin_id) {
        let _ = audit::record(
            &state.db,
            "capability.denied",
            "WORKLOAD",
            &claims.plugin_id,
            "capability",
            &format!("{name}:{major}"),
            "capability.invoke",
            "REJECTED",
            serde_json::json!({
                "reason": "provider mismatch",
                "boundProvider": bound_provider,
                "selectedProvider": provider.plugin_id,
            }),
            None,
        )
        .await;
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "CAPABILITY_PROVIDER_MISMATCH",
            "active grant is bound to a different provider",
        ));
    }
    crate::nodes::validate_node_data_endpoint(&state.config, &provider.data_endpoint)?;
    let manifest: ManifestV11 = serde_json::from_value(provider.manifest)
        .map_err(|error| AppError::internal(format!("provider manifest invalid: {error}")))?;
    let backend = manifest.backend.ok_or_else(|| {
        AppError::unavailable("CAPABILITY_UNAVAILABLE", "provider has no backend")
    })?;
    let requested = format!("/{path}");
    if !safe_path(&requested)
        || !(requested == backend.api_prefix
            || requested.starts_with(&format!("{}/", backend.api_prefix.trim_end_matches('/'))))
    {
        return Err(AppError::bad_request("INVALID_CAPABILITY_PATH"));
    }
    let request_id = Uuid::new_v4().to_string();
    let query = uri
        .query()
        .map(|value| format!("?{value}"))
        .unwrap_or_default();
    let target = format!(
        "{}/internal/v1/proxy/{}{}{}",
        provider.data_endpoint.trim_end_matches('/'),
        provider.instance_id,
        requested,
        query
    );
    let provider_claims = narrow_to_named_workspace(
        claims.clone(),
        headers
            .get("x-opsweave-workspace-id")
            .and_then(|value| value.to_str().ok()),
    )?;
    let mut request = state
        .http
        .request(method, target)
        .bearer_auth(&provider.data_token)
        .header("x-opsweave-request-id", &request_id)
        .header("x-opsweave-capability", format!("{name}:{major}"))
        .header("x-opsweave-workload-id", &claims.sub)
        .header("x-opsweave-workload-plugin-id", &claims.plugin_id)
        .header(
            "x-opsweave-caller-context",
            caller_context_token(&state, &provider.plugin_id, &provider_claims)?,
        )
        .timeout(Duration::from_secs(30));
    for (key, value) in headers.iter() {
        let key = key.as_str().to_ascii_lowercase();
        if matches!(
            key.as_str(),
            "host"
                | "authorization"
                | "cookie"
                | "content-length"
                | "connection"
                | "transfer-encoding"
        ) || key.starts_with("x-opsweave-")
        {
            continue;
        }
        request = request.header(key, value);
    }
    if !body.is_empty() {
        request = request.body(body);
    }
    let upstream = request.send().await.map_err(|_| {
        AppError::unavailable("CAPABILITY_TIMEOUT", "provider request failed or timed out")
    })?;
    let status = upstream.status();
    if upstream
        .content_length()
        .is_some_and(|length| length > MAX_CAPABILITY_RESPONSE_BYTES as u64)
    {
        return Err(AppError::bad_gateway(
            "CAPABILITY_RESPONSE_TOO_LARGE",
            "capability response exceeded limit",
        ));
    }
    let content_type = upstream.headers().get(header::CONTENT_TYPE).cloned();
    let bytes = upstream.bytes().await.map_err(|_| {
        AppError::bad_gateway(
            "CAPABILITY_RESPONSE_BODY_ERROR",
            "could not read capability response",
        )
    })?;
    if bytes.len() > MAX_CAPABILITY_RESPONSE_BYTES {
        return Err(AppError::bad_gateway(
            "CAPABILITY_RESPONSE_TOO_LARGE",
            "capability response exceeded limit",
        ));
    }
    let mut response = (status, bytes).into_response();
    if let Some(value) = content_type {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    Ok(response)
}

fn workload_identity_is_live(
    instance_state: &str,
    revoked: bool,
    node_status: &str,
    stale: bool,
    current_generation: i64,
    claimed_generation: i64,
) -> bool {
    instance_state == "READY"
        && !revoked
        && node_status == "READY"
        && !stale
        && current_generation == claimed_generation
}

fn provider_matches_grant(bound: Option<&str>, selected: &str) -> bool {
    bound.is_none_or(|bound| bound == selected)
}

async fn resolve_provider(state: &AppState, name: &str, major: i64) -> AppResult<ProviderRow> {
    let row = sqlx::query_as::<_, ProviderRow>(
        r#"
        SELECT i.id AS instance_id, r.plugin_id, r.version, r.generation,
               p.manifest, n.data_endpoint, n.data_token
        FROM kernel.capability_registrations c
        JOIN kernel.activation_revisions r ON r.id=c.revision_id AND r.status='ACTIVE'
        JOIN kernel.plugin_deployments d ON d.id=r.deployment_id
        JOIN kernel.plugin_packages p ON p.package_id=r.package_id
        JOIN kernel.trusted_publishers tp ON tp.publisher_id=p.publisher AND tp.trust_state='TRUSTED'
        JOIN kernel.plugin_instances i ON i.deployment_id=d.id
        JOIN kernel.nodes n ON n.id=i.node_id
        WHERE c.direction='PROVIDES' AND c.name=$1 AND c.major=$2
          AND i.state='READY' AND i.desired_action='START'
          AND n.revoked_at IS NULL AND n.status='READY'
          AND n.data_endpoint IS NOT NULL
          AND n.last_seen_at > now() - ($3 || ' seconds')::interval
        ORDER BY r.plugin_id, r.generation DESC, i.slot, i.id
        LIMIT 1
        "#,
    )
    .bind(name)
    .bind(major)
    .bind(state.config.node_stale_seconds)
    .fetch_optional(&state.db)
    .await?;
    row.ok_or_else(|| {
        AppError::unavailable("CAPABILITY_UNAVAILABLE", "no compatible READY provider")
    })
}

fn require_operator(auth: &AuthUser) -> AppResult<()> {
    if auth.role == Role::Admin || auth.role == Role::Operator {
        Ok(())
    } else {
        Err(AppError::forbidden("operator role required"))
    }
}

fn validate_capability_name(name: &str) -> AppResult<()> {
    if name.len() < 3
        || name.len() > 100
        || !name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.')
        || !name.starts_with(|c: char| c.is_ascii_lowercase())
    {
        return Err(AppError::bad_request("invalid capability name"));
    }
    Ok(())
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn context_key(state: &AppState, plugin_id: &str) -> Vec<u8> {
    let mut mac =
        HmacSha256::new_from_slice(&state.cursor_secret).expect("HMAC accepts any key length");
    mac.update(b"caller-context:");
    mac.update(plugin_id.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn sign_payload_with_key<T: Serialize>(key: &[u8], prefix: &str, claims: &T) -> AppResult<String> {
    let payload = serde_json::to_vec(claims).map_err(AppError::from)?;
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload);
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| AppError::internal("context signing key is invalid"))?;
    mac.update(encoded.as_bytes());
    let signature =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Ok(format!("{prefix}.{encoded}.{signature}"))
}

fn sign_claims_with_key(key: &[u8], claims: &WorkloadClaims) -> AppResult<String> {
    sign_payload_with_key(key, TOKEN_PREFIX, claims)
}

const USER_TOKEN_PREFIX: &str = "owu1";
const USER_CONTEXT_TTL_SECONDS: i64 = 120;

/// What the Gateway tells a plugin about a user request.
///
/// It carries the Kernel's authoritative answer to "which business workspaces
/// may this caller enter" at the instant of the call, instead of leaving the
/// plugin to trust a workspace id from the request body. The token is bound to
/// one plugin by the key it is signed with, so a plugin cannot replay it at a
/// sibling.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UserContextClaims<'a> {
    v: u8,
    user_id: Uuid,
    role: &'a str,
    plugin_id: &'a str,
    workspace_ids: Vec<Uuid>,
    issued_at: i64,
    expires_at: i64,
    request_id: &'a str,
}

pub(crate) fn user_context_token(
    state: &AppState,
    plugin_id: &str,
    user_id: Uuid,
    role: &str,
    workspace_ids: Vec<Uuid>,
    request_id: &str,
) -> AppResult<String> {
    let issued_at = Utc::now().timestamp();
    let claims = UserContextClaims {
        v: 1,
        user_id,
        role,
        plugin_id,
        workspace_ids,
        issued_at,
        expires_at: issued_at + USER_CONTEXT_TTL_SECONDS,
        request_id,
    };
    sign_payload_with_key(&context_key(state, plugin_id), USER_TOKEN_PREFIX, &claims)
}

fn sign_claims(state: &AppState, claims: &WorkloadClaims) -> AppResult<String> {
    sign_claims_with_key(&state.cursor_secret, claims)
}

fn caller_context_token(
    state: &AppState,
    provider_plugin_id: &str,
    claims: &WorkloadClaims,
) -> AppResult<String> {
    sign_claims_with_key(&context_key(state, provider_plugin_id), claims)
}

fn verify_claims(state: &AppState, token: &str) -> AppResult<WorkloadClaims> {
    verify_claims_with_key(&state.cursor_secret, token)
}

fn parse_claims_with_key(key: &[u8], token: &str) -> AppResult<WorkloadClaims> {
    let mut parts = token.split('.');
    let prefix = parts.next();
    let encoded = parts.next();
    let signature = parts.next();
    if prefix != Some(TOKEN_PREFIX)
        || encoded.is_none()
        || signature.is_none()
        || parts.next().is_some()
    {
        return Err(AppError::unauthorized("malformed workload token"));
    }
    let encoded = encoded.unwrap_or_default();
    let signature = signature.unwrap_or_default();
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| AppError::internal("workload signing key is invalid"))?;
    mac.update(encoded.as_bytes());
    let expected =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    if expected != signature {
        return Err(AppError::unauthorized("invalid workload token signature"));
    }
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| AppError::unauthorized("invalid workload token payload"))?;
    serde_json::from_slice(&payload)
        .map_err(|_| AppError::unauthorized("invalid workload token claims"))
}

/// Narrow a workload's placement to the one workspace a call names.
///
/// The permission matrix forbids a workload SELF-REPORTING a workspace, and this
/// keeps that: the named value is only ever a narrowing of the scope the grant
/// already gave this consumer, and a name outside that scope is refused. What it
/// fixes is the ambiguity on the provider side - a serving plugin granted several
/// workspaces could not tell which one an ingestion meant, and the Catalog
/// correctly refused to guess.
fn narrow_to_named_workspace(
    mut claims: WorkloadClaims,
    named: Option<&str>,
) -> AppResult<WorkloadClaims> {
    let Some(named) = named.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(claims);
    };
    let workspace = Uuid::parse_str(named).map_err(|_| {
        AppError::new(
            StatusCode::BAD_REQUEST,
            "WORKSPACE_INVALID",
            "x-opsweave-workspace-id must be a UUID",
        )
    })?;
    let holder = format!("workspace:{workspace}");
    if !claims.scope.iter().any(|scope| scope == &holder) {
        // A stable code, not a sentence: the console localises by code (rules/06).
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "WORKSPACE_FORBIDDEN",
            "this workload was not granted that workspace",
        ));
    }
    claims
        .scope
        .retain(|scope| !scope.starts_with("workspace:"));
    claims.scope.push(holder);
    Ok(claims)
}

fn verify_claims_with_key(key: &[u8], token: &str) -> AppResult<WorkloadClaims> {
    let claims = parse_claims_with_key(key, token)?;
    if claims.v != 1 || claims.expires_at <= Utc::now().timestamp() {
        return Err(AppError::unauthorized("workload token expired"));
    }
    Ok(claims)
}

fn verify_claims_with_key_allow_expired(key: &[u8], token: &str) -> AppResult<WorkloadClaims> {
    let claims = parse_claims_with_key(key, token)?;
    if claims.v != 1 {
        return Err(AppError::unauthorized("invalid workload token version"));
    }
    Ok(claims)
}

fn safe_path(path: &str) -> bool {
    if path.contains('\0') || path.contains('\\') {
        return false;
    }
    for segment in path.split('/') {
        let decoded = urlencoding::decode(segment)
            .map(|value| value.into_owned())
            .unwrap_or_else(|_| segment.to_string());
        if decoded == "." || decoded == ".." || decoded.contains('/') || decoded.contains('\\') {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::{narrow_to_named_workspace, safe_path, validate_capability_name, WorkloadClaims};
    use uuid::Uuid;

    #[test]
    fn capability_names_are_bounded() {
        assert!(validate_capability_name("data.catalog.v1").is_ok());
        assert!(validate_capability_name("Data.Catalog").is_err());
        assert!(validate_capability_name("../data").is_err());
    }

    #[test]
    fn capability_paths_reject_traversal() {
        assert!(safe_path("/api/data-catalog/datasets"));
        assert!(!safe_path("/api/../kernel"));
        assert!(!safe_path("/api/%2e%2e/kernel"));
        assert!(!safe_path("/api\\kernel"));
    }

    #[test]
    fn workload_identity_requires_live_instance_and_generation() {
        assert!(super::workload_identity_is_live(
            "READY", false, "READY", false, 3, 3
        ));
        assert!(!super::workload_identity_is_live(
            "STOPPED", false, "READY", false, 3, 3
        ));
        assert!(!super::workload_identity_is_live(
            "READY", true, "READY", false, 3, 3
        ));
        assert!(!super::workload_identity_is_live(
            "READY", false, "READY", false, 4, 3
        ));
        assert!(!super::workload_identity_is_live(
            "READY", false, "READY", true, 3, 3
        ));
    }

    #[test]
    fn provider_binding_is_enforced() {
        assert!(super::provider_matches_grant(None, "provider-a"));
        assert!(super::provider_matches_grant(
            Some("provider-a"),
            "provider-a"
        ));
        assert!(!super::provider_matches_grant(
            Some("provider-a"),
            "provider-b"
        ));
    }

    #[test]
    fn workload_token_round_trip_and_signature_rejection() {
        let key = b"test-workload-key";
        let claims = super::WorkloadClaims {
            v: 1,
            sub: uuid::Uuid::new_v4().to_string(),
            plugin_id: "opsweave.data-integration".into(),
            instance_id: uuid::Uuid::new_v4(),
            node_id: uuid::Uuid::new_v4(),
            node_generation: 1,
            capability_name: "data.catalog.v1".into(),
            capability_major: 1,
            audience: "plugin:data.catalog.v1".into(),
            scope: vec!["dataset:write".into()],
            issued_at: chrono::Utc::now().timestamp(),
            expires_at: (chrono::Utc::now() + chrono::Duration::hours(1)).timestamp(),
            jti: uuid::Uuid::new_v4(),
        };
        let token = super::sign_claims_with_key(key, &claims).unwrap();
        let parsed = super::verify_claims_with_key(key, &token).unwrap();
        assert_eq!(parsed.plugin_id, claims.plugin_id);
        let mut tampered = token.into_bytes();
        let last = tampered.len() - 1;
        tampered[last] = if tampered[last] == b'a' { b'b' } else { b'a' };
        assert!(
            super::verify_claims_with_key(key, std::str::from_utf8(&tampered).unwrap()).is_err()
        );
    }

    #[test]
    fn a_plugin_receives_only_its_own_secrets_and_adapter() {
        use std::collections::HashMap;
        let mut plugin_secrets = HashMap::new();
        plugin_secrets.insert(
            "a.plugin".to_string(),
            HashMap::from([(
                "00000000-0000-4000-8000-00000000000a".to_string(),
                HashMap::from([("secretref:a".to_string(), "value-a".to_string())]),
            )]),
        );
        plugin_secrets.insert(
            "b.plugin".to_string(),
            HashMap::from([(
                "00000000-0000-4000-8000-00000000000b".to_string(),
                HashMap::from([("secretref:b".to_string(), "value-b".to_string())]),
            )]),
        );
        let adapter_plugins = HashMap::from([("zabbix-main".to_string(), "a.plugin".to_string())]);
        let adapters = HashMap::from([
            ("zabbix-main".to_string(), "adapter-secret-a".to_string()),
            ("other".to_string(), "adapter-secret-b".to_string()),
        ]);

        let a = super::secret_environment(
            &plugin_secrets,
            &adapter_plugins,
            &adapters,
            &std::collections::HashMap::new(),
            false,
            "a.plugin",
        );
        assert!(a["OPSWEAVE_PLUGIN_SECRETS"].contains("value-a"));
        assert!(!a["OPSWEAVE_PLUGIN_SECRETS"].contains("value-b"));
        assert_eq!(a["OPSWEAVE_EVIDENCE_ADAPTER_ID"], "zabbix-main");
        assert_eq!(a["OPSWEAVE_EVIDENCE_ADAPTER_SECRET"], "adapter-secret-a");
        assert!(!a.values().any(|value| value.contains("adapter-secret-b")));

        let b = super::secret_environment(
            &plugin_secrets,
            &adapter_plugins,
            &adapters,
            &std::collections::HashMap::new(),
            false,
            "b.plugin",
        );
        assert!(b["OPSWEAVE_PLUGIN_SECRETS"].contains("value-b"));
        assert!(!b["OPSWEAVE_PLUGIN_SECRETS"].contains("value-a"));
        assert!(!b.contains_key("OPSWEAVE_EVIDENCE_ADAPTER_ID"));
        assert!(!b.contains_key("OPSWEAVE_EVIDENCE_ADAPTER_SECRET"));

        // Two assignments are a configuration error: deliver neither rather than
        // silently choosing one.
        let doubled = HashMap::from([
            ("zabbix-main".to_string(), "a.plugin".to_string()),
            ("other".to_string(), "a.plugin".to_string()),
        ]);
        let a2 = super::secret_environment(
            &plugin_secrets,
            &doubled,
            &adapters,
            &std::collections::HashMap::new(),
            false,
            "a.plugin",
        );
        assert!(!a2.contains_key("OPSWEAVE_EVIDENCE_ADAPTER_ID"));
        assert!(!a2.contains_key("OPSWEAVE_EVIDENCE_ADAPTER_SECRET"));
    }

    #[test]
    fn credential_bindings_are_metadata_for_exactly_one_plugin() {
        use std::collections::HashMap;
        let bindings = HashMap::from([
            (
                "a.plugin".to_string(),
                HashMap::from([(
                    "00000000-0000-4000-8000-00000000000a".to_string(),
                    HashMap::from([(
                        "secretref:a".to_string(),
                        crate::config::CredentialBinding {
                            endpoint: "https://zabbix.example/api_jsonrpc.php".to_string(),
                            tls: "VERIFY".to_string(),
                        },
                    )]),
                )]),
            ),
            (
                "b.plugin".to_string(),
                HashMap::from([(
                    "00000000-0000-4000-8000-00000000000b".to_string(),
                    HashMap::from([(
                        "secretref:b".to_string(),
                        crate::config::CredentialBinding {
                            endpoint: "https://b.example/api_jsonrpc.php".to_string(),
                            tls: "VERIFY".to_string(),
                        },
                    )]),
                )]),
            ),
        ]);
        let a = super::secret_environment(
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &bindings,
            true,
            "a.plugin",
        );
        let encoded = &a["OPSWEAVE_PLUGIN_CREDENTIAL_BINDINGS"];
        assert!(encoded.contains("https://zabbix.example/api_jsonrpc.php"));
        assert!(!encoded.contains("secretref:b"));
        assert!(
            !encoded.contains("b.example"),
            "another plugin's binding must not be injected"
        );
        assert_eq!(a["OPSWEAVE_ALLOW_INSECURE_SOURCE_ENDPOINTS"], "1");

        let b = super::secret_environment(
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &bindings,
            false,
            "b.plugin",
        );
        let b_encoded = &b["OPSWEAVE_PLUGIN_CREDENTIAL_BINDINGS"];
        assert!(b_encoded.contains("b.example"));
        assert!(!b_encoded.contains("a.example"));
        assert!(!b_encoded.contains("secretref:a"));
        assert!(!b.contains_key("OPSWEAVE_ALLOW_INSECURE_SOURCE_ENDPOINTS"));
    }

    fn workload_claims(scope: Vec<String>) -> WorkloadClaims {
        WorkloadClaims {
            v: 1,
            sub: "instance".into(),
            plugin_id: "opsweave.data-integration".into(),
            instance_id: Uuid::nil(),
            node_id: Uuid::nil(),
            node_generation: 1,
            capability_name: "data.catalog.v1".into(),
            capability_major: 1,
            audience: "plugin:data.catalog.v1".into(),
            scope,
            issued_at: 0,
            expires_at: i64::MAX,
            jti: Uuid::nil(),
        }
    }

    /// B2.1a: a capability call may narrow to one granted workspace, and may not
    /// name one it was not granted. This is the rule that lets an ingestion file
    /// records into the spec's workspace without letting it choose freely.
    #[test]
    fn a_capability_call_narrows_to_a_granted_workspace_and_refuses_an_ungranted_one() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let claims = workload_claims(vec![
            "dataset:read".into(),
            "dataset:write".into(),
            format!("workspace:{a}"),
            format!("workspace:{b}"),
        ]);

        // Named a granted workspace: the scope keeps the capability scopes and
        // exactly that one placement.
        let narrowed = narrow_to_named_workspace(claims.clone(), Some(&a.to_string()))
            .expect("naming a granted workspace is allowed");
        assert!(narrowed.scope.contains(&"dataset:write".to_string()));
        assert!(narrowed.scope.contains(&format!("workspace:{a}")));
        assert!(
            !narrowed.scope.contains(&format!("workspace:{b}")),
            "narrowing must drop the other placements, not add to them"
        );

        // Named a workspace that was not granted: refused.
        let other = Uuid::new_v4();
        let denied = narrow_to_named_workspace(claims.clone(), Some(&other.to_string()));
        assert!(denied.is_err());
        assert_eq!(denied.unwrap_err().code, "WORKSPACE_FORBIDDEN");

        // Not named: the whole scope is kept (a serving plugin acting across the
        // workspaces it was granted).
        let whole = narrow_to_named_workspace(claims.clone(), None).expect("no name is allowed");
        assert_eq!(whole.scope, claims.scope);

        // Malformed: refused rather than silently ignored.
        assert_eq!(
            narrow_to_named_workspace(claims, Some("not-a-uuid"))
                .unwrap_err()
                .code,
            "WORKSPACE_INVALID"
        );
    }

    #[test]
    fn a_user_context_is_bound_to_one_plugin_key() {
        use base64::Engine;
        use hmac::{Hmac, Mac};
        use sha2::Sha256;
        let key = [7u8; 32];
        let claims = super::UserContextClaims {
            v: 1,
            user_id: uuid::Uuid::nil(),
            role: "operator",
            plugin_id: "opsweave.zabbix-source",
            workspace_ids: vec![uuid::Uuid::nil()],
            issued_at: 1,
            expires_at: 2,
            request_id: "request-1",
        };
        let token = super::sign_payload_with_key(&key, super::USER_TOKEN_PREFIX, &claims).unwrap();
        let mut parts = token.split('.');
        assert_eq!(parts.next(), Some("owu1"));
        let encoded = parts.next().expect("payload");
        let signature = parts.next().expect("signature");
        assert!(parts.next().is_none());

        let mut mac = Hmac::<Sha256>::new_from_slice(&key).unwrap();
        mac.update(encoded.as_bytes());
        let expected =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        assert_eq!(
            signature, expected,
            "the signature covers the encoded claims"
        );

        let mut other = Hmac::<Sha256>::new_from_slice(&[8u8; 32]).unwrap();
        other.update(encoded.as_bytes());
        let wrong =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(other.finalize().into_bytes());
        assert_ne!(
            signature, wrong,
            "another plugin's key cannot produce this token"
        );
    }
}
