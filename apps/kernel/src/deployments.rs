use crate::audit;
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::nodes::NodeRow;
use crate::receipts::{self, ReceiptStart};
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use chrono::{DateTime, Utc};
use opsweave_contracts::{ManifestV11, ResourceRequirements};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;
use std::collections::{BTreeMap, HashMap, HashSet};
use tokio::time::{interval, Duration as TokioDuration};
use uuid::Uuid;

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct DeploymentRow {
    pub id: Uuid,
    pub plugin_id: String,
    pub package_id: Uuid,
    pub version: String,
    pub desired_replicas: i32,
    pub generation: i64,
    pub placement: Value,
    pub resources: Value,
    pub status: String,
    pub status_reason: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub activated_at: Option<DateTime<Utc>>,
    pub drain_until: Option<DateTime<Utc>>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct InstanceRow {
    pub id: Uuid,
    pub deployment_id: Uuid,
    pub node_id: Uuid,
    pub slot: i32,
    pub deployment_generation: i64,
    pub desired_action: String,
    pub state: String,
    pub observed_at: Option<DateTime<Utc>>,
    pub container_id: Option<String>,
    pub image_digest: Option<String>,
    pub host_port: Option<i32>,
    pub restart_count: i32,
    pub last_error: Option<String>,
    pub runtime_adapter_version: Option<String>,
    pub node_name: Option<String>,
    pub node_status: Option<String>,
    pub node_last_seen_at: Option<DateTime<Utc>>,
    pub node_data_endpoint: Option<String>,
    pub node_data_token: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct ActivationRow {
    pub id: Uuid,
    pub plugin_id: String,
    pub package_id: Uuid,
    pub version: String,
    pub deployment_id: Uuid,
    pub generation: i64,
    pub status: String,
    pub policy_digest: String,
    pub created_at: DateTime<Utc>,
    pub activated_at: Option<DateTime<Utc>>,
    pub superseded_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceView {
    pub id: Uuid,
    pub deployment_id: Uuid,
    pub node_id: Uuid,
    pub node_name: Option<String>,
    pub slot: i32,
    pub generation: i64,
    pub desired_action: String,
    pub state: String,
    pub observed_at: Option<DateTime<Utc>>,
    pub container_id: Option<String>,
    pub image_digest: Option<String>,
    pub host_port: Option<i32>,
    pub restart_count: i32,
    pub last_error: Option<String>,
    pub runtime_adapter_version: Option<String>,
    pub node_status: Option<String>,
    pub node_last_seen_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentView {
    pub id: Uuid,
    pub plugin_id: String,
    pub version: String,
    pub desired_replicas: i32,
    pub generation: i64,
    pub status: String,
    pub status_reason: Option<String>,
    pub placement: Value,
    pub resources: Value,
    pub ready_instances: i64,
    pub total_instances: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub activated_at: Option<DateTime<Utc>>,
    pub drain_until: Option<DateTime<Utc>>,
    pub instances: Vec<InstanceView>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationView {
    pub id: Uuid,
    pub plugin_id: String,
    pub version: String,
    pub deployment_id: Uuid,
    pub generation: i64,
    pub status: String,
    pub activated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDeploymentRequest {
    pub version: String,
    pub desired_replicas: i32,
    #[serde(default)]
    pub node_selector: BTreeMap<String, String>,
    pub max_instances_per_node: Option<i32>,
    pub cpu_millis: Option<i64>,
    #[serde(rename = "memoryMiB")]
    pub memory_mib: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivateRequest {
    pub version: String,
    pub expected_revision: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackRequest {
    pub target_version: String,
    pub expected_revision: i64,
    pub desired_replicas: Option<i32>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisableRequest {
    pub reason: Option<String>,
}

pub async fn list_deployments(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path(plugin_id): Path<String>,
) -> AppResult<Json<Vec<DeploymentView>>> {
    let rows = sqlx::query_as::<_, DeploymentRow>(
        "SELECT * FROM kernel.plugin_deployments WHERE plugin_id = $1 ORDER BY created_at DESC",
    )
    .bind(&plugin_id)
    .fetch_all(&state.db)
    .await?;
    let mut views = Vec::new();
    for row in rows {
        views.push(deployment_view(&state, row).await?);
    }
    Ok(Json(views))
}

pub async fn get_deployment(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path(deployment_id): Path<Uuid>,
) -> AppResult<Json<DeploymentView>> {
    let row = fetch_deployment(&state, deployment_id).await?;
    Ok(Json(deployment_view(&state, row).await?))
}

pub async fn create_deployment(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(plugin_id): Path<String>,
    headers: HeaderMap,
    Json(payload): Json<CreateDeploymentRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    auth.require_operator()?;
    let key = receipts::idempotency_key(&headers)?;
    let digest = receipts::digest_json(&serde_json::json!({
        "pluginId": plugin_id, "body": payload
    }));
    let receipt_id = match receipts::start(&state, &key, "plugin.deploy", &digest).await? {
        ReceiptStart::Replay(code, body) => return Ok((code, body)),
        ReceiptStart::New(id) => id,
    };
    let result = create_deployment_inner(&state, &auth, &plugin_id, &payload).await;
    match result {
        Ok((status, body)) => {
            receipts::finish(
                &state,
                receipt_id,
                if status == StatusCode::ACCEPTED {
                    "ACCEPTED"
                } else {
                    "CONFIRMED"
                },
                status,
                body.clone(),
            )
            .await?;
            Ok((status, Json(body)))
        }
        Err(error) => {
            receipts::finish(
                &state,
                receipt_id,
                "REJECTED",
                error.status,
                serde_json::json!({"code": error.code, "message": error.message}),
            )
            .await?;
            Err(error)
        }
    }
}

async fn create_deployment_inner(
    state: &AppState,
    auth: &AuthUser,
    plugin_id: &str,
    payload: &CreateDeploymentRequest,
) -> AppResult<(StatusCode, Value)> {
    if payload.desired_replicas < 0 || payload.desired_replicas > 20 {
        return Err(AppError::bad_request("desiredReplicas must be 0..=20"));
    }
    let package = crate::packages::get_package(state, plugin_id, &payload.version).await?;
    crate::packages::ensure_publisher_trusted(state, &package.publisher).await?;
    let manifest: ManifestV11 = serde_json::from_value(package.manifest.clone())
        .map_err(|error| AppError::internal(format!("stored manifest invalid: {error}")))?;
    if manifest.backend.is_none() {
        return Err(AppError::bad_request(
            "backend-less plugins cannot be deployed to a node",
        ));
    }
    if plugin_id.starts_with("opsweave.data-") {
        crate::storage::provision_binding(state, plugin_id).await?;
    }
    let resources = opsweave_contracts::ResourceRequirements {
        cpu_millis: payload.cpu_millis.unwrap_or(manifest.resources.cpu_millis),
        memory_mib: payload.memory_mib.unwrap_or(manifest.resources.memory_mib),
    };
    if resources.cpu_millis < 100
        || resources.memory_mib < 64
        || resources.cpu_millis > 16_000
        || resources.memory_mib > 65_536
    {
        return Err(AppError::bad_request("resource limits out of range"));
    }
    let max_per_node = payload.max_instances_per_node.unwrap_or(1).clamp(1, 20);
    let placement = serde_json::json!({
        "nodeSelector": payload.node_selector,
        "maxInstancesPerNode": max_per_node
    });
    let resources_json = serde_json::to_value(&resources).map_err(AppError::from)?;

    if let Some(existing) = sqlx::query_as::<_, DeploymentRow>(
        "SELECT * FROM kernel.plugin_deployments WHERE plugin_id=$1 AND version=$2",
    )
    .bind(plugin_id)
    .bind(&payload.version)
    .fetch_optional(&state.db)
    .await?
    {
        if existing.status == "ACTIVE" {
            return Err(AppError::conflict(
                "VERSION_ALREADY_ACTIVE",
                format!(
                    "{plugin_id}@{} is already the active version",
                    payload.version
                ),
            ));
        }
        if matches!(existing.status.as_str(), "READY" | "PREPARING" | "PENDING") {
            let body = serde_json::to_value(deployment_view(state, existing).await?)
                .map_err(AppError::from)?;
            return Ok((StatusCode::ACCEPTED, body));
        }
        if existing.status == "DISABLED"
            || existing.status == "DEGRADED"
            || existing.status == "FAILED"
            || existing.status == "DRAINING"
        {
            sqlx::query(
                "UPDATE kernel.plugin_deployments SET status='PENDING', status_reason='Redeploy requested', desired_replicas=$2, resources=$3, placement=$4, generation=generation+1, updated_at=now(), drain_until=NULL WHERE id=$1",
            )
            .bind(existing.id)
            .bind(payload.desired_replicas)
            .bind(&resources_json)
            .bind(&placement)
            .execute(&state.db)
            .await?;
            sqlx::query(
                "UPDATE kernel.plugin_instances SET deployment_generation=$2, desired_action='START', state='STARTING', observed_at=NULL, updated_at=now() WHERE deployment_id=$1",
            )
            .bind(existing.id)
            .bind(existing.generation + 1)
            .execute(&state.db)
            .await?;
            let row = fetch_deployment(state, existing.id).await?;
            audit::record(
                &state.db,
                "deployment.redeploy_requested",
                "USER",
                &auth.user_id.to_string(),
                "deployment",
                &row.id.to_string(),
                "deployment.create",
                "ACCEPTED",
                serde_json::json!({"pluginId": plugin_id, "version": payload.version}),
                None,
            )
            .await?;
            let body =
                serde_json::to_value(deployment_view(state, row).await?).map_err(AppError::from)?;
            return Ok((StatusCode::ACCEPTED, body));
        }
    }
    let id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO kernel.plugin_deployments
          (id, plugin_id, package_id, version, desired_replicas, generation, placement, resources, status, status_reason)
        VALUES ($1,$2,$3,$4,$5,1,$6,$7,'PENDING','Waiting for placement')
        "#,
    )
    .bind(id)
    .bind(plugin_id)
    .bind(package.package_id)
    .bind(&payload.version)
    .bind(payload.desired_replicas)
    .bind(&placement)
    .bind(&resources_json)
    .execute(&state.db)
    .await?;
    audit::record(
        &state.db,
        "deployment.created",
        "USER",
        &auth.user_id.to_string(),
        "deployment",
        &id.to_string(),
        "deployment.create",
        "ACCEPTED",
        serde_json::json!({
            "pluginId": plugin_id,
            "version": payload.version,
            "desiredReplicas": payload.desired_replicas,
            "imageRef": manifest.backend.as_ref().map(|backend| &backend.image_ref),
        }),
        None,
    )
    .await?;
    let row = fetch_deployment(state, id).await?;
    let body = serde_json::to_value(deployment_view(state, row).await?).map_err(AppError::from)?;
    Ok((StatusCode::ACCEPTED, body))
}

pub async fn activate(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(plugin_id): Path<String>,
    headers: HeaderMap,
    Json(payload): Json<ActivateRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    auth.require_operator()?;
    let key = receipts::idempotency_key(&headers)?;
    let digest = receipts::digest_json(&serde_json::json!({
        "pluginId": plugin_id, "body": payload
    }));
    let receipt_id = match receipts::start(&state, &key, "plugin.activate", &digest).await? {
        ReceiptStart::Replay(code, body) => return Ok((code, body)),
        ReceiptStart::New(id) => id,
    };
    let result = activate_inner(&state, &auth, &plugin_id, &payload).await;
    match result {
        Ok((status, body)) => {
            receipts::finish(&state, receipt_id, "CONFIRMED", status, body.clone()).await?;
            Ok((status, Json(body)))
        }
        Err(error) => {
            receipts::finish(
                &state,
                receipt_id,
                "REJECTED",
                error.status,
                serde_json::json!({"code": error.code, "message": error.message}),
            )
            .await?;
            Err(error)
        }
    }
}

async fn activate_inner(
    state: &AppState,
    auth: &AuthUser,
    plugin_id: &str,
    payload: &ActivateRequest,
) -> AppResult<(StatusCode, Value)> {
    let deployment = sqlx::query_as::<_, DeploymentRow>(
        "SELECT * FROM kernel.plugin_deployments WHERE plugin_id=$1 AND version=$2",
    )
    .bind(plugin_id)
    .bind(&payload.version)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found("deployment not found; deploy the version first"))?;
    let package = crate::packages::get_package(state, plugin_id, &payload.version).await?;
    crate::packages::ensure_publisher_trusted(state, &package.publisher).await?;

    let active: Option<ActivationRow> = sqlx::query_as::<_, ActivationRow>(
        "SELECT * FROM kernel.activation_revisions WHERE plugin_id=$1 AND status='ACTIVE'",
    )
    .bind(plugin_id)
    .fetch_optional(&state.db)
    .await?;
    let current_revision = active.as_ref().map(|row| row.generation).unwrap_or(0);
    let next_revision: i64 = sqlx::query_scalar(
        "SELECT COALESCE(max(generation), 0) + 1 FROM kernel.activation_revisions WHERE plugin_id=$1",
    )
    .bind(plugin_id)
    .fetch_one(&state.db)
    .await?;
    if payload.expected_revision != current_revision {
        return Err(AppError::conflict(
            "REVISION_CONFLICT",
            format!(
                "expectedRevision {} does not match current active revision {}",
                payload.expected_revision, current_revision
            ),
        ));
    }
    if let Some(active) = &active {
        if active.version == payload.version && active.deployment_id == deployment.id {
            sqlx::query(
                "UPDATE kernel.plugin_deployments SET status='ACTIVE', status_reason=NULL, updated_at=now() WHERE id=$1",
            )
            .bind(deployment.id)
            .execute(&state.db)
            .await?;
            let body = serde_json::to_value(activation_view(active)).map_err(AppError::from)?;
            return Ok((StatusCode::OK, body));
        }
    }
    if deployment.status != "READY" {
        return Err(AppError::conflict(
            "DEPLOYMENT_NOT_READY",
            format!(
                "deployment is {} ({}); wait for every replica to be READY",
                deployment.status,
                deployment.status_reason.clone().unwrap_or_default()
            ),
        ));
    }
    let instances = fetch_instances(state, deployment.id).await?;
    let ready_count = instances
        .iter()
        .filter(|instance| instance.slot < deployment.desired_replicas && instance.state == "READY")
        .count() as i32;
    if ready_count != deployment.desired_replicas {
        return Err(AppError::conflict(
            "REPLICAS_NOT_READY",
            format!(
                "{ready_count}/{} replicas are READY",
                deployment.desired_replicas
            ),
        ));
    }
    let manifest: ManifestV11 = serde_json::from_value(package.manifest.clone())
        .map_err(|error| AppError::internal(format!("stored manifest invalid: {error}")))?;
    validate_requires(state, plugin_id, &manifest).await?;
    let policy_digest = opsweave_bundle::sha256_digest(
        serde_json::to_string(&serde_json::json!({
            "manifest": &manifest,
            "activationRevision": next_revision,
            "deploymentGeneration": deployment.generation,
        }))
        .unwrap_or_default()
        .as_bytes(),
    );

    let revision_id = Uuid::new_v4();
    let mut tx = state.db.begin().await?;
    if let Some(active) = &active {
        sqlx::query(
            "UPDATE kernel.activation_revisions SET status='SUPERSEDED', superseded_at=now() WHERE id=$1",
        )
        .bind(active.id)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        r#"
        INSERT INTO kernel.activation_revisions
          (id, plugin_id, package_id, version, deployment_id, generation, status, policy_digest, activated_at)
        VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',$7,now())
        "#,
    )
    .bind(revision_id)
    .bind(plugin_id)
    .bind(package.package_id)
    .bind(&payload.version)
    .bind(deployment.id)
    .bind(next_revision)
    .bind(&policy_digest)
    .execute(&mut *tx)
    .await?;
    for capability in &manifest.provides {
        sqlx::query(
            "INSERT INTO kernel.capability_registrations (id, plugin_id, version, revision_id, direction, name, major, api_digest) VALUES ($1,$2,$3,$4,'PROVIDES',$5,$6,$7)",
        )
        .bind(Uuid::new_v4())
        .bind(plugin_id)
        .bind(&payload.version)
        .bind(revision_id)
        .bind(&capability.name)
        .bind(capability.major)
        .bind(&policy_digest)
        .execute(&mut *tx)
        .await?;
    }
    for capability in &manifest.requires {
        sqlx::query(
            "INSERT INTO kernel.capability_registrations (id, plugin_id, version, revision_id, direction, name, major, api_digest) VALUES ($1,$2,$3,$4,'REQUIRES',$5,$6,$7)",
        )
        .bind(Uuid::new_v4())
        .bind(plugin_id)
        .bind(&payload.version)
        .bind(revision_id)
        .bind(&capability.name)
        .bind(capability.major)
        .bind(&policy_digest)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("UPDATE kernel.plugin_packages SET status='INSTALLED' WHERE package_id=$1")
        .bind(package.package_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE kernel.plugin_installations SET state='INSTALLED', active_revision_id=$2, updated_at=now() WHERE plugin_id=$1",
    )
    .bind(plugin_id)
    .bind(revision_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE kernel.plugin_deployments SET status='ACTIVE', status_reason=NULL, activated_at=now(), updated_at=now() WHERE id=$1",
    )
    .bind(deployment.id)
    .execute(&mut *tx)
    .await?;
    if let Some(active) = &active {
        if active.deployment_id != deployment.id {
            sqlx::query(
                "UPDATE kernel.plugin_deployments SET status='DRAINING', status_reason='Superseded by activation revision', drain_until=now()+interval '15 seconds', updated_at=now() WHERE id=$1 AND status IN ('ACTIVE','READY')",
            )
            .bind(active.deployment_id)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;

    audit::record(
        &state.db,
        "plugin.activated",
        "USER",
        &auth.user_id.to_string(),
        "plugin",
        plugin_id,
        "plugin.activate",
        "CONFIRMED",
        serde_json::json!({
            "version": payload.version,
            "activationRevision": next_revision,
            "deploymentId": deployment.id,
            "policyDigest": policy_digest,
            "imageRef": manifest.backend.as_ref().map(|backend| &backend.image_ref),
        }),
        None,
    )
    .await?;
    let row: ActivationRow =
        sqlx::query_as::<_, ActivationRow>("SELECT * FROM kernel.activation_revisions WHERE id=$1")
            .bind(revision_id)
            .fetch_one(&state.db)
            .await?;
    let body = serde_json::to_value(activation_view(&row)).map_err(AppError::from)?;
    Ok((StatusCode::OK, body))
}

async fn validate_requires(
    state: &AppState,
    plugin_id: &str,
    manifest: &ManifestV11,
) -> AppResult<()> {
    for required in &manifest.requires {
        let self_provide = manifest
            .provides
            .iter()
            .any(|provided| provided.name == required.name && provided.major == required.major);
        if self_provide {
            continue;
        }
        let available: i64 = sqlx::query_scalar(
            r#"
            SELECT count(*) FROM kernel.capability_registrations c
            JOIN kernel.activation_revisions r ON r.id = c.revision_id AND r.status='ACTIVE'
            WHERE c.direction='PROVIDES' AND c.name=$1 AND c.major=$2 AND c.plugin_id<>$3
            "#,
        )
        .bind(&required.name)
        .bind(required.major)
        .bind(plugin_id)
        .fetch_one(&state.db)
        .await?;
        if available == 0 {
            return Err(AppError::conflict(
                "DEPENDENCY_MISSING",
                format!(
                    "required capability {} v{} has no active provider",
                    required.name, required.major
                ),
            ));
        }
    }
    Ok(())
}

pub async fn disable(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(plugin_id): Path<String>,
    headers: HeaderMap,
    Json(payload): Json<DisableRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    auth.require_operator()?;
    let key = receipts::idempotency_key(&headers)?;
    let digest = receipts::digest_json(&serde_json::json!({
        "pluginId": plugin_id, "body": payload
    }));
    let receipt_id = match receipts::start(&state, &key, "plugin.disable", &digest).await? {
        ReceiptStart::Replay(code, body) => return Ok((code, body)),
        ReceiptStart::New(id) => id,
    };
    let result = disable_inner(&state, &auth, &plugin_id, &payload).await;
    match result {
        Ok((status, body)) => {
            receipts::finish(&state, receipt_id, "CONFIRMED", status, body.clone()).await?;
            Ok((status, Json(body)))
        }
        Err(error) => {
            receipts::finish(
                &state,
                receipt_id,
                "REJECTED",
                error.status,
                serde_json::json!({"code": error.code, "message": error.message}),
            )
            .await?;
            Err(error)
        }
    }
}

async fn disable_inner(
    state: &AppState,
    auth: &AuthUser,
    plugin_id: &str,
    payload: &DisableRequest,
) -> AppResult<(StatusCode, Value)> {
    let active = sqlx::query_as::<_, ActivationRow>(
        "SELECT * FROM kernel.activation_revisions WHERE plugin_id=$1 AND status='ACTIVE'",
    )
    .bind(plugin_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::conflict("PLUGIN_NOT_ACTIVE", "plugin has no active revision"))?;
    let dependents: Vec<(String, String)> = sqlx::query_as(
        r#"
        SELECT DISTINCT consumer_plugin_id, name FROM (
          SELECT g.consumer_plugin_id, g.name
          FROM kernel.capability_grants g
          JOIN kernel.capability_registrations p
            ON p.name=g.name AND p.major=g.major AND p.direction='PROVIDES'
          WHERE p.plugin_id=$1 AND g.state='ACTIVE' AND g.consumer_plugin_id<>$1
          UNION
          SELECT c.plugin_id AS consumer_plugin_id, r.name
          FROM kernel.capability_registrations r
          JOIN kernel.activation_revisions c
            ON c.id=r.revision_id AND c.status='ACTIVE'
          JOIN kernel.capability_registrations p
            ON p.name=r.name AND p.major=r.major AND p.direction='PROVIDES'
          WHERE r.direction='REQUIRES' AND p.plugin_id=$1 AND c.plugin_id<>$1
        ) dependents
        ORDER BY consumer_plugin_id, name
        "#,
    )
    .bind(plugin_id)
    .fetch_all(&state.db)
    .await?;
    if !dependents.is_empty() {
        let names = dependents
            .iter()
            .map(|(consumer, capability)| format!("{consumer}:{capability}"))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(AppError::conflict(
            "DEPENDENCY_BLOCKED",
            format!("active capability consumers must be disabled first: {names}"),
        ));
    }
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE kernel.activation_revisions SET status='DISABLED', superseded_at=now() WHERE id=$1",
    )
    .bind(active.id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE kernel.plugin_installations SET state='DISABLED', updated_at=now() WHERE plugin_id=$1",
    )
    .bind(plugin_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE kernel.plugin_deployments SET status='DISABLED', status_reason=$2, updated_at=now() WHERE id=$1",
    )
    .bind(active.deployment_id)
    .bind(payload.reason.clone().unwrap_or_else(|| "Disabled by operator".into()))
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE kernel.plugin_instances SET desired_action='STOP', updated_at=now() WHERE deployment_id=$1",
    )
    .bind(active.deployment_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    audit::record(
        &state.db,
        "plugin.disabled",
        "USER",
        &auth.user_id.to_string(),
        "plugin",
        plugin_id,
        "plugin.disable",
        "CONFIRMED",
        serde_json::json!({
            "version": active.version,
            "activationRevision": active.generation,
            "reason": payload.reason,
        }),
        None,
    )
    .await?;
    Ok((
        StatusCode::OK,
        serde_json::json!({"ok": true, "pluginId": plugin_id, "version": active.version}),
    ))
}

pub async fn enable(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(plugin_id): Path<String>,
) -> AppResult<(StatusCode, Json<Value>)> {
    auth.require_operator()?;
    let installations = sqlx::query_as::<_, (String, Option<Uuid>)>(
        "SELECT state, active_revision_id FROM kernel.plugin_installations WHERE plugin_id=$1",
    )
    .bind(&plugin_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found("plugin not installed"))?;
    if installations.0 == "INSTALLED" {
        return Err(AppError::conflict(
            "PLUGIN_ALREADY_ENABLED",
            "plugin is already installed and active",
        ));
    }
    let latest: Option<DeploymentRow> = sqlx::query_as::<_, DeploymentRow>(
        "SELECT * FROM kernel.plugin_deployments WHERE plugin_id=$1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&plugin_id)
    .fetch_optional(&state.db)
    .await?;
    let Some(mut deployment) = latest else {
        return Err(AppError::conflict(
            "NO_DEPLOYMENT",
            "plugin has no deployment to re-enable; deploy a package version first",
        ));
    };
    if deployment.status == "DISABLED"
        || deployment.status == "DEGRADED"
        || deployment.status == "FAILED"
    {
        sqlx::query(
            "UPDATE kernel.plugin_deployments SET status='PENDING', status_reason='Enable requested', generation=generation+1, updated_at=now() WHERE id=$1",
        )
        .bind(deployment.id)
        .execute(&state.db)
        .await?;
        sqlx::query(
            "UPDATE kernel.plugin_instances SET deployment_generation=$2, desired_action='START', state='STARTING', observed_at=NULL, updated_at=now() WHERE deployment_id=$1",
        )
        .bind(deployment.id)
        .bind(deployment.generation + 1)
        .execute(&state.db)
        .await?;
        deployment = fetch_deployment(&state, deployment.id).await?;
    }
    sqlx::query("UPDATE kernel.plugin_installations SET state='STAGED', updated_at=now() WHERE plugin_id=$1")
        .bind(&plugin_id)
        .execute(&state.db)
        .await?;
    audit::record(
        &state.db,
        "plugin.enable_requested",
        "USER",
        &auth.user_id.to_string(),
        "plugin",
        &plugin_id,
        "plugin.enable",
        "ACCEPTED",
        serde_json::json!({"deploymentId": deployment.id, "version": deployment.version}),
        None,
    )
    .await?;
    let body =
        serde_json::to_value(deployment_view(&state, deployment).await?).map_err(AppError::from)?;
    Ok((StatusCode::ACCEPTED, Json(body)))
}

pub async fn uninstall(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(plugin_id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    auth.require_admin()?;
    sqlx::query("UPDATE kernel.activation_revisions SET status='DISABLED' WHERE plugin_id=$1 AND status='ACTIVE'")
        .bind(&plugin_id)
        .execute(&state.db)
        .await?;
    sqlx::query("UPDATE kernel.plugin_installations SET state='UNINSTALLED', active_revision_id=NULL, updated_at=now() WHERE plugin_id=$1")
        .bind(&plugin_id)
        .execute(&state.db)
        .await?;
    sqlx::query("UPDATE kernel.plugin_deployments SET status='DISABLED', status_reason='Plugin uninstalled; data retained', updated_at=now() WHERE plugin_id=$1")
        .bind(&plugin_id)
        .execute(&state.db)
        .await?;
    sqlx::query("UPDATE kernel.plugin_instances i SET desired_action='STOP', updated_at=now() FROM kernel.plugin_deployments d WHERE i.deployment_id=d.id AND d.plugin_id=$1")
        .bind(&plugin_id)
        .execute(&state.db)
        .await?;
    audit::record(
        &state.db,
        "plugin.uninstalled",
        "USER",
        &auth.user_id.to_string(),
        "plugin",
        &plugin_id,
        "plugin.uninstall",
        "CONFIRMED",
        serde_json::json!({"dataRetained": true}),
        None,
    )
    .await?;
    Ok(Json(serde_json::json!({"ok": true, "dataRetained": true})))
}

pub async fn rollback(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(plugin_id): Path<String>,
    Json(payload): Json<RollbackRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    auth.require_operator()?;
    let target = sqlx::query_as::<_, DeploymentRow>(
        "SELECT * FROM kernel.plugin_deployments WHERE plugin_id=$1 AND version=$2",
    )
    .bind(&plugin_id)
    .bind(&payload.target_version)
    .fetch_optional(&state.db)
    .await?;
    let Some(target) = target else {
        let package =
            crate::packages::get_package(&state, &plugin_id, &payload.target_version).await?;
        let manifest: ManifestV11 = serde_json::from_value(package.manifest)
            .map_err(|error| AppError::internal(error.to_string()))?;
        let create = CreateDeploymentRequest {
            version: payload.target_version.clone(),
            desired_replicas: payload.desired_replicas.unwrap_or(2),
            node_selector: BTreeMap::new(),
            max_instances_per_node: Some(1),
            cpu_millis: Some(manifest.resources.cpu_millis),
            memory_mib: Some(manifest.resources.memory_mib),
        };
        return create_deployment_inner(&state, &auth, &plugin_id, &create)
            .await
            .map(|(status, value)| (status, Json(value)));
    };
    if target.status == "READY" {
        let activate = ActivateRequest {
            version: target.version.clone(),
            expected_revision: payload.expected_revision,
        };
        activate_inner(&state, &auth, &plugin_id, &activate)
            .await
            .map(|(status, value)| (status, Json(value)))
    } else if matches!(target.status.as_str(), "PENDING" | "PREPARING") {
        let body =
            serde_json::to_value(deployment_view(&state, target).await?).map_err(AppError::from)?;
        Ok((StatusCode::ACCEPTED, Json(body)))
    } else {
        let create = CreateDeploymentRequest {
            version: payload.target_version,
            desired_replicas: payload.desired_replicas.unwrap_or(2),
            node_selector: BTreeMap::new(),
            max_instances_per_node: Some(1),
            cpu_millis: None,
            memory_mib: None,
        };
        create_deployment_inner(&state, &auth, &plugin_id, &create)
            .await
            .map(|(status, value)| (status, Json(value)))
    }
}

pub async fn fetch_deployment(state: &AppState, id: Uuid) -> AppResult<DeploymentRow> {
    sqlx::query_as::<_, DeploymentRow>("SELECT * FROM kernel.plugin_deployments WHERE id=$1")
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found("deployment not found"))
}

pub async fn fetch_instances(state: &AppState, deployment_id: Uuid) -> AppResult<Vec<InstanceRow>> {
    let rows = sqlx::query_as::<_, InstanceRow>(
        r#"
        SELECT i.*, n.name AS node_name, n.status AS node_status,
               n.last_seen_at AS node_last_seen_at, n.data_endpoint AS node_data_endpoint,
               n.data_token AS node_data_token
        FROM kernel.plugin_instances i
        JOIN kernel.nodes n ON n.id = i.node_id
        WHERE i.deployment_id=$1
        ORDER BY i.slot
        "#,
    )
    .bind(deployment_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

pub async fn deployment_view(state: &AppState, row: DeploymentRow) -> AppResult<DeploymentView> {
    let instances = fetch_instances(state, row.id).await?;
    let ready_instances = instances
        .iter()
        .filter(|instance| instance.slot < row.desired_replicas && instance.state == "READY")
        .count() as i64;
    let total_instances = instances
        .iter()
        .filter(|instance| instance.slot < row.desired_replicas)
        .count() as i64;
    Ok(DeploymentView {
        id: row.id,
        plugin_id: row.plugin_id,
        version: row.version,
        desired_replicas: row.desired_replicas,
        generation: row.generation,
        status: row.status,
        status_reason: row.status_reason,
        placement: row.placement,
        resources: row.resources,
        ready_instances,
        total_instances,
        created_at: row.created_at,
        updated_at: row.updated_at,
        activated_at: row.activated_at,
        drain_until: row.drain_until,
        instances: instances
            .iter()
            .map(|instance| InstanceView {
                id: instance.id,
                deployment_id: instance.deployment_id,
                node_id: instance.node_id,
                node_name: instance.node_name.clone(),
                slot: instance.slot,
                generation: instance.deployment_generation,
                desired_action: instance.desired_action.clone(),
                state: instance.state.clone(),
                observed_at: instance.observed_at,
                container_id: instance.container_id.clone(),
                image_digest: instance.image_digest.clone(),
                host_port: instance.host_port,
                restart_count: instance.restart_count,
                last_error: instance.last_error.clone(),
                runtime_adapter_version: instance.runtime_adapter_version.clone(),
                node_status: instance.node_status.clone(),
                node_last_seen_at: instance.node_last_seen_at,
            })
            .collect(),
    })
}

fn activation_view(row: &ActivationRow) -> ActivationView {
    ActivationView {
        id: row.id,
        plugin_id: row.plugin_id.clone(),
        version: row.version.clone(),
        deployment_id: row.deployment_id,
        generation: row.generation,
        status: row.status.clone(),
        activated_at: row.activated_at,
    }
}

pub fn spawn_reconciler(state: AppState) {
    tokio::spawn(async move {
        let mut ticker = interval(TokioDuration::from_secs(2));
        loop {
            ticker.tick().await;
            if let Err(error) = reconcile_once(&state).await {
                tracing::error!(error = %error, "reconciliation cycle failed");
            }
        }
    });
}

pub async fn reconcile_once(state: &AppState) -> anyhow::Result<()> {
    let stale_seconds = state.config.node_stale_seconds;
    sqlx::query(
        "UPDATE kernel.nodes SET status='UNREACHABLE' WHERE status IN ('READY','DEGRADED') AND (last_seen_at IS NULL OR last_seen_at < now() - ($1 || ' seconds')::interval)",
    )
    .bind(stale_seconds)
    .execute(&state.db)
    .await?;
    sqlx::query(
        r#"
        UPDATE kernel.plugin_instances i SET state='UNREACHABLE', updated_at=now()
        FROM kernel.nodes n
        WHERE i.node_id=n.id AND i.desired_action='START'
          AND i.state IN ('STARTING','READY','UNHEALTHY')
          AND (n.last_seen_at IS NULL OR n.last_seen_at < now() - ($1 || ' seconds')::interval)
        "#,
    )
    .bind(stale_seconds)
    .execute(&state.db)
    .await?;
    sqlx::query(
        "UPDATE kernel.plugin_deployments SET status='DISABLED', status_reason='Drain window elapsed', updated_at=now() WHERE status='DRAINING' AND drain_until IS NOT NULL AND drain_until < now()",
    )
    .execute(&state.db)
    .await?;

    let deployments = sqlx::query_as::<_, DeploymentRow>(
        "SELECT * FROM kernel.plugin_deployments WHERE status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED') ORDER BY created_at",
    )
    .fetch_all(&state.db)
    .await?;
    for deployment in deployments {
        if let Err(error) = reconcile_deployment(state, deployment).await {
            tracing::error!(error = %error, "deployment reconciliation failed");
        }
    }
    Ok(())
}

async fn reconcile_deployment(state: &AppState, deployment: DeploymentRow) -> anyhow::Result<()> {
    let nodes = sqlx::query_as::<_, NodeRow>(
        "SELECT * FROM kernel.nodes WHERE revoked_at IS NULL AND status='READY' AND last_seen_at > now() - ($1 || ' seconds')::interval ORDER BY name",
    )
    .bind(state.config.node_stale_seconds)
    .fetch_all(&state.db)
    .await?;
    let selector: BTreeMap<String, String> = deployment
        .placement
        .get("nodeSelector")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default();
    let max_per_node = deployment
        .placement
        .get("maxInstancesPerNode")
        .and_then(|value| value.as_i64())
        .unwrap_or(1)
        .clamp(1, 20) as usize;
    let requested: ResourceRequirements = serde_json::from_value(deployment.resources.clone())
        .unwrap_or(ResourceRequirements {
            cpu_millis: 500,
            memory_mib: 256,
        });
    let allocations: Vec<(Uuid, i64, i64)> = sqlx::query_as(
        r#"
        SELECT i.node_id,
               COALESCE(SUM((d.resources->>'cpuMillis')::bigint)::bigint, 0),
               COALESCE(SUM((d.resources->>'memoryMiB')::bigint)::bigint, 0)
        FROM kernel.plugin_instances i
        JOIN kernel.plugin_deployments d ON d.id=i.deployment_id
        WHERE i.desired_action='START'
          AND d.status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED')
        GROUP BY i.node_id
        "#,
    )
    .fetch_all(&state.db)
    .await?;
    let mut reserved: HashMap<Uuid, (i64, i64)> = allocations
        .into_iter()
        .map(|(node_id, cpu, memory)| (node_id, (cpu, memory)))
        .collect();
    let eligible: Vec<NodeRow> = nodes
        .into_iter()
        .filter(|node| node_matches(node, &selector))
        .collect();
    let global_instance_counts: Vec<(Uuid, i64)> = sqlx::query_as(
        r#"
        SELECT i.node_id, count(*)::bigint
        FROM kernel.plugin_instances i
        JOIN kernel.plugin_deployments d ON d.id=i.deployment_id
        WHERE i.desired_action='START'
          AND d.status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED')
        GROUP BY i.node_id
        "#,
    )
    .fetch_all(&state.db)
    .await?;
    let existing = sqlx::query_as::<_, InstanceRow>(
        "SELECT i.*, n.name AS node_name, n.status AS node_status, n.last_seen_at AS node_last_seen_at, n.data_endpoint AS node_data_endpoint, n.data_token AS node_data_token FROM kernel.plugin_instances i JOIN kernel.nodes n ON n.id=i.node_id WHERE i.deployment_id=$1 ORDER BY i.slot",
    )
    .bind(deployment.id)
    .fetch_all(&state.db)
    .await?;
    let by_slot: HashMap<i32, InstanceRow> =
        existing.iter().map(|row| (row.slot, row.clone())).collect();
    let mut global_counts: HashMap<Uuid, usize> = global_instance_counts
        .into_iter()
        .map(|(node_id, count)| (node_id, count.max(0) as usize))
        .collect();
    let mut used_nodes: HashMap<Uuid, usize> = existing
        .iter()
        .filter(|row| row.slot < deployment.desired_replicas && row.desired_action == "START")
        .fold(HashMap::new(), |mut map, row| {
            *map.entry(row.node_id).or_insert(0) += 1;
            map
        });
    let eligible_ids: HashSet<Uuid> = eligible.iter().map(|node| node.id).collect();
    let placement = PlacementContext {
        selector: &selector,
        requested: &requested,
        max_instances_per_deployment: max_per_node,
        max_instances_per_node: state.config.max_instances_per_node as usize,
    };
    let mut missing = 0_i32;
    let mut placement_rejection: Option<(String, PlacementRejection)> = None;

    for slot in 0..deployment.desired_replicas {
        let current = by_slot.get(&slot).cloned();
        let existing_node_ok = current
            .as_ref()
            .map(|row| {
                row.desired_action == "START"
                    && eligible_ids.contains(&row.node_id)
                    && used_nodes.get(&row.node_id).copied().unwrap_or(0) <= max_per_node
            })
            .unwrap_or(false);
        if existing_node_ok {
            sqlx::query("UPDATE kernel.plugin_instances SET desired_action='START', updated_at=now() WHERE id=$1")
                .bind(current.as_ref().unwrap().id)
                .execute(&state.db)
                .await?;
            continue;
        }
        let candidate = eligible
            .iter()
            .filter(|node| {
                let usage = NodeUsage::of(node, &reserved, &used_nodes, &global_counts);
                match evaluate_node(node, usage, &placement) {
                    Ok(()) => true,
                    Err(rejection) => {
                        let furthest = placement_rejection
                            .as_ref()
                            .map(|(_, best)| rejection.progress() > best.progress())
                            .unwrap_or(true);
                        if furthest {
                            placement_rejection = Some((node.name.clone(), rejection));
                        }
                        false
                    }
                }
            })
            .min_by_key(|node| {
                (
                    used_nodes.get(&node.id).copied().unwrap_or(0),
                    node.name.clone(),
                )
            });
        let Some(node) = candidate else {
            missing += 1;
            if let Some(current) = current {
                sqlx::query("UPDATE kernel.plugin_instances SET desired_action='STOP', updated_at=now() WHERE id=$1")
                    .bind(current.id)
                    .execute(&state.db)
                    .await?;
            }
            continue;
        };
        if let Some(current) = current {
            let was_started = current.desired_action == "START";
            if current.node_id != node.id {
                sqlx::query(
                    "UPDATE kernel.plugin_instances SET node_id=$2, desired_action='START', state='STARTING', observed_at=NULL, container_id=NULL, image_digest=NULL, host_port=NULL, restart_count=0, last_error=NULL, deployment_generation=$3, updated_at=now() WHERE id=$1",
                )
                .bind(current.id)
                .bind(node.id)
                .bind(deployment.generation)
                .execute(&state.db)
                .await?;
                if was_started {
                    transfer_placement(
                        &mut used_nodes,
                        &mut global_counts,
                        &mut reserved,
                        current.node_id,
                        node.id,
                        &requested,
                    );
                } else {
                    // A STOP instance was not counted at the source; only add
                    // it to the target's global and resource accounting.
                    account_start(
                        &mut used_nodes,
                        &mut global_counts,
                        &mut reserved,
                        node.id,
                        &requested,
                    );
                }
            } else {
                sqlx::query("UPDATE kernel.plugin_instances SET desired_action='START', updated_at=now() WHERE id=$1")
                    .bind(current.id)
                    .execute(&state.db)
                    .await?;
                if !was_started {
                    account_start(
                        &mut used_nodes,
                        &mut global_counts,
                        &mut reserved,
                        node.id,
                        &requested,
                    );
                }
            }
        } else {
            let id = Uuid::new_v4();
            sqlx::query(
                r#"
                INSERT INTO kernel.plugin_instances
                  (id, deployment_id, node_id, slot, deployment_generation, desired_action, state)
                VALUES ($1,$2,$3,$4,$5,'START','STARTING')
                "#,
            )
            .bind(id)
            .bind(deployment.id)
            .bind(node.id)
            .bind(slot)
            .bind(deployment.generation)
            .execute(&state.db)
            .await?;
            *used_nodes.entry(node.id).or_insert(0) += 1;
            *global_counts.entry(node.id).or_insert(0) += 1;
            let reservation = reserved.entry(node.id).or_insert((0, 0));
            reservation.0 += requested.cpu_millis;
            reservation.1 += requested.memory_mib;
        }
    }
    if missing > 0 && placement_rejection.is_none() {
        placement_rejection =
            diagnose_placement(state, &placement, &reserved, &used_nodes, &global_counts).await?;
    }
    for row in existing
        .iter()
        .filter(|row| row.slot >= deployment.desired_replicas)
    {
        sqlx::query("UPDATE kernel.plugin_instances SET desired_action='STOP', updated_at=now() WHERE id=$1")
            .bind(row.id)
            .execute(&state.db)
            .await?;
    }

    let is_effective: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM kernel.activation_revisions WHERE deployment_id=$1 AND status='ACTIVE')",
    )
    .bind(deployment.id)
    .fetch_one(&state.db)
    .await?;
    let instances = fetch_instances(state, deployment.id).await?;
    let relevant: Vec<&InstanceRow> = instances
        .iter()
        .filter(|instance| {
            instance.slot < deployment.desired_replicas && instance.desired_action == "START"
        })
        .collect();
    let ready = relevant
        .iter()
        .filter(|instance| instance.state == "READY")
        .count() as i32;
    let starting = relevant
        .iter()
        .filter(|instance| matches!(instance.state.as_str(), "STARTING" | "UNKNOWN"))
        .count() as i32;
    let failed = relevant
        .iter()
        .filter(|instance| matches!(instance.state.as_str(), "UNHEALTHY" | "UNREACHABLE"))
        .count() as i32;
    let (status, reason) = if deployment.desired_replicas == 0 {
        ("DISABLED", Some("Desired replicas is zero".to_string()))
    } else if missing == deployment.desired_replicas {
        (
            "PENDING",
            Some(match placement_rejection.as_ref() {
                Some((node_name, rejection)) => placement_failure_reason(node_name, rejection),
                None => PLACEMENT_FAILURE.to_string(),
            }),
        )
    } else if ready == deployment.desired_replicas {
        if is_effective {
            ("ACTIVE", None)
        } else {
            ("READY", None)
        }
    } else if is_effective {
        (
            "DEGRADED",
            Some(format!(
                "{ready}/{} replicas READY",
                deployment.desired_replicas
            )),
        )
    } else if starting > 0 {
        (
            "PREPARING",
            Some(format!(
                "{ready}/{} replicas READY",
                deployment.desired_replicas
            )),
        )
    } else if failed > 0 {
        (
            "DEGRADED",
            Some(format!(
                "{ready}/{} replicas READY; {failed} failed",
                deployment.desired_replicas
            )),
        )
    } else {
        (
            "PREPARING",
            Some(format!(
                "{ready}/{} replicas READY",
                deployment.desired_replicas
            )),
        )
    };
    if deployment.status != status || deployment.status_reason != reason {
        sqlx::query(
            "UPDATE kernel.plugin_deployments SET status=$2, status_reason=$3, updated_at=now() WHERE id=$1 AND status<>'DRAINING'",
        )
        .bind(deployment.id)
        .bind(status)
        .bind(&reason)
        .execute(&state.db)
        .await?;
    }
    Ok(())
}

fn account_start(
    used_nodes: &mut HashMap<Uuid, usize>,
    global_counts: &mut HashMap<Uuid, usize>,
    reserved: &mut HashMap<Uuid, (i64, i64)>,
    node: Uuid,
    request: &ResourceRequirements,
) {
    *used_nodes.entry(node).or_insert(0) += 1;
    *global_counts.entry(node).or_insert(0) += 1;
    let reservation = reserved.entry(node).or_insert((0, 0));
    reservation.0 += request.cpu_millis;
    reservation.1 += request.memory_mib;
}

fn transfer_placement(
    used_nodes: &mut HashMap<Uuid, usize>,
    global_counts: &mut HashMap<Uuid, usize>,
    reserved: &mut HashMap<Uuid, (i64, i64)>,
    from: Uuid,
    to: Uuid,
    request: &ResourceRequirements,
) {
    if let Some(count) = used_nodes.get_mut(&from) {
        *count = count.saturating_sub(1);
    }
    if let Some(count) = global_counts.get_mut(&from) {
        *count = count.saturating_sub(1);
    }
    if let Some(reservation) = reserved.get_mut(&from) {
        reservation.0 = reservation.0.saturating_sub(request.cpu_millis);
        reservation.1 = reservation.1.saturating_sub(request.memory_mib);
    }
    *used_nodes.entry(to).or_insert(0) += 1;
    *global_counts.entry(to).or_insert(0) += 1;
    let reservation = reserved.entry(to).or_insert((0, 0));
    reservation.0 += request.cpu_millis;
    reservation.1 += request.memory_mib;
}

const PLACEMENT_FAILURE: &str = "No eligible healthy node matches the placement selector";

/// Why a node was refused a slot.
///
/// Placement is a boolean in the data model - an instance exists or it does
/// not - so every distinct refusal reason has to survive as a value. Sharing
/// one `false` between six unrelated causes is what made a PENDING deployment
/// indistinguishable from an unreachable node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PlacementRejection {
    NodeNotReady {
        status: String,
    },
    SelectorMismatch {
        key: String,
        expected: String,
        actual: Option<String>,
    },
    InstanceCapacityExceeded {
        scope: &'static str,
        instances: usize,
        limit: usize,
    },
    ResourceSnapshotMissing {
        field: Option<&'static str>,
    },
    MemoryInsufficient {
        requested_mib: i64,
        available_mib: i64,
        limit_mib: i64,
    },
    CpuInsufficient {
        requested_millis: i64,
        cores: i64,
        limit_millis: i64,
    },
}

impl PlacementRejection {
    /// Stable machine-readable code. The frontend maps this code to localized
    /// copy, so the spelling must not change once published.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::NodeNotReady { .. } => "NODE_NOT_READY",
            Self::SelectorMismatch { .. } => "SELECTOR_MISMATCH",
            Self::InstanceCapacityExceeded { .. } => "INSTANCE_CAPACITY_EXCEEDED",
            Self::ResourceSnapshotMissing { .. } => "RESOURCE_SNAPSHOT_MISSING",
            Self::MemoryInsufficient { .. } => "MEMORY_INSUFFICIENT",
            Self::CpuInsufficient { .. } => "CPU_INSUFFICIENT",
        }
    }

    /// Operator-facing detail. Every variant names the numbers that produced
    /// the decision: a reason without a value is another boolean in disguise.
    pub(crate) fn detail(&self) -> String {
        match self {
            Self::NodeNotReady { status } => format!(
                "node status is {status}, placement requires READY with a recent heartbeat"
            ),
            Self::SelectorMismatch {
                key,
                expected,
                actual,
            } => match actual {
                Some(actual) => {
                    format!("selector {key}={expected} does not match node label {key}={actual}")
                }
                None => format!("selector {key}={expected} does not match: node has no label {key}"),
            },
            Self::InstanceCapacityExceeded {
                scope,
                instances,
                limit,
            } => format!(
                "{instances} instances already scheduled on this node against a {scope} limit of {limit}"
            ),
            Self::ResourceSnapshotMissing { field } => match field {
                Some(field) => format!("resource snapshot has no {field}"),
                None => "node has not reported a resource snapshot".to_string(),
            },
            Self::MemoryInsufficient {
                requested_mib,
                available_mib,
                limit_mib,
            } => format!(
                "requested {requested_mib} MiB but only {limit_mib} MiB of the {available_mib} MiB available are budgetable (90% headroom)"
            ),
            Self::CpuInsufficient {
                requested_millis,
                cores,
                limit_millis,
            } => format!(
                "requested {requested_millis}m of CPU but only {limit_millis}m of {cores} cores are budgetable (90% headroom)"
            ),
        }
    }

    /// How far the node got through the gate. Several nodes can be refused in
    /// one decision; reporting the furthest one keeps the message useful
    /// ("the only node ran out of CPU" beats "another node is not READY").
    fn progress(&self) -> u8 {
        match self {
            Self::NodeNotReady { .. } => 0,
            Self::SelectorMismatch { .. } => 1,
            Self::InstanceCapacityExceeded { .. } => 2,
            Self::ResourceSnapshotMissing { .. } => 3,
            Self::MemoryInsufficient { .. } => 4,
            Self::CpuInsufficient { .. } => 5,
        }
    }
}

/// Placement inputs that do not vary between nodes in one slot decision.
struct PlacementContext<'a> {
    selector: &'a BTreeMap<String, String>,
    requested: &'a ResourceRequirements,
    max_instances_per_deployment: usize,
    max_instances_per_node: usize,
}

/// What a node already carries before this slot is added.
#[derive(Debug, Clone, Copy, Default)]
struct NodeUsage {
    cpu_millis: i64,
    memory_mib: i64,
    deployment_instances: usize,
    node_instances: usize,
}

impl NodeUsage {
    fn of(
        node: &NodeRow,
        reserved: &HashMap<Uuid, (i64, i64)>,
        used_nodes: &HashMap<Uuid, usize>,
        global_counts: &HashMap<Uuid, usize>,
    ) -> Self {
        let (cpu_millis, memory_mib) = reserved.get(&node.id).copied().unwrap_or((0, 0));
        Self {
            cpu_millis,
            memory_mib,
            deployment_instances: used_nodes.get(&node.id).copied().unwrap_or(0),
            node_instances: global_counts.get(&node.id).copied().unwrap_or(0),
        }
    }
}

/// The whole placement gate for one node and one slot, in the order the
/// scheduler used to evaluate it inline, now answering *why* when it refuses.
fn evaluate_node(
    node: &NodeRow,
    usage: NodeUsage,
    placement: &PlacementContext<'_>,
) -> Result<(), PlacementRejection> {
    if node.revoked_at.is_some() {
        return Err(PlacementRejection::NodeNotReady {
            status: "REVOKED".to_string(),
        });
    }
    if node.status != "READY" {
        return Err(PlacementRejection::NodeNotReady {
            status: node.status.clone(),
        });
    }
    if let Some(mismatch) = selector_mismatch(node, placement.selector) {
        return Err(mismatch);
    }
    if usage.deployment_instances >= placement.max_instances_per_deployment {
        return Err(PlacementRejection::InstanceCapacityExceeded {
            scope: "per-deployment",
            instances: usage.deployment_instances,
            limit: placement.max_instances_per_deployment,
        });
    }
    if usage.node_instances >= placement.max_instances_per_node {
        return Err(PlacementRejection::InstanceCapacityExceeded {
            scope: "per-node",
            instances: usage.node_instances,
            limit: placement.max_instances_per_node,
        });
    }
    node_has_capacity(
        node,
        usage.cpu_millis + placement.requested.cpu_millis,
        usage.memory_mib + placement.requested.memory_mib,
    )
}

/// Resource gate for one slot. The request includes the node's existing
/// reservation, so the budget is compared against what the node would carry if
/// this slot were placed.
///
/// `cpuCores`/`memoryTotalBytes` are host-schedulable totals, never the Node
/// Runtime container's own cgroup limits: plugin containers are siblings of the
/// node runtime on the host, so a container quota would shrink the budget for
/// work that does not run inside it. Staging proved the cost of mixing the two:
/// the node container is capped at 1 CPU (deployments/staging/compose.yaml)
/// while /proc/meminfo reports the host's 3.7 GiB, so the kernel saw "1 core"
/// and budgeted 900m for a 4 vCPU host.
fn node_has_capacity(
    node: &NodeRow,
    requested_cpu_millis: i64,
    requested_memory_mib: i64,
) -> Result<(), PlacementRejection> {
    let Some(snapshot) = node.resource_snapshot.as_ref() else {
        return Err(PlacementRejection::ResourceSnapshotMissing { field: None });
    };
    let Some(total) = snapshot.get("memoryTotalBytes").and_then(Value::as_i64) else {
        return Err(PlacementRejection::ResourceSnapshotMissing {
            field: Some("memoryTotalBytes"),
        });
    };
    let Some(cores) = snapshot.get("cpuCores").and_then(Value::as_i64) else {
        return Err(PlacementRejection::ResourceSnapshotMissing {
            field: Some("cpuCores"),
        });
    };
    let used = snapshot
        .get("memoryUsedBytes")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let available_mib = (total - used).max(0) / (1024 * 1024);
    let memory_budget_mib = available_mib * 9 / 10;
    if available_mib <= 0 || requested_memory_mib > memory_budget_mib {
        return Err(PlacementRejection::MemoryInsufficient {
            requested_mib: requested_memory_mib,
            available_mib,
            limit_mib: memory_budget_mib,
        });
    }
    let cpu_budget_millis = cores * 1000 * 9 / 10;
    if cores <= 0 || requested_cpu_millis > cpu_budget_millis {
        return Err(PlacementRejection::CpuInsufficient {
            requested_millis: requested_cpu_millis,
            cores,
            limit_millis: cpu_budget_millis,
        });
    }
    Ok(())
}

fn selector_mismatch(
    node: &NodeRow,
    selector: &BTreeMap<String, String>,
) -> Option<PlacementRejection> {
    let labels = node.labels.as_object();
    for (key, expected) in selector {
        let actual = labels.and_then(|map| map.get(key)).and_then(Value::as_str);
        if actual != Some(expected.as_str()) {
            return Some(PlacementRejection::SelectorMismatch {
                key: key.clone(),
                expected: expected.clone(),
                actual: actual.map(str::to_string),
            });
        }
    }
    None
}

fn node_matches(node: &NodeRow, selector: &BTreeMap<String, String>) -> bool {
    selector_mismatch(node, selector).is_none()
}

/// Re-evaluates every known node once a slot found no candidate. The scheduler
/// only ever looks at READY, recently-seen nodes, so without this pass a
/// deployment refused because its only node is UNREACHABLE waits forever with a
/// reason that names nothing.
async fn diagnose_placement(
    state: &AppState,
    placement: &PlacementContext<'_>,
    reserved: &HashMap<Uuid, (i64, i64)>,
    used_nodes: &HashMap<Uuid, usize>,
    global_counts: &HashMap<Uuid, usize>,
) -> anyhow::Result<Option<(String, PlacementRejection)>> {
    let nodes = sqlx::query_as::<_, NodeRow>(
        "SELECT * FROM kernel.nodes WHERE revoked_at IS NULL ORDER BY name",
    )
    .fetch_all(&state.db)
    .await?;
    let mut furthest: Option<(String, PlacementRejection)> = None;
    for node in &nodes {
        let usage = NodeUsage::of(node, reserved, used_nodes, global_counts);
        let Err(rejection) = evaluate_node(node, usage, placement) else {
            continue;
        };
        let further = furthest
            .as_ref()
            .map(|(_, best)| rejection.progress() > best.progress())
            .unwrap_or(true);
        if further {
            furthest = Some((node.name.clone(), rejection));
        }
    }
    Ok(furthest)
}

fn placement_failure_reason(node_name: &str, rejection: &PlacementRejection) -> String {
    format!(
        "{PLACEMENT_FAILURE} [{}] node {node_name}: {}",
        rejection.code(),
        rejection.detail()
    )
}

#[cfg(test)]
mod tests {
    use super::{
        evaluate_node, node_has_capacity, placement_failure_reason, NodeUsage, PlacementContext,
        PlacementRejection,
    };
    use crate::nodes::NodeRow;
    use chrono::Utc;
    use opsweave_contracts::ResourceRequirements;
    use serde_json::json;
    use std::collections::BTreeMap;
    use uuid::Uuid;

    fn node_row(
        status: &str,
        labels: serde_json::Value,
        snapshot: Option<serde_json::Value>,
    ) -> NodeRow {
        NodeRow {
            id: Uuid::new_v4(),
            name: "staging-node".into(),
            control_token_hash: String::new(),
            data_token: String::new(),
            generation: 1,
            os: "linux".into(),
            arch: "amd64".into(),
            labels,
            capabilities: json!([]),
            status: status.into(),
            last_seen_at: Some(Utc::now()),
            data_endpoint: Some("http://127.0.0.1:9101".into()),
            runtime_adapter_version: Some("test".into()),
            resource_snapshot: snapshot,
            enrolled_at: Utc::now(),
            revoked_at: None,
            cert_expires_at: None,
        }
    }

    /// The resource totals staging actually reports: 3.7 GiB host memory and
    /// 1.04 GiB in use.
    fn staging_snapshot(cpu_cores: i64) -> serde_json::Value {
        json!({
            "cpuCores": cpu_cores,
            "memoryTotalBytes": 3_904_065_536_i64,
            "memoryUsedBytes": 1_119_035_392_i64,
        })
    }

    fn staging_node(cpu_cores: i64) -> NodeRow {
        node_row(
            "READY",
            json!({"role": "node", "zone": "staging"}),
            Some(staging_snapshot(cpu_cores)),
        )
    }

    fn selector() -> BTreeMap<String, String> {
        BTreeMap::from([("role".to_string(), "node".to_string())])
    }

    fn request(cpu_millis: i64, memory_mib: i64) -> ResourceRequirements {
        ResourceRequirements {
            cpu_millis,
            memory_mib,
        }
    }

    fn placement<'a>(
        selector: &'a BTreeMap<String, String>,
        requested: &'a ResourceRequirements,
    ) -> PlacementContext<'a> {
        PlacementContext {
            selector,
            requested,
            max_instances_per_deployment: 1,
            max_instances_per_node: 4,
        }
    }

    #[test]
    fn stopped_migration_does_not_decrement_an_uncounted_source() {
        let source = Uuid::new_v4();
        let target = Uuid::new_v4();
        let mut used = std::collections::HashMap::new();
        let mut global = std::collections::HashMap::from([(source, 1), (target, 2)]);
        let mut reserved =
            std::collections::HashMap::from([(source, (500, 128)), (target, (1000, 256))]);
        // The STOP instance is represented by neither `used` nor the source
        // reservation; only the target is charged when it is activated.
        super::account_start(
            &mut used,
            &mut global,
            &mut reserved,
            target,
            &ResourceRequirements {
                cpu_millis: 500,
                memory_mib: 128,
            },
        );
        assert_eq!(used.get(&source), None);
        assert_eq!(global.get(&source), Some(&1));
        assert_eq!(reserved.get(&source), Some(&(500, 128)));
        assert_eq!(global.get(&target), Some(&3));
        assert_eq!(reserved.get(&target), Some(&(1500, 384)));
    }

    #[test]
    fn stopped_instance_restart_restores_accounting() {
        let node = Uuid::new_v4();
        let mut used = std::collections::HashMap::new();
        let mut global = std::collections::HashMap::from([(node, 2)]);
        let mut reserved = std::collections::HashMap::from([(node, (1000, 256))]);
        super::account_start(
            &mut used,
            &mut global,
            &mut reserved,
            node,
            &ResourceRequirements {
                cpu_millis: 500,
                memory_mib: 128,
            },
        );
        assert_eq!(used.get(&node), Some(&1));
        assert_eq!(global.get(&node), Some(&3));
        assert_eq!(reserved.get(&node), Some(&(1500, 384)));
    }

    #[test]
    fn migration_transfers_global_count_and_reservation_to_target() {
        let from = Uuid::new_v4();
        let to = Uuid::new_v4();
        let mut used = std::collections::HashMap::from([(from, 1)]);
        let mut global = std::collections::HashMap::from([(from, 1), (to, 2)]);
        let mut reserved = std::collections::HashMap::from([(from, (500, 128)), (to, (1000, 256))]);
        super::transfer_placement(
            &mut used,
            &mut global,
            &mut reserved,
            from,
            to,
            &ResourceRequirements {
                cpu_millis: 500,
                memory_mib: 128,
            },
        );
        assert_eq!(used.get(&from), Some(&0));
        assert_eq!(global.get(&to), Some(&3));
        assert_eq!(reserved.get(&from), Some(&(0, 0)));
        assert_eq!(reserved.get(&to), Some(&(1500, 384)));
    }

    #[test]
    fn placement_accepts_a_deployment_that_fits() {
        let selector = selector();
        let requested = request(500, 128);
        let placement = placement(&selector, &requested);
        assert_eq!(
            evaluate_node(&staging_node(4), NodeUsage::default(), &placement),
            Ok(())
        );
    }

    #[test]
    fn placement_rejects_a_node_that_is_not_ready() {
        let selector = selector();
        let requested = request(500, 128);
        let placement = placement(&selector, &requested);
        let node = node_row(
            "UNREACHABLE",
            json!({"role": "node"}),
            Some(staging_snapshot(4)),
        );
        let rejection = evaluate_node(&node, NodeUsage::default(), &placement).unwrap_err();
        assert_eq!(rejection.code(), "NODE_NOT_READY");
        assert!(
            rejection.detail().contains("UNREACHABLE"),
            "{}",
            rejection.detail()
        );
        let reason = placement_failure_reason("staging-node", &rejection);
        assert!(reason.contains("[NODE_NOT_READY]"), "{reason}");
    }

    #[test]
    fn placement_rejects_a_selector_mismatch() {
        let selector = selector();
        let requested = request(500, 128);
        let placement = placement(&selector, &requested);
        let worker = node_row(
            "READY",
            json!({"role": "worker"}),
            Some(staging_snapshot(4)),
        );
        let rejection = evaluate_node(&worker, NodeUsage::default(), &placement).unwrap_err();
        assert_eq!(rejection.code(), "SELECTOR_MISMATCH");
        let detail = rejection.detail();
        assert!(
            detail.contains("role=node") && detail.contains("worker"),
            "{detail}"
        );
        let bare = node_row(
            "READY",
            json!({"zone": "staging"}),
            Some(staging_snapshot(4)),
        );
        let rejection = evaluate_node(&bare, NodeUsage::default(), &placement).unwrap_err();
        assert_eq!(rejection.code(), "SELECTOR_MISMATCH");
        assert!(
            rejection.detail().contains("no label role"),
            "{}",
            rejection.detail()
        );
    }

    #[test]
    fn placement_rejects_a_missing_resource_snapshot() {
        let selector = selector();
        let requested = request(500, 128);
        let placement = placement(&selector, &requested);
        let no_snapshot = node_row("READY", json!({"role": "node"}), None);
        let rejection = evaluate_node(&no_snapshot, NodeUsage::default(), &placement).unwrap_err();
        assert_eq!(rejection.code(), "RESOURCE_SNAPSHOT_MISSING");
        assert!(
            rejection.detail().contains("has not reported"),
            "{}",
            rejection.detail()
        );

        let no_memory = node_row(
            "READY",
            json!({"role": "node"}),
            Some(json!({"cpuCores": 4})),
        );
        let rejection = evaluate_node(&no_memory, NodeUsage::default(), &placement).unwrap_err();
        assert_eq!(rejection.code(), "RESOURCE_SNAPSHOT_MISSING");
        assert!(
            rejection.detail().contains("memoryTotalBytes"),
            "{}",
            rejection.detail()
        );

        let no_cores = node_row(
            "READY",
            json!({"role": "node"}),
            Some(json!({"memoryTotalBytes": 3_904_065_536_i64})),
        );
        let rejection = evaluate_node(&no_cores, NodeUsage::default(), &placement).unwrap_err();
        assert_eq!(rejection.code(), "RESOURCE_SNAPSHOT_MISSING");
        assert!(
            rejection.detail().contains("cpuCores"),
            "{}",
            rejection.detail()
        );
    }

    #[test]
    fn placement_rejects_insufficient_memory_with_the_numbers() {
        let selector = selector();
        let requested = request(100, 1000);
        let placement = placement(&selector, &requested);
        let node = node_row(
            "READY",
            json!({"role": "node"}),
            Some(json!({
                "cpuCores": 4,
                "memoryTotalBytes": 1_073_741_824_i64,
                "memoryUsedBytes": 0,
            })),
        );
        let rejection = evaluate_node(&node, NodeUsage::default(), &placement).unwrap_err();
        assert_eq!(
            rejection,
            PlacementRejection::MemoryInsufficient {
                requested_mib: 1000,
                available_mib: 1024,
                limit_mib: 921,
            }
        );
        assert_eq!(rejection.code(), "MEMORY_INSUFFICIENT");
        let detail = rejection.detail();
        assert!(
            detail.contains("1000 MiB")
                && detail.contains("921 MiB")
                && detail.contains("1024 MiB"),
            "{detail}"
        );
    }

    #[test]
    fn placement_rejects_insufficient_cpu_with_the_numbers() {
        // The staging failure: the node reported the Node Runtime container's
        // cgroup quota (1 core), so the budget was 900m while the incumbent
        // plugin already held 500m of it.
        let selector = selector();
        let requested = request(500, 128);
        let placement = placement(&selector, &requested);
        let usage = NodeUsage {
            cpu_millis: 500,
            memory_mib: 128,
            deployment_instances: 0,
            node_instances: 1,
        };
        let rejection = evaluate_node(&staging_node(1), usage, &placement).unwrap_err();
        assert_eq!(
            rejection,
            PlacementRejection::CpuInsufficient {
                requested_millis: 1000,
                cores: 1,
                limit_millis: 900,
            }
        );
        assert_eq!(rejection.code(), "CPU_INSUFFICIENT");
        let detail = rejection.detail();
        assert!(
            detail.contains("1000m") && detail.contains("900m"),
            "{detail}"
        );
    }

    #[test]
    fn placement_accepts_the_same_slot_once_the_node_reports_host_cores() {
        let selector = selector();
        let requested = request(500, 128);
        let placement = placement(&selector, &requested);
        let usage = NodeUsage {
            cpu_millis: 500,
            memory_mib: 128,
            deployment_instances: 0,
            node_instances: 1,
        };
        assert_eq!(evaluate_node(&staging_node(4), usage, &placement), Ok(()));
    }

    #[test]
    fn placement_rejects_instance_capacity_exceeded() {
        let selector = selector();
        let requested = request(500, 128);
        let placement = placement(&selector, &requested);
        let per_deployment = NodeUsage {
            deployment_instances: 1,
            ..NodeUsage::default()
        };
        let rejection = evaluate_node(&staging_node(4), per_deployment, &placement).unwrap_err();
        assert_eq!(
            rejection,
            PlacementRejection::InstanceCapacityExceeded {
                scope: "per-deployment",
                instances: 1,
                limit: 1,
            }
        );
        assert_eq!(rejection.code(), "INSTANCE_CAPACITY_EXCEEDED");
        assert!(
            rejection.detail().contains("per-deployment limit of 1"),
            "{}",
            rejection.detail()
        );

        let per_node = NodeUsage {
            node_instances: 4,
            ..NodeUsage::default()
        };
        let rejection = evaluate_node(&staging_node(4), per_node, &placement).unwrap_err();
        assert_eq!(
            rejection,
            PlacementRejection::InstanceCapacityExceeded {
                scope: "per-node",
                instances: 4,
                limit: 4,
            }
        );
        assert!(
            rejection.detail().contains("per-node limit of 4"),
            "{}",
            rejection.detail()
        );
    }

    #[test]
    fn capacity_gate_keeps_the_nine_tenths_headroom() {
        // Staging: 3.7 GiB total, 1.04 GiB used -> 2656 MiB available, so the
        // budget stays 2390 MiB; with host cores, 4 cores budget 3600m.
        let node = staging_node(4);
        assert_eq!(node_has_capacity(&node, 3600, 2390), Ok(()));
        assert_eq!(
            node_has_capacity(&node, 3601, 100),
            Err(PlacementRejection::CpuInsufficient {
                requested_millis: 3601,
                cores: 4,
                limit_millis: 3600,
            })
        );
        assert_eq!(
            node_has_capacity(&node, 100, 2391),
            Err(PlacementRejection::MemoryInsufficient {
                requested_mib: 2391,
                available_mib: 2656,
                limit_mib: 2390,
            })
        );
    }
}
