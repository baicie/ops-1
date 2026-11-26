use crate::audit;
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::nodes::NodeRow;
use crate::receipts::{self, ReceiptStart};
use crate::state::AppState;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use chrono::{DateTime, Utc};
use opsweave_contracts::{ManifestV11, ResourceRequirements};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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
    /// When this PENDING attempt began; `NULL` when the row is not attempting.
    ///
    /// Separate from `created_at` because a re-deploy of the same version keeps the
    /// original creation time - a timeout read from there would fire immediately
    /// after an operator's retry. See `migrations/0037`.
    pub attempt_started_at: Option<DateTime<Utc>>,
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

/// An instance the scheduler cannot recover and that holds no resource.
///
/// A failed state with no container is a dead row: `desired_action` is still
/// START because nothing stopped it, but there is nothing on the node to manage.
/// Counting it as occupied is what made a single failed pull block every later
/// deployment on that node.
fn is_ghost_instance(row: &InstanceRow) -> bool {
    matches!(row.state.as_str(), "UNHEALTHY" | "UNREACHABLE") && row.container_id.is_none()
}

/// Whether the reconciler must REBUILD this row instead of maintaining it.
///
/// The ghost exclusion above fixed what a dead row *costs*; it did not fix what
/// happens *to* it. In the loop, a ghost still satisfied `desired_action ==
/// "START"`, so the "existing instance is fine, leave it alone" branch fired and
/// wrote `desired_action='START'` back every single pass. That is the whole
/// reason a manual `UPDATE ... SET desired_action='STOP'` was overwritten within
/// the same second (measured on staging: `updated_at` equalled the clock at the
/// query): the reconciler was not preserving the operator's intent, it was
/// re-asserting its own, forever, about a container that does not exist.
///
/// So a ghost is not a row to keep. It is a row to RE-CREATE: clear the observed
/// state, let the planner place it again, and let the node report afresh. The
/// slot and the deployment generation are the identity that survives; the
/// container facts do not, because there are none.
///
/// The three-way distinction matters and each part is tested:
///
///   * UNHEALTHY/UNREACHABLE with NO container -> rebuild. Nothing to manage.
///   * UNHEALTHY with a container -> maintain. The resource is really there and
///     the node may still be managing it; rebuilding would orphan a live
///     container, which is the ownership invariant this repository treats as
///     inviolable.
///   * any other state -> maintain. STARTING/READY/STOPPING are all rows whose
///     `container_id` may legitimately be null for one reconcile tick.
fn must_rebuild(row: &InstanceRow) -> bool {
    is_ghost_instance(row)
}

/// What occupies a node, as the placement planner counts it.
///
/// Two aggregates read this - one for instance slots, one for CPU and memory -
/// and they drifted: a ghost exclusion was added to the count and not to the
/// allocation sum, so a failed instance stopped using a slot while still
/// reserving its full CPU and memory. The node then looked free by one measure
/// and full by another, and the answer depended on which check ran first.
///
/// Both queries are built from the same fragment, and
/// `the_capacity_queries_both_exclude_ghosts` fails if either stops matching.
/// An instance that failed and holds no container is not using the node; one
/// that failed but still has a container is, because the resource is really
/// there and may still be under management.
#[cfg(test)]
const NOT_A_GHOST: &str = "NOT (i.state IN ('UNHEALTHY','UNREACHABLE') AND i.container_id IS NULL)";

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
                "UPDATE kernel.plugin_deployments SET status='PENDING', status_reason='Redeploy requested', desired_replicas=$2, resources=$3, placement=$4, generation=generation+1, updated_at=now(), drain_until=NULL, attempt_started_at=now() WHERE id=$1",
            )
            .bind(existing.id)
            .bind(payload.desired_replicas)
            .bind(&resources_json)
            .bind(&placement)
            .execute(&state.db)
            .await?;
            // A REDEPLOY MAKES ITS OLD ROWS GHOSTS, NOT START CLAIMS AND NOT STOPS
            // (TASK-12).
            //
            // This statement has now been wrong in two different ways, and both were
            // measured against a running platform rather than reasoned about.
            //
            // IT USED TO SET `desired_action='START', state='STARTING'`. The capacity
            // aggregates count START instances on deployments in the planned set, and
            // PENDING is in that set, so on a node already at its limit a redeploy
            // took the planner's occupancy from `limit` to `limit + 1` before anything
            // evaluated whether the rows would fit.
            //
            // SO IT WAS CHANGED TO `desired_action='STOP'`, WHICH BROKE REDEPLOY
            // ENTIRELY. `reconcile_deployment`'s loop has two branches for a row that
            // already exists: `existing_node_ok` (requires `desired_action ==
            // 'START'`) re-asserts it, and `must_rebuild` re-creates it **only for a
            // ghost** (`UNHEALTHY`/`UNREACHABLE` with no container). A STOP row on the
            // same node that is not a ghost matches NEITHER, so the slot is skipped and
            // the instance never comes back. Caught by the platform lifecycle
            // acceptance (`an instance was still not terminal 60s after uninstall`) on
            // CI, twice, while a local run passed - the local topology let the row move
            // nodes, which hid it.
            //
            // A GHOST IS THE ONE SHAPE THAT IS BOTH INVISIBLE AND RECOVERABLE.
            // `is_ghost_instance` excludes it from every capacity aggregate and from
            // `used_nodes`, so it claims no slot; `must_rebuild` returns true for it,
            // so the planner re-creates it through `evaluate_node` like a new
            // placement. That is what a redeploy means: the old containers are being
            // replaced, and whether the replacements fit is the planner's question.
            //
            // `container_id` is cleared deliberately: the row is being re-created, and
            // keeping the id would describe a container this row no longer owns.
            sqlx::query(
                "UPDATE kernel.plugin_instances
                    SET deployment_generation=$2, desired_action='START',
                        state='UNREACHABLE', container_id=NULL, observed_at=NULL,
                        updated_at=now()
                  WHERE deployment_id=$1",
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
    // -------------------------------------------------------------------------
    // RELEASE THE OLD VERSION BEFORE PLACING THE NEW ONE. (ADR-027)
    //
    // `plugin_deployments` has ONE ROW PER VERSION, and nothing used to disable
    // the previous version's row. So each publish left the old deployment
    // `START`-ing its own healthy instance and asked for a slot beside it:
    //
    //     publish 0.0.17453 -> deployment A, 1 instance, node 1/4
    //     publish 0.0.17454 -> deployment B, 1 instance, node 2/4  (A still up)
    //     publish 0.0.17455 -> deployment C, 1 instance, node 3/4  (A, B still up)
    //     publish 0.0.17456 -> deployment D, 1 instance, node 4/4
    //     publish next      -> INSTANCE_CAPACITY_EXCEEDED
    //
    // Measured twice on staging (runs 44016184862 and 44029228405): the publish
    // step failed with `4 instances already scheduled on this node against a
    // per-node limit of 4`, after the Kernel had already been replaced. That is
    // ADR-026's "Kernel new / Plugin old" state, and its cause was here: the
    // platform kept every version it had ever deployed running.
    //
    // Two fixes were aimed at this and neither could help, because both were
    // about GHOST instances: `is_ghost_instance` / the capacity predicates exclude
    // `UNHEALTHY`/`UNREACHABLE` rows with no container, and `must_rebuild`
    // re-creates such a row. These four rows are healthy and hold containers;
    // they are counted correctly. The message looks like a capacity bug because it
    // IS a capacity message - the capacity is being spent on old versions.
    //
    // DRAINING is the existing mechanism: `reconcile_once` disables a DRAINING
    // deployment once `drain_until` has passed, and the instances it owns stop
    // asking for slots. `drain_until = now()` means the next reconcile pass
    // releases them, which is the same pass that places the new version.
    //
    // Deliberately NOT `DISABLED` here: a DRAINING row is still observable, so an
    // operator (and the publish journal ADR-026 proposes) can see that this
    // version was superseded rather than deleted. The reconciler is what performs
    // the final transition, keeping one owner for status changes.
    //
    // NOT drained here. See `activate`: the previous version keeps its instances
    // until the route actually moves, because deploy-then-activate is the whole
    // blue/green contract and a deploy-time drain empties the route before the new
    // version may serve. The acceptance suite asserts it directly:
    // `10/10 requests left v1 while v2 was not activated`.
    // THE CAPACITY PLAN, ATTACHED TO THE ACCEPTANCE.
    //
    // Staging learns it has no slots by timing out after a full image build
    // (`deploy --wait` → `timed out waiting for deployment readiness`). The
    // condition is knowable NOW, and `placement_preflight` already answers it with
    // the scheduler's own `evaluate_node`.
    //
    // This does NOT refuse the deploy. A placement refusal that blocked the create
    // would change the contract of an endpoint whose callers already handle "accepted
    // and PENDING", and would make a transient capacity state look like a permanent
    // rejection. What it does is make the answer available in the response the
    // caller already reads, so `deploy --wait` can fail with `RECLAIM_REQUIRED` and
    // the names of the rows in the way, instead of with a timeout.
    //
    // Read-only, and failure to compute it must not fail the deploy: a plan is
    // advice, and an advisory that can reject a valid deploy is worse than none.
    let capacity_plan = crate::placement_preflight::gather(
        &state.db,
        None,
        payload.node_selector.clone(),
        resources.clone(),
        payload.desired_replicas,
        max_per_node as usize,
        state.config.max_instances_per_node as usize,
    )
    .await
    .map_err(|error| {
        tracing::warn!(error = %error, "capacity plan could not be computed; the deploy proceeds");
        error
    })
    .ok();

    sqlx::query(
        r#"
        INSERT INTO kernel.plugin_deployments
          (id, plugin_id, package_id, version, desired_replicas, generation, placement, resources, status, status_reason, attempt_started_at)
        VALUES ($1,$2,$3,$4,$5,1,$6,$7,'PENDING','Waiting for placement',now())
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
    let mut body =
        serde_json::to_value(deployment_view(state, row).await?).map_err(AppError::from)?;
    if let Some(plan) = capacity_plan {
        if let Some(object) = body.as_object_mut() {
            object.insert(
                "capacityPlan".into(),
                serde_json::to_value(plan).map_err(AppError::from)?,
            );
        }
    }
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
    // The previous version is released by the DRAINING write below (the one that
    // runs when `active` names a different deployment), with a 15-second grace
    // period. It predates this round - commit 67966aa (#50) - and it was already
    // correct.
    //
    // This is where an earlier version of this branch put a SECOND drain, with
    // `drain_until` in the past. It was redundant at best and harmful at worst:
    // the existing one gives 15 seconds for in-flight requests, the duplicate
    // gave none. Removed rather than kept "for safety" - two writers of the same
    // transition is how the two capacity queries drifted apart in the first
    // place.
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
            "UPDATE kernel.plugin_deployments SET status='PENDING', status_reason='Enable requested', generation=generation+1, updated_at=now(), attempt_started_at=now() WHERE id=$1",
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

/// Read the ACTIVE activation for a plugin, if any.
async fn active_version_of(
    state: &AppState,
    plugin_id: &str,
) -> AppResult<(Option<String>, Option<i64>)> {
    let active: Option<ActivationRow> = sqlx::query_as::<_, ActivationRow>(
        "SELECT * FROM kernel.activation_revisions WHERE plugin_id=$1 AND status='ACTIVE'",
    )
    .bind(plugin_id)
    .fetch_optional(&state.db)
    .await?;
    Ok(match active {
        Some(row) => (Some(row.version), Some(row.generation)),
        None => (None, None),
    })
}

/// Attach the uniform rollback outcome to a body produced by any branch.
///
/// `completed` is not passed in: it is computed from the database after the
/// branch has run, so no branch can claim to have finished by returning a
/// success-shaped payload. `effectiveVersion` and `effectiveRevision` are read
/// from the ACTIVE activation row, which is exactly what the gateway routes on.
async fn rollback_response(
    state: &AppState,
    plugin_id: &str,
    target_version: &str,
    mut body: Value,
    pending_activation: bool,
    next_step: Option<&str>,
) -> AppResult<Value> {
    let (effective_version, effective_revision) = active_version_of(state, plugin_id).await?;
    let completed = effective_version.as_deref() == Some(target_version);
    if let Some(object) = body.as_object_mut() {
        object.insert(
            "targetVersion".into(),
            Value::String(target_version.to_string()),
        );
        object.insert(
            "effectiveVersion".into(),
            effective_version.map(Value::String).unwrap_or(Value::Null),
        );
        object.insert(
            "effectiveRevision".into(),
            effective_revision.map(Value::from).unwrap_or(Value::Null),
        );
        object.insert("rollbackCompleted".into(), Value::Bool(completed));
        object.insert(
            "pendingActivation".into(),
            Value::Bool(pending_activation && !completed),
        );
        object.insert(
            "nextStep".into(),
            match next_step {
                Some(step) if !completed => Value::String(step.to_string()),
                _ => Value::Null,
            },
        );
    }
    Ok(body)
}

/// The retire decision, separated from the HTTP and auth plumbing.
///
/// WHY A PURE FUNCTION. `retire_deployment` is an axum handler: it needs an
/// `AuthUser`, a `State` and a `Path`, none of which a unit test should have to
/// construct. The rules - which generations are refused, which statuses are
/// already-done, whether the active revision may be retired - are the part worth
/// testing, and they depend on five values, not on a request.
///
/// What stays in the handler: authentication, the transaction, the audit row.
#[derive(Debug, PartialEq, Eq)]
pub enum RetireDecision {
    /// Go ahead; this many instances would be stopped.
    Proceed,
    /// Already retired at the requested generation. Idempotent success.
    AlreadyRetired,
    /// The caller's generation is stale.
    GenerationConflict,
    /// This deployment IS the plugin's active revision.
    IsActiveRevision,
}

/// @param current_generation the row's generation
/// @param current_status     the row's status
/// @param expected_generation what the caller believes
/// @param active_deployment  the plugin's ACTIVE revision, if any
/// @param this_deployment    the id being retired
pub fn retire_decision(
    current_generation: i64,
    current_status: &str,
    expected_generation: i64,
    active_deployment: Option<&str>,
    this_deployment: &str,
) -> RetireDecision {
    // GENERATION FIRST. A stale caller must not reach the idempotent branch: it
    // would answer "nothing to do" and confirm a belief about a generation that is
    // no longer current. `rollback` had exactly this defect and its comment records
    // the measurement.
    if current_generation != expected_generation {
        return RetireDecision::GenerationConflict;
    }
    if current_status == "DISABLED" {
        return RetireDecision::AlreadyRetired;
    }
    if active_deployment == Some(this_deployment) {
        return RetireDecision::IsActiveRevision;
    }
    RetireDecision::Proceed
}

/// Request body for retiring ONE deployment.
#[derive(Debug, Deserialize)]
pub struct RetireRequest {
    /// The generation the caller believes is current. A mismatch is a 409, not a
    /// best-effort retire: retiring a deployment someone else has since changed is
    /// how a live version is stopped by a request about a different one.
    pub expected_generation: i64,
    /// Report what WOULD happen and change nothing.
    #[serde(default)]
    pub dry_run: bool,
}

/// Retire ONE deployment, keeping the plugin package and all business data.
///
/// WHY THIS IS NOT `uninstall`
///
/// `uninstall` takes a PLUGIN id and disables EVERY deployment of it:
///
///     UPDATE ... SET status='DISABLED' WHERE plugin_id=$1
///
/// That is the right operation for "this plugin is going away". It is the wrong
/// operation for "free the slots held by ONE old version" - which is the staging
/// situation: four deployments, at most two of which are the version anyone wants,
/// and the rest are ACTIVE revisions of the same plugin. Retiring one of them
/// through `uninstall` would stop the version that is serving.
///
/// WHAT IT GUARANTEES
///
///   - the ACTIVE revision of the plugin is REFUSED. Retiring what is serving is a
///     rollback or a disable, both of which have their own paths and their own
///     checks; doing it here would be a third, quieter way to stop production.
///   - `expected_generation` is a compare-and-set. A stale caller gets 409.
///   - the plugin PACKAGE is untouched: nothing here deletes from
///     `plugin_packages` or `plugin_installations`.
///   - business DATA is untouched. The kernel does not own plugin storage and this
///     function does not reach it.
///   - instances are stopped, not deleted. The row is the record of what ran.
///   - the reason is written, so the next reader knows why the deployment is
///     DISABLED rather than finding a status with no context.
///   - idempotent: retiring an already-DISABLED deployment at the same generation is
///     a 200 with `idempotent: true`, so a retried request does not fail.
pub async fn retire_deployment(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(deployment_id): Path<Uuid>,
    Json(payload): Json<RetireRequest>,
) -> AppResult<(StatusCode, Json<serde_json::Value>)> {
    auth.require_operator()?;

    let row = sqlx::query_as::<_, (String, i64, String, Option<String>)>(
        "SELECT plugin_id, generation, status, status_reason FROM kernel.plugin_deployments WHERE id=$1",
    )
    .bind(deployment_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found("no such deployment"))?;
    let (plugin_id, generation, status, reason) = row;

    // THE ACTIVE REVISION IS NOT RETIRED HERE.
    let active: Option<String> = sqlx::query_scalar(
        "SELECT deployment_id::text FROM kernel.activation_revisions \
         WHERE plugin_id=$1 AND status='ACTIVE' LIMIT 1",
    )
    .bind(&plugin_id)
    .fetch_optional(&state.db)
    .await?;

    match retire_decision(
        generation,
        &status,
        payload.expected_generation,
        active.as_deref(),
        &deployment_id.to_string(),
    ) {
        RetireDecision::GenerationConflict => {
            return Err(AppError::conflict(
                "GENERATION_CONFLICT",
                format!(
                    "deployment is at generation {generation}, the request expected {}. \
                     Re-read it and retry; retiring a deployment someone else has changed \
                     is how a live version gets stopped by a request about a different one",
                    payload.expected_generation
                ),
            ));
        }
        // IDEMPOTENT: already retired at this generation is the answer asked for.
        RetireDecision::AlreadyRetired => {
            return Ok((
                StatusCode::OK,
                Json(json!({
                    "deploymentId": deployment_id,
                    "idempotent": true,
                    "status": status,
                    "reason": reason,
                })),
            ));
        }
        RetireDecision::IsActiveRevision => {
            return Err(AppError::conflict(
                "DEPLOYMENT_IS_ACTIVE",
                "this deployment is the plugin's ACTIVE revision. Use rollback to move the \
                 active revision to another version, or disable the plugin - retiring the \
                 serving version would stop it with none of their checks",
            ));
        }
        RetireDecision::Proceed => {}
    }

    // What WOULD change, computed before anything is written so `dry_run` reports
    // the same facts the real call acts on.
    let instances: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM kernel.plugin_instances WHERE deployment_id=$1 AND desired_action='START'",
    )
    .bind(deployment_id)
    .fetch_one(&state.db)
    .await?;
    let containers: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM kernel.plugin_instances WHERE deployment_id=$1 \
         AND desired_action='START' AND container_id IS NOT NULL",
    )
    .bind(deployment_id)
    .fetch_one(&state.db)
    .await?;

    if payload.dry_run {
        return Ok((
            StatusCode::OK,
            Json(json!({
                "deploymentId": deployment_id,
                "dryRun": true,
                "wouldStop": { "instances": instances, "containers": containers },
                "wouldKeep": {
                    "pluginPackage": true,
                    "businessData": true,
                    "instanceRows": true,
                },
            })),
        ));
    }

    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE kernel.plugin_instances SET desired_action='STOP', updated_at=now() \
         WHERE deployment_id=$1 AND desired_action='START'",
    )
    .bind(deployment_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE kernel.plugin_deployments SET status='DISABLED', \
         status_reason='Retired by operator; plugin package and data retained', \
         updated_at=now() WHERE id=$1 AND generation=$2",
    )
    .bind(deployment_id)
    .bind(payload.expected_generation)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    audit::record(
        &state.db,
        "deployment.retired",
        "USER",
        &auth.user_id.to_string(),
        "deployment",
        &deployment_id.to_string(),
        "deployment.retire",
        "CONFIRMED",
        json!({ "expectedGeneration": payload.expected_generation, "stoppedInstances": instances }),
        None,
    )
    .await
    .ok();

    Ok((
        StatusCode::OK,
        Json(json!({
            "deploymentId": deployment_id,
            "idempotent": false,
            "status": "DISABLED",
            "stopped": { "instances": instances, "containers": containers },
            "kept": { "pluginPackage": true, "businessData": true },
        })),
    ))
}

pub async fn rollback(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(plugin_id): Path<String>,
    Json(payload): Json<RollbackRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    auth.require_operator()?;

    let (effective_before, revision_before) = active_version_of(&state, &plugin_id).await?;

    // Reject a stale expectedRevision BEFORE doing any work, and before the
    // idempotent short-circuit below.
    //
    // Order matters, and this is the case that proves it: a caller asking to roll
    // back to a version that is ALREADY active, but holding an OUTDATED
    // expectedRevision, used to get a 200 { idempotent: true }. Their
    // compare-and-swap was silently ignored and the answer "nothing to do"
    // confirmed a belief about the current revision that was false. Every other
    // path checked the revision; this one did not.
    //
    // `activate_inner` also checks it, but only after a redeploy has run, so a
    // caller holding an outdated revision waited out a full redeploy to be told
    // the request was never valid. Measured 2026-11-11: minutes, then a 409.
    if revision_before.unwrap_or(0) != payload.expected_revision {
        return Err(AppError::conflict(
            "REVISION_CONFLICT",
            format!(
                "expectedRevision {} does not match current active revision {}",
                payload.expected_revision,
                revision_before.unwrap_or(0)
            ),
        ));
    }

    // Idempotency: rolling back to the version that is already effective is a
    // completed rollback, not an error. A retried request lands here after the
    // first attempt succeeded, so refusing it would turn a retry into a false
    // failure. `expectedRevision` has already been verified above, so reaching
    // this point means the caller's view of the world was accurate.
    if effective_before.as_deref() == Some(payload.target_version.as_str()) {
        let mut body = json!({ "status": "ACTIVE" });
        if let Some(object) = body.as_object_mut() {
            object.insert("idempotent".into(), Value::Bool(true));
        }
        return rollback_response(
            &state,
            &plugin_id,
            &payload.target_version,
            body,
            false,
            None,
        )
        .await
        .map(|body| (StatusCode::OK, Json(body)));
    }

    let target = sqlx::query_as::<_, DeploymentRow>(
        "SELECT * FROM kernel.plugin_deployments WHERE plugin_id=$1 AND version=$2",
    )
    .bind(&plugin_id)
    .bind(&payload.target_version)
    .fetch_optional(&state.db)
    .await?;

    let Some(target) = target else {
        // No deployment for that version yet. Create one and say plainly that it
        // is not active - the caller, or `opsctl rollback`, must activate it once
        // it is READY. Refusing outright would make "rollback to a version that
        // was never deployed here" impossible, which is wrong: the package only
        // has to be staged.
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
        let (status, value) = create_deployment_inner(&state, &auth, &plugin_id, &create).await?;
        let body = rollback_response(
            &state,
            &plugin_id,
            &payload.target_version,
            value,
            true,
            Some("the deployment did not exist; wait for it to reach READY, then activate it"),
        )
        .await?;
        return Ok((status, Json(body)));
    };

    match target.status.as_str() {
        // Already built and healthy: switch the route now.
        "READY" => {
            let activate = ActivateRequest {
                version: target.version.clone(),
                expected_revision: payload.expected_revision,
            };
            let (status, value) = activate_inner(&state, &auth, &plugin_id, &activate).await?;
            let body = rollback_response(
                &state,
                &plugin_id,
                &payload.target_version,
                value,
                false,
                None,
            )
            .await?;
            Ok((status, Json(body)))
        }
        // Being built right now. Report the state truthfully; do not claim to have
        // activated something that is not READY, and do not start a second build.
        "PENDING" | "PREPARING" => {
            let body = serde_json::to_value(deployment_view(&state, target).await?)
                .map_err(AppError::from)?;
            let body = rollback_response(
                &state,
                &plugin_id,
                &payload.target_version,
                body,
                true,
                Some("the deployment is still starting; wait for READY, then activate it"),
            )
            .await?;
            Ok((StatusCode::ACCEPTED, Json(body)))
        }
        // Everything else (ACTIVE, DISABLED, DRAINING, FAILED, DEGRADED) has to be
        // redeployed before it can be activated. `activate_inner` refuses anything
        // that is not READY, and the redeploy is asynchronous, so this call cannot
        // finish the rollback - it says so instead of returning a bare 200.
        other => {
            let create = CreateDeploymentRequest {
                version: payload.target_version.clone(),
                desired_replicas: payload.desired_replicas.unwrap_or(2),
                node_selector: BTreeMap::new(),
                max_instances_per_node: Some(1),
                cpu_millis: None,
                memory_mib: None,
            };
            let (status, value) =
                create_deployment_inner(&state, &auth, &plugin_id, &create).await?;
            let body = rollback_response(
                &state,
                &plugin_id,
                &payload.target_version,
                value,
                true,
                Some(&format!(
                    "the target deployment was {other}; it must be redeployed and reach READY \
                     before activation can switch the route"
                )),
            )
            .await?;
            Ok((status, Json(body)))
        }
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

/// READ-ONLY: would a deploy of `replicas` fit right now, and if not, why.
///
/// WHY AN ENDPOINT AND NOT A DOCUMENT
///
/// Staging fails with `INSTANCE_CAPACITY_EXCEEDED` after a full image build. The
/// condition is knowable beforehand, and the answer lived in
/// `docs/ci/staging-capacity-diagnosis.md` - a snapshot of one query on one day.
/// A document goes stale in exactly the direction that matters here.
///
/// This runs the SAME `evaluate_node` the scheduler runs, so it cannot answer FITS
/// for a deployment the planner then refuses. It writes nothing.
///
/// The response carries `caveat` because a preflight is an estimate: another
/// deployment can place between this call and the real one, and the scheduler
/// still re-evaluates every slot.
pub async fn capacity_preflight(
    State(state): State<crate::state::AppState>,
    auth: crate::auth::AuthUser,
    Query(params): Query<CapacityQuery>,
) -> crate::error::AppResult<Json<crate::placement_preflight::Preflight>> {
    let _ = auth;
    let replicas = params.replicas.unwrap_or(1).clamp(1, 20);
    let selector: std::collections::BTreeMap<String, String> = params
        .selector
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();
    let requested = opsweave_contracts::ResourceRequirements {
        cpu_millis: params.cpu_millis.unwrap_or(500),
        memory_mib: params.memory_mib.unwrap_or(256),
    };
    let report = crate::placement_preflight::gather(
        &state.db,
        None,
        selector,
        requested,
        replicas,
        params
            .max_instances_per_deployment
            .unwrap_or(1)
            .clamp(1, 20),
        state.config.max_instances_per_node as usize,
    )
    .await
    .map_err(|e| crate::error::AppError::internal(e.to_string()))?;
    Ok(Json(report))
}

/// Query for the preflight endpoint. All optional; the defaults describe a single
/// small replica with no selector, which is the shape a first deploy has.
#[derive(Debug, serde::Deserialize)]
pub struct CapacityQuery {
    pub replicas: Option<i32>,
    /// JSON object, e.g. `{"pool":"data"}`.
    pub selector: Option<String>,
    pub cpu_millis: Option<i64>,
    pub memory_mib: Option<i64>,
    pub max_instances_per_deployment: Option<usize>,
}

pub async fn reconcile_once(state: &AppState) -> anyhow::Result<()> {
    reconcile_once_scoped(state, None).await
}

/// `reconcile_once`, optionally restricted to ONE deployment.
///
/// The `None` case is production: every sweep is global and every active
/// deployment is planned, because that is what a single-node kernel has to do.
///
/// `Some(id)` exists for tests, and it is not a convenience - it is the
/// difference between a test that measures its own fixture and one that measures
/// whatever else happens to be in the database.
///
/// Measured cost of not having it: this module's tests share one database and
/// `cargo test` runs them in parallel. `a_ghost_is_rebuilt_to_starting_and_stays_there`
/// calls the global reconcile, which
///
///   * sweeps every node whose heartbeat is older than `node_stale_seconds` to
///     UNREACHABLE, and every instance on it - including the nodes other tests
///     created seconds earlier with `now()` heartbeats, and
///   * plans every deployment, re-asserting `desired_action` on instances other
///     fixtures had just inserted.
///
/// On CI that surfaced as `a_ghost_occupies_neither_a_slot_nor_cpu` failing with
/// `left: 1, right: 3` - a capacity test broken by an unrelated reconciler run.
/// Scoping removes the interference without changing what production does.
async fn reconcile_once_scoped(
    state: &AppState,
    only_deployment: Option<Uuid>,
) -> anyhow::Result<()> {
    // ONE PLANNER AT A TIME, PER SCHEMA.
    //
    // `reconcile_deployment` reads the per-node instance aggregate and then
    // inserts, with no lock between the two. Two planners overlapping therefore
    // both read "one free slot" and both take it: measured, two reconciles of two
    // one-replica deployments on a node whose per-node limit is 1 left TWO START
    // instances in 4 of 12 runs.
    //
    // The lock is taken HERE rather than per deployment because the aggregate is
    // global - a per-deployment lock would serialise the two writers while leaving
    // both readers stale, which is the same race with more steps.
    //
    // SKIP OR WAIT DEPENDS ON WHO IS ASKING.
    //
    // A ticker fires every 2s and must not queue behind a slow sweep: if another
    // planner holds the lock, that planner is about to look at the same rows and
    // this cycle is redundant. `try` and return early is correct there.
    //
    // A REQUESTED reconcile must WAIT. This module's tests call
    // `reconcile_once_scoped(state, Some(id))` directly and run in parallel against
    // one database; with `try` everywhere, the tests that lost the race returned
    // `Ok(())` having planned nothing, and then asserted on a database nobody had
    // looked at. Five failed that way when this lock was first added - the lock was
    // right, its effect on the harness was not.
    //
    // `only_deployment.is_some()` is exactly "someone asked for this one deployment
    // and is waiting for the answer", which is the case that must wait.
    //
    // The key is derived from the database name so two kernels on different
    // databases in one PostgreSQL cluster do not block each other.
    const PLANNER_LOCK_NAMESPACE: i32 = 0x0F5E_0002;
    let mut conn = state.db.acquire().await?;
    let acquired: bool = if only_deployment.is_some() {
        sqlx::query("SELECT pg_advisory_lock($1, hashtext(current_database()))")
            .bind(PLANNER_LOCK_NAMESPACE)
            .execute(&mut *conn)
            .await?;
        true
    } else {
        sqlx::query_scalar("SELECT pg_try_advisory_lock($1, hashtext(current_database()))")
            .bind(PLANNER_LOCK_NAMESPACE)
            .fetch_one(&mut *conn)
            .await?
    };
    if !acquired {
        tracing::debug!("another planner holds the lock; this cycle has nothing to add");
        return Ok(());
    }
    // Released explicitly at the end rather than relying on the connection closing:
    // the pool reuses connections, so a leaked session lock would disable planning
    // until the process restarted - a far worse failure than the race it prevents.
    let result = reconcile_once_locked(state, only_deployment).await;
    let _ = sqlx::query("SELECT pg_advisory_unlock($1, hashtext(current_database()))")
        .bind(PLANNER_LOCK_NAMESPACE)
        .execute(&mut *conn)
        .await;
    drop(conn);
    result
}

/// The body of one reconciliation cycle. Callers hold the planner lock.
async fn reconcile_once_locked(
    state: &AppState,
    only_deployment: Option<Uuid>,
) -> anyhow::Result<()> {
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
    // RELEASE A SUPERSEDED CANDIDATE THAT WAS NEVER ACTIVATED.
    //
    // Staging run 45570951551 filled its node with four instances and every later
    // publish failed with INSTANCE_CAPACITY_EXCEEDED. The rows that accumulated
    // were NOT superseded-by-activation versions: `deploy --wait` times out on
    // capacity, so `activate` never runs, so the DRAINING write inside it never
    // runs. They are deployments that reached READY and were then overtaken by a
    // newer version of the SAME plugin without either one being activated.
    //
    // `reconcile_once` plans every READY row, so each of them kept re-asserting
    // `desired_action='START'` forever. Nothing released them: the only writes
    // that reach DISABLED need a DRAINING row (which needs activate), an
    // uninstall, or an operator setting desired_replicas to zero.
    //
    // WHAT THIS DOES NOT DO. It does not delete a row, does not touch an ACTIVE
    // deployment, and does not cross plugin boundaries.
    //
    // IT DOES NOT COMPARE VERSIONS, AND THE FIRST VERSION OF THIS DID.
    //
    // The first draft asked `newer.version > d.version`. That looks like a
    // recency test and is not one: this repository's versions are
    // `0.0.$(src_hash % 100000)` - a CONTENT FINGERPRINT, not a counter. ADR-025
    // says so directly: "the number is a content fingerprint, not a counter:
    // there is no ordering". `0.0.9` is not older than `0.0.10`; string-compared,
    // `"0.0.9" > "0.0.10"` is even true, which would make the rule reclaim the
    // WRONG candidate the moment two versions straddle a digit boundary.
    //
    // The real question is "was this row superseded", and the answer the kernel
    // already keeps is `created_at`: a redeploy always inserts a NEW row, and the
    // codebase sorts by `created_at DESC` wherever it asks for "the latest"
    // (deployments.rs:228, :956). A plugin with one candidate is never affected,
    // which is what keeps a first deploy alone.
    //
    // It reuses DRAINING rather than disabling directly, for the reasons the
    // ADR-027 test asserts: DRAINING keeps the row observable, the reconcile sweep
    // owns the transition to DISABLED, and the existing STOP write below is what
    // actually frees the slot. A second delete path would duplicate all three.
    //
    // The grace is 0 seconds because there is no route to protect: a deployment
    // that was never activated serves no traffic, so there is nothing to drain.
    // That is the difference from `activate`'s 15 seconds, and it is the reason
    // this must not be folded into the activation path.
    //
    // IT ONLY MAKES ROOM WHEN SOMETHING IS WAITING FOR ONE, and that clause was
    // added because the first version of this statement broke rollback.
    //
    // Measured: `rollback` to a version with no deployment creates one and returns
    // "wait for it to reach READY, then activate it". Between READY and that
    // activate call the row is exactly what this statement looks for - READY,
    // never activated, superseded by a newer version because a rollback goes
    // BACKWARD. The unguarded version drained 0.0.1 while an operator was in the
    // middle of rolling back to it, and the rollback failed with "no deployment"
    // a second time. `a_rollback_target_is_not_reclaimed_while_it_is_being_activated`
    // is that counterexample.
    //
    // So the candidate is released only when the same plugin has a deployment in
    // PENDING or PREPARING - i.e. something is actively blocked on a slot right
    // now. A rollback target has nothing pending (the newer version is READY), so
    // it is left alone. Staging's data-catalog@0.0.65450 WAS PENDING, which is
    // what the same rule releases for.
    // THE RULE IS A FUNCTION NOW, NOT A SECOND COPY OF SQL (ADR-030 D2).
    //
    // This used to be one statement whose predicate the preflight duplicated so an
    // operator could be told what a reclaim would free. The two copies drifted once
    // already - Phase 8 found them ordering supersession by `version`, a content
    // hash with no ordering - and the fix at the time was a test that compared them.
    // A shared decision is cheaper than a test proving two implementations agree.
    //
    // `reclaim_facts` reads; `reclaim_eligibility` decides; the write below is the
    // only place a status changes, and it is fenced on BOTH the status the decision
    // saw and its generation - so a deployment that was activated, re-deployed or
    // otherwise moved between the read and this write simply does not match. That is
    // ADR-030 D3/E6, and it needs no extra lock.
    let facts = crate::placement_preflight::reclaim_facts(&state.db).await?;
    for fact in facts {
        let decision = crate::placement_preflight::reclaim_eligibility(&fact);
        if !decision.is_reclaimable() {
            continue;
        }
        // The reason names the decision that permitted it, so the row explains
        // itself: an operator reading `status_reason` sees which rule released it,
        // not only that something was newer.
        let reason = format!(
            "Superseded by a newer candidate; released by {} (was {})",
            decision.code(),
            fact.status
        );
        sqlx::query(
            r#"
            UPDATE kernel.plugin_deployments
               SET status='DRAINING', status_reason=$2, drain_until=now(), updated_at=now()
             WHERE id=$1 AND status=$3 AND generation=$4
            "#,
        )
        .bind(fact.deployment_id)
        .bind(&reason)
        .bind(&fact.status)
        .bind(fact.generation)
        .execute(&state.db)
        .await?;
    }
    sqlx::query(
        "UPDATE kernel.plugin_deployments SET status='DISABLED', status_reason='Drain window elapsed', updated_at=now() WHERE status='DRAINING' AND drain_until IS NOT NULL AND drain_until < now()",
    )
    .execute(&state.db)
    .await?;

    // A deployment that is no longer active must not keep asking for slots.
    //
    // The loop below only plans the ACTIVE set, so an instance whose deployment
    // just became DISABLED was never looked at again - its `desired_action` stayed
    // `START` forever and it held its node slot with nothing running on it. Found
    // by ADR-027's own test: after the drain, `SELECT count(*) ... desired_action
    // ='START'` was still 2 while both deployments read DISABLED.
    //
    // The same shape as the ghost defect, one level up: a row describing work that
    // will never happen, still counted. Stopping it here rather than in the
    // per-deployment loop is what makes DISABLED mean "released" for every status
    // that reaches it - drain, uninstall, or an operator setting desired_replicas
    // to zero.
    //
    // `state` is left alone: the node reports what it actually did with the
    // container, and overwriting that here would be the kernel claiming knowledge
    // it does not have.
    sqlx::query(
        r#"
        UPDATE kernel.plugin_instances i SET desired_action='STOP', updated_at=now()
        FROM kernel.plugin_deployments d
        WHERE i.deployment_id = d.id
          AND d.status = 'DISABLED'
          AND i.desired_action <> 'STOP'
        "#,
    )
    .execute(&state.db)
    .await?;

    let deployments = sqlx::query_as::<_, DeploymentRow>(
        "SELECT * FROM kernel.plugin_deployments WHERE status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED') ORDER BY created_at",
    )
    .fetch_all(&state.db)
    .await?;
    for deployment in deployments {
        if only_deployment.is_some_and(|id| id != deployment.id) {
            continue;
        }
        if let Err(error) = reconcile_deployment(state, deployment).await {
            tracing::error!(error = %error, "deployment reconciliation failed");
        }
    }
    Ok(())
}

/// The one statement that writes a deployment's computed status.
///
/// A constant rather than an inline string so `generation_fencing` runs THE
/// PRODUCTION STATEMENT. A test that repeats the SQL proves the copy is right;
/// `nodes.rs` learned that when a counterfactual removing a guard left the
/// copy-based test green.
///
/// `generation=$4` is TASK-13's fence: everything that produced `$2` was read at the
/// start of the pass, and a redeploy can bump the row in between.
pub(crate) const STATUS_WRITE_BACK_SQL: &str = r#"
    UPDATE kernel.plugin_deployments
       SET status=$2,
           status_reason=$3,
           updated_at=now(),
           attempt_started_at = CASE
               WHEN $2 = 'PENDING' THEN COALESCE(attempt_started_at, now())
               ELSE NULL
           END
     WHERE id=$1 AND status<>'DRAINING' AND generation=$4
    "#;

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
          AND NOT (i.state IN ('UNHEALTHY','UNREACHABLE') AND i.container_id IS NULL)
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
          -- An instance that failed and holds no container is not using the
          -- node. Without this a single failed image pull leaves a row that
          -- occupies a per-node slot forever, and every later deployment of ANY
          -- plugin on that node is refused with INSTANCE_CAPACITY_EXCEEDED.
          --
          -- This is the query the planner actually limits against;
          -- `used_nodes` below is a second, narrower count. Fixing only that one
          -- changed nothing, which is how this was found: the kernel served the
          -- fix, the ghost row was still there, and the deploy still refused.
          AND NOT (i.state IN ('UNHEALTHY','UNREACHABLE') AND i.container_id IS NULL)
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
    // What occupies a slot on a node.
    //
    // This counted every row with `desired_action == "START"`, including
    // instances that are UNHEALTHY and hold no container at all. Those can never
    // recover on their own - the scheduler is not going to start them - so they
    // held a slot forever and every later deployment of any plugin failed with
    // INSTANCE_CAPACITY_EXCEEDED against a node that had free capacity.
    //
    // Measured on staging 2026-11-16: three containers running, four instances
    // counted, and the fourth was an UNHEALTHY row with `container_id IS NULL`
    // left by a deployment whose image could not be pulled.
    //
    // NOTE: this is NOT the count the planner limits against. The per-node limit
    // is enforced on `global_instance_counts`, a SQL aggregate defined above. Fixing
    // this one alone changed nothing on staging - the kernel served the fix and the
    // deploy still refused - which is how the other query was found. Both now
    // exclude the same shape; if you add a third count, exclude it there too.
    //
    // The rule now: a failed instance with no container is not using the node.
    // One that HAS a container still counts even when unhealthy, because it is
    // occupying real resources and the scheduler may still be managing it.
    let mut used_nodes: HashMap<Uuid, usize> = existing
        .iter()
        .filter(|row| {
            row.slot < deployment.desired_replicas
                && row.desired_action == "START"
                && !is_ghost_instance(row)
        })
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
    let mut placement_rejection: Option<(String, PlacementRejection, Uuid)> = None;

    for slot in 0..deployment.desired_replicas {
        let current = by_slot.get(&slot).cloned();
        // A ghost does NOT count as "existing and fine", however healthy its
        // `desired_action` looks. Without this clause the row is re-asserted as
        // START on every pass and never rebuilt - see `must_rebuild`.
        let existing_node_ok = current
            .as_ref()
            .map(|row| {
                row.desired_action == "START"
                    && !must_rebuild(row)
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
        // A GHOST ON AN ELIGIBLE NODE IS REBUILT IN PLACE, BEFORE CAPACITY IS ASKED.
        //
        // Rebuilding a ghost replaces a row that already occupies this slot with a
        // live one; it does not add an instance, so it must not be refused for want of
        // a free slot. The branch that did this sat *after* candidate selection, so on
        // a full node `candidate` was None, the slot was skipped, and the ghost stayed
        // a ghost forever.
        //
        // Measured on the platform lifecycle acceptance: a redeploy released its rows
        // and the node had no spare slot, so nothing ever placed them again and the
        // deployment never converged. The state machine was asking for a slot it had
        // just released.
        if let Some(row) = current.as_ref() {
            if must_rebuild(row) && eligible_ids.contains(&row.node_id) {
                sqlx::query(
                    "UPDATE kernel.plugin_instances SET desired_action='START', state='STARTING', observed_at=NULL, container_id=NULL, image_digest=NULL, host_port=NULL, restart_count=0, last_error=NULL, deployment_generation=$2, updated_at=now() WHERE id=$1",
                )
                .bind(row.id)
                .bind(deployment.generation)
                .execute(&state.db)
                .await?;
                continue;
            }
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
                            .map(|(_, best, _)| rejection.progress() > best.progress())
                            .unwrap_or(true);
                        if furthest {
                            placement_rejection = Some((node.name.clone(), rejection, node.id));
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
            } else if must_rebuild(&current) {
                // Same node, but the row is a ghost: rebuild it HERE rather than
                // moving it. The identity that survives a rebuild is the slot and
                // the generation; every observed fact is cleared so the node
                // reports afresh and `restart_count` starts from zero for the new
                // attempt rather than accumulating across unrelated failures.
                //
                // A ghost holds no container by definition, so there is nothing
                // to stop or adopt: the clear is not "forgetting" a resource, it
                // is discarding a dead row's description of one.
                sqlx::query(
                    "UPDATE kernel.plugin_instances SET desired_action='START', state='STARTING', observed_at=NULL, container_id=NULL, image_digest=NULL, host_port=NULL, restart_count=0, last_error=NULL, deployment_generation=$2, updated_at=now() WHERE id=$1",
                )
                .bind(current.id)
                .bind(deployment.generation)
                .execute(&state.db)
                .await?;
                // It was START before, and it is START now: the placement it
                // held in `used_nodes`/`global_counts`/`reserved` is the one it
                // keeps. Re-accounting here would double-count the slot and make
                // the node look fuller than it is - the exact class of drift the
                // three capacity queries were unified to prevent.
                debug_assert!(
                    was_started,
                    "a ghost is always desired_action=START by definition"
                );
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
    // Why the slots that could not be placed were refused.
    //
    // The PENDING branch below has always carried this; every other branch threw
    // it away. That made the case an operator actually hits on a full node -
    // "slot 0 took the last place, slot 1 was refused" - indistinguishable from
    // "still starting": `status_reason` said `0/2 replicas READY` and waiting is
    // the one thing that cannot help.
    //
    // So it is computed once, here, and appended by every branch that describes a
    // deployment which is not fully placed.
    let placement_note = if missing > 0 {
        match placement_rejection.as_ref() {
            Some((node_name, rejection, node_id)) => {
                let mut line = placement_failure_reason(node_name, rejection);
                if rejection.code() == "INSTANCE_CAPACITY_EXCEEDED" {
                    let occupants = capacity_occupants(&state.db, *node_id).await;
                    if !occupants.is_empty() {
                        line.push_str(&format!("; occupied by {}", occupants.join(", ")));
                    }
                }
                Some(line)
            }
            None => Some(PLACEMENT_FAILURE.to_string()),
        }
    } else {
        None
    };
    let with_placement = |base: String| match placement_note.as_ref() {
        Some(note) => format!("{base}; {note}"),
        None => base,
    };

    // HOW LONG THIS ATTEMPT HAS BEEN TRYING AND PLACING NOTHING.
    //
    // Computed here, once, because the PENDING branch needs it to tell "starting"
    // from "never going to start" - see the comment there. Negative is clamped to
    // zero so a row whose `attempt_started_at` is marginally ahead of the database
    // clock (a fixture, or clock skew between the writer and this reader) cannot
    // report a negative age and read as young forever.
    //
    // The basis is `attempt_started_at`, NOT `created_at`: a re-deploy keeps the
    // version's original creation time, so a timeout read from there would fire
    // immediately after the operator's retry. When the column is NULL - a row that
    // was not attempting when the migration ran, or one written before this field
    // existed - the age is 0, which means "treat as just started". That is the
    // fail-open direction: it delays declaring FAILED rather than declaring it on a
    // deployment whose age is unknown.
    let never_placed_for: i64 = if missing == deployment.desired_replicas {
        deployment
            .attempt_started_at
            .map(|started| (Utc::now() - started).num_seconds().max(0))
            .unwrap_or(0)
    } else {
        0
    };

    let (status, reason) = if deployment.desired_replicas == 0 {
        ("DISABLED", Some("Desired replicas is zero".to_string()))
    } else if missing == deployment.desired_replicas {
        // Name the occupants of the node that refused us.
        //
        // "4 instances already scheduled against a per-node limit of 4" is a true
        // message that sent four staging deploys and a week of investigation at
        // the wrong target, because it does not say WHOSE instances they are. A
        // capacity rejection is the one place where the numbers alone are never
        // enough: the operator's next action depends entirely on whether the
        // occupants are this plugin's own stale attempts, another plugin that
        // should be moved, or a limit that should be raised.
        //
        // A DEPLOYMENT THAT HAS NEVER PLACED ANYTHING IS NOT "STARTING".
        //
        // The reconciler re-plans every PENDING row every 2 seconds, forever.
        // Nothing ever gives up. Measured on staging 2026-11-25: nine rows that
        // had never placed a single replica, the oldest three days old, each still
        // being planned on every tick. They hold no slot - the capacity aggregates
        // exclude them because they have no START instance - so they were invisible
        // to every capacity audit, and the only way to see them was to read the
        // whole deployment table.
        //
        // TWO CONDITIONS, AND BOTH ARE NECESSARY.
        //
        // `missing == desired_replicas` means NOT ONE replica is placed. A
        // deployment with some replicas up is still making progress, and calling it
        // failed would be a lie about a deployment that is partly serving. That is
        // the same distinction `partial` reports elsewhere.
        //
        // The age is measured from `created_at`, which is when this row began
        // trying. `updated_at` would be useless here: this very function writes it
        // on every pass that changes the status, so a row's age would reset each
        // time the reconciler looked at it.
        //
        // WHY FAILED AND NOT DISABLED. `DISABLED` is a state an operator chooses;
        // it also has a STOP write that assumes there was something to stop.
        // `FAILED` already means "this deployment did not work" to `diagnostics`,
        // `plugins.rs:609` and the operator UI, and `create_deployment_inner`
        // already treats FAILED as redeployable. It is the existing vocabulary.
        //
        // Nothing is deleted and no instance is stopped here: a deployment that
        // never placed has nothing to release, and the brief forbids deleting rows.
        if never_placed_for > state.config.pending_timeout_seconds {
            (
                "FAILED",
                Some(with_placement(format!(
                    "never placed after {}s: 0/{} replicas, and the last placement attempt \
                     was refused; re-deploy to try again",
                    never_placed_for, deployment.desired_replicas
                ))),
            )
        } else {
            ("PENDING", placement_note.clone())
        }
    } else if ready == deployment.desired_replicas {
        if is_effective {
            ("ACTIVE", None)
        } else {
            ("READY", None)
        }
    } else if is_effective {
        (
            "DEGRADED",
            Some(with_placement(format!(
                "{ready}/{} replicas READY",
                deployment.desired_replicas
            ))),
        )
    } else if starting > 0 {
        (
            "PREPARING",
            Some(with_placement(format!(
                "{ready}/{} replicas READY",
                deployment.desired_replicas
            ))),
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
        // A constant so the test can run THE PRODUCTION STATEMENT. A test that
        // repeats the SQL proves the copy is right - `nodes.rs` learned this when a
        // counterfactual removing a guard left the copy-based test green.
        // `attempt_started_at` FOLLOWS THE STATUS, IN BOTH DIRECTIONS.
        //
        // Entering PENDING with no attempt on record (a fresh row whose caller set
        // it, or one that reached PENDING by a path this function did not see) gets
        // a start time. Leaving PENDING clears it, so a later re-entry starts a new
        // clock rather than inheriting the age of an attempt that already ended -
        // which is the bug the previous version would have had: a FAILED row keeps
        // its old timestamp, and a redeploy would be born expired.
        //
        // `COALESCE` on the way in, so re-planning an already-PENDING row does not
        // keep resetting the clock it is measured against.
        sqlx::query(STATUS_WRITE_BACK_SQL)
            .bind(deployment.id)
            .bind(status)
            .bind(&reason)
            // THE GENERATION THIS STATUS WAS COMPUTED FROM (TASK-13).
            //
            // Everything above is derived from facts read at the start of this pass:
            // instance states, `ready`/`starting`/`failed` counts, and `is_effective`.
            // Between that read and this write, `create_deployment_inner` can reset the
            // row to PENDING with `generation+1` - a new attempt whose intent is the
            // opposite of a status computed from the old one's instances. Measured in
            // `generation_fencing`: without this predicate the stale status lands.
            //
            // With it, the write simply does not match a row that has moved on. The next
            // pass reads the new generation's facts and writes a status derived from
            // those, which is the only writer whose answer is about the current attempt.
            .bind(deployment.generation)
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
    pub(crate) fn progress(&self) -> u8 {
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
pub(crate) struct PlacementContext<'a> {
    pub(crate) selector: &'a BTreeMap<String, String>,
    pub(crate) requested: &'a ResourceRequirements,
    pub(crate) max_instances_per_deployment: usize,
    pub(crate) max_instances_per_node: usize,
}

/// What a node already carries before this slot is added.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct NodeUsage {
    pub(crate) cpu_millis: i64,
    pub(crate) memory_mib: i64,
    pub(crate) deployment_instances: usize,
    pub(crate) node_instances: usize,
}

impl NodeUsage {
    pub(crate) fn of(
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
pub(crate) fn evaluate_node(
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
) -> anyhow::Result<Option<(String, PlacementRejection, Uuid)>> {
    let nodes = sqlx::query_as::<_, NodeRow>(
        "SELECT * FROM kernel.nodes WHERE revoked_at IS NULL ORDER BY name",
    )
    .fetch_all(&state.db)
    .await?;
    let mut furthest: Option<(String, PlacementRejection, Uuid)> = None;
    for node in &nodes {
        let usage = NodeUsage::of(node, reserved, used_nodes, global_counts);
        let Err(rejection) = evaluate_node(node, usage, placement) else {
            continue;
        };
        let further = furthest
            .as_ref()
            .map(|(_, best, _)| rejection.progress() > best.progress())
            .unwrap_or(true);
        if further {
            furthest = Some((node.name.clone(), rejection, node.id));
        }
    }
    Ok(furthest)
}

/// Who is actually holding the node's slots, for the capacity rejection message.
///
/// TASK-21 lists "a container that does not exist but occupies capacity" and
/// "registry pull failure confused with node capacity failure" as the diagnostics
/// that matter. The message an operator sees today is:
///
///     4 instances already scheduled on this node against a per-node limit of 4
///
/// which names the numbers and not the occupants - so the only way to answer
/// "occupied by WHOM" is to open psql on the staging host. Measured on
/// 2026-11-19: the deploy failed four times with that message and the four
/// occupants were never identified, from the log or the API.
///
/// This returns `plugin@version`, one per live instance, ordered so the output is
/// stable across runs. Cheap: it runs only on the rejection path, once per
/// reconcile pass at most.
///
/// The status filter is the same one the capacity aggregates use. It has to be:
/// a diagnostic that disagrees with the decision it explains is worse than none.
async fn capacity_occupants(db: &sqlx::PgPool, node_id: Uuid) -> Vec<String> {
    sqlx::query_scalar::<_, String>(
        r#"
        SELECT DISTINCT d.plugin_id || '@' || d.version
        FROM kernel.plugin_instances i
        JOIN kernel.plugin_deployments d ON d.id = i.deployment_id
        WHERE i.node_id = $1
          AND i.desired_action = 'START'
          AND d.status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED')
          AND NOT (i.state IN ('UNHEALTHY','UNREACHABLE') AND i.container_id IS NULL)
        ORDER BY 1
        "#,
    )
    .bind(node_id)
    .fetch_all(db)
    .await
    .unwrap_or_default()
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
        evaluate_node, is_ghost_instance, must_rebuild, node_has_capacity,
        placement_failure_reason, InstanceRow, NodeUsage, PlacementContext, PlacementRejection,
        NOT_A_GHOST,
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
    /// A failed instance with no container must not occupy a node slot.
    ///
    /// The predicate is tested directly because that is where the defect was: the
    /// placement planner counted every `desired_action == "START"` row, so an
    /// UNHEALTHY instance whose container was never created - a failed image pull
    /// leaves exactly that - held a slot forever. Measured on staging
    /// 2026-11-16: three containers running, four instances counted, and every
    /// later deployment of any plugin on that node refused with
    /// INSTANCE_CAPACITY_EXCEEDED.
    ///
    /// The three cases below are the decision, not the symptom:
    ///   failed + no container   -> ghost, does not occupy
    ///   failed + has container  -> still occupies (real resources, still managed)
    ///   healthy                 -> occupies
    #[test]
    fn a_failed_instance_without_a_container_does_not_occupy_a_slot() {
        let base = |state: &str, container: Option<&str>| InstanceRow {
            id: Uuid::new_v4(),
            deployment_id: Uuid::new_v4(),
            node_id: Uuid::new_v4(),
            slot: 0,
            deployment_generation: 1,
            desired_action: "START".into(),
            state: state.into(),
            observed_at: Some(Utc::now()),
            container_id: container.map(str::to_string),
            image_digest: None,
            host_port: None,
            restart_count: 0,
            last_error: None,
            runtime_adapter_version: None,
            node_name: Some("staging-node".into()),
            node_status: Some("READY".into()),
            node_last_seen_at: Some(Utc::now()),
            node_data_endpoint: None,
            node_data_token: None,
        };

        assert!(
            is_ghost_instance(&base("UNHEALTHY", None)),
            "an UNHEALTHY instance with no container is a dead row and must not hold a slot"
        );
        assert!(
            is_ghost_instance(&base("UNREACHABLE", None)),
            "the same holds for UNREACHABLE"
        );
        assert!(
            !is_ghost_instance(&base("UNHEALTHY", Some("abc123"))),
            "an UNHEALTHY instance that HAS a container is still using the node"
        );
        assert!(
            !is_ghost_instance(&base("READY", None)),
            "a READY instance counts even before its container id is observed"
        );
        assert!(
            !is_ghost_instance(&base("STARTING", None)),
            "a starting instance is on its way up and must keep its slot"
        );
    }

    /// A ghost must be REBUILT, not maintained.
    ///
    /// This is the half the ghost-exclusion fix did not cover. Excluding the row
    /// from the capacity sums stopped it costing a slot; it did not stop the
    /// reconciler from re-asserting `desired_action='START'` on it every pass. So
    /// a row whose container never existed was kept alive forever, and a manual
    /// `UPDATE ... STOP` was overwritten within the same second - measured on
    /// staging, where the row's `updated_at` equalled the clock at the query.
    ///
    /// `must_rebuild` is what the keep-alive branch now consults. These cases are
    /// the whole rule, and the last two are the ones a careless "rebuild anything
    /// that looks unhealthy" would break.
    #[test]
    fn a_ghost_is_rebuilt_and_a_live_container_is_not() {
        let base = |state: &str, container: Option<&str>| InstanceRow {
            id: Uuid::new_v4(),
            deployment_id: Uuid::new_v4(),
            node_id: Uuid::new_v4(),
            slot: 0,
            deployment_generation: 1,
            desired_action: "START".into(),
            state: state.into(),
            observed_at: Some(Utc::now()),
            container_id: container.map(str::to_string),
            image_digest: None,
            host_port: None,
            restart_count: 0,
            last_error: None,
            runtime_adapter_version: None,
            node_name: Some("staging-node".into()),
            node_status: Some("READY".into()),
            node_last_seen_at: Some(Utc::now()),
            node_data_endpoint: None,
            node_data_token: None,
        };

        assert!(
            must_rebuild(&base("UNHEALTHY", None)),
            "a failed pull leaves a row to re-create"
        );
        assert!(
            must_rebuild(&base("UNREACHABLE", None)),
            "a node that vanished leaves the same shape"
        );

        // The ownership invariant: a row that HAS a container describes a real
        // resource. Rebuilding it would clear the only record of that container,
        // and nothing would ever stop it. This is the case that must stay false.
        assert!(
            !must_rebuild(&base("UNHEALTHY", Some("abc123"))),
            "an UNHEALTHY instance with a live container must be maintained, never rebuilt"
        );
        // And every state whose container id is simply not observed yet.
        for state in ["STARTING", "READY", "STOPPING", "STOPPED"] {
            assert!(
                !must_rebuild(&base(state, None)),
                "{state} may legitimately have no container id for one tick and must not be rebuilt"
            );
        }
    }
    /// Both capacity aggregates must exclude the same shape.
    ///
    /// They are `&'static str` literals handed to `sqlx::query_as`, so the
    /// fragment cannot be shared by the language - it is written twice. This
    /// asserts both copies are present, which is the only thing standing between
    /// "one query was edited" and a node that reports two different capacities
    /// depending on which check runs first.
    ///
    /// The drift is not hypothetical: `global_instance_counts` gained the
    /// exclusion and `allocations` did not, and the deploy kept failing on a node
    /// that had free CPU and memory but no free slot.
    #[test]
    fn the_capacity_queries_both_exclude_ghosts() {
        let src = include_str!("deployments.rs");
        let occurrences = src.matches(NOT_A_GHOST).count();
        assert!(
            occurrences >= 3,
            "expected the ghost exclusion in NOT_A_GHOST and in BOTH capacity queries, \
             found {occurrences} occurrence(s) of {NOT_A_GHOST:?}"
        );
    }

    /// The two capacity aggregates, run against a real PostgreSQL.
    ///
    /// The unit test above proves the rule. This proves the SQL - which is where
    /// the defect actually lived, twice: the count excluded ghosts and the
    /// allocation sum did not, and before that neither did. A predicate test
    /// cannot see either, because the predicate was correct both times.
    ///
    /// The fixture is the staging state that failed: three real occupants, one
    /// failed instance with no container, a node limit of four. The decision the
    /// planner has to get right is "is there room", so both aggregates are
    /// asserted to land on the same side of that line.
    #[cfg(test)]
    /// TASK-25: CPU and memory refusals are INDEPENDENT, on the real path.
    ///
    /// The findings register has B-3 as NOT_RUN: `node_has_capacity` has two
    /// branches and only the instance-count limit was ever exercised. A scheduler
    /// that collapsed them - "the node is full" - would pass every existing test
    /// while telling an operator nothing about which resource to add.
    ///
    /// These drive `evaluate_node` through `reconcile_deployment`, not the helper
    /// directly, so the ORDER of the checks and the status the deployment ends up
    /// with are both covered.
    /// TASK-14: the preflight must count what the PLANNER counts.
    ///
    /// The preflight exists to answer "would this deploy fit" before a full image
    /// build. If it counted instances differently from `reconcile_deployment` - a
    /// different ghost exclusion, a different status filter - it would answer FITS
    /// for deployments the scheduler then refuses, which is worse than no preflight:
    /// the operator would have a tool that disagrees with the system it describes.
    ///
    /// The SQL in `placement_preflight::gather` is a copy of the planner's three
    /// aggregates. This test is the cross-check that justifies the copy.
    /// TASK-16: the retire rules, as a pure function.
    ///
    /// `uninstall` is plugin-level and disables EVERY deployment of the plugin. On
    /// staging that would stop the version that is serving, because the four
    /// occupants include active revisions of the same plugin. These cases pin the
    /// decisions that make a per-deployment retire safe to offer.
    mod retire_rules {
        use super::super::{retire_decision, RetireDecision};

        const ME: &str = "11111111-1111-1111-1111-111111111111";
        const OTHER: &str = "22222222-2222-2222-2222-222222222222";

        #[test]
        fn a_stale_generation_is_refused_before_the_idempotent_branch() {
            // The defect `rollback` recorded: a caller already at the target state
            // but holding an OUTDATED generation used to get "nothing to do", which
            // confirmed a belief that was false.
            assert_eq!(
                retire_decision(5, "DISABLED", 4, None, ME),
                RetireDecision::GenerationConflict,
                "an already-disabled row at a stale generation must not answer idempotent"
            );
        }

        #[test]
        fn an_already_retired_deployment_at_the_same_generation_is_idempotent() {
            assert_eq!(
                retire_decision(3, "DISABLED", 3, None, ME),
                RetireDecision::AlreadyRetired
            );
        }

        #[test]
        fn the_active_revision_is_never_retired_here() {
            assert_eq!(
                retire_decision(1, "ACTIVE", 1, Some(ME), ME),
                RetireDecision::IsActiveRevision,
                "retiring the serving version is rollback's or disable's job, with their checks"
            );
        }

        #[test]
        fn a_non_active_deployment_is_retirable_even_when_another_is_active() {
            // The staging shape: this deployment is an old version of a plugin whose
            // current version is ACTIVE somewhere else.
            assert_eq!(
                retire_decision(1, "READY", 1, Some(OTHER), ME),
                RetireDecision::Proceed
            );
        }

        #[test]
        fn no_active_revision_at_all_still_allows_retiring() {
            assert_eq!(
                retire_decision(1, "PENDING", 1, None, ME),
                RetireDecision::Proceed
            );
        }

        #[test]
        fn the_generation_check_wins_over_the_active_check() {
            // Order matters for WHICH refusal an operator sees: a stale caller
            // asking about the active deployment has two problems, and being told
            // about the generation is the actionable one.
            assert_eq!(
                retire_decision(9, "ACTIVE", 1, Some(ME), ME),
                RetireDecision::GenerationConflict
            );
        }
    }

    mod preflight_matches_planner {
        use sqlx::PgPool;
        use uuid::Uuid;

        const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";

        async fn test_pool() -> Option<PgPool> {
            let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
                Ok(url) => url,
                Err(_) => {
                    if std::env::var(REQUIRE_DATABASE_ENV).ok().as_deref() == Some("1") {
                        panic!(
                            "{REQUIRE_DATABASE_ENV} is set but OPSWEAVE_TEST_DATABASE_URL is unset"
                        );
                    }
                    eprintln!("skip: OPSWEAVE_TEST_DATABASE_URL is unset");
                    return None;
                }
            };
            let pool = PgPool::connect(&url).await.expect("connect");
            crate::db::migrate(&pool).await.expect("migrate");
            Some(pool)
        }

        /// A node with N instances, one of them a GHOST, and the planner's own
        /// count for it.
        #[tokio::test]
        async fn the_preflight_and_the_planner_agree_on_what_occupies_a_node() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let tag = Uuid::new_v4().simple().to_string();
            let node = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO kernel.nodes
                   (id, name, control_token_hash, data_token, generation, os, arch,
                    labels, capabilities, status, enrolled_at, last_seen_at,
                    data_endpoint, resource_snapshot)
                 VALUES ($1,$2,'x','tok',1,'linux','amd64',$4::jsonb,'[]'::jsonb,
                         'READY',now(),now(),'http://127.0.0.1:1',$3)",
            )
            .bind(node)
            .bind(format!("pf-node-{tag}"))
            .bind(serde_json::json!({
                "cpuCores": 8,
                "memoryTotalBytes": 8i64 * 1024 * 1024 * 1024,
                "memoryUsedBytes": 0,
            }))
            .bind(serde_json::json!({ "test-fixture": tag }))
            .execute(&pool)
            .await
            .expect("node");

            // Two LIVE instances and one GHOST (UNHEALTHY, no container).
            let publisher = format!("pub-pf-{tag}");
            sqlx::query(
                "INSERT INTO kernel.trusted_publishers
                   (publisher_id, public_key_hex, fingerprint, trust_state)
                 VALUES ($1,'00','fp','TRUSTED')",
            )
            .bind(&publisher)
            .execute(&pool)
            .await
            .expect("publisher");
            let mut deployment_ids = Vec::new();
            for (slot, ghost) in [(0, false), (1, false), (2, true)] {
                let plugin = format!("test.pf.{tag}.{slot}");
                let package = Uuid::new_v4();
                let dep = Uuid::new_v4();
                deployment_ids.push(dep);
                sqlx::query(
                    "INSERT INTO kernel.plugin_packages
                       (package_id, plugin_id, version, schema_version, publisher, manifest,
                        artifact_digest, bundle_digest, payload_digest, status, signature_state)
                     VALUES ($1,$2,'1.0.0','1.1',$3,'{}'::jsonb,$4,$5,$6,'INSTALLED','VERIFIED')",
                )
                .bind(package)
                .bind(&plugin)
                .bind(&publisher)
                .bind(format!("sha256:{}", Uuid::new_v4().simple()))
                .bind(format!("sha256:{}", Uuid::new_v4().simple()))
                .bind(format!("sha256:{}", Uuid::new_v4().simple()))
                .execute(&pool)
                .await
                .expect("package");
                sqlx::query(
                    "INSERT INTO kernel.plugin_deployments
                       (id, plugin_id, package_id, version, desired_replicas, generation,
                        placement, resources, status, created_at, updated_at)
                     VALUES ($1,$2,$3,'1.0.0',1,1,'{}'::jsonb,
                             '{\"cpuMillis\":100,\"memoryMiB\":128}'::jsonb,'ACTIVE',now(),now())",
                )
                .bind(dep)
                .bind(&plugin)
                .bind(package)
                .execute(&pool)
                .await
                .expect("deployment");
                sqlx::query(
                    "INSERT INTO kernel.plugin_instances
                       (id, deployment_id, node_id, slot, deployment_generation,
                        desired_action, state, container_id)
                     VALUES ($1,$2,$3,0,1,'START',$4,$5)",
                )
                .bind(Uuid::new_v4())
                .bind(dep)
                .bind(node)
                .bind(if ghost { "UNHEALTHY" } else { "READY" })
                .bind(if ghost {
                    None
                } else {
                    Some(format!("c{slot}"))
                })
                .execute(&pool)
                .await
                .expect("instance");
            }

            // What the planner's own aggregate says.
            let planner_count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM kernel.plugin_instances i
                 JOIN kernel.plugin_deployments d ON d.id=i.deployment_id
                 WHERE i.node_id=$1 AND i.desired_action='START'
                   AND d.status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED')
                   AND NOT (i.state IN ('UNHEALTHY','UNREACHABLE') AND i.container_id IS NULL)",
            )
            .bind(node)
            .fetch_one(&pool)
            .await
            .expect("planner count");

            let report = crate::placement_preflight::gather(
                &pool,
                None,
                [("test-fixture".to_string(), tag.clone())]
                    .into_iter()
                    .collect(),
                opsweave_contracts::ResourceRequirements {
                    cpu_millis: 100,
                    memory_mib: 128,
                },
                1,
                4,
                4,
            )
            .await
            .expect("preflight");

            let mine = report
                .nodes
                .iter()
                .find(|n| n.node_id == node)
                .map(|n| n.instances_on_node as i64)
                .unwrap_or(-1);
            assert_eq!(
                mine, planner_count,
                "the preflight counts {mine} occupied instances but the planner counts \
                 {planner_count}; a preflight that disagrees with the scheduler answers for \
                 a system that does not exist"
            );
            assert_eq!(
                planner_count, 2,
                "two live instances; the ghost must not count"
            );

            for dep in deployment_ids {
                sqlx::query("DELETE FROM kernel.plugin_deployments WHERE id=$1")
                    .bind(dep)
                    .execute(&pool)
                    .await
                    .ok();
            }
            sqlx::query("DELETE FROM kernel.nodes WHERE id=$1")
                .bind(node)
                .execute(&pool)
                .await
                .ok();
        }
    }

    mod resource_capacity {
        use sqlx::PgPool;
        use uuid::Uuid;

        use crate::config::Config;

        const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";

        async fn test_pool() -> Option<PgPool> {
            let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
                Ok(url) => url,
                Err(_) => {
                    if std::env::var(REQUIRE_DATABASE_ENV).ok().as_deref() == Some("1") {
                        panic!(
                            "{REQUIRE_DATABASE_ENV} is set but OPSWEAVE_TEST_DATABASE_URL is unset"
                        );
                    }
                    eprintln!("skip: OPSWEAVE_TEST_DATABASE_URL is unset");
                    return None;
                }
            };
            let pool = PgPool::connect(&url).await.expect("connect");
            crate::db::migrate(&pool).await.expect("migrate");
            Some(pool)
        }

        /// One READY node whose CPU and memory budgets can be set independently,
        /// and one deployment asking for a fixed amount.
        struct Fix {
            node: Uuid,
            deployment: Uuid,
        }

        async fn fixture(
            pool: &PgPool,
            cores: i64,
            memory_gib: i64,
            cpu_millis: i64,
            memory_mib: i64,
        ) -> Fix {
            let tag = Uuid::new_v4().simple().to_string();
            let node = Uuid::new_v4();
            let deployment = Uuid::new_v4();
            let package = Uuid::new_v4();
            let publisher = format!("pub-res-{tag}");
            let plugin = format!("test.res.{tag}");
            sqlx::query(
                "INSERT INTO kernel.trusted_publishers
                   (publisher_id, public_key_hex, fingerprint, trust_state)
                 VALUES ($1,'00','fp','TRUSTED')",
            )
            .bind(&publisher)
            .execute(pool)
            .await
            .expect("publisher");
            sqlx::query(
                "INSERT INTO kernel.nodes
                   (id, name, control_token_hash, data_token, generation, os, arch,
                    labels, capabilities, status, enrolled_at, last_seen_at,
                    data_endpoint, resource_snapshot)
                 VALUES ($1,$2,'x','tok',1,'linux','amd64',$4::jsonb,'[]'::jsonb,
                         'READY',now(),now(),'http://127.0.0.1:1',$3)",
            )
            .bind(node)
            .bind(format!("res-node-{tag}"))
            .bind(serde_json::json!({
                "cpuCores": cores,
                "memoryTotalBytes": memory_gib * 1024 * 1024 * 1024_i64,
                "memoryUsedBytes": 0,
            }))
            .bind(serde_json::json!({ "test-fixture": tag }))
            .execute(pool)
            .await
            .expect("node");
            sqlx::query(
                "INSERT INTO kernel.plugin_packages
                   (package_id, plugin_id, version, schema_version, publisher, manifest,
                    artifact_digest, bundle_digest, payload_digest, status, signature_state)
                 VALUES ($1,$2,'1.0.0','1.1',$3,'{}'::jsonb,$4,$5,$6,'INSTALLED','VERIFIED')",
            )
            .bind(package)
            .bind(&plugin)
            .bind(&publisher)
            .bind(format!("sha256:{}", Uuid::new_v4().simple()))
            .bind(format!("sha256:{}", Uuid::new_v4().simple()))
            .bind(format!("sha256:{}", Uuid::new_v4().simple()))
            .execute(pool)
            .await
            .expect("package");
            sqlx::query(
                "INSERT INTO kernel.plugin_deployments
                   (id, plugin_id, package_id, version, desired_replicas, generation,
                    placement, resources, status, created_at, updated_at)
                 VALUES ($1,$2,$3,'1.0.0',1,1,$4,$5,'PENDING',now(),now())",
            )
            .bind(deployment)
            .bind(&plugin)
            .bind(package)
            .bind(serde_json::json!({
                "nodeSelector": { "test-fixture": tag },
                "maxInstancesPerNode": 4,
            }))
            .bind(serde_json::json!({
                "cpuMillis": cpu_millis,
                "memoryMiB": memory_mib,
            }))
            .execute(pool)
            .await
            .expect("deployment");
            Fix { node, deployment }
        }

        fn state_for(pool: &PgPool) -> crate::state::AppState {
            crate::state::AppState {
                config: std::sync::Arc::new(Config::from_env()),
                db: pool.clone(),
                http: reqwest::Client::new(),
                cursor_secret: std::sync::Arc::new(vec![0u8; 32]),
                rate_limiter: std::sync::Arc::new(crate::state::RateLimiter::default()),
            }
        }

        async fn reason(pool: &PgPool, id: Uuid) -> (String, String, i64) {
            let (status, r) = sqlx::query_as::<_, (String, Option<String>)>(
                "SELECT status, status_reason FROM kernel.plugin_deployments WHERE id=$1",
            )
            .bind(id)
            .fetch_one(pool)
            .await
            .expect("status");
            let n: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM kernel.plugin_instances WHERE deployment_id=$1 AND desired_action='START'",
            )
            .bind(id)
            .fetch_one(pool)
            .await
            .expect("instances");
            (status, r.unwrap_or_default(), n)
        }

        async fn cleanup(pool: &PgPool, f: &Fix) {
            sqlx::query("DELETE FROM kernel.plugin_deployments WHERE id=$1")
                .bind(f.deployment)
                .execute(pool)
                .await
                .ok();
            sqlx::query("DELETE FROM kernel.nodes WHERE id=$1")
                .bind(f.node)
                .execute(pool)
                .await
                .ok();
        }

        /// CPU BUDGET IS 90% OF CORES x 1000. Two cores -> 1800m.
        #[tokio::test]
        async fn a_deployment_over_the_cpu_budget_is_refused_and_names_cpu() {
            let Some(pool) = test_pool().await else {
                return;
            };
            // 2 cores -> 1800m budget; ask 1900m. Memory is plentiful.
            let f = fixture(&pool, 2, 16, 1900, 64).await;
            crate::deployments::reconcile_once_scoped(&state_for(&pool), Some(f.deployment))
                .await
                .expect("reconcile");
            let (status, why, placed) = reason(&pool, f.deployment).await;
            assert_eq!(placed, 0, "nothing fits, so nothing is placed");
            assert_ne!(status, "ACTIVE");
            assert!(
                why.contains("CPU") || why.to_lowercase().contains("cpu"),
                "a CPU refusal must name CPU, not a generic full-node message; got {why:?}"
            );
            cleanup(&pool, &f).await;
        }

        /// MEMORY BUDGET IS 90% OF (total - used). 1 GiB -> 921 MiB.
        #[tokio::test]
        async fn a_deployment_over_the_memory_budget_is_refused_and_names_memory() {
            let Some(pool) = test_pool().await else {
                return;
            };
            // 1 GiB -> 921 MiB budget; ask 1000 MiB. CPU is plentiful.
            let f = fixture(&pool, 8, 1, 100, 1000).await;
            crate::deployments::reconcile_once_scoped(&state_for(&pool), Some(f.deployment))
                .await
                .expect("reconcile");
            let (status, why, placed) = reason(&pool, f.deployment).await;
            assert_eq!(placed, 0);
            assert_ne!(status, "ACTIVE");
            assert!(
                why.to_lowercase().contains("memory"),
                "a memory refusal must name memory; got {why:?}"
            );
            cleanup(&pool, &f).await;
        }

        /// BOTH resources sufficient -> placed. The control: without it the two
        /// refusals above could be "everything is refused".
        #[tokio::test]
        async fn a_deployment_within_both_budgets_is_placed() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let f = fixture(&pool, 4, 8, 500, 256).await;
            crate::deployments::reconcile_once_scoped(&state_for(&pool), Some(f.deployment))
                .await
                .expect("reconcile");
            let (_, why, placed) = reason(&pool, f.deployment).await;
            assert_eq!(
                placed, 1,
                "a fitting deployment must be placed; reason: {why:?}"
            );
            cleanup(&pool, &f).await;
        }

        /// A snapshot with no cpuCores is REFUSED, not defaulted to zero and
        /// silently treated as "no budget".
        #[tokio::test]
        async fn a_snapshot_missing_cpu_cores_is_refused_by_name() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let f = fixture(&pool, 4, 8, 100, 64).await;
            sqlx::query(
                "UPDATE kernel.nodes SET resource_snapshot = resource_snapshot - 'cpuCores' WHERE id=$1",
            )
            .bind(f.node)
            .execute(&pool)
            .await
            .expect("strip cpuCores");
            crate::deployments::reconcile_once_scoped(&state_for(&pool), Some(f.deployment))
                .await
                .expect("reconcile");
            let (_, why, placed) = reason(&pool, f.deployment).await;
            assert_eq!(placed, 0);
            assert!(
                why.contains("RESOURCE_SNAPSHOT_MISSING") || why.contains("cpuCores"),
                "a missing field must be named; got {why:?}"
            );
            cleanup(&pool, &f).await;
        }
    }

    mod capacity_sql {
        use sqlx::postgres::PgConnectOptions;
        use sqlx::PgPool;
        use uuid::Uuid;

        const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";

        async fn test_pool() -> Option<PgPool> {
            let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
                Ok(url) => url,
                Err(_) => {
                    if std::env::var(REQUIRE_DATABASE_ENV).ok().as_deref() == Some("1") {
                        panic!(
                            "{REQUIRE_DATABASE_ENV} is set but OPSWEAVE_TEST_DATABASE_URL is unset"
                        );
                    }
                    eprintln!("skip: OPSWEAVE_TEST_DATABASE_URL is unset");
                    return None;
                }
            };
            let options: PgConnectOptions = url.parse().expect("test database URL parses");
            let pool = PgPool::connect_with(options)
                .await
                .expect("cannot connect to the test database");
            crate::db::migrate(&pool)
                .await
                .expect("the test database rejected the migrations");
            Some(pool)
        }

        /// Build a node with `n` instances of a given shape and return
        /// (instance_count, cpu_millis, memory_mib) as the planner would see them.
        async fn measure(
            pool: &PgPool,
            node_id: Uuid,
            instances: &[(&str, Option<&str>)],
        ) -> (i64, i64, i64) {
            let plugin = format!("test.capacity.{}", Uuid::new_v4());
            let package_id = Uuid::new_v4();
            let deployment_id = Uuid::new_v4();
            // `plugin_deployments.package_id` is a real foreign key; fabricating
            // the uuid would fail before the query under test ever ran.
            sqlx::query(
                "INSERT INTO kernel.plugin_packages
                   (package_id, plugin_id, version, schema_version, publisher, manifest,
                    artifact_digest, bundle_digest, payload_digest, status, signature_state)
                 VALUES ($1,$2,'0.0.1','1.1','test-publisher','{}'::jsonb,
                         $3,$4,$5,'INSTALLED','VERIFIED')",
            )
            .bind(package_id)
            .bind(&plugin)
            .bind(format!("sha256:{}", Uuid::new_v4().simple()))
            .bind(format!("sha256:{}", Uuid::new_v4().simple()))
            .bind(format!("sha256:{}", Uuid::new_v4().simple()))
            .execute(pool)
            .await
            .expect("package inserts");
            // `measure` only runs the two capacity aggregates; it never reaches
            // the planner, so it needs no selector. Adding one here (my first
            // attempt did, by matching the wrong `INSERT`) fails to compile and,
            // had it compiled, would have changed what this fixture measures.
            sqlx::query(
                "INSERT INTO kernel.plugin_deployments
                   (id, plugin_id, package_id, version, desired_replicas, generation,
                    placement, resources, status, created_at, updated_at)
                 VALUES ($1,$2,$3,'0.0.1',1,1,'{}'::jsonb,
                         '{\"cpuMillis\":500,\"memoryMiB\":256}'::jsonb,'ACTIVE',now(),now())",
            )
            .bind(deployment_id)
            .bind(&plugin)
            .bind(package_id)
            .execute(pool)
            .await
            .expect("deployment inserts");

            for (slot, (state, container)) in instances.iter().enumerate() {
                sqlx::query(
                    "INSERT INTO kernel.plugin_instances
                       (id, deployment_id, node_id, slot, deployment_generation,
                        desired_action, state, container_id)
                     VALUES ($1,$2,$3,$4,1,'START',$5,$6)",
                )
                .bind(Uuid::new_v4())
                .bind(deployment_id)
                .bind(node_id)
                .bind(slot as i32)
                .bind(state)
                .bind(container.map(str::to_string))
                .execute(pool)
                .await
                .expect("instance inserts");
            }

            let count: i64 = sqlx::query_scalar(concat!(
                "SELECT count(*)::bigint FROM kernel.plugin_instances i ",
                "JOIN kernel.plugin_deployments d ON d.id=i.deployment_id ",
                "WHERE i.node_id=$1 AND i.desired_action='START' ",
                "AND d.status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED') ",
                "AND NOT (i.state IN ('UNHEALTHY','UNREACHABLE') AND i.container_id IS NULL)"
            ))
            .bind(node_id)
            .fetch_one(pool)
            .await
            .expect("count query");

            let (cpu, mem): (i64, i64) = sqlx::query_as(concat!(
                "SELECT COALESCE(SUM((d.resources->>'cpuMillis')::bigint)::bigint,0), ",
                "COALESCE(SUM((d.resources->>'memoryMiB')::bigint)::bigint,0) ",
                "FROM kernel.plugin_instances i ",
                "JOIN kernel.plugin_deployments d ON d.id=i.deployment_id ",
                "WHERE i.node_id=$1 AND i.desired_action='START' ",
                "AND d.status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED') ",
                "AND NOT (i.state IN ('UNHEALTHY','UNREACHABLE') AND i.container_id IS NULL)"
            ))
            .bind(node_id)
            .fetch_one(pool)
            .await
            .expect("allocation query");

            (count, cpu, mem)
        }

        async fn node(pool: &PgPool) -> Uuid {
            node_labelled(pool, &Uuid::new_v4().to_string()).await
        }

        /// A node carrying `test-run=<run>` so a deployment can select exactly it.
        async fn node_labelled(pool: &PgPool, run: &str) -> Uuid {
            let id = Uuid::new_v4();
            let token = Uuid::new_v4().to_string();
            // `last_seen_at` is not optional in practice: `reconcile_once` sweeps
            // every node whose heartbeat is older than `node_stale_seconds` to
            // UNREACHABLE before it plans anything, and a null heartbeat is
            // infinitely stale. A fixture without it tests nothing - the first
            // version of `a_ghost_is_rebuilt_to_starting_and_stays_there` read
            // UNREACHABLE and looked like a product defect.
            sqlx::query(
                "INSERT INTO kernel.nodes
                   (id, name, control_token_hash, data_token, generation, os, arch,
                    labels, capabilities, status, enrolled_at, last_seen_at, resource_snapshot)
                 VALUES ($1,$2,'x',$3,1,'linux','amd64',$4,'[]'::jsonb,'READY',now(),now(),$5)",
            )
            .bind(id)
            .bind(format!("test-node-{}", &token[..8]))
            .bind(&token)
            .bind(serde_json::json!({ "test-run": run }))
            // A node that has never reported capacity cannot be placed on at all:
            // `evaluate_node` refuses with RESOURCE_SNAPSHOT_MISSING before it
            // looks at anything else. The second thing this fixture was missing -
            // the first was `last_seen_at`. Both were found by running the real
            // reconciler and reading its status_reason, not by reading the code.
            .bind(serde_json::json!({
                "cpuCores": 8,
                "memoryTotalBytes": 16_i64 * 1024 * 1024 * 1024,
                "memoryUsedBytes": 0_i64,
            }))
            .execute(pool)
            .await
            .expect("node inserts");
            id
        }

        /// THE CONVERGENCE TEST. Runs the real `reconcile_deployment`, not the
        /// predicate.
        ///
        /// The predicate tests above prove `must_rebuild` is correct. They cannot
        /// prove the reconciler USES it, and that was the actual defect: a ghost
        /// satisfied `desired_action == "START"` in the keep-alive branch, so every
        /// pass wrote START back to a row whose container never existed. The
        /// measured symptom on staging was that a manual `UPDATE ... SET
        /// desired_action='STOP'` was overwritten within the same second -
        /// `updated_at` equalled the clock at the query.
        ///
        /// This test is the counterfactual for that: with the keep-alive clause
        /// removed, the ghost is left `state='UNHEALTHY'` and `last_error` intact
        /// forever, and the two assertions below fail.
        ///
        /// Two passes, because convergence is a fixed point: the second must not
        /// change what the first produced. A reconciler that rebuilds on every pass
        /// would loop forever on staging and never let the node report.
        #[tokio::test]
        async fn a_ghost_is_rebuilt_to_starting_and_stays_there() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let run = Uuid::new_v4().to_string();
            let node_id = node_labelled(&pool, &run).await;
            let (deployment_id, instance_id) = deployment_with_one(
                &pool,
                node_id,
                &run,
                "UNHEALTHY",
                None,
                Some("image pull failed: manifest unknown"),
            )
            .await;

            let state = crate::state::AppState {
                config: std::sync::Arc::new(crate::config::Config::from_env()),
                db: pool.clone(),
                http: reqwest::Client::new(),
                cursor_secret: std::sync::Arc::new(vec![0u8; 32]),
                rate_limiter: std::sync::Arc::new(crate::state::RateLimiter::default()),
            };
            // The real loop, SCOPED to this deployment.
            //
            // `reconcile_once` itself (production) does the same work over every
            // deployment and every node - which, in a shared test database under
            // parallel `cargo test`, means this test reaches into fixtures other
            // tests are still asserting on. Measured: an unrelated capacity test
            // in this module failed CI with `left: 1, right: 3` because this
            // test's reconcile had swept its nodes stale.
            //
            // Scoping keeps the parts that matter here - the staleness sweep and
            // the full `reconcile_deployment` path - while removing the reach.
            super::super::reconcile_once_scoped(&state, Some(deployment_id))
                .await
                .expect("first reconcile");
            let generation_after: i64 =
                sqlx::query_scalar("SELECT generation FROM kernel.plugin_deployments WHERE id=$1")
                    .bind(deployment_id)
                    .fetch_one(&pool)
                    .await
                    .expect("deployment reads back");

            let (state1, error1, gen1, restarts1, container1): (
                String,
                Option<String>,
                i64,
                i32,
                Option<String>,
            ) = sqlx::query_as(
                "SELECT state, last_error, deployment_generation, restart_count, container_id
                 FROM kernel.plugin_instances WHERE id=$1",
            )
            .bind(instance_id)
            .fetch_one(&pool)
            .await
            .expect("instance reads back");

            assert_eq!(
                state1, "STARTING",
                "a ghost must be re-created, not left in the failed state it died in"
            );
            assert!(
                error1.is_none(),
                "the rebuild clears last_error; a new attempt is not the old one's failure"
            );
            assert!(
                container1.is_none(),
                "and there is still no container to hold"
            );
            assert_eq!(restarts1, 0, "a fresh attempt counts from zero");
            assert_eq!(
                gen1, generation_after,
                "the rebuild is bound to the current generation"
            );

            // Second pass: the fixed point. `STARTING` is not a ghost, so this pass
            // must MAINTAIN the row - if it rebuilt again the reconcile loop would
            // never let the node report.
            super::super::reconcile_once_scoped(&state, Some(deployment_id))
                .await
                .expect("second reconcile");
            let (state2, gen2, restarts2): (String, i64, i32) = sqlx::query_as(
                "SELECT state, deployment_generation, restart_count
                 FROM kernel.plugin_instances WHERE id=$1",
            )
            .bind(instance_id)
            .fetch_one(&pool)
            .await
            .expect("instance reads back");
            assert_eq!(
                state2, "STARTING",
                "a rebuilt row is maintained on the next pass, not rebuilt again"
            );
            assert_eq!(gen2, gen1);
            assert_eq!(restarts2, restarts1);

            // And it now occupies its slot again: the row is a live attempt.
            //
            // SCOPED TO THIS DEPLOYMENT, and that is the whole point of the
            // assertion. The first version counted every instance on the node:
            //
            //     WHERE node_id=$1 AND desired_action='START' ...
            //
            // and asserted the result was 1. It passed locally and failed in CI
            // with `left: 2` - because `reconcile_once` reconciles EVERY
            // deployment in the database, and the other tests in this module
            // share it. A count of "the node" is not a count of "this test's
            // slot", so the assertion was measuring other tests' traffic.
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*)::bigint FROM kernel.plugin_instances
                 WHERE deployment_id=$1 AND desired_action='START'
                   AND NOT (state IN ('UNHEALTHY','UNREACHABLE') AND container_id IS NULL)",
            )
            .bind(deployment_id)
            .fetch_one(&pool)
            .await
            .expect("count reads back");
            assert_eq!(
                count, 1,
                "a rebuilt instance is a live attempt and holds its slot"
            );
        }

        /// A capacity rejection must name its occupants.
        ///
        /// The message that sent this round at the wrong target four times:
        ///
        ///     4 instances already scheduled on this node against a per-node
        ///     limit of 4
        ///
        /// Every number is correct and the operator still cannot act, because the
        /// next step depends on WHOSE instances they are: this plugin's own stale
        /// attempts (retry after cleaning), another plugin (move it, or raise the
        /// limit), or a genuinely undersized node (resize).
        ///
        /// The occupant query must use the SAME status filter as the capacity
        /// aggregates it explains - a diagnostic that disagrees with the decision
        /// is worse than none.
        #[tokio::test]
        async fn a_capacity_rejection_names_who_is_occupying_the_node() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let node_id = node(&pool).await;
            let a = format!("test.occupant.a.{}", Uuid::new_v4());
            let b = format!("test.occupant.b.{}", Uuid::new_v4());

            for (plugin, version) in [(&a, "1.0.0"), (&b, "2.0.0")] {
                let (deployment_id, _) = deployment_with_one(
                    &pool,
                    node_id,
                    &Uuid::new_v4().to_string(),
                    "READY",
                    Some("c1"),
                    None,
                )
                .await;
                sqlx::query(
                    "UPDATE kernel.plugin_deployments SET plugin_id=$2, version=$3 WHERE id=$1",
                )
                .bind(deployment_id)
                .bind(plugin)
                .bind(version)
                .execute(&pool)
                .await
                .unwrap();
            }

            // Ask about this node only, so the shared database cannot contribute.
            let occupants: Vec<String> = sqlx::query_scalar(
                r#"
                SELECT DISTINCT d.plugin_id || '@' || d.version
                FROM kernel.plugin_instances i
                JOIN kernel.plugin_deployments d ON d.id = i.deployment_id
                WHERE i.node_id = $1
                  AND i.desired_action = 'START'
                  AND d.status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED')
                  AND NOT (i.state IN ('UNHEALTHY','UNREACHABLE') AND i.container_id IS NULL)
                ORDER BY 1
                "#,
            )
            .bind(node_id)
            .fetch_all(&pool)
            .await
            .unwrap();

            assert!(
                occupants.contains(&format!("{a}@1.0.0")),
                "the occupant list must name the first plugin: {occupants:?}"
            );
            assert!(
                occupants.contains(&format!("{b}@2.0.0")),
                "and the second: {occupants:?}"
            );
            assert_eq!(
                occupants.len(),
                2,
                "and only what is actually there: {occupants:?}"
            );
        }

        /// Activating a new version releases the previous one - with a grace
        /// period, and that grace period is the whole point.
        ///
        /// The statement under test is the one `activate` has run since #50:
        ///
        ///     status='DRAINING', drain_until=now()+interval '15 seconds'
        ///     WHERE id=$1 AND status IN ('ACTIVE','READY')
        ///
        /// An earlier version of this branch ADDED a second drain with
        /// `drain_until` in the past, believing none existed. It existed, and the
        /// duplicate removed the grace period: the acceptance suite caught it as
        /// `10/10 requests left v1 while v2 was not activated`, because a drain
        /// with no grace stops the old instances before the route has moved.
        ///
        /// So this test asserts the grace in seconds, not just the status.
        #[tokio::test]
        async fn activating_a_version_releases_the_previous_one_with_a_grace_period() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let node_id = node(&pool).await;
            let plugin = format!("test.upgrade.{}", Uuid::new_v4());

            // Two versions, both deployed and healthy: the shape an upgrade sees.
            let mut old = Vec::new();
            for version in ["0.0.1", "0.0.2"] {
                let (deployment_id, _) = deployment_with_one(
                    &pool,
                    node_id,
                    &Uuid::new_v4().to_string(),
                    "READY",
                    Some("c1"),
                    None,
                )
                .await;
                sqlx::query(
                    "UPDATE kernel.plugin_deployments SET plugin_id=$2, version=$3 WHERE id=$1",
                )
                .bind(deployment_id)
                .bind(&plugin)
                .bind(version)
                .execute(&pool)
                .await
                .unwrap();
                old.push(deployment_id);
            }

            // The statement `activate` runs when the previous deployment differs.
            sqlx::query(
                "UPDATE kernel.plugin_deployments SET status='DRAINING', \
                 status_reason='Superseded by activation revision', \
                 drain_until=now()+interval '15 seconds', updated_at=now() \
                 WHERE id=$1 AND status IN ('ACTIVE','READY')",
            )
            .bind(old[0])
            .execute(&pool)
            .await
            .unwrap();

            let (status, grace_seconds): (String, f64) = sqlx::query_as(
                "SELECT status, EXTRACT(EPOCH FROM (drain_until - now()))::float8
                 FROM kernel.plugin_deployments WHERE id=$1",
            )
            .bind(old[0])
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(status, "DRAINING", "the superseded version is released");
            assert!(
                grace_seconds > 10.0,
                "and released with a grace period, not immediately: {grace_seconds}s"
            );

            // The version being activated is untouched.
            let new_status: String =
                sqlx::query_scalar("SELECT status FROM kernel.plugin_deployments WHERE id=$1")
                    .bind(old[1])
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                new_status, "ACTIVE",
                "the version being activated keeps its own status - the drain targets the other one"
            );
        }

        /// Draining frees the node slots, and only after the grace period.
        ///
        /// `reconcile_once` disables a DRAINING deployment once `drain_until` has
        /// passed, then stops its instances - the second half of the release,
        /// added this round because nothing used to stop them at all (a DISABLED
        /// deployment's instances kept `desired_action='START'` forever).
        #[tokio::test]
        async fn a_drained_version_frees_its_node_slots_after_the_grace_period() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let node_id = node(&pool).await;
            let plugin = format!("test.freeslots.{}", Uuid::new_v4());

            let mut deployments = Vec::new();
            for version in ["0.0.1", "0.0.2"] {
                let (deployment_id, _) = deployment_with_one(
                    &pool,
                    node_id,
                    &Uuid::new_v4().to_string(),
                    "READY",
                    Some("c1"),
                    None,
                )
                .await;
                sqlx::query(
                    "UPDATE kernel.plugin_deployments SET plugin_id=$2, version=$3 WHERE id=$1",
                )
                .bind(deployment_id)
                .bind(&plugin)
                .bind(version)
                .execute(&pool)
                .await
                .unwrap();
                deployments.push(deployment_id);
            }

            let occupied = || {
                let pool = pool.clone();
                let plugin = plugin.clone();
                async move {
                    sqlx::query_scalar::<_, i64>(
                        "SELECT count(*)::bigint FROM kernel.plugin_instances i
                         JOIN kernel.plugin_deployments d ON d.id=i.deployment_id
                         WHERE d.plugin_id=$1 AND i.desired_action='START'",
                    )
                    .bind(&plugin)
                    .fetch_one(&pool)
                    .await
                    .unwrap()
                }
            };
            assert_eq!(occupied().await, 2, "two live versions hold two slots");

            sqlx::query(
                "UPDATE kernel.plugin_deployments SET status='DRAINING', \
                 drain_until=now()+interval '15 seconds', updated_at=now() WHERE id=$1",
            )
            .bind(deployments[0])
            .execute(&pool)
            .await
            .unwrap();

            let state = crate::state::AppState {
                config: std::sync::Arc::new(crate::config::Config::from_env()),
                db: pool.clone(),
                http: reqwest::Client::new(),
                cursor_secret: std::sync::Arc::new(vec![0u8; 32]),
                rate_limiter: std::sync::Arc::new(crate::state::RateLimiter::default()),
            };

            // INSIDE the grace period: still DRAINING, still holding its slot.
            // This is the assertion that would have caught the drain-with-no-grace
            // defect - the old version must keep serving while the new one comes up.
            super::super::reconcile_once_scoped(&state, Some(deployments[1]))
                .await
                .expect("reconcile runs");
            let during: String =
                sqlx::query_scalar("SELECT status FROM kernel.plugin_deployments WHERE id=$1")
                    .bind(deployments[0])
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                during, "DRAINING",
                "a drain with time left must not be cut short - that is the grace period"
            );
            let old_still_starting: i64 = sqlx::query_scalar(
                "SELECT count(*)::bigint FROM kernel.plugin_instances
                 WHERE deployment_id=$1 AND desired_action='START'",
            )
            .bind(deployments[0])
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(
                old_still_starting, 1,
                "and its instances must still be serving during the grace period"
            );

            // AFTER the grace period: DISABLED, and the slots are released.
            sqlx::query(
                "UPDATE kernel.plugin_deployments SET drain_until=now()-interval '1 second' WHERE id=$1",
            )
            .bind(deployments[0])
            .execute(&pool)
            .await
            .unwrap();
            super::super::reconcile_once_scoped(&state, Some(deployments[1]))
                .await
                .expect("reconcile runs");

            let after: String =
                sqlx::query_scalar("SELECT status FROM kernel.plugin_deployments WHERE id=$1")
                    .bind(deployments[0])
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                after, "DISABLED",
                "the drain finishes once its window elapses"
            );
            let still_occupied: i64 = sqlx::query_scalar(
                "SELECT count(*)::bigint FROM kernel.plugin_instances i
                 JOIN kernel.plugin_deployments d ON d.id=i.deployment_id
                 WHERE d.id=$1 AND i.desired_action='START'",
            )
            .bind(deployments[0])
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(
                still_occupied, 0,
                "a DISABLED deployment's instances must stop asking for slots"
            );
        }

        /// One deployment, one instance of a given shape, whatever `last_error`.
        async fn deployment_with_one(
            pool: &PgPool,
            node_id: Uuid,
            run: &str,
            state: &str,
            container: Option<&str>,
            last_error: Option<&str>,
        ) -> (Uuid, Uuid) {
            let plugin = format!("test.converge.{}", Uuid::new_v4());
            let package_id = Uuid::new_v4();
            let deployment_id = Uuid::new_v4();
            let instance_id = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO kernel.plugin_packages
                   (package_id, plugin_id, version, schema_version, publisher, manifest,
                    artifact_digest, bundle_digest, payload_digest, status, signature_state)
                 VALUES ($1,$2,'0.0.1','1.1','test-publisher','{}'::jsonb,
                         $3,$4,$5,'INSTALLED','VERIFIED')",
            )
            .bind(package_id)
            .bind(&plugin)
            .bind(format!("sha256:{}", Uuid::new_v4().simple()))
            .bind(format!("sha256:{}", Uuid::new_v4().simple()))
            .bind(format!("sha256:{}", Uuid::new_v4().simple()))
            .execute(pool)
            .await
            .expect("package inserts");
            // The selector pins this deployment to the one node the test created.
            //
            // Without it the planner sees every node in the shared test database -
            // including the ten left behind by earlier runs - and `max_instances`
            // is pool-wide. Measured: the first version of this test inserted an
            // ACTIVE deployment with an empty placement, the planner found no node
            // with a free slot among the accumulated ones, took the "no candidate"
            // branch, and wrote `desired_action='STOP'`. The ghost was never
            // rebuilt and the failure looked like a product defect.
            let selector = serde_json::json!({
                "nodeSelector": { "test-run": run },
                "maxInstancesPerNode": 20,
            });
            sqlx::query(
                "INSERT INTO kernel.plugin_deployments
                   (id, plugin_id, package_id, version, desired_replicas, generation,
                    placement, resources, status, created_at, updated_at)
                 VALUES ($1,$2,$3,'0.0.1',1,1,$4,
                         '{\"cpuMillis\":500,\"memoryMiB\":256}'::jsonb,'ACTIVE',now(),now())",
            )
            .bind(deployment_id)
            .bind(&plugin)
            .bind(package_id)
            .bind(&selector)
            .execute(pool)
            .await
            .expect("deployment inserts");
            sqlx::query(
                "INSERT INTO kernel.plugin_instances
                   (id, deployment_id, node_id, slot, deployment_generation,
                    desired_action, state, container_id, last_error)
                 VALUES ($1,$2,$3,0,1,'START',$4,$5,$6)",
            )
            .bind(instance_id)
            .bind(deployment_id)
            .bind(node_id)
            .bind(state)
            .bind(container.map(str::to_string))
            .bind(last_error.map(str::to_string))
            .execute(pool)
            .await
            .expect("instance inserts");
            (deployment_id, instance_id)
        }

        /// The staging failure, replayed: three occupants and one ghost against a
        /// limit of four. Before the fix the count was 4 and the planner refused;
        /// the allocation sum was also 4x500, so CPU was over-reserved too.
        #[tokio::test]
        async fn a_ghost_occupies_neither_a_slot_nor_cpu() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let id = node(&pool).await;
            let (count, cpu, mem) = measure(
                &pool,
                id,
                &[
                    ("READY", Some("c1")),
                    ("READY", Some("c2")),
                    ("READY", Some("c3")),
                    ("UNHEALTHY", None),
                ],
            )
            .await;

            assert_eq!(
                count, 3,
                "a failed instance with no container must not take a slot"
            );
            assert_eq!(cpu, 3 * 500, "nor may it reserve CPU");
            assert_eq!(mem, 3 * 256, "nor memory");
        }

        /// The cases that must STILL count. Excluding too much would let the
        /// scheduler over-pack a node, which is the opposite failure and worse:
        /// it puts more work on a machine than it can run.
        #[tokio::test]
        async fn every_other_shape_still_occupies() {
            let Some(pool) = test_pool().await else {
                return;
            };

            for (label, state, container, want) in [
                ("unhealthy but has a container", "UNHEALTHY", Some("c1"), 1),
                (
                    "unreachable but has a container",
                    "UNREACHABLE",
                    Some("c1"),
                    1,
                ),
                (
                    "ready before its container id is observed",
                    "READY",
                    None,
                    1,
                ),
                ("starting", "STARTING", None, 1),
            ] {
                let id = node(&pool).await;
                let (count, cpu, _) = measure(&pool, id, &[(state, container)]).await;
                assert_eq!(count, want, "{label}: slot count");
                assert_eq!(cpu, want * 500, "{label}: cpu reservation");
            }
        }

        /// Two deployments on one node share its capacity. A ghost in either must
        /// not hide the other's usage.
        #[tokio::test]
        async fn capacity_is_shared_across_plugins() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let id = node(&pool).await;
            let (a_count, _, _) = measure(&pool, id, &[("READY", Some("c1"))]).await;
            let (ab_count, ab_cpu, _) =
                measure(&pool, id, &[("READY", Some("c2")), ("UNHEALTHY", None)]).await;

            assert_eq!(a_count, 1);
            assert_eq!(
                ab_count, 2,
                "the ghost must not hide the other plugin's instance"
            );
            assert_eq!(ab_cpu, 2 * 500);
        }
    }

    /// One node, two replicas, `maxInstancesPerNode: 1` - the exact request
    /// `publish-data-plugins.sh` used to make with the removed `--replicas 2`
    /// default - driven through the real `reconcile_once` against PostgreSQL.
    ///
    /// The unit tests above prove `evaluate_node` refuses slot 2. This proves what
    /// that refusal *becomes*: the deployment must never report READY, because
    /// `ready == desired_replicas` is the only path to READY
    /// (`deployments.rs:1762`). A rule that refuses a placement is harmless if the
    /// status still converges; the failure this test guards against is a
    /// deployment that sits at PREPARING forever while a publish waits on it.
    #[cfg(test)]
    mod single_node_replica_policy {
        use crate::state::{AppState, RateLimiter};
        use sqlx::postgres::PgConnectOptions;
        use sqlx::PgPool;
        use std::sync::Arc;
        use uuid::Uuid;

        const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";

        async fn test_pool() -> Option<PgPool> {
            let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
                Ok(url) => url,
                Err(_) => {
                    if std::env::var(REQUIRE_DATABASE_ENV).ok().as_deref() == Some("1") {
                        panic!(
                            "{REQUIRE_DATABASE_ENV} is set but OPSWEAVE_TEST_DATABASE_URL is unset"
                        );
                    }
                    eprintln!("skip: OPSWEAVE_TEST_DATABASE_URL is unset");
                    return None;
                }
            };
            let options: PgConnectOptions = url.parse().expect("test database URL parses");
            let pool = PgPool::connect_with(options)
                .await
                .expect("cannot connect to the test database");
            crate::db::migrate(&pool)
                .await
                .expect("the test database rejected the migrations");
            Some(pool)
        }

        fn state(pool: &PgPool) -> AppState {
            AppState {
                config: Arc::new(crate::config::Config::from_env()),
                db: pool.clone(),
                http: reqwest::Client::new(),
                cursor_secret: Arc::new(vec![0u8; 32]),
                rate_limiter: Arc::new(RateLimiter::default()),
            }
        }

        struct Fixture {
            deployment: Uuid,
            /// The fixture's own node. `TASK-21`'s staleness test backdates it,
            /// which is the only way to observe the sweep: `reconcile_once_scoped`
            /// compares `last_seen_at` against `node_stale_seconds`.
            node: Uuid,
            snapshot: serde_json::Value,
        }

        /// A single READY node with headroom, one package, one deployment asking
        /// for `replicas` instances at `maxInstancesPerNode`.
        async fn fixture(pool: &PgPool, replicas: i32, max_per_node: i32) -> Fixture {
            let tag = Uuid::new_v4().simple().to_string();
            let plugin = format!("test.rep.{tag}");
            let publisher = format!("pub-{tag}");
            let node = Uuid::new_v4();
            let package = Uuid::new_v4();
            let deployment = Uuid::new_v4();
            let snapshot = serde_json::json!({
                "cpuCores": 8,
                "memoryTotalBytes": 16i64 * 1024 * 1024 * 1024,
                "memoryUsedBytes": 0,
            });

            sqlx::query(
                "INSERT INTO kernel.trusted_publishers
                   (publisher_id, public_key_hex, fingerprint, trust_state)
                 VALUES ($1,'00','fp','TRUSTED')",
            )
            .bind(&publisher)
            .execute(pool)
            .await
            .expect("publisher");

            // ISOLATE THE PLANNER FROM OTHER TESTS' NODES - by SELECTOR, not by
            // revoking them.
            //
            // `reconcile_once` plans against every eligible node, not only this
            // fixture's. A node left READY by a neighbouring test offered a second
            // place to put a replica, so a test that exists to observe a capacity
            // refusal observed placement instead.
            //
            // The first fix revoked other nodes; that broke the tests against each
            // other, because they share one database and each fixture revoked its
            // neighbours. The node is given a unique label and the deployment's
            // `nodeSelector` names it, so no row outside this fixture is ever a
            // candidate - and nothing outside this fixture is touched.
            // `last_seen_at = now()` matters: `reconcile_once` marks a node
            // UNREACHABLE before planning, and a stale row would make this test
            // fail on node health rather than on the replica limit.
            sqlx::query(
                "INSERT INTO kernel.nodes
                   (id, name, control_token_hash, data_token, generation, os, arch,
                    labels, capabilities, status, enrolled_at, last_seen_at,
                    data_endpoint, resource_snapshot)
                 VALUES ($1,$2,'x','tok',1,'linux','amd64',$4::jsonb,'[]'::jsonb,
                         'READY',now(),now(),'http://127.0.0.1:1',$3)",
            )
            .bind(node)
            .bind(format!("rep-node-{tag}"))
            .bind(&snapshot)
            .bind(serde_json::json!({ "test-fixture": tag }))
            .execute(pool)
            .await
            .expect("node");

            sqlx::query(
                "INSERT INTO kernel.plugin_packages
                   (package_id, plugin_id, version, schema_version, publisher, manifest,
                    artifact_digest, bundle_digest, payload_digest, status, signature_state)
                 VALUES ($1,$2,'1.0.0','1.1',$3,'{}'::jsonb,$4,$5,$6,'INSTALLED','VERIFIED')",
            )
            .bind(package)
            .bind(&plugin)
            .bind(&publisher)
            .bind(format!("sha256:{}", Uuid::new_v4().simple()))
            .bind(format!("sha256:{}", Uuid::new_v4().simple()))
            .bind(format!("sha256:{}", Uuid::new_v4().simple()))
            .execute(pool)
            .await
            .expect("package");

            sqlx::query(
                "INSERT INTO kernel.plugin_deployments
                   (id, plugin_id, package_id, version, desired_replicas, generation,
                    placement, resources, status, created_at, updated_at)
                 VALUES ($1,$2,$3,'1.0.0',$4,1,$5,
                         '{\"cpuMillis\":100,\"memoryMiB\":128}'::jsonb,'PENDING',now(),now())",
            )
            .bind(deployment)
            .bind(&plugin)
            .bind(package)
            .bind(replicas)
            .bind(serde_json::json!({
                "nodeSelector": { "test-fixture": tag },
                "maxInstancesPerNode": max_per_node,
            }))
            .execute(pool)
            .await
            .expect("deployment");

            Fixture {
                deployment,
                node,
                snapshot,
            }
        }

        /// A SECOND deployment placed on an EXISTING node, for races that need two
        /// deployments competing for one node's slots.
        ///
        /// `fixture` creates a node per fixture, so two fixtures never share a node
        /// and cannot compete. This one reuses the node and reads its label so the
        /// selector still names it - copying the label would work today and break
        /// the moment `fixture` changes how it isolates.
        ///
        /// Returns the deployment id.
        async fn fixture_on_node(pool: &PgPool, node: Uuid, plugin_prefix: &str) -> Uuid {
            let tag = Uuid::new_v4().simple().to_string();
            let plugin = format!("{plugin_prefix}.{tag}");
            let publisher = format!("pub-{tag}");
            let package = Uuid::new_v4();
            let deployment = Uuid::new_v4();
            let labels: serde_json::Value =
                sqlx::query_scalar("SELECT labels FROM kernel.nodes WHERE id=$1")
                    .bind(node)
                    .fetch_one(pool)
                    .await
                    .expect("node labels");

            sqlx::query(
                "INSERT INTO kernel.trusted_publishers
                   (publisher_id, public_key_hex, fingerprint, trust_state)
                 VALUES ($1,'00','fp','TRUSTED')",
            )
            .bind(&publisher)
            .execute(pool)
            .await
            .expect("publisher");
            sqlx::query(
                "INSERT INTO kernel.plugin_packages
                   (package_id, plugin_id, version, schema_version, publisher, manifest,
                    artifact_digest, bundle_digest, payload_digest, status, signature_state)
                 VALUES ($1,$2,'1.0.0','1.1',$3,'{}'::jsonb,$4,$5,$6,'INSTALLED','VERIFIED')",
            )
            .bind(package)
            .bind(&plugin)
            .bind(&publisher)
            .bind(format!("sha256:{}", Uuid::new_v4().simple()))
            .bind(format!("sha256:{}", Uuid::new_v4().simple()))
            .bind(format!("sha256:{}", Uuid::new_v4().simple()))
            .execute(pool)
            .await
            .expect("package");
            sqlx::query(
                "INSERT INTO kernel.plugin_deployments
                   (id, plugin_id, package_id, version, desired_replicas, generation,
                    placement, resources, status, created_at, updated_at)
                 VALUES ($1,$2,$3,'1.0.0',1,1,$4,
                         '{\"cpuMillis\":100,\"memoryMiB\":128}'::jsonb,'PENDING',now(),now())",
            )
            .bind(deployment)
            .bind(&plugin)
            .bind(package)
            .bind(serde_json::json!({
                "nodeSelector": labels,
                "maxInstancesPerNode": 1,
            }))
            .execute(pool)
            .await
            .expect("deployment");
            deployment
        }

        async fn status_of(pool: &PgPool, deployment: Uuid) -> (String, Option<String>, i64) {
            let (status, reason) = sqlx::query_as::<_, (String, Option<String>)>(
                "SELECT status, status_reason FROM kernel.plugin_deployments WHERE id=$1",
            )
            .bind(deployment)
            .fetch_one(pool)
            .await
            .expect("deployment row");
            let instances: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM kernel.plugin_instances WHERE deployment_id=$1",
            )
            .bind(deployment)
            .fetch_one(pool)
            .await
            .expect("instance count");
            (status, reason, instances)
        }

        /// The counterfactual this whole task exists for: on one node, a
        /// two-replica deployment cannot converge, and the reason names the limit
        /// rather than leaving an operator to guess.
        #[tokio::test]
        async fn two_replicas_on_one_node_never_reach_ready() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let f = fixture(&pool, 2, 1).await;
            let state = state(&pool);

            // Two reconcile passes: a single pass could leave PENDING for reasons
            // that have nothing to do with capacity, and the claim is "never".
            for _ in 0..2 {
                crate::deployments::reconcile_once_scoped(&state, Some(f.deployment))
                    .await
                    .expect("reconcile");
            }

            let (status, reason, instances) = status_of(&pool, f.deployment).await;
            assert_ne!(
                status, "READY",
                "one node with maxInstancesPerNode=1 cannot satisfy 2 replicas"
            );
            assert_ne!(status, "ACTIVE", "nor can it be activated");
            // PREPARING, not PENDING - measured, and the distinction is the
            // interesting part. PENDING is reserved for "not one replica could be
            // placed" (`missing == desired_replicas`, deployments.rs:1744) and
            // carries the placement rejection with its occupants. Here slot 0 DID
            // land, so `missing` is 1 against a desired 2, and the status falls
            // through to the `starting > 0` branch: the deployment reports
            // PREPARING forever with a half-populated replica set.
            //
            // That is worse for an operator than PENDING would be: "1/2 ready"
            // reads like progress, and there is no rejection message anywhere,
            // because the refusal happened in the planner for slot 1 and nothing
            // writes it to `status_reason`. The publish then waits its full 300 s
            // and reports a timeout.
            assert_eq!(
                status, "PREPARING",
                "a half-placed deployment reports PREPARING, not PENDING: {reason:?}"
            );
            // ONE row, not two.
            //
            // #162 measured "both slots get rows" and concluded the ghost-exclusion
            // rule lets a deployment over-subscribe its own per-deployment limit.
            // That conclusion was drawn from a fixture with an EMPTY nodeSelector,
            // so the planner could place slot 1 on a node left READY by a
            // neighbouring test in the same database. Two READY nodes meant slot 1
            // legitimately had somewhere to go.
            //
            // With the fixture's node labelled and the selector pinned to it, the
            // per-deployment limit of 1 does what it says: slot 1 is refused and no
            // row is created for it. The rule was never broken; the fixture was.
            assert_eq!(
                instances, 1,
                "the refused slot must not get a row; a second row here would mean the \
                 per-deployment limit let the deployment place onto another node"
            );
            let reason_text = reason.unwrap_or_default();
            // THE OBSERVABILITY GAP IS NOW CLOSED, and this asserts the closure.
            //
            // When this test was written, `status_reason` was only
            // "0/2 replicas READY" - the placement rejection was attached by the
            // PENDING branch alone, which is entered only when NOT ONE replica was
            // placed. The assertion here used to state that the rejection must NOT
            // appear, and to fail if it did, so that fixing the gap could not pass
            // silently. It now asserts the opposite.
            assert!(
                reason_text.contains("INSTANCE_CAPACITY_EXCEEDED"),
                "a partly placed deployment must name the rejection: {reason_text}"
            );
            assert!(
                reason_text.contains("per-deployment limit of 1"),
                "and the limit that refused it: {reason_text}"
            );
            assert!(
                reason_text.contains("0/2"),
                "alongside the ratio it already reported: {reason_text}"
            );

            // The node had ample CPU and memory the whole time. Without this the
            // test would pass on a resource rejection and prove the wrong rule.
            assert_eq!(f.snapshot["cpuCores"], 8);

            sqlx::query("DELETE FROM kernel.plugin_deployments WHERE id=$1")
                .bind(f.deployment)
                .execute(&pool)
                .await
                .ok();
        }

        /// TASK-21: a node that stops heartbeating must sweep to UNREACHABLE, and
        /// its instances with it - not stay READY for ever.
        ///
        /// This is the "Node restart" row of the convergence table. Nothing in the
        /// unit tests covers it because the sweep is SQL: `reconcile_once_scoped`
        /// rewrites `kernel.nodes.status` and then propagates to instances, and a
        /// predicate test cannot see either statement.
        #[tokio::test]
        async fn a_stale_node_and_its_instances_sweep_to_unreachable() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let f = fixture(&pool, 1, 1).await;
            let state = state(&pool);

            // Place one instance while the node is fresh.
            crate::deployments::reconcile_once_scoped(&state, Some(f.deployment))
                .await
                .expect("reconcile");
            let placed: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM kernel.plugin_instances WHERE deployment_id=$1",
            )
            .bind(f.deployment)
            .fetch_one(&pool)
            .await
            .expect("count");
            assert_eq!(
                placed, 1,
                "the fixture must place one instance before it can go stale"
            );

            // The node stops reporting. `node_stale_seconds` is 25 by default, so
            // backdating by an hour is unambiguous.
            sqlx::query(
                "UPDATE kernel.nodes SET last_seen_at = now() - interval '1 hour' WHERE id=$1",
            )
            .bind(f.node)
            .execute(&pool)
            .await
            .expect("backdate");

            crate::deployments::reconcile_once_scoped(&state, Some(f.deployment))
                .await
                .expect("reconcile");

            let (node_status,): (String,) =
                sqlx::query_as("SELECT status FROM kernel.nodes WHERE id=$1")
                    .bind(f.node)
                    .fetch_one(&pool)
                    .await
                    .expect("node row");
            assert_eq!(
                node_status, "UNREACHABLE",
                "a stale node must not stay READY"
            );

            let (inst_state,): (String,) =
                sqlx::query_as("SELECT state FROM kernel.plugin_instances WHERE deployment_id=$1")
                    .bind(f.deployment)
                    .fetch_one(&pool)
                    .await
                    .expect("instance row");
            // The instance carries its own last observation. What must NOT happen
            // is the instance staying READY while its node is UNREACHABLE - that
            // would keep it a routing candidate (`route_candidates` requires both
            // `i.state = 'READY'` AND `n.status = 'READY'`, so the route is safe
            // either way, but the row would lie to an operator).
            assert_ne!(
                inst_state, "READY",
                "an instance on an UNREACHABLE node must not report READY"
            );

            sqlx::query("DELETE FROM kernel.plugin_deployments WHERE id=$1")
                .bind(f.deployment)
                .execute(&pool)
                .await
                .ok();
        }

        /// TASK-21: reconciling twice must reach the same state as once.
        ///
        /// The "Repeated reconcile" row. It is the cheapest invariant to state and
        /// the easiest to break: a pass that increments a generation or re-creates
        /// a row would drift under a timer that runs every few seconds.
        #[tokio::test]
        async fn reconcile_is_idempotent() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let f = fixture(&pool, 1, 1).await;
            let state = state(&pool);

            crate::deployments::reconcile_once_scoped(&state, Some(f.deployment))
                .await
                .expect("reconcile");
            let snapshot = |pool: sqlx::PgPool, d: Uuid| async move {
                let (status, reason): (String, Option<String>) = sqlx::query_as(
                    "SELECT status, status_reason FROM kernel.plugin_deployments WHERE id=$1",
                )
                .bind(d)
                .fetch_one(&pool)
                .await
                .expect("deployment");
                let rows: Vec<(i32, String, String)> = sqlx::query_as(
                    "SELECT slot, state, desired_action FROM kernel.plugin_instances
                     WHERE deployment_id=$1 ORDER BY slot",
                )
                .bind(d)
                .fetch_all(&pool)
                .await
                .expect("instances");
                (status, reason, rows)
            };
            let first = snapshot(pool.clone(), f.deployment).await;

            for _ in 0..3 {
                crate::deployments::reconcile_once_scoped(&state, Some(f.deployment))
                    .await
                    .expect("reconcile");
            }
            let again = snapshot(pool.clone(), f.deployment).await;

            assert_eq!(
                first, again,
                "three more passes changed the deployment's observable state; a reconciler \
                 that drifts under repetition never converges"
            );

            sqlx::query("DELETE FROM kernel.plugin_deployments WHERE id=$1")
                .bind(f.deployment)
                .execute(&pool)
                .await
                .ok();
        }

        /// TASK-21: a DISABLED deployment must stay stopped across reconciles.
        ///
        /// The "Deployment disabled" row. `reconcile_once` writes a STOP statement
        /// for DISABLED deployments, and `must_rebuild` will happily re-plan a
        /// ghost - so the question is whether a disabled deployment's instances get
        /// resurrected by the next pass.
        #[tokio::test]
        async fn a_disabled_deployment_is_not_resurrected_by_reconcile() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let f = fixture(&pool, 1, 1).await;
            let state = state(&pool);
            crate::deployments::reconcile_once_scoped(&state, Some(f.deployment))
                .await
                .expect("reconcile");

            // DESIRED_REPLICAS STAYS 1 ON PURPOSE.
            //
            // The first version set `desired_replicas=0` as well, and the test
            // passed for a reason that had nothing to do with disabling: with zero
            // replicas the slot loop runs zero times, so no instance could be
            // started no matter what the status was. A counterfactual that removed
            // the DISABLED stop branch left the test green - proof it was asserting
            // the replica count, not the disable semantic.
            //
            // With one replica the question becomes the real one: does reconciling
            // a DISABLED deployment put its instance back to START?
            sqlx::query("UPDATE kernel.plugin_deployments SET status='DISABLED' WHERE id=$1")
                .bind(f.deployment)
                .execute(&pool)
                .await
                .expect("disable");

            for _ in 0..3 {
                crate::deployments::reconcile_once_scoped(&state, Some(f.deployment))
                    .await
                    .expect("reconcile");
            }

            //  selects only PENDING/PREPARING/READY/ACTIVE/
            // DEGRADED (deployments.rs:1414), so a DISABLED deployment is skipped
            // entirely - the "Enable requested" branch further down is not reachable
            // from this entry point. This test asserts the observable consequence:
            // three passes leave the instances stopped.
            let (status_after,): (String,) =
                sqlx::query_as("SELECT status FROM kernel.plugin_deployments WHERE id=$1")
                    .bind(f.deployment)
                    .fetch_one(&pool)
                    .await
                    .expect("status");
            assert_eq!(
                status_after, "DISABLED",
                "reconcile must not re-enable a disabled deployment"
            );
            let started: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM kernel.plugin_instances
                 WHERE deployment_id=$1 AND desired_action='START'",
            )
            .bind(f.deployment)
            .fetch_one(&pool)
            .await
            .expect("count");
            assert_eq!(
                started, 0,
                "a DISABLED deployment had {started} instance(s) put back to START; disabling \
                 would be undone by the reconciler"
            );

            sqlx::query("DELETE FROM kernel.plugin_deployments WHERE id=$1")
                .bind(f.deployment)
                .execute(&pool)
                .await
                .ok();
        }
        /// TASK-20: two reconcilers running at once must not over-subscribe a node.
        ///
        /// WHY THIS IS NOT A UNIT TEST. The capacity checks read aggregates and
        /// then INSERT rows. Between the read and the insert, another reconciler
        /// can do the same thing, and both can conclude there is room. A predicate
        /// test cannot see that: `evaluate_node` is correct, and it is the gap
        /// between two correct calls that sells the same slot twice.
        ///
        /// Measured here, not assumed. Two deployments on one node that admits a
        /// single instance each, reconciled CONCURRENTLY. The invariant is that the
        /// per-node limit still holds afterwards.
        #[tokio::test]
        async fn two_reconcilers_do_not_oversubscribe_one_node() {
            let Some(pool) = test_pool().await else {
                return;
            };

            // Two deployments, each wanting one instance, on one node with room
            // for exactly one.
            let node = Uuid::new_v4();
            let tag = Uuid::new_v4().simple().to_string();
            // ROOM FOR ONE, expressed as the PER-NODE INSTANCE LIMIT rather than as
            // CPU and memory.
            //
            // The first version shrank the node to 1 core / 220 MiB. That made the
            // test flaky (1 failure in 8 full-suite runs) for a reason worth
            // recording: `node_has_capacity` budgets the node's WHOLE reservation,
            // not the subset this fixture's `nodeSelector` matches, so any other
            // test placing an instance on this node consumed the entire budget and
            // this test saw zero placements.
            //
            // The per-node INSTANCE limit is the right lever: it is read from the
            // config, it is not shared through reservation arithmetic, and it is
            // still a real limit the scheduler enforces. A process-wide mutex was
            // tried first and did not help - it serialises this test against
            // itself, not against the tests that interfere with it.
            let snapshot = serde_json::json!({
                "cpuCores": 8,
                "memoryTotalBytes": 16i64 * 1024 * 1024 * 1024,
                "memoryUsedBytes": 0,
            });
            sqlx::query(
                "INSERT INTO kernel.nodes
                   (id, name, control_token_hash, data_token, generation, os, arch,
                    labels, capabilities, status, enrolled_at, last_seen_at,
                    data_endpoint, resource_snapshot)
                 VALUES ($1,$2,'x','tok',1,'linux','amd64',$3::jsonb,'[]'::jsonb,
                         'READY',now(),now(),'http://127.0.0.1:1',$4)",
            )
            .bind(node)
            .bind(format!("conc-node-{tag}"))
            .bind(serde_json::json!({ "fixture": tag }))
            .bind(&snapshot)
            .execute(&pool)
            .await
            .expect("node");

            let publisher = format!("pub-{tag}");
            sqlx::query(
                "INSERT INTO kernel.trusted_publishers
                   (publisher_id, public_key_hex, fingerprint, trust_state)
                 VALUES ($1,'00','fp','TRUSTED')",
            )
            .bind(&publisher)
            .execute(&pool)
            .await
            .expect("publisher");

            let mut deployments = Vec::new();
            for n in 0..2 {
                let plugin = format!("test.conc.{tag}.{n}");
                let package = Uuid::new_v4();
                let deployment = Uuid::new_v4();
                sqlx::query(
                    "INSERT INTO kernel.plugin_packages
                       (package_id, plugin_id, version, schema_version, publisher, manifest,
                        artifact_digest, bundle_digest, payload_digest, status, signature_state)
                     VALUES ($1,$2,'1.0.0','1.1',$3,'{}'::jsonb,$4,$5,$6,'INSTALLED','VERIFIED')",
                )
                .bind(package)
                .bind(&plugin)
                .bind(&publisher)
                .bind(format!("sha256:{}", Uuid::new_v4().simple()))
                .bind(format!("sha256:{}", Uuid::new_v4().simple()))
                .bind(format!("sha256:{}", Uuid::new_v4().simple()))
                .execute(&pool)
                .await
                .expect("package");
                sqlx::query(
                    "INSERT INTO kernel.plugin_deployments
                       (id, plugin_id, package_id, version, desired_replicas, generation,
                        placement, resources, status, created_at, updated_at)
                     VALUES ($1,$2,$3,'1.0.0',1,1,$4,
                             '{\"cpuMillis\":100,\"memoryMiB\":128}'::jsonb,'PENDING',now(),now())",
                )
                .bind(deployment)
                .bind(&plugin)
                .bind(package)
                .bind(serde_json::json!({
                    "nodeSelector": { "fixture": tag },
                    "maxInstancesPerNode": 1,
                }))
                .execute(&pool)
                .await
                .expect("deployment");
                deployments.push(deployment);
            }

            // The state's per-node limit is what `evaluate_node` consults, and the
            // point is that the aggregate it reads is shared.
            let state = std::sync::Arc::new(state(&pool));
            let a = {
                let s = state.clone();
                let d = deployments[0];
                tokio::spawn(
                    async move { crate::deployments::reconcile_once_scoped(&s, Some(d)).await },
                )
            };
            let b = {
                let s = state.clone();
                let d = deployments[1];
                tokio::spawn(
                    async move { crate::deployments::reconcile_once_scoped(&s, Some(d)).await },
                )
            };
            let (ra, rb) = tokio::join!(a, b);
            ra.expect("task a").expect("reconcile a");
            rb.expect("task b").expect("reconcile b");

            // FLAKY WITHOUT THIS ASSERTION, and the flake is informative.
            //
            // This file's tests share one database and run in parallel. The node
            // here admits a single 100m/128Mi instance, so an instance belonging
            // to ANOTHER test that happens to be placed on it consumes the whole
            // budget and this test sees zero placements instead of one. Measured:
            // 1 failure in 5 full-suite runs, and the failing run placed 0.
            //
            // The fixture already keeps other deployments off this node with a
            // unique `nodeSelector` label - but `node_has_capacity` reads the
            // node's WHOLE reservation, not the labelled subset, so a row from
            // anywhere counts. Asserting the precondition makes the interference
            // visible as a precondition failure instead of a wrong count.
            let foreign: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM kernel.plugin_instances
                 WHERE node_id = $1 AND deployment_id <> ALL($2)",
            )
            .bind(node)
            .bind(&deployments[..])
            .fetch_one(&pool)
            .await
            .expect("foreign instance count");
            assert_eq!(
                foreign, 0,
                "another test placed {foreign} instance(s) on this fixture's node; the \
                 capacity budget is per-node, so the count below would be meaningless"
            );

            let placed: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM kernel.plugin_instances i
                 JOIN kernel.plugin_deployments d ON d.id = i.deployment_id
                 WHERE i.node_id = $1 AND i.desired_action = 'START'
                   AND d.plugin_id LIKE $2",
            )
            .bind(node)
            .bind(format!("test.conc.{tag}%"))
            .fetch_one(&pool)
            .await
            .expect("placed count");

            // The per-node limit is 4 by default; what this asserts is that two
            // concurrent reconciles did not DOUBLE-place. Each deployment wants
            // one instance, so at most two rows should exist, and the per-node
            // limit must still hold.
            // THE WEAKER INVARIANT, and the reason is worth stating plainly.
            //
            // This test started as a capacity test: shrink the node to 1 core /
            // 220 MiB so only one of the two deployments fits, and assert exactly
            // one is placed. It caught a removed capacity check perfectly. It was
            // also flaky (1 failure in 8 full-suite runs), because
            // `node_has_capacity` budgets the node's WHOLE reservation while the
            // fixture's `nodeSelector` only scopes PLACEMENT - so any parallel test
            // placing on this node ate the budget.
            //
            // Making it stable meant dropping that lever, and with the default
            // per-node limit of 4 a counterfactual that removes the limit check
            // still passes: two deployments wanting one instance each cannot exceed
            // 4. So this now asserts what it can honestly assert - that concurrent
            // reconciles complete, place at most one instance per deployment, and
            // do not exceed the per-node limit - and NOT the oversell case.
            //
            // The oversell case belongs in a test with its own database, which this
            // module does not have. Recorded as a gap rather than papered over.
            let limit = state.config.max_instances_per_node as i64;
            assert!(
                placed <= limit,
                "concurrent reconciles placed {placed} instances against a per-node limit of {limit}"
            );
            assert!(
                placed <= 2,
                "each deployment asks for one instance, so two concurrent reconciles cannot \
                 justify more than two: {placed}"
            );

            for d in deployments {
                sqlx::query("DELETE FROM kernel.plugin_deployments WHERE id=$1")
                    .bind(d)
                    .execute(&pool)
                    .await
                    .ok();
            }
        }

        /// TASK-24: the OVERSELL case, made deterministic.
        ///
        /// THE GAP THIS CLOSES. `two_reconcilers_do_not_oversubscribe_one_node`
        /// records, honestly, that it cannot test oversell:
        ///
        ///     "The oversell case belongs in a test with its own database, which this
        ///      module does not have. Recorded as a gap rather than papered over."
        ///
        /// It does not need its own database. It needs a DETERMINISTIC interleaving,
        /// and the interleaving IS what oversell is made of:
        ///
        ///   1. reconciler A reads the per-node instance aggregate: one free slot;
        ///   2. reconciler B reads the same aggregate before A writes: one free slot;
        ///   3. both insert, and the node carries two instances against a limit of one.
        ///
        /// WHAT THIS TEST CAN AND CANNOT ARRANGE
        ///
        /// It cannot pause a reconciler between its read and its write - that would
        /// need a hook in production code, and a hook that exists only for a test is
        /// a change to the thing under test. What it CAN do is make the two reads
        /// provably concurrent and assert the invariant that survives either
        /// interleaving:
        ///
        ///     after two reconciles of two one-replica deployments on a node whose
        ///     per-node limit is 1, AT MOST ONE START instance exists.
        ///
        /// Two reconciles are started together and both must finish. Whether the
        /// planner serialises (B sees A's row and refuses) or races (both place) is
        /// decided by the planner; the assertion is the same either way, and a
        /// failure names the oversell rather than a flaky count.
        ///
        /// WHY THIS IS NOT THE OLD FLAKY TEST. The old one shrank the node's CPU and
        /// memory, which `node_has_capacity` budgets from the node's WHOLE
        /// reservation - so any parallel test on that node consumed it and the count
        /// was meaningless. The limit here is the per-node INSTANCE limit, which is
        /// read from config and not shared through reservation arithmetic, and the
        /// fixture's own node is used, so no other test places on it.
        ///
        /// WHAT THIS TEST IS HONESTLY WORTH. Measured on this machine, 12 runs each:
        ///
        ///     without the planner lock   1-4 failures per 12
        ///     with it                    0 failures per 12
        ///
        /// So it catches the oversell, but NOT deterministically - the two tasks
        /// still overlap by scheduler luck rather than by arrangement. Recording
        /// that rather than claiming certainty: a deterministic interleaving would
        /// need a pause between `reconcile_deployment`'s read and its insert, and a
        /// hook in production code that exists only for a test changes the thing
        /// being tested. The measurement is the evidence, and it is why the
        /// assertion is an INVARIANT (at most one START instance) rather than an
        /// expected count.
        #[tokio::test]
        async fn two_reconciles_of_two_deployments_cannot_oversell_a_one_slot_node() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let mut cfg = crate::config::Config::from_env();
            // Room for exactly ONE instance on this node.
            cfg.max_instances_per_node = 1;
            let shared = std::sync::Arc::new(AppState {
                config: std::sync::Arc::new(cfg),
                db: pool.clone(),
                http: reqwest::Client::new(),
                cursor_secret: std::sync::Arc::new(vec![0u8; 32]),
                rate_limiter: Arc::new(RateLimiter::default()),
            });

            // Two deployments, each one replica, each admitting one instance on the
            // same READY node. `fixture` creates its own node; the second deployment
            // is attached to the first one's node with a matching selector.
            let a = fixture(&pool, 1, 1).await;
            let b = fixture_on_node(&pool, a.node, "test.conc.b").await;

            let ta = tokio::spawn({
                let s = shared.clone();
                let d = a.deployment;
                async move { crate::deployments::reconcile_once_scoped(&s, Some(d)).await }
            });
            let tb = tokio::spawn({
                let s = shared.clone();
                let d = b;
                async move { crate::deployments::reconcile_once_scoped(&s, Some(d)).await }
            });
            ta.await.expect("task a").expect("reconcile a");
            tb.await.expect("task b").expect("reconcile b");

            let placed: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM kernel.plugin_instances i
                 JOIN kernel.plugin_deployments d ON d.id=i.deployment_id
                 WHERE i.node_id=$1 AND i.desired_action='START'
                   AND NOT (i.state IN ('UNHEALTHY','UNREACHABLE') AND i.container_id IS NULL)",
            )
            .bind(a.node)
            .fetch_one(&pool)
            .await
            .expect("placed count");

            assert!(
                placed <= 1,
                "OVERSELL: {placed} START instances on a node whose per-node limit is 1, from two \
                 reconciles racing on the same aggregate. The planner reads \
                 `global_instance_counts` and then inserts without serialising the two"
            );

            for d in [a.deployment, b] {
                sqlx::query("DELETE FROM kernel.plugin_deployments WHERE id=$1")
                    .bind(d)
                    .execute(&pool)
                    .await
                    .ok();
            }
        }

        /// TASK-07: when SOME replicas are placed, the deployment must still say
        /// why the others were not.
        ///
        /// THE DEFECT. The placement rejection is only attached in the PENDING
        /// branch, which is entered when `missing == desired_replicas` - i.e. when
        /// NOT ONE replica could be placed. As soon as a single slot lands, the
        /// status falls through to PREPARING and `status_reason` becomes
        /// "0/2 replicas READY" and nothing else.
        //
        //         That is the case an operator actually hits on a full node: slot 0
        //         took the last place, slot 1 was refused for capacity. "0/2 replicas
        //         READY" reads as "still starting", so the obvious next move is to
        //         wait - and it will never converge. The rejection the planner
        //         already computed (deployments.rs:1579) is thrown away.
        #[tokio::test]
        async fn partial_placement_reports_why_the_rest_were_refused() {
            let Some(pool) = test_pool().await else {
                return;
            };
            // A node with room for exactly one of the two requested replicas.
            let f = fixture(&pool, 2, 1).await;
            let state = state(&pool);
            for _ in 0..2 {
                crate::deployments::reconcile_once_scoped(&state, Some(f.deployment))
                    .await
                    .expect("reconcile");
            }

            let (status, reason, _) = status_of(&pool, f.deployment).await;
            let reason = reason.unwrap_or_default();
            assert_ne!(status, "READY");
            assert!(
                reason.contains("INSTANCE_CAPACITY_EXCEEDED") || reason.contains("per-deployment"),
                "a partly placed deployment must name the placement rejection that refused \
                 the remaining slots, not only a ready ratio; got {reason}"
            );

            sqlx::query("DELETE FROM kernel.plugin_deployments WHERE id=$1")
                .bind(f.deployment)
                .execute(&pool)
                .await
                .ok();
        }

        /// The same topology with an explicit single replica converges. This is
        /// the control: without it, "two does not converge" could be a statement
        /// about a broken fixture.
        #[tokio::test]
        async fn one_replica_on_one_node_is_placed() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let f = fixture(&pool, 1, 1).await;
            let state = state(&pool);

            crate::deployments::reconcile_once_scoped(&state, Some(f.deployment))
                .await
                .expect("reconcile");

            let (_, reason, instances) = status_of(&pool, f.deployment).await;
            assert_eq!(
                instances, 1,
                "the one placeable slot must be created; reason: {reason:?}"
            );

            sqlx::query("DELETE FROM kernel.plugin_deployments WHERE id=$1")
                .bind(f.deployment)
                .execute(&pool)
                .await
                .ok();
        }
    }

    /// Phase 8B TASK-30 D-1: a deployment that reached READY and was never
    /// activated keeps its node slot forever.
    ///
    /// The live evidence is staging run 45570951551:
    ///
    /// ```text
    /// PENDING 0/0 ready (No eligible healthy node matches the placement selector
    /// [INSTANCE_CAPACITY_EXCEEDED] node staging-node: 4 instances already
    /// scheduled on this node against a per-node limit of 4; occupied by
    /// dev.opsweave.hello@0.0.1, opsweave.data-catalog@0.0.2,
    /// opsweave.data-catalog@0.0.3590, opsweave.data-integration@0.0.2)
    /// ```
    ///
    /// ADR-027 was withdrawn because its premise was false: `activate` DOES drain
    /// the previous version. But `activate` only runs after a deploy succeeds, and
    /// the publish never gets there - `deploy --wait` times out on capacity first.
    /// So the rows that accumulate are not "superseded versions". They are
    /// deployments that were created and never activated, and `reconcile_once`
    /// plans every `READY` row, so their instances keep `desired_action='START'`
    /// and keep counting against the per-node limit.
    ///
    /// This test is the counterexample. It must FAIL on the current code, and it
    /// fails at the LAST assertion: nothing reclaims the candidate.
    #[cfg(test)]
    mod unactivated_candidate_holds_a_slot {
        use sqlx::postgres::PgConnectOptions;
        use sqlx::PgPool;
        use uuid::Uuid;

        const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";

        async fn test_pool() -> Option<PgPool> {
            let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
                Ok(url) => url,
                Err(_) => {
                    if std::env::var(REQUIRE_DATABASE_ENV).ok().as_deref() == Some("1") {
                        panic!(
                            "{REQUIRE_DATABASE_ENV} is set but OPSWEAVE_TEST_DATABASE_URL is unset"
                        );
                    }
                    eprintln!("skip: OPSWEAVE_TEST_DATABASE_URL is unset");
                    return None;
                }
            };
            let options: PgConnectOptions = url.parse().expect("test database URL parses");
            let pool = PgPool::connect_with(options)
                .await
                .expect("cannot connect to the test database");
            crate::db::migrate(&pool)
                .await
                .expect("the test database rejected the migrations");
            Some(pool)
        }

        /// A node plus one READY deployment of `plugin@version` holding one
        /// START instance, which is the shape a failed publish leaves behind.
        async fn candidate_on(pool: &PgPool, node_id: Uuid, plugin: &str, version: &str) -> Uuid {
            let package_id = Uuid::new_v4();
            let deployment_id = Uuid::new_v4();
            let tag = Uuid::new_v4().simple().to_string();
            sqlx::query(
                "INSERT INTO kernel.plugin_packages
                   (package_id, plugin_id, version, schema_version, publisher, manifest,
                    artifact_digest, bundle_digest, payload_digest, status, signature_state)
                 VALUES ($1,$2,$3,'1.1','test-publisher','{}'::jsonb,$4,$5,$6,'INSTALLED','VERIFIED')",
            )
            // Digests are unique per test run. The suite shares one database and
            // `plugin_packages` has a unique constraint on them, so a fixed value
            // makes the SECOND run of this test fail on the first one's rows.
            .bind(package_id)
            .bind(plugin)
            .bind(version)
            .bind(format!("{tag}-{version}-artifact"))
            .bind(format!("{tag}-{version}-bundle"))
            .bind(format!("{tag}-{version}-payload"))
            .execute(pool)
            .await
            .expect("insert package");
            sqlx::query(
                "INSERT INTO kernel.plugin_deployments
                   (id, plugin_id, package_id, version, desired_replicas, generation,
                    placement, resources, status)
                 VALUES ($1,$2,$3,$4,1,1,'{\"nodeSelector\":{}}'::jsonb,
                         '{\"cpuMillis\":500,\"memoryMib\":256}'::jsonb,'READY')",
            )
            .bind(deployment_id)
            .bind(plugin)
            .bind(package_id)
            .bind(version)
            .execute(pool)
            .await
            .expect("insert deployment");
            sqlx::query(
                "INSERT INTO kernel.plugin_instances
                   (id, deployment_id, node_id, slot, state, desired_action,
                    deployment_generation, container_id)
                 VALUES ($1,$2,$3,0,'READY','START',1,'container-1')",
            )
            .bind(Uuid::new_v4())
            .bind(deployment_id)
            .bind(node_id)
            .execute(pool)
            .await
            .expect("insert instance");
            deployment_id
        }

        async fn node(pool: &PgPool) -> Uuid {
            let node_id = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO kernel.nodes
                   (id, name, control_token_hash, data_token, generation, os, arch,
                    labels, capabilities, status, enrolled_at, last_seen_at, data_endpoint)
                 VALUES ($1,$2,'hash',$3,1,'linux','x86_64','{}'::jsonb,'{}'::jsonb,
                         'READY',now(),now(),'http://node:7000')",
            )
            .bind(node_id)
            .bind(format!("node-{}", Uuid::new_v4()))
            .bind(format!("token-{}", Uuid::new_v4()))
            .execute(pool)
            .await
            .expect("insert node");
            node_id
        }

        fn state_for(pool: PgPool) -> crate::state::AppState {
            crate::state::AppState {
                config: std::sync::Arc::new(crate::config::Config::from_env()),
                db: pool,
                http: reqwest::Client::new(),
                cursor_secret: std::sync::Arc::new(vec![0u8; 32]),
                rate_limiter: std::sync::Arc::new(crate::state::RateLimiter::default()),
            }
        }

        /// THE COUNTEREXAMPLE. Four READY-but-never-activated deployments are
        /// placed, which is what staging accumulated; a fifth is then asked for.
        ///
        /// Before the fix this ends with five slots consumed and the fifth
        /// deployment refusing placement. After it, a candidate that has been
        /// superseded by a newer candidate of the SAME plugin is drained, and the
        /// newer one takes the slot.
        #[tokio::test]
        async fn a_superseded_candidate_that_was_never_activated_stops_holding_its_slot() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let node_id = node(&pool).await;
            let plugin = format!("test.candidate.{}", Uuid::new_v4());

            // The staging shape: several versions of ONE plugin, each deployed
            // and READY, none ever activated. `0.0.2` is the oldest still here.
            let mut candidates = Vec::new();
            for version in ["0.0.2", "0.0.3590", "0.0.65450"] {
                candidates.push(candidate_on(&pool, node_id, &plugin, version).await);
            }
            // The shape staging actually had: the newest candidate is PENDING,
            // asking for a slot it cannot get. That is the condition the
            // reclamation keys on - it makes room only when something is waiting.
            sqlx::query(
                "UPDATE kernel.plugin_deployments
                 SET status='PENDING', status_reason='Waiting for placement' WHERE id=$1",
            )
            .bind(candidates[2])
            .execute(&pool)
            .await
            .unwrap();
            // A different plugin's ACTIVE deployment, which must never be touched.
            // Its id is per-run for the same reason the digests are: the suite
            // shares one database and `plugin_packages` is unique on
            // (plugin_id, version).
            //
            // ACTIVE means an ACTIVATION REVISION is active, not a status flag on
            // the deployment row. Setting only the flag makes the reconciler
            // rewrite it to READY on the next pass (`is_effective` asks
            // `activation_revisions`), which is what this fixture did before -
            // a fixture that cannot express "active" tests the wrong thing.
            let sibling = format!("test.sibling.{}", Uuid::new_v4());
            let other = candidate_on(&pool, node_id, &sibling, "0.0.1").await;
            sqlx::query("UPDATE kernel.plugin_deployments SET status='ACTIVE' WHERE id=$1")
                .bind(other)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO kernel.activation_revisions
                   (id, plugin_id, package_id, version, deployment_id, generation,
                    status, policy_digest, activated_at, created_at)
                 SELECT $1,$2,p.package_id,p.version,p.id,1,'ACTIVE','digest',now(),now()
                 FROM kernel.plugin_deployments p WHERE p.id=$3",
            )
            .bind(Uuid::new_v4())
            .bind(&sibling)
            .bind(other)
            .execute(&pool)
            .await
            .expect("insert activation revision");

            let occupied = |pool: PgPool, plugin: String| async move {
                sqlx::query_scalar::<_, i64>(
                    "SELECT count(*)::bigint FROM kernel.plugin_instances i
                     JOIN kernel.plugin_deployments d ON d.id=i.deployment_id
                     WHERE d.plugin_id=$1 AND i.desired_action='START'",
                )
                .bind(&plugin)
                .fetch_one(&pool)
                .await
                .unwrap()
            };

            // The precondition is asserted, but not as a race against the other
            // tests: a global reconcile in a parallel test can already have swept
            // these rows, and then this is 1 and the number below is also 1.
            //
            // What the test actually claims is the CONVERGENCE, and the claim is
            // only meaningful if the candidates were occupying slots to begin
            // with. So the count before the sweep is recorded and asserted to be
            // 1 or 3 - never 0, which would mean the fixture never placed them.
            let before = occupied(pool.clone(), plugin.clone()).await;
            assert!(
                before == 3 || before == 1,
                "the fixture placed the three candidates (before={before})"
            );

            // The reconciler runs. On current code it plans all three (READY is in
            // the planned set) and reclaims none of them.
            //
            // `Some(..)` is what makes this WAIT for the planner lock instead of
            // returning early with `pg_try_advisory_lock`. Measured: with `None`
            // this test passed alone and failed in the module run with three slots
            // still occupied, because a parallel test held the lock and this call
            // quietly planned nothing.
            //
            // The reclamation under test is a GLOBAL statement in the sweep, so it
            // runs whichever deployment is named here - passing the newest
            // candidate keeps the per-deployment planning scoped to this fixture
            // while still executing the statement that is being asserted on.
            super::super::reconcile_once_scoped(&state_for(pool.clone()), Some(candidates[2]))
                .await
                .expect("reconcile runs");

            // THE ASSERTION THAT FAILS TODAY.
            //
            // `0.0.2` and `0.0.3590` are superseded by `0.0.65450`: same plugin,
            // newer version present, neither is ACTIVE. Leaving them START-able is
            // what filled staging's node. One slot - the newest candidate - is the
            // correct steady state.
            let after = occupied(pool.clone(), plugin.clone()).await;
            assert_eq!(
                after, 1,
                "only the newest candidate of a plugin should hold a slot; \
                 the superseded ones were never activated and must be released \
                 (before={before}, after={after})"
            );

            // And the two things the brief forbids touching.
            let active: String =
                sqlx::query_scalar("SELECT status FROM kernel.plugin_deployments WHERE id=$1")
                    .bind(other)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(active, "ACTIVE", "an ACTIVE deployment is never reclaimed");
            assert_eq!(
                occupied(pool.clone(), sibling.clone()).await,
                1,
                "and a different plugin's slot is untouched"
            );
        }

        /// THE DEPLOY RESPONSE CARRIES THE PLAN, AND A PLAN FAILURE IS NOT A
        /// DEPLOY FAILURE.
        ///
        /// Two claims, both taken from the code shape rather than from a comment:
        ///
        ///   * the plan is attached to the 202 body under `capacityPlan`, so a
        ///     caller does not have to poll to learn the deployment cannot place;
        ///   * `gather` returning an error is swallowed with `.ok()`, so an
        ///     advisory that cannot be computed never rejects a valid deploy.
        ///
        /// A behavioural test would need a full router; what can go wrong here is
        /// someone turning the advisory into a gate, and that is a source fact.
        #[test]
        fn the_capacity_plan_is_an_advisory_not_a_gate() {
            let source = include_str!("deployments.rs");
            let start = source
                .find("let capacity_plan = crate::placement_preflight::gather(")
                .expect("the deploy path computes a capacity plan");
            let block = &source[start..start + 900];

            assert!(
                block.contains(".ok()"),
                "a failed plan must not fail the deploy: {block}"
            );
            assert!(
                !block.contains('?'),
                "and it must not propagate: a `?` here makes the advisory a gate: {block}"
            );
            assert!(
                block.contains("tracing::warn!"),
                "a swallowed plan failure must still be visible in the log: {block}"
            );

            let attach = source
                .find("\"capacityPlan\".into()")
                .expect("the response body carries the plan");
            let around = &source[attach.saturating_sub(300)..attach + 100];
            assert!(
                around.contains("ACCEPTED") || around.contains("body.as_object_mut()"),
                "the plan is attached to the acceptance body: {around}"
            );
        }

        /// A VERSION IS A CONTENT HASH, NOT A COUNTER — so the reclamation must
        /// not order by it.
        ///
        /// `scripts/publish-data-plugins.sh:175` computes
        ///
        /// ```text
        /// version="0.0.$(( 0x$src_hash % 100000 ))"
        /// ```
        ///
        /// and ADR-025 says of it: "the number is a content fingerprint, not a
        /// counter: there is no ordering". `0.0.9` is not older than `0.0.10`; they
        /// are two unrelated hash values. String-compared, `"0.0.9" > "0.0.10"` is
        /// even true, which is what would make a version-ordered rule reclaim the
        /// WRONG row the moment two versions straddle a digit boundary.
        ///
        /// This fixture is built so the two rules DISAGREE: `0.0.9` is inserted
        /// FIRST (older, lower string) and `0.0.10` SECOND (newer, but string-LOWER).
        /// The correct answer reclaims `0.0.9`; a version-ordered rule would not.
        #[tokio::test]
        async fn a_version_straddling_a_digit_boundary_is_still_superseded() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let node_id = node(&pool).await;
            let plugin = format!("test.hashversion.{}", Uuid::new_v4());

            // `0.0.9` first, then `0.0.10`. As STRINGS, "0.0.9" > "0.0.10".
            let older = candidate_on(&pool, node_id, &plugin, "0.0.9").await;
            // A distinct created_at so "which is newer" is unambiguous.
            sqlx::query("UPDATE kernel.plugin_deployments SET created_at=now()-interval '10 minutes' WHERE id=$1")
                .bind(older)
                .execute(&pool)
                .await
                .unwrap();
            let newer = candidate_on(&pool, node_id, &plugin, "0.0.10").await;
            sqlx::query(
                "UPDATE kernel.plugin_deployments
                 SET status='PENDING', status_reason='Waiting for placement' WHERE id=$1",
            )
            .bind(newer)
            .execute(&pool)
            .await
            .unwrap();

            // Sanity: the string comparison really does invert these, so the test
            // is measuring what it claims to.
            assert!(
                "0.0.9" > "0.0.10",
                "the fixture is pointless unless the string order is inverted"
            );

            super::super::reconcile_once_scoped(&state_for(pool.clone()), Some(newer))
                .await
                .expect("reconcile runs");

            let status: String =
                sqlx::query_scalar("SELECT status FROM kernel.plugin_deployments WHERE id=$1")
                    .bind(older)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_ne!(
                status, "READY",
                "0.0.9 was superseded by 0.0.10 (it is older by created_at); a version-ordered \
                 rule leaves it READY because \"0.0.9\" > \"0.0.10\" as a string"
            );
        }

        /// A ROLLBACK TARGET MUST NOT BE RECLAIMED WHILE IT WAITS TO BE ACTIVATED.
        ///
        /// `rollback` to a version that has no deployment creates one and returns:
        ///
        /// ```text
        /// "the deployment did not exist; wait for it to reach READY, then activate it"
        /// ```
        ///
        /// That is a deliberate, multi-step operator flow. Between READY and the
        /// activate call the row is exactly what the reclamation looks for - READY,
        /// never activated, and (after a rollback to an OLD version) superseded by a
        /// newer one. Without this guard, my own fix would drain the version an
        /// operator was in the middle of rolling back to, and the rollback would
        /// fail with "no deployment" a second time.
        #[tokio::test]
        async fn a_rollback_target_is_not_reclaimed_while_it_is_being_activated() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let node_id = node(&pool).await;
            let plugin = format!("test.rollback.{}", Uuid::new_v4());

            // The newer version that is deployed, and the OLD version an operator
            // has just asked to roll back to - READY, not yet activated.
            let newer = candidate_on(&pool, node_id, &plugin, "0.0.9").await;
            let target = candidate_on(&pool, node_id, &plugin, "0.0.1").await;

            super::super::reconcile_once_scoped(&state_for(pool.clone()), Some(newer))
                .await
                .expect("reconcile runs");

            let status: String =
                sqlx::query_scalar("SELECT status FROM kernel.plugin_deployments WHERE id=$1")
                    .bind(target)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                status, "READY",
                "the rollback target must still be READY and waiting for activation; \
                 a reclaim that drains it turns an operator's rollback into a missing deployment"
            );
            let action: String = sqlx::query_scalar(
                "SELECT desired_action FROM kernel.plugin_instances WHERE deployment_id=$1",
            )
            .bind(target)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(
                action, "START",
                "and its instance is still meant to be running"
            );
        }

        /// THE PREFLIGHT MUST NOT PROMISE A RECLAIM THE SWEEP WILL NOT PERFORM.
        ///
        /// `placement_preflight::gather` counts reclaimable candidates with a copy
        /// of the sweep's predicate, and a copy is a thing that drifts. If the
        /// preflight over-counted, an operator would be told "reclaim will fix
        /// this" and then wait for a reclaim that never comes; if it under-counted,
        /// a perfectly fixable capacity block would read as `CAPACITY_BLOCKED` and
        /// send someone to add a node.
        ///
        /// So the two numbers are measured against each other on one fixture,
        /// before and after a real reconcile.
        #[tokio::test]
        async fn preflight_reclaims_what_the_sweep_releases() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let node_id = node(&pool).await;
            let plugin = format!("test.reclaim.{}", Uuid::new_v4());
            let mut candidates = Vec::new();
            for version in ["0.0.1", "0.0.2"] {
                candidates.push(candidate_on(&pool, node_id, &plugin, version).await);
            }
            // The newer one is PENDING, waiting for the slot the older one holds -
            // the condition the reclamation keys on.
            sqlx::query(
                "UPDATE kernel.plugin_deployments
                 SET status='PENDING', status_reason='Waiting for placement' WHERE id=$1",
            )
            .bind(candidates[1])
            .execute(&pool)
            .await
            .unwrap();

            // Before: exactly one candidate (`0.0.1`, superseded by `0.0.2`) is
            // reclaimable, and the preflight must say so.
            let before = crate::placement_preflight::gather(
                &pool,
                None,
                Default::default(),
                opsweave_contracts::ResourceRequirements {
                    cpu_millis: 100,
                    memory_mib: 64,
                },
                1,
                1,
                4,
            )
            .await
            .expect("preflight runs");
            // NOT asserted as an exact list. Another test's global sweep shares
            // this database and may release the candidate between the insert and
            // this query - measured: `left: []` in 2 of 4 module runs, while the
            // test passed alone. The claim that survives a concurrent sweep is the
            // INVARIANT: whatever the preflight lists is a subset of what exists,
            // and a listed row is not ACTIVE.
            for candidate in &before.reclaim.candidates {
                if candidate.plugin_id != plugin {
                    continue;
                }
                assert!(
                    candidate.version == "0.0.1",
                    "only the superseded candidate is named, never the newest: {}",
                    candidate.version
                );
                assert_eq!(
                    candidate.superseded_by, "0.0.2",
                    "and it says what supersedes it"
                );
            }
            assert_eq!(
                before.reclaim.slots_freed,
                before.reclaim.candidates.len(),
                "slots_freed is the number of candidates, not a second calculation"
            );

            // The sweep runs. Now the preflight must promise NOTHING for this
            // plugin - the rows it named are gone from the reclaimable set.
            super::super::reconcile_once_scoped(&state_for(pool.clone()), Some(candidates[1]))
                .await
                .expect("reconcile runs");
            let after = crate::placement_preflight::gather(
                &pool,
                None,
                Default::default(),
                opsweave_contracts::ResourceRequirements {
                    cpu_millis: 100,
                    memory_mib: 64,
                },
                1,
                1,
                4,
            )
            .await
            .expect("preflight runs");
            let still_promised: Vec<String> = after
                .reclaim
                .candidates
                .iter()
                .filter(|c| c.plugin_id == plugin)
                .map(|c| c.version.clone())
                .collect();
            assert!(
                still_promised.is_empty(),
                "the sweep released what the preflight promised: {still_promised:?}"
            );

            // The invariant that makes this test worth having even under a
            // concurrent sweep: the sweep and the preflight cannot disagree about
            // a row that still EXISTS. If `0.0.1` is still READY, the preflight
            // must still name it; if it is gone or drained, it must not.
            let still_ready: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM kernel.plugin_deployments
                               WHERE id=$1 AND status='READY')",
            )
            .bind(candidates[0])
            .fetch_one(&pool)
            .await
            .unwrap();
            let named = after
                .reclaim
                .candidates
                .iter()
                .any(|c| c.deployment_id == candidates[0]);
            assert_eq!(
                named, still_ready,
                "a READY candidate must be named and a released one must not \
                 (still_ready={still_ready}, named={named})"
            );
        }
    }

    /// A `PENDING` DEPLOYMENT THAT HAS NEVER PLACED A REPLICA IS NOT "STARTING".
    ///
    /// Staging, 2026-11-25: nine rows across two plugins, none of which had ever
    /// placed a single replica, the oldest three days old, every one still being
    /// re-planned every two seconds. They hold no slot, so no capacity audit could
    /// see them; the only way to find them was to read the whole deployment table.
    ///
    /// This module is that state, narrowed to its two failure modes: a deployment
    /// that keeps being told the node is full, and the operator's retry - which must
    /// NOT be born already expired.
    #[cfg(test)]
    mod a_pending_deployment_must_not_attempt_forever {
        use sqlx::postgres::PgConnectOptions;
        use sqlx::PgPool;
        use uuid::Uuid;

        const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";

        async fn test_pool() -> Option<PgPool> {
            let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
                Ok(url) => url,
                Err(_) => {
                    if std::env::var(REQUIRE_DATABASE_ENV).ok().as_deref() == Some("1") {
                        panic!(
                            "{REQUIRE_DATABASE_ENV} is set but OPSWEAVE_TEST_DATABASE_URL is unset"
                        );
                    }
                    eprintln!("skip: OPSWEAVE_TEST_DATABASE_URL is unset");
                    return None;
                }
            };
            let options: PgConnectOptions = url.parse().expect("test database URL parses");
            let pool = PgPool::connect_with(options)
                .await
                .expect("cannot connect to the test database");
            // The schema is what makes this test meaningful: `attempt_started_at`
            // arrives in migration 0037, and a fixture that ran against an
            // unmigrated database would fail on a missing COLUMN rather than on the
            // behaviour under test.
            crate::db::migrate(&pool)
                .await
                .expect("the test database rejected the migrations");
            Some(pool)
        }

        /// A node with NO free slot, a package, and a deployment row in the state
        /// under test, plus a sibling that fills the node so placement really fails.
        struct Fixture {
            deployment: Uuid,
            plugin: String,
        }

        async fn full_node_fixture(
            pool: &PgPool,
            status: &str,
            attempt_age_secs: i64,
            state_limit: i32,
        ) -> Fixture {
            let tag = Uuid::new_v4().simple().to_string();
            let plugin = format!("test.pending.{tag}");
            let sibling = format!("test.pending.other.{tag}");
            let publisher = format!("pub-{tag}");
            let node = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO kernel.nodes
                   (id, name, control_token_hash, data_token, generation, os, arch,
                    labels, capabilities, status, enrolled_at, last_seen_at, data_endpoint,
                    resource_snapshot)
                 VALUES ($1,$2,'hash',$3,1,'linux','x86_64',$5::jsonb,'{}'::jsonb,
                         'READY',now(),now(),'http://node:7000',$4)",
            )
            .bind(node)
            .bind(format!("node-{tag}"))
            .bind(format!("token-{tag}"))
            // A NODE WITHOUT A RESOURCE SNAPSHOT IS REFUSED OUTRIGHT, and the
            // scheduler then keeps looking at OTHER nodes - including ones other
            // tests left with free slots. Measured: without this the deployment
            // under test placed itself on a parallel test's node and went
            // PREPARING, which read as "the timeout is broken".
            //
            // This node is deliberately LARGE, so the only thing that can prevent
            // placement is the per-node instance limit the fixture fills.
            .bind(serde_json::json!({
                "cpuCores": 64,
                "memoryTotalBytes": 256i64 * 1024 * 1024 * 1024,
                "memoryUsedBytes": 0,
                "diskTotalBytes": 1024i64 * 1024 * 1024 * 1024,
                "diskUsedBytes": 0,
            }))
            // THE LABEL IS THE ISOLATION. Every query in this module is global over
            // the shared test database, so a fixture that says only "any READY node"
            // will happily place itself on a node some parallel test left with free
            // slots - which is exactly what happened: the deployment under test went
            // PREPARING and the failure read as "the timeout is broken". A selector
            // that names this node and nothing else makes the fixture's own topology
            // the only thing that can decide the outcome.
            .bind(serde_json::json!({"fixture": tag.clone()}))
            .execute(pool)
            .await
            .expect("node");
            sqlx::query(
                "INSERT INTO kernel.trusted_publishers
                   (publisher_id, public_key_hex, fingerprint, trust_state)
                 VALUES ($1,'00','fp','TRUSTED')",
            )
            .bind(&publisher)
            .execute(pool)
            .await
            .expect("publisher");

            // Each package carries its OWN tag in the digests. They share a unique
            // constraint across the table, so one tag reused for two packages
            // collides with itself before the second row is even written.
            let make_package = |plugin: &str, version: &str| {
                (
                    Uuid::new_v4(),
                    plugin.to_string(),
                    version.to_string(),
                    Uuid::new_v4().simple().to_string(),
                )
            };
            let (sibling_pkg, sibling_plugin, sibling_version, sibling_tag) =
                make_package(&sibling, "0.0.1");
            let (pkg, plugin_owned, version, own_tag) = make_package(&plugin, "0.0.1");
            for (package_id, plugin_id, ver, pkg_tag) in [
                (
                    sibling_pkg,
                    sibling_plugin.clone(),
                    sibling_version.clone(),
                    sibling_tag,
                ),
                (pkg, plugin_owned.clone(), version.clone(), own_tag),
            ] {
                sqlx::query(
                    "INSERT INTO kernel.plugin_packages
                       (package_id, plugin_id, version, schema_version, publisher, manifest,
                        artifact_digest, bundle_digest, payload_digest, status, signature_state)
                     VALUES ($1,$2,$3,'1.1',$4,'{}'::jsonb,$5,$6,$7,'INSTALLED','VERIFIED')",
                )
                .bind(package_id)
                .bind(&plugin_id)
                .bind(&ver)
                .bind(&publisher)
                // Unique per run: the suite shares one database and the digests
                // carry a unique constraint, so a fixed value makes the SECOND run
                // of this test collide with the first one's rows.
                .bind(format!("{pkg_tag}-{ver}-artifact"))
                .bind(format!("{pkg_tag}-{ver}-bundle"))
                .bind(format!("{pkg_tag}-{ver}-payload"))
                .execute(pool)
                .await
                .expect("package");
            }

            // The sibling occupies slots until the node's per-node limit is reached.
            //
            // ONE sibling is not enough, and the first version of this fixture used
            // one: `evaluate_node` counts `usage.node_instances` from the GLOBAL
            // aggregate across every deployment, against
            // `max_instances_per_node` (default 4), not against this deployment's own
            // instances. With one occupant the scheduler happily placed the
            // deployment under test and it went PREPARING - the test then failed with
            // "left: PREPARING, right: PENDING", which reads like the timeout being
            // wrong and is really the fixture never having created the condition.
            //
            // The limit is read from config rather than hard-coded so a run with
            // OPSWEAVE_MAX_INSTANCES_PER_NODE set still fills the node.
            let limit = state_limit;
            let sibling_dep = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO kernel.plugin_deployments
                   (id, plugin_id, package_id, version, desired_replicas, generation,
                    placement, resources, status)
                 VALUES ($1,$2,$3,$4,$5,1,$6::jsonb,
                         '{\"cpuMillis\":500,\"memoryMib\":256}'::jsonb,'ACTIVE')",
            )
            .bind(sibling_dep)
            .bind(&sibling_plugin)
            .bind(sibling_pkg)
            .bind(&sibling_version)
            .bind(limit)
            .bind(serde_json::json!({"nodeSelector": {"fixture": tag.clone()}}))
            .execute(pool)
            .await
            .expect("sibling deployment");
            for slot in 0..limit {
                sqlx::query(
                    "INSERT INTO kernel.plugin_instances
                       (id, deployment_id, node_id, slot, state, desired_action,
                        deployment_generation, container_id)
                     VALUES ($1,$2,$3,$4,'READY','START',1,$5)",
                )
                .bind(Uuid::new_v4())
                .bind(sibling_dep)
                .bind(node)
                .bind(slot)
                .bind(format!("container-{slot}"))
                .execute(pool)
                .await
                .expect("sibling instance");
            }

            let deployment = Uuid::new_v4();
            // `created_at` IS DELIBERATELY OLDER THAN THE ATTEMPT CLOCK.
            //
            // A real row in this position has been around for a while: it was
            // created, failed, and is now being retried. Leaving `created_at` at its
            // `now()` default made the redeploy test pass even against a fix that
            // timed out on `created_at`, because the two clocks happened to agree -
            // the test agreed with a bug it was written to catch. Separating them
            // by a day is what makes "the basis is the attempt, not the row" a
            // thing this fixture can actually distinguish.
            sqlx::query(
                "INSERT INTO kernel.plugin_deployments
                   (id, plugin_id, package_id, version, desired_replicas, generation,
                    placement, resources, status, status_reason, attempt_started_at,
                    created_at, updated_at)
                 VALUES ($1,$2,$3,$4,1,1,$7::jsonb,
                         '{\"cpuMillis\":500,\"memoryMib\":256}'::jsonb,$5,
                         'Waiting for placement',
                         now() - ($6 || ' seconds')::interval,
                         now() - (($6::bigint + 86400) || ' seconds')::interval,
                         now() - ($6 || ' seconds')::interval)",
            )
            .bind(deployment)
            .bind(&plugin_owned)
            .bind(pkg)
            .bind(&version)
            .bind(status)
            .bind(attempt_age_secs.to_string())
            .bind(serde_json::json!({"nodeSelector": {"fixture": tag.clone()}}))
            .execute(pool)
            .await
            .expect("deployment");

            Fixture {
                deployment,
                plugin: plugin_owned,
            }
        }

        fn state_for(pool: PgPool, pending_timeout_seconds: i64) -> crate::state::AppState {
            let mut config = crate::config::Config::from_env();
            config.pending_timeout_seconds = pending_timeout_seconds;
            crate::state::AppState {
                config: std::sync::Arc::new(config),
                db: pool,
                http: reqwest::Client::new(),
                cursor_secret: std::sync::Arc::new(vec![0u8; 32]),
                rate_limiter: std::sync::Arc::new(crate::state::RateLimiter::default()),
            }
        }

        async fn status_of(pool: &PgPool, id: Uuid) -> (String, Option<String>) {
            sqlx::query_as::<_, (String, Option<String>)>(
                "SELECT status, status_reason FROM kernel.plugin_deployments WHERE id=$1",
            )
            .bind(id)
            .fetch_one(pool)
            .await
            .expect("status")
        }

        async fn attempt_started(pool: &PgPool, id: Uuid) -> Option<chrono::DateTime<chrono::Utc>> {
            sqlx::query_scalar(
                "SELECT attempt_started_at FROM kernel.plugin_deployments WHERE id=$1",
            )
            .bind(id)
            .fetch_one(pool)
            .await
            .expect("attempt_started_at")
        }

        /// THE DEFECT. A deployment that has been refused placement for longer than
        /// the timeout must stop claiming to be starting.
        ///
        /// Counterfactual: with the timeout branch removed, this is the only test in
        /// the module that fails - the row stays PENDING and keeps being re-planned.
        #[tokio::test]
        async fn a_deployment_that_never_placed_is_not_pending_forever() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let node_limit = crate::config::Config::from_env().max_instances_per_node as i32;
            let f = full_node_fixture(&pool, "PENDING", 3600, node_limit).await;
            let state = state_for(pool.clone(), 600);

            crate::deployments::reconcile_once_scoped(&state, Some(f.deployment))
                .await
                .expect("reconcile");

            let (status, reason) = status_of(&pool, f.deployment).await;
            assert_eq!(
                status, "FAILED",
                "a deployment with 0 replicas placed for an hour must not still say PENDING \
                 (plugin={}, reason={reason:?})",
                f.plugin
            );
            let reason = reason.unwrap_or_default();
            assert!(
                reason.contains("never placed"),
                "the reason must say what happened, not just carry the placement rejection: {reason}"
            );
            assert!(
                reason.contains("re-deploy"),
                "and it must tell the operator what to do about it: {reason}"
            );
            assert_eq!(
                attempt_started(&pool, f.deployment).await,
                None,
                "leaving PENDING must clear the attempt clock"
            );
        }

        /// A DEPLOYMENT THAT IS STILL INSIDE ITS TIMEOUT IS NOT A FAILURE.
        ///
        /// The other half of the same rule. Without it, a fix that failed everything
        /// would pass the test above.
        #[tokio::test]
        async fn a_young_pending_deployment_is_left_alone() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let node_limit = crate::config::Config::from_env().max_instances_per_node as i32;
            let f = full_node_fixture(&pool, "PENDING", 5, node_limit).await;
            let state = state_for(pool.clone(), 600);

            crate::deployments::reconcile_once_scoped(&state, Some(f.deployment))
                .await
                .expect("reconcile");

            let (status, _) = status_of(&pool, f.deployment).await;
            assert_eq!(
                status, "PENDING",
                "five seconds into a ten-minute timeout the deployment is still starting"
            );
            assert!(
                attempt_started(&pool, f.deployment).await.is_some(),
                "and its clock keeps running - clearing it here would restart the timeout \
                 on every pass and the row would never expire"
            );
        }

        /// THE OPERATOR'S RETRY MUST NOT BE BORN EXPIRED.
        ///
        /// This is the defect the first version of the fix had. `created_at` does not
        /// change when a failed version is re-deployed, so a timeout read from it
        /// fires on the first pass after the retry: the redeploy is declared FAILED
        /// before it has had a single chance to place.
        ///
        /// The assertion drives that sequence through the real `create_deployment_inner`
        /// path rather than simulating it, because the reset lives in that statement.
        #[tokio::test]
        async fn a_redeploy_starts_a_fresh_clock() {
            let Some(pool) = test_pool().await else {
                return;
            };
            // An old row that already failed: `created_at` is ancient, the attempt
            // clock is old too, and nothing is PENDING.
            let node_limit = crate::config::Config::from_env().max_instances_per_node as i32;
            let f = full_node_fixture(&pool, "FAILED", 7200, node_limit).await;
            let state = state_for(pool.clone(), 600);

            // What a redeploy does to the row: back to PENDING with a NEW clock.
            sqlx::query(
                "UPDATE kernel.plugin_deployments
                    SET status='PENDING', status_reason='Redeploy requested',
                        generation=generation+1, updated_at=now(),
                        drain_until=NULL, attempt_started_at=now()
                  WHERE id=$1",
            )
            .bind(f.deployment)
            .execute(&pool)
            .await
            .expect("redeploy");

            let age: i64 = sqlx::query_scalar(
                "SELECT EXTRACT(EPOCH FROM (now() - attempt_started_at))::bigint \
                   FROM kernel.plugin_deployments WHERE id=$1",
            )
            .bind(f.deployment)
            .fetch_one(&pool)
            .await
            .expect("age");
            assert!(
                age < 60,
                "the redeploy's clock must start now, not inherit the failed attempt's age \
                 (age={age}s)"
            );

            // And one reconcile pass must leave it PENDING rather than declaring it
            // failed on the strength of its `created_at`.
            crate::deployments::reconcile_once_scoped(&state, Some(f.deployment))
                .await
                .expect("reconcile");
            let (status, reason) = status_of(&pool, f.deployment).await;
            assert_eq!(
                status, "PENDING",
                "a just-redeployed version must get its full timeout, not be failed on the \
                 first pass (reason={reason:?})"
            );
        }
    }

    /// TASK-06: THE STAGING SHAPE, REPRODUCED IN REAL POSTGRESQL.
    ///
    /// This module exists to make the staging condition a thing the repository can
    /// observe rather than a paragraph in a document. It asserts what IS, not what
    /// should be: the last test states plainly that the current reclamation rule
    /// does not release the candidate, which is the defect Phase 9 exists to fix.
    ///
    /// The shape, measured from `capacity.json` on staging (run 45634540776):
    ///
    ///   per-node limit        4
    ///   START instances       4   (three ACTIVE deployments + one DEGRADED candidate)
    ///   free                  0
    ///   verdict               CAPACITY_BLOCKED / INSTANCE_CAPACITY_EXCEEDED
    ///
    /// Everything is isolated behind a unique `nodeSelector`, because this suite
    /// shares one database and Phase 8 measured what happens without that: a
    /// fixture placed itself on a parallel test's node and the failure read as the
    /// rule being broken.
    #[cfg(test)]
    mod staging_capacity_shape {
        use sqlx::postgres::PgConnectOptions;
        use sqlx::PgPool;
        use uuid::Uuid;

        const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";
        const PER_NODE_LIMIT: i32 = 4;

        async fn test_pool() -> Option<PgPool> {
            let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
                Ok(url) => url,
                Err(_) => {
                    if std::env::var(REQUIRE_DATABASE_ENV).ok().as_deref() == Some("1") {
                        panic!(
                            "{REQUIRE_DATABASE_ENV} is set but OPSWEAVE_TEST_DATABASE_URL is unset"
                        );
                    }
                    eprintln!("skip: OPSWEAVE_TEST_DATABASE_URL is unset");
                    return None;
                }
            };
            let options: PgConnectOptions = url.parse().expect("test database URL parses");
            let pool = PgPool::connect_with(options)
                .await
                .expect("cannot connect to the test database");
            crate::db::migrate(&pool)
                .await
                .expect("the test database rejected the migrations");
            Some(pool)
        }

        fn state_for(pool: PgPool) -> crate::state::AppState {
            crate::state::AppState {
                config: std::sync::Arc::new(crate::config::Config::from_env()),
                db: pool,
                http: reqwest::Client::new(),
                cursor_secret: std::sync::Arc::new(vec![0u8; 32]),
                rate_limiter: std::sync::Arc::new(crate::state::RateLimiter::default()),
            }
        }

        async fn insert_package(pool: &PgPool, plugin: &str, version: &str, publisher: &str) {
            let tag = Uuid::new_v4().simple().to_string();
            sqlx::query(
                "INSERT INTO kernel.plugin_packages
                   (package_id, plugin_id, version, schema_version, publisher, manifest,
                    artifact_digest, bundle_digest, payload_digest, status, signature_state)
                 VALUES ($1,$2,$3,'1.1',$4,'{}'::jsonb,$5,$6,$7,'INSTALLED','VERIFIED')",
            )
            .bind(Uuid::new_v4())
            .bind(plugin)
            .bind(version)
            .bind(publisher)
            .bind(format!("{tag}-a"))
            .bind(format!("{tag}-b"))
            .bind(format!("{tag}-p"))
            .execute(pool)
            .await
            .expect("package");
        }

        /// A deployment with `desired` replicas, of which `instances` are placed.
        ///
        /// `desired` and `instances` are separate because they are separate in the
        /// world: staging's PENDING candidate WANTS one replica and has none, and the
        /// first version of this helper conflated them - `instances: 0` also set
        /// `desired_replicas = 0`, which the Kernel correctly reads as "stop it" and
        /// answers DISABLED. The test then measured a deployment nobody had asked to
        /// run, not the capacity condition.
        ///
        /// Returns the deployment id.
        #[allow(clippy::too_many_arguments)]
        async fn deployed(
            pool: &PgPool,
            node: Uuid,
            plugin: &str,
            version: &str,
            publisher: &str,
            status: &str,
            desired: i32,
            instances: i32,
            activated: bool,
            tag: &str,
        ) -> Uuid {
            insert_package(pool, plugin, version, publisher).await;
            let package_id: Uuid = sqlx::query_scalar(
                "SELECT package_id FROM kernel.plugin_packages WHERE plugin_id=$1 AND version=$2",
            )
            .bind(plugin)
            .bind(version)
            .fetch_one(pool)
            .await
            .expect("package id");
            let id = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO kernel.plugin_deployments
                   (id, plugin_id, package_id, version, desired_replicas, generation,
                    placement, resources, status, activated_at)
                 VALUES ($1,$2,$3,$4,$5,1,$8::jsonb,
                         '{\"cpuMillis\":100,\"memoryMib\":128}'::jsonb,$6,$7)",
            )
            .bind(id)
            .bind(plugin)
            .bind(package_id)
            .bind(version)
            .bind(desired)
            .bind(status)
            .bind(if activated {
                Some(chrono::Utc::now())
            } else {
                None
            })
            .bind(serde_json::json!({"nodeSelector": {"staging-shape": tag}}))
            .execute(pool)
            .await
            .expect("deployment");
            for slot in 0..instances {
                sqlx::query(
                    "INSERT INTO kernel.plugin_instances
                       (id, deployment_id, node_id, slot, state, desired_action,
                        deployment_generation, container_id)
                     VALUES ($1,$2,$3,$4,'READY','START',1,$5)",
                )
                .bind(Uuid::new_v4())
                .bind(id)
                .bind(node)
                .bind(slot)
                .bind(format!("ctr-{slot}"))
                .execute(pool)
                .await
                .expect("instance");
            }
            if activated {
                sqlx::query(
                    "INSERT INTO kernel.activation_revisions
                       (id, plugin_id, package_id, version, deployment_id, generation,
                        status, policy_digest, activated_at)
                     VALUES ($1,$2,$3,$4,$5,1,'ACTIVE','digest',now())",
                )
                .bind(Uuid::new_v4())
                .bind(plugin)
                .bind(package_id)
                .bind(version)
                .bind(id)
                .execute(pool)
                .await
                .expect("activation revision");
            }
            id
        }

        struct Shape {
            node: Uuid,
            /// Three ACTIVE deployments on distinct plugins - the serving set.
            active: Vec<Uuid>,
            /// `data-catalog@0.0.3590`: DEGRADED, never activated, holds one slot.
            degraded: Uuid,
            /// A newer PENDING data-catalog that cannot place.
            pending: Uuid,
        }

        /// THE STAGING TOPOLOGY: four START instances, three of them serving.
        async fn staging_shape(pool: &PgPool) -> Shape {
            let tag = Uuid::new_v4().simple().to_string();
            let node = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO kernel.nodes
                   (id, name, control_token_hash, data_token, generation, os, arch,
                    labels, capabilities, status, enrolled_at, last_seen_at, data_endpoint,
                    resource_snapshot)
                 VALUES ($1,$2,'hash',$3,1,'linux','x86_64',$5::jsonb,'{}'::jsonb,
                         'READY',now(),now(),'http://node:7000',$4)",
            )
            .bind(node)
            .bind(format!("staging-node-{tag}"))
            .bind(format!("token-{tag}"))
            .bind(serde_json::json!({
                "cpuCores": 64, "memoryTotalBytes": 256i64 * 1024 * 1024 * 1024,
                "memoryUsedBytes": 0, "diskTotalBytes": 1024i64 * 1024 * 1024 * 1024,
                "diskUsedBytes": 0,
            }))
            // A UNIQUE LABEL, AND EVERY DEPLOYMENT SELECTS IT.
            //
            // Without this the fixture is not isolated and the suite proved it: the
            // PENDING deployment placed itself on a PARALLEL TEST's node, which had a
            // free slot, so `the_new_candidate_cannot_be_placed` passed alone and
            // failed in the full run. Same defect Phase 8 hit and fixed the same way.
            .bind(serde_json::json!({"staging-shape": tag.clone()}))
            .execute(pool)
            .await
            .expect("node");
            sqlx::query(
                "INSERT INTO kernel.trusted_publishers
                   (publisher_id, public_key_hex, fingerprint, trust_state)
                 VALUES ($1,'00','fp','TRUSTED')",
            )
            .bind(format!("pub-{tag}"))
            .execute(pool)
            .await
            .expect("publisher");
            let publisher = format!("pub-{tag}");

            // Three ACTIVE deployments, one instance each: the serving set.
            let mut active = Vec::new();
            for (i, plugin) in [
                format!("dev.opsweave.hello.{tag}"),
                format!("opsweave.data-catalog.{tag}"),
                format!("opsweave.data-integration.{tag}"),
            ]
            .iter()
            .enumerate()
            {
                active.push(
                    deployed(
                        pool, node, plugin, "0.0.1", &publisher, "ACTIVE", 1, 1, true, &tag,
                    )
                    .await,
                );
                let _ = i;
            }

            // The candidate: DEGRADED, one START instance, never activated.
            let catalog = format!("opsweave.data-catalog.{tag}");
            let degraded = deployed(
                pool, node, &catalog, "0.0.3590", &publisher, "DEGRADED", 1, 1, false, &tag,
            )
            .await;

            // A newer candidate of the SAME plugin, which cannot place.
            let pending = deployed(
                pool,
                node,
                &catalog,
                "0.0.65450",
                &publisher,
                "PENDING",
                1,
                0,
                false,
                &tag,
            )
            .await;

            Shape {
                node,
                active,
                degraded,
                pending,
            }
        }

        async fn start_instances_on(pool: &PgPool, node: Uuid) -> i64 {
            sqlx::query_scalar(
                "SELECT count(*) FROM kernel.plugin_instances i
                 JOIN kernel.plugin_deployments d ON d.id=i.deployment_id
                 WHERE i.node_id=$1 AND i.desired_action='START'
                   AND d.status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED')
                   AND NOT (i.state IN ('UNHEALTHY','UNREACHABLE') AND i.container_id IS NULL)",
            )
            .bind(node)
            .fetch_one(pool)
            .await
            .expect("count")
        }

        /// 1. THE FOUR INSTANCES ARE COUNTED BY THE SCHEDULER.
        ///
        /// The capacity aggregates count `desired_action='START'` joined to
        /// deployments in the planned set. All four must be in that count, or the
        /// fixture is not the staging shape and nothing below means anything.
        #[tokio::test]
        async fn four_start_instances_are_what_the_scheduler_counts() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let shape = staging_shape(&pool).await;
            let counted = start_instances_on(&pool, shape.node).await;
            assert_eq!(
                counted, 4,
                "the fixture must place exactly four START instances; the per-node limit \
                 is {PER_NODE_LIMIT} and staging is full because of these four"
            );
        }

        /// 2. THE THREE ACTIVE DEPLOYMENTS ARE BACKED BY ACTIVE REVISIONS.
        ///
        /// This is what makes them un-reclaimable, and it is a different fact from
        /// their deployment status. Asserted so the protection below cannot be read
        /// as an argument about a column.
        #[tokio::test]
        async fn the_serving_deployments_have_active_revisions() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let shape = staging_shape(&pool).await;
            for id in &shape.active {
                let revisions: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM kernel.activation_revisions
                     WHERE deployment_id=$1 AND status='ACTIVE'",
                )
                .bind(id)
                .fetch_one(&pool)
                .await
                .expect("count");
                assert_eq!(
                    revisions, 1,
                    "an ACTIVE deployment must have one ACTIVE revision"
                );
            }
        }

        /// 3. THE CANDIDATE IS NOT ACTIVATED - WHICH IS NOT THE SAME AS DEAD.
        ///
        /// The brief forbids treating "never activated" as sufficient for
        /// reclamation, so this test records ONLY the fact, and says in its message
        /// that the fact alone decides nothing.
        #[tokio::test]
        async fn the_degraded_candidate_was_never_activated() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let shape = staging_shape(&pool).await;
            let revisions: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM kernel.activation_revisions WHERE deployment_id=$1",
            )
            .bind(shape.degraded)
            .fetch_one(&pool)
            .await
            .expect("count");
            assert_eq!(
                revisions, 0,
                "the candidate has no revision at all. This is a fact about it, not yet a \
                 reason to stop it: serving, rollback material and recovery are decided \
                 elsewhere"
            );
        }

        /// 4. THE PREFLIGHT AGREES THE NODE IS FULL.
        ///
        /// Not "the node looks full" - the same `evaluate_node` the planner runs,
        /// through the same `gather` the HTTP endpoint calls.
        #[tokio::test]
        async fn the_preflight_reports_capacity_blocked() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let shape = staging_shape(&pool).await;
            let state = state_for(pool.clone());
            let report = crate::placement_preflight::gather(
                &state.db,
                None,
                std::collections::BTreeMap::from([(
                    "staging-node".to_string(),
                    "never-matches".to_string(),
                )]),
                opsweave_contracts::ResourceRequirements {
                    cpu_millis: 100,
                    memory_mib: 128,
                },
                1,
                1,
                PER_NODE_LIMIT as usize,
            )
            .await
            .expect("gather");

            // Selector above matches nothing on purpose: this call asserts the
            // preflight RUNS, and the assertion on the node's own numbers comes from
            // a second call with the node's real labels. Keeping the selector out of
            // it avoids depending on every node in the shared database.
            assert!(
                !report.nodes.is_empty() || report.verdict == "CAPACITY_BLOCKED",
                "the preflight must answer for every unrevolked node (verdict={})",
                report.verdict
            );

            // And with no selector the fixture node itself must be full.
            let full = crate::placement_preflight::gather(
                &state.db,
                None,
                std::collections::BTreeMap::new(),
                opsweave_contracts::ResourceRequirements {
                    cpu_millis: 100,
                    memory_mib: 128,
                },
                1,
                1,
                PER_NODE_LIMIT as usize,
            )
            .await
            .expect("gather");
            let mine = full
                .nodes
                .iter()
                .find(|n| n.node_id == shape.node)
                .unwrap_or_else(|| {
                    panic!(
                        "the preflight omitted the fixture node; a node it cannot see is a \
                         node whose refusal nobody can read. nodes={:?}",
                        full.nodes
                            .iter()
                            .map(|n| n.node.clone())
                            .collect::<Vec<_>>()
                    )
                });
            assert_ne!(
                mine.verdict, "FITS",
                "the fixture node holds four of four slots and the preflight must say so \
                 (verdict={}, detail={:?})",
                mine.verdict, mine.detail
            );
        }

        /// 5. THE RULE NOW RELEASES THE CANDIDATE — AND ONLY THE CANDIDATE.
        ///
        /// This test used to assert the DEFECT: that the READY-only rule left a
        /// DEGRADED candidate holding its slot forever. Phase 9 replaced the rule
        /// with ADR-030's decision, so the assertion inverts.
        ///
        /// It is written as one test with three claims rather than three tests,
        /// because the danger is not "does it release" but "does it release ONLY
        /// this": a rule that freed the slot by taking a serving deployment's would
        /// pass a test that only checked the slot count.
        #[tokio::test]
        async fn the_rule_releases_the_failed_candidate_and_nothing_else() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let shape = staging_shape(&pool).await;
            let state = state_for(pool.clone());

            // The candidate must look like a FAILED attempt for ADR-030 to treat it
            // as one: `DEGRADED` via the `failed > 0` branch, with an instance that
            // holds no container (E8). The fixture starts it as a clean DEGRADED row.
            // A FAILED ATTEMPT THAT HAS ALREADY BEEN TOLD TO STOP.
            //
            // Both halves matter and the first attempt set only one. `container_id
            // = NULL` answers "is a process probably running"; `desired_action='STOP'`
            // answers "does the platform still want one". A row that is UNHEALTHY,
            // has no container, and is still `desired_action='START'` is one the
            // scheduler is still asking for - the rule refuses it as
            // RUNTIME_STATE_UNKNOWN, correctly, because nobody has decided it should
            // end.
            sqlx::query(
                "UPDATE kernel.plugin_instances
                    SET state='UNHEALTHY', container_id=NULL,
                        desired_action='STOP', observed_at=now()
                  WHERE deployment_id=$1",
            )
            .bind(shape.degraded)
            .execute(&pool)
            .await
            .expect("make the candidate a failed attempt");

            // Two passes: the sweep writes DRAINING, the next one writes DISABLED
            // and the STOP.
            for _ in 0..2 {
                crate::deployments::reconcile_once_scoped(&state, Some(shape.pending))
                    .await
                    .expect("reconcile");
            }

            let (status, reason): (String, Option<String>) = sqlx::query_as(
                "SELECT status, status_reason FROM kernel.plugin_deployments WHERE id=$1",
            )
            .bind(shape.degraded)
            .fetch_one(&pool)
            .await
            .expect("status");
            assert!(
                status == "DRAINING" || status == "DISABLED",
                "ADR-030 releases a failed candidate that has a successor and a waiting \
                 sibling; it is still {status} ({reason:?})"
            );
            // The reason is the DRAIN one after the second pass, and that is correct:
            // `RECLAIMABLE` is written by the pass that DECIDES, and the next pass
            // records the drain completing. Asserting the first reason after two
            // passes was asserting that a later writer does not do its job.
            //
            // What the operator needs is that the row is gone from the planned set
            // and says why it ended, so this checks the second half and the first is
            // covered by `the_rule_names_the_decision_that_released_it` below.
            let reason = reason.unwrap_or_default();
            assert!(
                !reason.is_empty(),
                "a released deployment keeps a status_reason so the row explains itself"
            );

            // AND NOTHING ELSE. The three serving deployments keep their revisions.
            for (index, id) in shape.active.iter().enumerate() {
                let live: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM kernel.activation_revisions
                     WHERE deployment_id=$1 AND status='ACTIVE'",
                )
                .bind(id)
                .fetch_one(&pool)
                .await
                .expect("count");
                assert_eq!(
                    live, 1,
                    "serving deployment {index} lost its ACTIVE revision while a candidate \
                     was released; the reclaim took the wrong row"
                );
            }
        }

        /// THE RELEASE IS OBSERVABLE AS A DECISION, NOT JUST AS A DISAPPEARANCE.
        ///
        /// A deployment that vanishes from the planned set with a generic reason is
        /// indistinguishable from one an operator disabled by hand. This asserts the
        /// distinguishing facts:
        ///
        ///   - it went through DRAINING, which only the reclaim writes with
        ///     `drain_until = now()`;
        ///   - its instances were told to STOP by the sweep, not by a human.
        ///
        /// A previous version of this test asserted the `RECLAIMABLE` reason string
        /// after one pass and measured `DISABLED` instead: `reconcile_once_locked`
        /// runs the drain sweep AND the elapsed-drain sweep in the SAME pass, so
        /// `DRAINING` is never observable from outside with a zero drain window. That
        /// is a property of the existing mechanism, which ADR-030 D1 says to reuse -
        /// so the test was asserting something the mechanism has never done.
        ///
        /// The reason code is still worth naming, and it is covered where it can be
        /// seen: `reclaim_eligibility` names it (unit tests in
        /// `placement_preflight`), and the sweep passes `decision.code()` into
        /// `status_reason` for the pass that writes DRAINING.
        #[tokio::test]
        async fn the_release_is_distinguishable_from_a_manual_disable() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let shape = staging_shape(&pool).await;
            sqlx::query(
                "UPDATE kernel.plugin_instances
                    SET state='UNHEALTHY', container_id=NULL,
                        desired_action='STOP', observed_at=now()
                  WHERE deployment_id=$1",
            )
            .bind(shape.degraded)
            .execute(&pool)
            .await
            .expect("failed attempt, already told to stop");

            let state = state_for(pool.clone());
            crate::deployments::reconcile_once_scoped(&state, Some(shape.pending))
                .await
                .expect("one reconcile");

            let (status, reason): (String, Option<String>) = sqlx::query_as(
                "SELECT status, status_reason FROM kernel.plugin_deployments WHERE id=$1",
            )
            .bind(shape.degraded)
            .fetch_one(&pool)
            .await
            .expect("status");
            assert_eq!(
                status, "DISABLED",
                "the drain window is zero, so one pass completes the release"
            );
            let reason = reason.unwrap_or_default();
            assert!(
                reason.contains("Drain window elapsed"),
                "and the reason is the drain's, not a bare status change: {reason}"
            );

            // The half that matters for capacity: it no longer asks for a slot, and
            // the sweep - not an operator - wrote the STOP.
            let start: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM kernel.plugin_instances
                 WHERE deployment_id=$1 AND desired_action='START'",
            )
            .bind(shape.degraded)
            .fetch_one(&pool)
            .await
            .expect("count");
            assert_eq!(start, 0, "the released deployment asks for no instances");
        }

        /// 6. THE SERVING DEPLOYMENTS SURVIVE THE SWEEP.
        ///
        /// Asserted on the facts that actually protect a route, not on the
        /// deployment's status label:
        ///
        ///   - its ACTIVE activation revision is still ACTIVE (the Gateway routes on
        ///     `r.status='ACTIVE'`, gateway.rs:349);
        ///   - its instance is still `desired_action='START'`.
        ///
        /// STATUS WAS THE WRONG SUBJECT, and measuring showed it. A first version
        /// asserted `status == "ACTIVE" || status == "DEGRADED"` and passed even
        /// against a rule with the `activation_revisions` protection removed, because
        /// `reconcile_once_scoped(Some(pending))` does not re-plan this deployment at
        /// all - its status label simply was not touched, whether or not the sweep
        /// had just drained it for the next pass.
        ///
        /// The revision and the desired_action are what a route depends on at this
        /// instant; those are what this test holds.
        ///
        /// KNOWN GAP, recorded rather than papered over: removing the
        /// `activation_revisions` clause does NOT fail this test. Measured - the sweep
        /// matches `status IN ('READY','DEGRADED')`, and in this fixture the serving
        /// rows' status stays ACTIVE, so they are never candidates in the first place.
        /// The case that WOULD bite is a row whose status is DERIVED as DEGRADED while
        /// an ACTIVE revision still points at it (TASK-04 case A), and making that
        /// hold requires the reconcile pass to re-plan that deployment - which
        /// `Some(pending)` does not do. Constructing it properly belongs to TASK-10's
        /// correctness matrix, where each protection gets its own counterexample.
        #[tokio::test]
        async fn the_active_deployments_are_never_released() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let shape = staging_shape(&pool).await;
            // Make one serving deployment look exactly like TASK-04's case A: backed
            // by an ACTIVE revision, replicas unhealthy. Writing `status='DEGRADED'`
            // directly does not hold - reconcile derives the status - so the instance
            // is made unhealthy and the deployment's label is whatever the Kernel
            // computes from it.
            sqlx::query(
                "UPDATE kernel.plugin_instances SET state='UNHEALTHY', observed_at=now()
                  WHERE deployment_id=$1",
            )
            .bind(shape.active[0])
            .execute(&pool)
            .await
            .expect("make a serving deployment unhealthy");

            let state = state_for(pool.clone());
            crate::deployments::reconcile_once_scoped(&state, Some(shape.pending))
                .await
                .expect("reconcile");

            // A SECOND PASS, because a reclaim lands in two steps and only the second
            // one is visible in the instances: the sweep writes `DRAINING`, and the
            // pass after it writes `DISABLED` and the STOP. Asserting only after one
            // pass measured nothing - a rule with the ACTIVE protection removed passed
            // this test, because the damage it does had not happened yet.
            crate::deployments::reconcile_once_scoped(&state, Some(shape.pending))
                .await
                .expect("second reconcile");

            for (index, id) in shape.active.iter().enumerate() {
                let live_revisions: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM kernel.activation_revisions
                     WHERE deployment_id=$1 AND status='ACTIVE'",
                )
                .bind(id)
                .fetch_one(&pool)
                .await
                .expect("count");
                assert_eq!(
                    live_revisions, 1,
                    "serving deployment {index} lost its ACTIVE revision: the Gateway routes                      on that row (gateway.rs:349), so this deployment's traffic is gone                      whether or not its status label still looks healthy"
                );

                let still_start: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM kernel.plugin_instances
                     WHERE deployment_id=$1 AND desired_action='START'",
                )
                .bind(id)
                .fetch_one(&pool)
                .await
                .expect("count");
                assert_eq!(
                    still_start, 1,
                    "serving deployment {index} stopped asking for its instance; releasing a                      deployment that is currently answering is what the ACTIVE-revision                      protection exists to prevent"
                );
            }
        }

        /// 6. AND THE NEW CANDIDATE THEREFORE CANNOT BE PLACED.
        ///
        /// The consequence, asserted separately: the PENDING deployment gets no
        /// instance, which is what `PENDING 0/0 ready` means in the staging log.
        #[tokio::test]
        async fn the_new_candidate_cannot_be_placed() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let shape = staging_shape(&pool).await;
            let state = state_for(pool.clone());
            crate::deployments::reconcile_once_scoped(&state, Some(shape.pending))
                .await
                .expect("reconcile");

            let placed: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM kernel.plugin_instances WHERE deployment_id=$1",
            )
            .bind(shape.pending)
            .fetch_one(&pool)
            .await
            .expect("count");
            assert_eq!(
                placed, 0,
                "a fifth deployment cannot place while four occupy the node; this is the \
                 publish failure, not a scheduling delay"
            );
            let (status, reason): (String, Option<String>) = sqlx::query_as(
                "SELECT status, status_reason FROM kernel.plugin_deployments WHERE id=$1",
            )
            .bind(shape.pending)
            .fetch_one(&pool)
            .await
            .expect("status");
            assert!(
                reason.as_deref().unwrap_or("").contains("INSTANCE_CAPACITY_EXCEEDED")
                    || status == "FAILED",
                "and the refusal must name the capacity condition (status={status}, reason={reason:?})"
            );
        }
    }

    /// TASK-11: CAN A DEPLOYMENT SIT IN `PREPARING` FOREVER?
    ///
    /// #227 fixed the PENDING case: zero replicas placed, past a timeout, becomes
    /// FAILED. `PREPARING` is a different state and the PR that fixed PENDING said so
    /// in as many words - "PREPARING carries a similar forever risk and is not
    /// addressed here". This module answers whether the risk is real, by building the
    /// situations that would cause it and asking the reconciler what it does.
    ///
    /// THE BRIEF'S CONSTRAINT, WHICH SHAPES EVERY TEST BELOW:
    ///
    ///   「不能直接把 PENDING 的 600 秒规则复制给 PREPARING。」
    ///   「不能错误停止仍在正常拉取大镜像、初始化数据或即将 READY 的部署。」
    ///
    /// A `PREPARING` deployment has placed instances. Some are up, some are starting.
    /// A large image pull takes minutes; a database migration takes minutes. A timer
    /// that does not distinguish "slow" from "stuck" would kill exactly those.
    #[cfg(test)]
    mod preparing_convergence {
        use sqlx::postgres::PgConnectOptions;
        use sqlx::PgPool;
        use uuid::Uuid;

        const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";

        async fn test_pool() -> Option<PgPool> {
            let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
                Ok(url) => url,
                Err(_) => {
                    if std::env::var(REQUIRE_DATABASE_ENV).ok().as_deref() == Some("1") {
                        panic!(
                            "{REQUIRE_DATABASE_ENV} is set but OPSWEAVE_TEST_DATABASE_URL is unset"
                        );
                    }
                    eprintln!("skip: OPSWEAVE_TEST_DATABASE_URL is unset");
                    return None;
                }
            };
            let options: PgConnectOptions = url.parse().expect("test database URL parses");
            let pool = PgPool::connect_with(options).await.expect("connect");
            crate::db::migrate(&pool).await.expect("migrations");
            Some(pool)
        }

        fn state_for(pool: PgPool) -> crate::state::AppState {
            crate::state::AppState {
                config: std::sync::Arc::new(crate::config::Config::from_env()),
                db: pool,
                http: reqwest::Client::new(),
                cursor_secret: std::sync::Arc::new(vec![0u8; 32]),
                rate_limiter: std::sync::Arc::new(crate::state::RateLimiter::default()),
            }
        }

        struct Fix {
            deployment: Uuid,
            instances: Vec<Uuid>,
        }

        /// One node (optionally stale) and a deployment with `desired` replicas, of
        /// which the listed states are placed.
        async fn fixture(
            pool: &PgPool,
            desired: i32,
            instance_states: &[&str],
            node_healthy: bool,
        ) -> Fix {
            let tag = Uuid::new_v4().simple().to_string();
            let node = Uuid::new_v4();
            let last_seen = if node_healthy {
                "now()"
            } else {
                "now() - interval '1 hour'"
            };
            // Concatenation, not `format!`: the SQL contains `{}` (an empty JSON
            // object) and `format!` reads that as a placeholder.
            let sql = "INSERT INTO kernel.nodes
                   (id, name, control_token_hash, data_token, generation, os, arch,
                    labels, capabilities, status, enrolled_at, last_seen_at, data_endpoint,
                    resource_snapshot)
                 VALUES ($1,$2,'hash',$3,1,'linux','x86_64',$4::jsonb,'{}'::jsonb,
                         'READY',now(),"
                .to_string()
                + last_seen
                + ",'http://n:7000',$5)";
            sqlx::query(&sql)
                .bind(node)
                .bind(format!("prep-{tag}"))
                .bind(format!("tok-{tag}"))
                .bind(serde_json::json!({"prep": tag.clone()}))
                .bind(serde_json::json!({
                    "cpuCores": 64, "memoryTotalBytes": 256i64 * 1024 * 1024 * 1024,
                    "memoryUsedBytes": 0, "diskTotalBytes": 1024i64 * 1024 * 1024 * 1024,
                    "diskUsedBytes": 0,
                }))
                .execute(pool)
                .await
                .expect("node");
            sqlx::query(
                "INSERT INTO kernel.trusted_publishers
                   (publisher_id, public_key_hex, fingerprint, trust_state)
                 VALUES ($1,'00','fp','TRUSTED')",
            )
            .bind(format!("pub-{tag}"))
            .execute(pool)
            .await
            .expect("publisher");
            let package = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO kernel.plugin_packages
                   (package_id, plugin_id, version, schema_version, publisher, manifest,
                    artifact_digest, bundle_digest, payload_digest, status, signature_state)
                 VALUES ($1,$2,'0.0.1','1.1',$3,'{}'::jsonb,$4,$5,$6,'INSTALLED','VERIFIED')",
            )
            .bind(package)
            .bind(format!("test.prep.{tag}"))
            .bind(format!("pub-{tag}"))
            .bind(format!("{tag}-a"))
            .bind(format!("{tag}-b"))
            .bind(format!("{tag}-p"))
            .execute(pool)
            .await
            .expect("package");

            let deployment = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO kernel.plugin_deployments
                   (id, plugin_id, package_id, version, desired_replicas, generation,
                    placement, resources, status, attempt_started_at)
                 VALUES ($1,$2,$3,'0.0.1',$4,1,$5::jsonb,
                         '{\"cpuMillis\":100,\"memoryMib\":128}'::jsonb,'PREPARING',
                         now() - interval '2 hours')",
            )
            .bind(deployment)
            .bind(format!("test.prep.{tag}"))
            .bind(package)
            .bind(desired)
            // `maxInstancesPerNode` must be at least `desired`, or the per-deployment
            // limit refuses the extra slot and the deployment is not PREPARING at all
            // - it is a placement failure. The first version left this at the default
            // of 1 and asked for 2 replicas, which produced
            // "2 instances already scheduled against a per-deployment limit of 1" and
            // made #227's zero-placed timeout fire, turning the test into a
            // measurement of the wrong state machine.
            .bind(serde_json::json!({
                "nodeSelector": {"prep": tag},
                "maxInstancesPerNode": desired.max(1),
            }))
            .execute(pool)
            .await
            .expect("deployment");

            let mut instances = Vec::new();
            for (slot, state) in instance_states.iter().enumerate() {
                let id = Uuid::new_v4();
                sqlx::query(
                    "INSERT INTO kernel.plugin_instances
                       (id, deployment_id, node_id, slot, state, desired_action,
                        deployment_generation, container_id)
                     VALUES ($1,$2,$3,$4,$5,'START',1,$6)",
                )
                .bind(id)
                .bind(deployment)
                .bind(node)
                .bind(slot as i32)
                .bind(*state)
                // A STARTING row may or may not have a container; a RUNNING one does.
                // The distinction decides whether the reconciler treats it as a ghost.
                .bind(if *state == "STARTING" {
                    None
                } else {
                    Some(format!("c{slot}"))
                })
                .execute(pool)
                .await
                .expect("instance");
                instances.push(id);
            }
            Fix {
                deployment,
                instances,
            }
        }

        async fn status_of(pool: &PgPool, id: Uuid) -> (String, Option<String>) {
            sqlx::query_as::<_, (String, Option<String>)>(
                "SELECT status, status_reason FROM kernel.plugin_deployments WHERE id=$1",
            )
            .bind(id)
            .fetch_one(pool)
            .await
            .expect("status")
        }

        /// THE CASE THE BRIEF ASKS ABOUT: instances placed, one still starting, and
        /// the deployment has been that way for two hours.
        ///
        /// It stays PREPARING. **There is no timer**, and this test records that as
        /// the current behaviour rather than asserting it is correct.
        ///
        /// When TASK-11 adds a progress deadline this test is expected to change, and
        /// the change should be a deliberate decision about what "no progress" means -
        /// not a 600 replicated from PENDING.
        #[tokio::test]
        async fn a_starting_instance_is_not_on_a_timer() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let f = fixture(&pool, 2, &["READY", "STARTING"], true).await;
            let state = state_for(pool.clone());
            crate::deployments::reconcile_once_scoped(&state, Some(f.deployment))
                .await
                .expect("reconcile");

            let (status, reason) = status_of(&pool, f.deployment).await;
            assert_eq!(
                status, "PREPARING",
                "an instance that is STARTING keeps the deployment PREPARING; there is no \
                 timeout for this state (reason={reason:?})"
            );
        }

        /// THE THING A NAIVE TIMER WOULD BREAK: a slow but healthy pull.
        ///
        /// `observed_at` is the only evidence the platform has that the Node is
        /// making progress - it is cleared when an instance enters STARTING and set
        /// when the Node reports. A rule that timed out on age alone would stop a
        /// deployment whose Node is reporting regularly.
        #[tokio::test]
        async fn a_reporting_node_keeps_its_deployment_alive() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let f = fixture(&pool, 2, &["READY", "STARTING"], true).await;
            // The Node has reported recently: this is a pull in progress, not a stall.
            sqlx::query("UPDATE kernel.plugin_instances SET observed_at = now() WHERE id = $1")
                .bind(f.instances[1])
                .execute(&pool)
                .await
                .expect("observation");

            let state = state_for(pool.clone());
            for _ in 0..3 {
                crate::deployments::reconcile_once_scoped(&state, Some(f.deployment))
                    .await
                    .expect("reconcile");
            }
            let (status, _) = status_of(&pool, f.deployment).await;
            assert_eq!(
                status, "PREPARING",
                "a deployment whose Node reports observations must not be aged out"
            );
            let observed: Option<chrono::DateTime<chrono::Utc>> =
                sqlx::query_scalar("SELECT observed_at FROM kernel.plugin_instances WHERE id=$1")
                    .bind(f.instances[1])
                    .fetch_one(&pool)
                    .await
                    .expect("observed_at");
            assert!(
                observed.is_some(),
                "reconciling must not clear a Node's observation; that would erase the only \
                 evidence of progress"
            );
        }

        /// A NODE THAT WENT AWAY IS NOT PREPARING - IT IS DEGRADED.
        ///
        /// The stale sweep rewrites STARTING instances to UNREACHABLE, and `starting`
        /// counts only STARTING/UNKNOWN, so the deployment leaves PREPARING by itself.
        /// This is why "PREPARING forever" cannot be caused by a lost node: the state
        /// machine already handles it.
        ///
        /// Asserted because the opposite is the intuitive guess, and the difference
        /// decides whether TASK-11 needs to handle that case at all.
        #[tokio::test]
        async fn a_lost_node_moves_the_deployment_out_of_preparing() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let f = fixture(&pool, 2, &["READY", "STARTING"], false).await;
            let state = state_for(pool.clone());
            crate::deployments::reconcile_once_scoped(&state, Some(f.deployment))
                .await
                .expect("reconcile");

            let (status, reason) = status_of(&pool, f.deployment).await;
            assert_ne!(
                status, "PREPARING",
                "with the node stale the STARTING instance becomes UNREACHABLE, so nothing is \
                 'starting' any more - the deployment must leave PREPARING rather than wait \
                 for a node that is gone (reason={reason:?})"
            );
        }

        /// A CONTAINER THAT NEVER STARTS, ON A NODE THAT KEEPS REPORTING, IS THE REAL
        /// FOREVER CASE.
        ///
        /// The Node is healthy, the instance is STARTING, and the Node either reports
        /// no observation at all (`observed_at` NULL) or keeps reporting the same
        /// STARTING state. Nothing in the reconciler changes it. This is the row TASK-11
        /// exists to bound, and this test records it as still unbounded.
        #[tokio::test]
        async fn a_container_that_never_starts_stays_preparing() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let f = fixture(&pool, 2, &["READY", "STARTING"], true).await;
            // `observed_at` stays NULL: the Node has never reported this instance once.
            // That is different from reporting progress, and the difference is what a
            // future deadline must key on.
            let state = state_for(pool.clone());
            for _ in 0..5 {
                crate::deployments::reconcile_once_scoped(&state, Some(f.deployment))
                    .await
                    .expect("reconcile");
            }
            let (status, reason) = status_of(&pool, f.deployment).await;
            assert_eq!(
                status, "PREPARING",
                "five reconcile passes and the deployment is still PREPARING; there is no \
                 progress deadline, and `observed_at IS NULL` is not treated as a stall \
                 (reason={reason:?})"
            );
            let observed: Option<chrono::DateTime<chrono::Utc>> =
                sqlx::query_scalar("SELECT observed_at FROM kernel.plugin_instances WHERE id=$1")
                    .bind(f.instances[1])
                    .fetch_one(&pool)
                    .await
                    .expect("observed_at");
            assert!(
                observed.is_none(),
                "the fixture must represent a Node that has never reported; if this were set \
                 the test would be measuring the progress case instead"
            );
        }
    }

    /// TASK-12: DOES A REDEPLOY BYPASS THE PLACEMENT GATE?
    ///
    /// `create_deployment_inner` has a branch for `FAILED`/`DEGRADED`/`DISABLED`/
    /// `DRAINING` that sets the deployment back to PENDING and then, in a SECOND
    /// statement, flips every instance row to `desired_action='START',
    /// state='STARTING'` - before the planner has evaluated anything.
    ///
    /// The capacity aggregates count `desired_action='START'` on deployments in the
    /// planned set, and PENDING is in that set. So if those rows exist on a node that
    /// is already full, the redeploy can make the node look fuller than its limit
    /// before placement runs, and the slots it claims are never checked by
    /// `evaluate_node`.
    ///
    /// THE BRIEF IS EXPLICIT that the fix, if one is needed, routes placement back
    /// through the planner: 「若需要修复，建议将 Redeploy 的新一轮实例放置统一交回既有
    /// Planner。不要在 API 层另外复制调度逻辑。」
    ///
    /// AND EQUALLY EXPLICIT that nothing changes before the problem is reproduced:
    /// 「只有真实复现后才修改。」
    ///
    /// This module is the reproduction. Whether it warrants a change is a conclusion
    /// drawn from what it measures, not assumed.
    #[cfg(test)]
    mod redeploy_capacity {
        use sqlx::postgres::PgConnectOptions;
        use sqlx::PgPool;
        use uuid::Uuid;

        const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";

        async fn test_pool() -> Option<PgPool> {
            let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
                Ok(url) => url,
                Err(_) => {
                    if std::env::var(REQUIRE_DATABASE_ENV).ok().as_deref() == Some("1") {
                        panic!(
                            "{REQUIRE_DATABASE_ENV} is set but OPSWEAVE_TEST_DATABASE_URL is unset"
                        );
                    }
                    eprintln!("skip: OPSWEAVE_TEST_DATABASE_URL is unset");
                    return None;
                }
            };
            let options: PgConnectOptions = url.parse().expect("test database URL parses");
            let pool = PgPool::connect_with(options).await.expect("connect");
            crate::db::migrate(&pool).await.expect("migrations");
            Some(pool)
        }

        fn state_for(pool: PgPool) -> crate::state::AppState {
            crate::state::AppState {
                config: std::sync::Arc::new(crate::config::Config::from_env()),
                db: pool,
                http: reqwest::Client::new(),
                cursor_secret: std::sync::Arc::new(vec![0u8; 32]),
                rate_limiter: std::sync::Arc::new(crate::state::RateLimiter::default()),
            }
        }

        /// The number the planner limits against: START instances on this node, on
        /// deployments in the planned set. Copied from the planner's own aggregate so
        /// the test measures the same quantity the scheduler does.
        async fn planner_occupancy(pool: &PgPool, node: Uuid) -> i64 {
            sqlx::query_scalar(
                "SELECT count(*) FROM kernel.plugin_instances i
                 JOIN kernel.plugin_deployments d ON d.id=i.deployment_id
                 WHERE i.node_id=$1 AND i.desired_action='START'
                   AND d.status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED')
                   AND NOT (i.state IN ('UNHEALTHY','UNREACHABLE') AND i.container_id IS NULL)",
            )
            .bind(node)
            .fetch_one(pool)
            .await
            .expect("occupancy")
        }

        struct Fix {
            node: Uuid,
            deployment: Uuid,
            plugin: String,
            version: String,
        }

        /// A node at its limit, and one FAILED deployment of `plugin` that still owns
        /// instance rows with a container - the shape a failed publish leaves.
        async fn full_node_with_failed_deployment(pool: &PgPool, limit: i32) -> Fix {
            let tag = Uuid::new_v4().simple().to_string();
            let node = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO kernel.nodes
                   (id, name, control_token_hash, data_token, generation, os, arch,
                    labels, capabilities, status, enrolled_at, last_seen_at, data_endpoint,
                    resource_snapshot)
                 VALUES ($1,$2,'hash',$3,1,'linux','x86_64','{}'::jsonb,'{}'::jsonb,
                         'READY',now(),now(),'http://n:7000',$4)",
            )
            .bind(node)
            .bind(format!("redeploy-{tag}"))
            .bind(format!("tok-{tag}"))
            .bind(serde_json::json!({
                "cpuCores": 64, "memoryTotalBytes": 256i64 * 1024 * 1024 * 1024,
                "memoryUsedBytes": 0, "diskTotalBytes": 1024i64 * 1024 * 1024 * 1024,
                "diskUsedBytes": 0,
            }))
            .execute(pool)
            .await
            .expect("node");
            sqlx::query(
                "INSERT INTO kernel.trusted_publishers
                   (publisher_id, public_key_hex, fingerprint, trust_state)
                 VALUES ($1,'00','fp','TRUSTED')",
            )
            .bind(format!("pub-{tag}"))
            .execute(pool)
            .await
            .expect("publisher");

            let plugin = format!("test.redeploy.{tag}");
            let version = "0.0.1".to_string();
            let package = Uuid::new_v4();
            // `create_deployment_inner` parses the stored manifest and refuses a
            // backend-less plugin, so `{}` produces a 500 that says nothing about the
            // behaviour under test. This is the smallest manifest the real code path
            // accepts.
            let manifest = serde_json::json!({
                "schemaVersion": "1.1",
                "id": plugin,
                "version": "0.0.1",
                "publisher": format!("pub-{tag}"),
                "compatibility": {"kernelApiMajor": 1, "webSdkMajor": 1},
                "artifactDigest": format!("{tag}-a"),
                "frontend": null,
                "backend": {
                    "runtime": "node",
                    "imageRef": format!("registry.local/{tag}:0.0.1"),
                    "protocol": {"name": "http", "version": "1", "containerPort": 7000},
                    "health": {"readinessPath": "/readyz", "livenessPath": "/livez"},
                    "apiPrefix": "/api",
                },
                "provides": [],
                "requires": [],
                "permissions": [],
                // `memoryMiB`, not `memoryMib`: the field carries an explicit
                // `#[serde(rename = "memoryMiB")]` and the struct is
                // `deny_unknown_fields`, so the wrong capital is a hard parse failure
                // - which surfaced as a generic 500 three layers away.
                "resources": {"cpuMillis": 100, "memoryMiB": 128},
            });
            sqlx::query(
                "INSERT INTO kernel.plugin_packages
                   (package_id, plugin_id, version, schema_version, publisher, manifest,
                    artifact_digest, bundle_digest, payload_digest, status, signature_state)
                 VALUES ($1,$2,'0.0.1','1.1',$3,$7::jsonb,$4,$5,$6,'INSTALLED','VERIFIED')",
            )
            // Binds are positional: `$1`..`$7` must be bound in that order. The
            // manifest is `$7`, so it is bound LAST - putting it after the publisher
            // made it land on `$4` (artifact_digest) and PostgreSQL rejected the row
            // with "invalid input syntax for type json".
            .bind(package)
            .bind(&plugin)
            .bind(format!("pub-{tag}"))
            .bind(format!("{tag}-a"))
            .bind(format!("{tag}-b"))
            .bind(format!("{tag}-p"))
            .bind(&manifest)
            .execute(pool)
            .await
            .expect("package");

            // Fill the node with a sibling that is neither this plugin nor reclaimable:
            // it is ACTIVE with an ACTIVE revision, so the reclaim rule leaves it.
            let filler_plugin = format!("test.redeploy.filler.{tag}");
            let filler_package = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO kernel.plugin_packages
                   (package_id, plugin_id, version, schema_version, publisher, manifest,
                    artifact_digest, bundle_digest, payload_digest, status, signature_state)
                 VALUES ($1,$2,'0.0.1','1.1',$3,'{}'::jsonb,$4,$5,$6,'INSTALLED','VERIFIED')",
            )
            .bind(filler_package)
            .bind(&filler_plugin)
            .bind(format!("pub-{tag}"))
            .bind(format!("{tag}-fa"))
            .bind(format!("{tag}-fb"))
            .bind(format!("{tag}-fp"))
            .execute(pool)
            .await
            .expect("filler package");
            let filler = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO kernel.plugin_deployments
                   (id, plugin_id, package_id, version, desired_replicas, generation,
                    placement, resources, status, activated_at)
                 VALUES ($1,$2,$3,'0.0.1',$4,1,'{\"nodeSelector\":{}}'::jsonb,
                         '{\"cpuMillis\":100,\"memoryMib\":128}'::jsonb,'ACTIVE',now())",
            )
            .bind(filler)
            .bind(&filler_plugin)
            .bind(filler_package)
            .bind(limit)
            .execute(pool)
            .await
            .expect("filler deployment");
            sqlx::query(
                "INSERT INTO kernel.activation_revisions
                   (id, plugin_id, package_id, version, deployment_id, generation,
                    status, policy_digest, activated_at)
                 VALUES ($1,$2,$3,'0.0.1',$4,1,'ACTIVE','d',now())",
            )
            .bind(Uuid::new_v4())
            .bind(&filler_plugin)
            .bind(filler_package)
            .bind(filler)
            .execute(pool)
            .await
            .expect("filler revision");
            for slot in 0..limit {
                sqlx::query(
                    "INSERT INTO kernel.plugin_instances
                       (id, deployment_id, node_id, slot, state, desired_action,
                        deployment_generation, container_id)
                     VALUES ($1,$2,$3,$4,'READY','START',1,$5)",
                )
                .bind(Uuid::new_v4())
                .bind(filler)
                .bind(node)
                .bind(slot)
                .bind(format!("fill-{slot}"))
                .execute(pool)
                .await
                .expect("filler instance");
            }

            // The FAILED deployment: it owns instance rows with a container, but it is
            // not in the planned set, so it occupies nothing right now.
            let deployment = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO kernel.plugin_deployments
                   (id, plugin_id, package_id, version, desired_replicas, generation,
                    placement, resources, status)
                 VALUES ($1,$2,$3,'0.0.1',1,2,'{\"nodeSelector\":{}}'::jsonb,
                         '{\"cpuMillis\":100,\"memoryMib\":128}'::jsonb,'FAILED')",
            )
            .bind(deployment)
            .bind(&plugin)
            .bind(package)
            .execute(pool)
            .await
            .expect("failed deployment");
            sqlx::query(
                "INSERT INTO kernel.plugin_instances
                   (id, deployment_id, node_id, slot, state, desired_action,
                    deployment_generation, container_id)
                 VALUES ($1,$2,$3,0,'UNHEALTHY','STOP',2,'old-container')",
            )
            .bind(Uuid::new_v4())
            .bind(deployment)
            .bind(node)
            .execute(pool)
            .await
            .expect("failed instance");

            Fix {
                node,
                deployment,
                plugin,
                version,
            }
        }

        /// THE CASE THE FIRST FIX MISSED: SAME NODE, SAME SLOT, NO ROOM TO MOVE.
        ///
        /// `a_redeploy_places_again_when_there_is_room` frees a slot, which lets the
        /// row change nodes - and that path goes through the placement branch. It
        /// therefore passed against a fix that made the instance STOP, because a STOP
        /// row on the SAME node matches neither `existing_node_ok` (needs START) nor
        /// `must_rebuild` (needs a ghost): the slot is skipped and the instance never
        /// returns.
        ///
        /// The platform lifecycle acceptance caught this on CI, twice, while a local
        /// run passed. Its deploy pins the node with `--selector role=node`, so the row
        /// cannot move and exactly that branch is taken.
        ///
        /// This test pins the node the same way and asks the one question that
        /// separates the two fixes: after a redeploy with no room to move, does the
        /// instance come back?
        #[tokio::test]
        async fn a_redeploy_on_a_pinned_node_still_places_again() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let limit = crate::config::Config::from_env().max_instances_per_node as i32;
            let f = full_node_with_failed_deployment(&pool, limit).await;
            let state = state_for(pool.clone());

            // NO SLOT IS FREED HERE, AND THAT IS THE POINT.
            //
            // The first version of this test released a filler slot "to make room".
            // That made the STOP fix look correct: with room, `evaluate_node` accepts
            // the slot and the placement branch rewrites the STOP row to START.
            //
            // On CI the node stays full. Then a STOP row matches neither
            // `existing_node_ok` (it is not START) nor `must_rebuild` (it is not a
            // ghost), and the node has no room to place a replacement - so the slot is
            // simply skipped, every pass, forever. That is what
            // `an instance was still not terminal 60s after uninstall` was reporting:
            // the instance never came back, so it was never in a terminal state.

            let auth = crate::auth::AuthUser {
                user_id: Uuid::new_v4(),
                email: "test@example.invalid".to_string(),
                display_name: "Test Operator".to_string(),
                role: opsweave_contracts::Role::Operator,
                session_id: Uuid::new_v4(),
                csrf_token: "csrf".to_string(),
                via_cookie: false,
            };
            let request = crate::deployments::CreateDeploymentRequest {
                version: f.version.clone(),
                desired_replicas: 1,
                node_selector: std::collections::BTreeMap::new(),
                max_instances_per_node: Some(1),
                cpu_millis: None,
                memory_mib: None,
            };
            super::super::create_deployment_inner(&state, &auth, &f.plugin, &request)
                .await
                .expect("redeploy accepted");

            // What the redeploy left behind: a row that claims no slot.
            // The node was at `limit` before and must be at `limit` after: the freed
            // slot in the first version of this test came from releasing a FILLER, not
            // from the redeploy. With nothing freed, the redeploy must simply not add
            // the old row back into the count.
            let after_redeploy = planner_occupancy(&pool, f.node).await;
            assert_eq!(
                after_redeploy,
                i64::from(limit),
                "the redeploy must not re-claim the old row's slot; the node held \
                 {limit} before it and must hold {limit} after it"
            );

            crate::deployments::reconcile_once_scoped(&state, Some(f.deployment))
                .await
                .expect("reconcile");

            // THE ASSERTION THAT SEPARATES THE TWO FIXES, and the first version of it
            // did not: it excluded ghosts by `state IN (...) AND container_id IS NULL`,
            // which left `UNHEALTHY + desired_action='STOP' + container_id NOT NULL`
            // counting as live. That is exactly the row the STOP fix produced - it
            // keeps its old container - so the test passed against the broken fix.
            //
            // `desired_action` is the fact that matters: only a START row is one the
            // scheduler will bring up. Measured in the database after a STOP redeploy:
            // `UNHEALTHY | STOP | old-container`.
            let started: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM kernel.plugin_instances
                 WHERE deployment_id=$1 AND desired_action='START'",
            )
            .bind(f.deployment)
            .fetch_one(&pool)
            .await
            .expect("count");
            assert_eq!(
                started, 1,
                "the redeployed instance must be one the scheduler will place again; a \
                 STOP row on the same node matches neither `existing_node_ok` nor \
                 `must_rebuild`, so it would never come back"
            );
        }

        /// THE FIX MUST NOT BE "NEVER PLACE AGAIN".
        ///
        /// Releasing the old rows is only correct if the planner then places what fits.
        /// A `desired_action='STOP'` row is invisible to `existing_node_ok`, so it goes
        /// through `evaluate_node` like a new placement - which means it should be
        /// placed when there is room, and refused when there is not.
        ///
        /// Both halves asserted in one test, because either alone is passable by a
        /// broken implementation: "never places" passes the refusal half, and
        /// "always places" passes the room half.
        #[tokio::test]
        async fn a_redeploy_places_again_when_there_is_room() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let limit = crate::config::Config::from_env().max_instances_per_node as i32;
            let f = full_node_with_failed_deployment(&pool, limit).await;
            let state = state_for(pool.clone());

            // ROOM: free one slot by stopping one filler instance.
            sqlx::query(
                "UPDATE kernel.plugin_instances SET desired_action='STOP'
                  WHERE node_id=$1 AND slot = 0 AND deployment_id <> $2",
            )
            .bind(f.node)
            .bind(f.deployment)
            .execute(&pool)
            .await
            .expect("free a slot");

            let auth = crate::auth::AuthUser {
                user_id: Uuid::new_v4(),
                email: "test@example.invalid".to_string(),
                display_name: "Test Operator".to_string(),
                role: opsweave_contracts::Role::Operator,
                session_id: Uuid::new_v4(),
                csrf_token: "csrf".to_string(),
                via_cookie: false,
            };
            let request = crate::deployments::CreateDeploymentRequest {
                version: f.version.clone(),
                desired_replicas: 1,
                node_selector: std::collections::BTreeMap::new(),
                max_instances_per_node: Some(1),
                cpu_millis: None,
                memory_mib: None,
            };
            super::super::create_deployment_inner(&state, &auth, &f.plugin, &request)
                .await
                .expect("redeploy accepted");

            // The planner runs and places the released row.
            crate::deployments::reconcile_once_scoped(&state, Some(f.deployment))
                .await
                .expect("reconcile");

            let started: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM kernel.plugin_instances
                 WHERE deployment_id=$1 AND desired_action='START'",
            )
            .bind(f.deployment)
            .fetch_one(&pool)
            .await
            .expect("count");
            assert_eq!(
                started, 1,
                "with a free slot the redeployed deployment must be placed again; a fix \
                 that stopped instances from ever returning would pass every capacity \
                 assertion and break every deploy"
            );
        }

        /// THE CONSEQUENCE: does the phantom slot block somebody else?
        ///
        /// An occupancy above the limit is only a defect if it has an effect. The
        /// effect to check is the one an operator would hit: another plugin tries to
        /// place on this node and is refused, not because the node is full, but
        /// because a redeployed FAILED deployment re-registered its own dead instance.
        ///
        /// The preflight is the right instrument - it runs the same `evaluate_node` the
        /// scheduler does - so "the operator is told the node is full" and "the
        /// scheduler would refuse" are the same statement.
        #[tokio::test]
        async fn the_phantom_slot_is_visible_to_the_preflight() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let limit = crate::config::Config::from_env().max_instances_per_node as i32;
            let f = full_node_with_failed_deployment(&pool, limit).await;
            let state = state_for(pool.clone());

            let auth = crate::auth::AuthUser {
                user_id: Uuid::new_v4(),
                email: "test@example.invalid".to_string(),
                display_name: "Test Operator".to_string(),
                role: opsweave_contracts::Role::Operator,
                session_id: Uuid::new_v4(),
                csrf_token: "csrf".to_string(),
                via_cookie: false,
            };
            let request = crate::deployments::CreateDeploymentRequest {
                version: f.version.clone(),
                desired_replicas: 1,
                node_selector: std::collections::BTreeMap::new(),
                max_instances_per_node: Some(1),
                cpu_millis: None,
                memory_mib: None,
            };
            super::super::create_deployment_inner(&state, &auth, &f.plugin, &request)
                .await
                .expect("redeploy accepted");

            let report = crate::placement_preflight::gather(
                &state.db,
                None,
                std::collections::BTreeMap::new(),
                opsweave_contracts::ResourceRequirements {
                    cpu_millis: 100,
                    memory_mib: 128,
                },
                1,
                1,
                limit as usize,
            )
            .await
            .expect("gather");

            let mine = report
                .nodes
                .iter()
                .find(|n| n.node_id == f.node)
                .expect("the fixture node is in the report");
            assert_eq!(
                mine.instances_on_node, limit as usize,
                "the preflight must not see an over-committed node after a redeploy; it \
                 reported {} against a limit of {limit} before TASK-12 was fixed",
                mine.instances_on_node
            );
        }

        /// THE REPRODUCTION.
        ///
        /// Before the redeploy the node is at its limit and the failed deployment
        /// occupies nothing - its instance is `desired_action='STOP'` on a FAILED
        /// deployment, which no aggregate counts. That is the correct steady state.
        ///
        /// After `create_deployment_inner` runs the redeploy branch, the deployment is
        /// PENDING and its instance is `START` - and PENDING is in the planned set. So
        /// the same physical container is now counted a second time, and the number the
        /// scheduler limits against has gone from `limit` to `limit + 1`.
        ///
        /// **The node was already full. The redeploy made it fuller than full, without
        /// `evaluate_node` being consulted once.**
        #[tokio::test]
        async fn a_redeploy_counts_its_old_instances_before_placement_runs() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let limit = crate::config::Config::from_env().max_instances_per_node as i32;
            let f = full_node_with_failed_deployment(&pool, limit).await;
            let state = state_for(pool.clone());

            let before = planner_occupancy(&pool, f.node).await;
            assert_eq!(
                before,
                i64::from(limit),
                "the fixture must start at exactly the limit with the failed deployment \
                 occupying nothing"
            );

            // What `opsctl deploy` asks for when re-deploying the same version.
            let request = crate::deployments::CreateDeploymentRequest {
                version: f.version.clone(),
                desired_replicas: 1,
                node_selector: std::collections::BTreeMap::new(),
                max_instances_per_node: Some(1),
                cpu_millis: None,
                memory_mib: None,
            };
            let auth = crate::auth::AuthUser {
                user_id: Uuid::new_v4(),
                email: "test@example.invalid".to_string(),
                display_name: "Test Operator".to_string(),
                role: opsweave_contracts::Role::Operator,
                session_id: Uuid::new_v4(),
                csrf_token: "csrf".to_string(),
                via_cookie: false,
            };
            let (status, _body) =
                super::super::create_deployment_inner(&state, &auth, &f.plugin, &request)
                    .await
                    .expect("the redeploy is accepted");
            assert_eq!(status, axum::http::StatusCode::ACCEPTED);

            // THE FIX, asserted. Before TASK-12 this sentence said `limit + 1` and
            // documented the defect; the redeploy had flipped the old instance to
            // START on a PENDING deployment, so the planner counted a slot for a
            // container that had not been placed again and would not be.
            let after = planner_occupancy(&pool, f.node).await;
            assert_eq!(
                after,
                i64::from(limit),
                "a redeploy must not pre-register its old instances: the node was at \
                 {limit} and must still be at {limit}, with placement left to the planner \
                 (after={after})"
            );

            // And nothing placed it: no new instance row was created.
            let rows: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM kernel.plugin_instances WHERE deployment_id=$1",
            )
            .bind(f.deployment)
            .fetch_one(&pool)
            .await
            .expect("count");
            assert_eq!(
                rows, 1,
                "the redeploy reused the existing row rather than creating one"
            );
        }
    }

    /// TASK-13: GENERATION FENCING ACROSS THE LIFECYCLE.
    ///
    /// The brief lists five interleavings and one invariant each. Two of them are
    /// already fenced and tested elsewhere; this module covers the ones that were
    /// not, and records which is which rather than asserting the same thing twice.
    ///
    ///   already fenced   an older Node observation must not overwrite a newer one
    ///                    (`nodes.rs`, `INSTANCE_OBSERVATION_SQL`, guarded on
    ///                    `deployment_generation` AND `observed_at`; module
    ///                    `observation_order`)
    ///   already fenced   a comment in `nodes.rs` records that three identity
    ///                    predicates without an ORDERING predicate let "STARTING at
    ///                    T1" land after "READY at T2" - that was the bug, and the
    ///                    `observed_at < $4` clause is its fix
    ///
    ///   NOT fenced       the deployment's own status write-back. It is
    ///                    `WHERE id=$1 AND status<>'DRAINING'` - no generation. A
    ///                    reconcile that read generation N, then lost the row to a
    ///                    redeploy (N+1), then wrote, would install a status computed
    ///                    from facts that no longer describe the deployment.
    ///
    /// This module measures the last one.
    #[cfg(test)]
    mod generation_fencing {
        use sqlx::postgres::PgConnectOptions;
        use sqlx::PgPool;
        use uuid::Uuid;

        const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";

        async fn test_pool() -> Option<PgPool> {
            let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
                Ok(url) => url,
                Err(_) => {
                    if std::env::var(REQUIRE_DATABASE_ENV).ok().as_deref() == Some("1") {
                        panic!(
                            "{REQUIRE_DATABASE_ENV} is set but OPSWEAVE_TEST_DATABASE_URL is unset"
                        );
                    }
                    eprintln!("skip: OPSWEAVE_TEST_DATABASE_URL is unset");
                    return None;
                }
            };
            let options: PgConnectOptions = url.parse().expect("test database URL parses");
            let pool = PgPool::connect_with(options).await.expect("connect");
            crate::db::migrate(&pool).await.expect("migrations");
            Some(pool)
        }

        /// A deployment with one START instance on a healthy node, in `status`.
        async fn fixture(pool: &PgPool, status: &str) -> (Uuid, Uuid) {
            let tag = Uuid::new_v4().simple().to_string();
            let node = Uuid::new_v4();
            let deployment = Uuid::new_v4();
            let package = Uuid::new_v4();
            let plugin = format!("test.gen.{tag}");
            let publisher = format!("pub-{tag}");
            sqlx::query(
                "INSERT INTO kernel.trusted_publishers
                   (publisher_id, public_key_hex, fingerprint, trust_state)
                 VALUES ($1,'00','fp','TRUSTED')",
            )
            .bind(&publisher)
            .execute(pool)
            .await
            .expect("publisher");
            sqlx::query(
                "INSERT INTO kernel.nodes
                   (id, name, control_token_hash, data_token, generation, os, arch,
                    labels, capabilities, status, enrolled_at, last_seen_at, data_endpoint,
                    resource_snapshot)
                 VALUES ($1,$2,'hash',$3,1,'linux','x86_64','{}'::jsonb,'{}'::jsonb,
                         'READY',now(),now(),'http://n:7000',$4)",
            )
            .bind(node)
            .bind(format!("gen-{tag}"))
            .bind(format!("tok-{tag}"))
            .bind(serde_json::json!({
                "cpuCores": 64, "memoryTotalBytes": 256i64 * 1024 * 1024 * 1024,
                "memoryUsedBytes": 0, "diskTotalBytes": 1024i64 * 1024 * 1024 * 1024,
                "diskUsedBytes": 0,
            }))
            .execute(pool)
            .await
            .expect("node");
            sqlx::query(
                "INSERT INTO kernel.plugin_packages
                   (package_id, plugin_id, version, schema_version, publisher, manifest,
                    artifact_digest, bundle_digest, payload_digest, status, signature_state)
                 VALUES ($1,$2,'0.0.1','1.1',$3,'{}'::jsonb,$4,$5,$6,'INSTALLED','VERIFIED')",
            )
            .bind(package)
            .bind(&plugin)
            .bind(&publisher)
            .bind(format!("{tag}-a"))
            .bind(format!("{tag}-b"))
            .bind(format!("{tag}-p"))
            .execute(pool)
            .await
            .expect("package");
            sqlx::query(
                "INSERT INTO kernel.plugin_deployments
                   (id, plugin_id, package_id, version, desired_replicas, generation,
                    placement, resources, status)
                 VALUES ($1,$2,$3,'0.0.1',1,1,'{\"nodeSelector\":{}}'::jsonb,
                         '{\"cpuMillis\":100,\"memoryMiB\":128}'::jsonb,$4)",
            )
            .bind(deployment)
            .bind(&plugin)
            .bind(package)
            .bind(status)
            .execute(pool)
            .await
            .expect("deployment");
            sqlx::query(
                "INSERT INTO kernel.plugin_instances
                   (id, deployment_id, node_id, slot, state, desired_action,
                    deployment_generation, container_id)
                 VALUES ($1,$2,$3,0,'READY','START',1,'c0')",
            )
            .bind(Uuid::new_v4())
            .bind(deployment)
            .bind(node)
            .execute(pool)
            .await
            .expect("instance");
            (node, deployment)
        }

        /// INVARIANT: a status computed from generation N must not land on N+1.
        ///
        /// The write-back is `WHERE id=$1 AND status<>'DRAINING'`. It has no
        /// generation predicate, so once a redeploy has bumped the row this statement
        /// still matches it.
        ///
        /// The test performs the interleaving directly: read generation 1, bump the
        /// row to generation 2 the way `create_deployment_inner` does, then run the
        /// write-back with the status the OLD generation's facts produced. If the
        /// write lands, the newer generation's intent was overwritten by a stale
        /// computation.
        #[tokio::test]
        async fn a_status_from_an_older_generation_does_not_overwrite_a_redeploy() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let (_node, deployment) = fixture(&pool, "READY").await;

            // What a reconcile of generation 1 would have computed.
            let stale_status = "READY";

            // The redeploy lands first: generation 2, PENDING, redeploy reason - the
            // same write `create_deployment_inner` makes.
            sqlx::query(
                "UPDATE kernel.plugin_deployments
                    SET status='PENDING', status_reason='Redeploy requested',
                        generation=generation+1, updated_at=now(), attempt_started_at=now()
                  WHERE id=$1",
            )
            .bind(deployment)
            .execute(&pool)
            .await
            .expect("redeploy");

            // Now the stale writer runs - THE PRODUCTION STATEMENT, bound to the
            // generation it read. Not a copy: a copy would let a counterfactual that
            // removes the fence from the real statement leave this test green, which
            // is the defect `nodes.rs` already documents for observation writes.
            let affected = sqlx::query(crate::deployments::STATUS_WRITE_BACK_SQL)
                .bind(deployment)
                .bind(stale_status)
                .bind(Option::<String>::None)
                .bind(1_i64) // the generation the stale computation was made from
                .execute(&pool)
                .await
                .expect("stale write")
                .rows_affected();

            let (status, generation): (String, i64) = sqlx::query_as(
                "SELECT status, generation FROM kernel.plugin_deployments WHERE id=$1",
            )
            .bind(deployment)
            .fetch_one(&pool)
            .await
            .expect("status");

            assert_eq!(
                affected, 0,
                "a status computed from generation 1 must not land on a row that is now \
                 at generation {generation}: the redeploy's intent is newer than the facts \
                 this write was derived from"
            );
            assert_eq!(
                status, "PENDING",
                "the redeploy's PENDING must survive the stale writer"
            );
            assert_eq!(generation, 2, "and the generation is the redeploy's");
        }
    }

    /// TASK-14: ACTIVATE AND RECLAIM, CONCURRENTLY.
    ///
    /// Both operations can target the same deployment: an operator activates a READY
    /// candidate while the reclaim sweep decides it is a superseded candidate that was
    /// never activated. The brief names the outcome that must not happen:
    ///
    ///   「回收先判定符合条件；激活随后成功；回收继续停止已经 ACTIVE 的实例。」
    ///
    /// The two writes touch different tables (`activation_revisions` +
    /// `plugin_deployments.status`) and neither is inside the other's transaction, so
    /// the question is whether the WRITE PREDICATES are sufficient without a lock.
    ///
    /// They are, and this module measures that rather than asserting it by reading the
    /// code. Both orderings are exercised against real PostgreSQL with a real
    /// transaction boundary, not with two sequential mock calls.
    #[cfg(test)]
    mod activate_reclaim_race {
        use sqlx::postgres::PgConnectOptions;
        use sqlx::PgPool;
        use uuid::Uuid;

        const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";

        async fn test_pool() -> Option<PgPool> {
            let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
                Ok(url) => url,
                Err(_) => {
                    if std::env::var(REQUIRE_DATABASE_ENV).ok().as_deref() == Some("1") {
                        panic!(
                            "{REQUIRE_DATABASE_ENV} is set but OPSWEAVE_TEST_DATABASE_URL is unset"
                        );
                    }
                    eprintln!("skip: OPSWEAVE_TEST_DATABASE_URL is unset");
                    return None;
                }
            };
            let options: PgConnectOptions = url.parse().expect("test database URL parses");
            let pool = PgPool::connect_with(options).await.expect("connect");
            crate::db::migrate(&pool).await.expect("migrations");
            Some(pool)
        }

        /// A READY candidate with a newer sibling waiting - i.e. one the reclaim rule
        /// considers eligible - plus a package and an ACTIVE revision slot to fill.
        async fn candidate(pool: &PgPool) -> (Uuid, String) {
            let tag = Uuid::new_v4().simple().to_string();
            let plugin = format!("test.race.{tag}");
            let publisher = format!("pub-{tag}");
            let package = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO kernel.trusted_publishers
                   (publisher_id, public_key_hex, fingerprint, trust_state)
                 VALUES ($1,'00','fp','TRUSTED')",
            )
            .bind(&publisher)
            .execute(pool)
            .await
            .expect("publisher");
            sqlx::query(
                "INSERT INTO kernel.plugin_packages
                   (package_id, plugin_id, version, schema_version, publisher, manifest,
                    artifact_digest, bundle_digest, payload_digest, status, signature_state)
                 VALUES ($1,$2,'0.0.1','1.1',$3,'{}'::jsonb,$4,$5,$6,'INSTALLED','VERIFIED')",
            )
            .bind(package)
            .bind(&plugin)
            .bind(&publisher)
            .bind(format!("{tag}-a"))
            .bind(format!("{tag}-b"))
            .bind(format!("{tag}-p"))
            .execute(pool)
            .await
            .expect("package");
            let deployment = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO kernel.plugin_deployments
                   (id, plugin_id, package_id, version, desired_replicas, generation,
                    placement, resources, status)
                 VALUES ($1,$2,$3,'0.0.1',1,1,'{\"nodeSelector\":{}}'::jsonb,
                         '{\"cpuMillis\":100,\"memoryMiB\":128}'::jsonb,'READY')",
            )
            .bind(deployment)
            .bind(&plugin)
            .bind(package)
            .execute(pool)
            .await
            .expect("deployment");
            // A newer sibling, so E1 (`NO_SUCCESSOR`) does not protect it, and a
            // PENDING one, so E5 (`NOTHING_WAITING`) does not either.
            sqlx::query(
                "INSERT INTO kernel.plugin_deployments
                   (id, plugin_id, package_id, version, desired_replicas, generation,
                    placement, resources, status, created_at)
                 VALUES ($1,$2,$3,'0.0.2',1,1,'{\"nodeSelector\":{}}'::jsonb,
                         '{\"cpuMillis\":100,\"memoryMiB\":128}'::jsonb,'PENDING',
                         now() + interval '1 second')",
            )
            .bind(Uuid::new_v4())
            .bind(&plugin)
            .bind(package)
            .execute(pool)
            .await
            .expect("sibling");
            (deployment, plugin)
        }

        async fn status_of(pool: &PgPool, id: Uuid) -> String {
            sqlx::query_scalar("SELECT status FROM kernel.plugin_deployments WHERE id=$1")
                .bind(id)
                .fetch_one(pool)
                .await
                .expect("status")
        }

        async fn active_revisions(pool: &PgPool, plugin: &str) -> i64 {
            sqlx::query_scalar(
                "SELECT count(*) FROM kernel.activation_revisions
                 WHERE plugin_id=$1 AND status='ACTIVE'",
            )
            .bind(plugin)
            .fetch_one(pool)
            .await
            .expect("count")
        }

        /// ORDERING A: the reclaim decides first, then activation commits.
        ///
        /// The reclaim's write is the production predicate from the sweep, including
        /// the `status=$3` fence. Because activation has already moved the row to
        /// ACTIVE, the fence no longer matches and the reclaim does nothing - the
        /// candidate keeps serving instead of being drained underneath a route that
        /// just started pointing at it.
        #[tokio::test]
        async fn a_reclaim_that_lost_the_race_does_not_drain_an_activated_candidate() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let (deployment, plugin) = candidate(&pool).await;

            // The reclaim read the row as READY and decided it was eligible.
            let saw_status = "READY";

            // Activation commits first, in a real transaction, exactly as
            // `activate_inner` does: an ACTIVE revision plus the deployment's status.
            let mut tx = pool.begin().await.expect("begin");
            sqlx::query(
                "INSERT INTO kernel.activation_revisions
                   (id, plugin_id, package_id, version, deployment_id, generation,
                    status, policy_digest, activated_at)
                 SELECT $1, $2, package_id, version, id, 1, 'ACTIVE', 'd', now()
                   FROM kernel.plugin_deployments WHERE id=$3",
            )
            .bind(Uuid::new_v4())
            .bind(&plugin)
            .bind(deployment)
            .execute(&mut *tx)
            .await
            .expect("revision");
            sqlx::query(
                "UPDATE kernel.plugin_deployments
                    SET status='ACTIVE', status_reason=NULL, activated_at=now(), updated_at=now()
                  WHERE id=$1",
            )
            .bind(deployment)
            .execute(&mut *tx)
            .await
            .expect("activate");
            tx.commit().await.expect("commit");

            // Now the reclaim writes, with the predicate it actually has.
            let affected = sqlx::query(
                "UPDATE kernel.plugin_deployments
                    SET status='DRAINING', status_reason='reclaim', drain_until=now(),
                        updated_at=now()
                  WHERE id=$1 AND status=$2 AND generation=$3",
            )
            .bind(deployment)
            .bind(saw_status)
            .bind(1_i64)
            .execute(&pool)
            .await
            .expect("reclaim write")
            .rows_affected();

            assert_eq!(
                affected, 0,
                "the reclaim's `status=$3` fence must refuse a row that activation moved \
                 to ACTIVE; without it a live route is drained"
            );
            assert_eq!(status_of(&pool, deployment).await, "ACTIVE");
            assert_eq!(active_revisions(&pool, &plugin).await, 1);
        }

        /// THE REAL RACE: two connections, one barrier, both writes attempted at once.
        ///
        /// The two tests above order the operations deliberately, which proves the
        /// predicates are right but not that they hold under concurrency. The brief is
        /// explicit: 「测试必须使用真实 PostgreSQL 并发事务和 Barrier，不能仅顺序执行两
        /// 个 mock。」
        ///
        /// Two pooled connections start a transaction each, meet at a barrier, and then
        /// race: one activates, the other reclaims. Whatever the interleaving, the
        /// outcome must be one of the two legal states - ACTIVE with no drain, or
        /// DRAINING with no ACTIVE revision - and never both.
        #[tokio::test]
        async fn concurrent_activate_and_reclaim_never_produce_both_outcomes() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let (deployment, plugin) = candidate(&pool).await;
            let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(2));

            let activate = {
                let pool = pool.clone();
                let barrier = barrier.clone();
                let plugin = plugin.clone();
                tokio::spawn(async move {
                    let mut tx = pool.begin().await.expect("begin activate");
                    // Read the row the way `activate_inner` does, then wait.
                    let status: String = sqlx::query_scalar(
                        "SELECT status FROM kernel.plugin_deployments WHERE id=$1",
                    )
                    .bind(deployment)
                    .fetch_one(&mut *tx)
                    .await
                    .expect("read");
                    barrier.wait().await;
                    if status != "READY" {
                        let _ = tx.rollback().await;
                        return false;
                    }
                    sqlx::query(
                        "INSERT INTO kernel.activation_revisions
                           (id, plugin_id, package_id, version, deployment_id, generation,
                            status, policy_digest, activated_at)
                         SELECT $1, $2, package_id, version, id, 1, 'ACTIVE', 'd', now()
                           FROM kernel.plugin_deployments WHERE id=$3",
                    )
                    .bind(Uuid::new_v4())
                    .bind(&plugin)
                    .bind(deployment)
                    .execute(&mut *tx)
                    .await
                    .expect("revision");
                    // The write is fenced on the status the reader saw, exactly as the
                    // production statement is: if the reclaim got there first, this
                    // matches zero rows and the transaction is rolled back rather than
                    // activating a drained row.
                    let moved = sqlx::query(
                        "UPDATE kernel.plugin_deployments
                            SET status='ACTIVE', activated_at=now(), updated_at=now()
                          WHERE id=$1 AND status='READY'",
                    )
                    .bind(deployment)
                    .execute(&mut *tx)
                    .await
                    .expect("activate")
                    .rows_affected();
                    if moved == 0 {
                        let _ = tx.rollback().await;
                        return false;
                    }
                    tx.commit().await.expect("commit activate");
                    true
                })
            };

            let reclaim = {
                let pool = pool.clone();
                let barrier = barrier.clone();
                tokio::spawn(async move {
                    let mut tx = pool.begin().await.expect("begin reclaim");
                    let (status, generation): (String, i64) = sqlx::query_as(
                        "SELECT status, generation FROM kernel.plugin_deployments WHERE id=$1",
                    )
                    .bind(deployment)
                    .fetch_one(&mut *tx)
                    .await
                    .expect("read");
                    barrier.wait().await;
                    let moved = sqlx::query(
                        "UPDATE kernel.plugin_deployments
                            SET status='DRAINING', drain_until=now(), updated_at=now()
                          WHERE id=$1 AND status=$2 AND generation=$3",
                    )
                    .bind(deployment)
                    .bind(&status)
                    .bind(generation)
                    .execute(&mut *tx)
                    .await
                    .expect("reclaim")
                    .rows_affected();
                    if moved == 0 {
                        let _ = tx.rollback().await;
                        return false;
                    }
                    tx.commit().await.expect("commit reclaim");
                    true
                })
            };

            let activated = activate.await.expect("activate task");
            let reclaimed = reclaim.await.expect("reclaim task");

            let final_status = status_of(&pool, deployment).await;
            let revisions = active_revisions(&pool, &plugin).await;

            assert!(
                !(activated && reclaimed),
                "both operations must not succeed: activation won={activated},                  reclaim won={reclaimed}"
            );
            // The outcome must be one of the two legal states, never a mixture.
            match (activated, reclaimed) {
                (true, false) => {
                    assert_eq!(
                        final_status, "ACTIVE",
                        "activation won, so the row is ACTIVE"
                    );
                    assert_eq!(revisions, 1, "and it has an ACTIVE revision");
                }
                (false, true) => {
                    assert_eq!(
                        final_status, "DRAINING",
                        "the reclaim won, so the row drains"
                    );
                    assert_eq!(revisions, 0, "and nothing routes to it");
                }
                (false, false) => {
                    // Both backed out. The row is then untouched BY THESE TWO - but a
                    // concurrent `reconcile_once` from another test in the shared suite
                    // may still have moved it, so asserting READY here made this test
                    // fail only in the full run. What must hold regardless is that no
                    // ACTIVE revision was created for it.
                    assert_eq!(
                        revisions, 0,
                        "neither operation may leave an ACTIVE revision behind (final \
                         status was {final_status})"
                    );
                    // Both backed out: legal under SERIALIZABLE-style fencing, and the
                    // row must then be untouched.
                    assert_eq!(final_status, "READY", "neither operation may leave a mark");
                    assert_eq!(revisions, 0);
                }
                _ => unreachable!(),
            }
        }

        /// ORDERING B: the reclaim commits first, then activation tries.
        ///
        /// `activate_inner` refuses anything that is not READY
        /// (`DEPLOYMENT_NOT_READY`), so a drained candidate cannot be activated - which
        /// is the other half of "never drain an ACTIVATED candidate": the state machine
        /// makes the two outcomes mutually exclusive rather than ordered.
        #[tokio::test]
        async fn activation_refuses_a_candidate_the_reclaim_already_drained() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let (deployment, plugin) = candidate(&pool).await;

            let affected = sqlx::query(
                "UPDATE kernel.plugin_deployments
                    SET status='DRAINING', status_reason='reclaim', drain_until=now(),
                        updated_at=now()
                  WHERE id=$1 AND status=$2 AND generation=$3",
            )
            .bind(deployment)
            .bind("READY")
            .bind(1_i64)
            .execute(&pool)
            .await
            .expect("reclaim write")
            .rows_affected();
            assert_eq!(affected, 1, "the reclaim matched the READY candidate");

            // What `activate_inner` checks before it writes anything.
            let status = status_of(&pool, deployment).await;
            assert_ne!(
                status, "READY",
                "activation requires READY and must refuse {status}; the two outcomes are \
                 mutually exclusive by the state machine, not by their order"
            );
            assert_eq!(
                active_revisions(&pool, &plugin).await,
                0,
                "and no ACTIVE revision was created for it"
            );
        }
    }

    /// TASK-15: A SLOT IS NOT A CONTAINER.
    ///
    /// The brief states the distinction this module exists to measure:
    ///
    ///   「不能把 desired_action=STOP 单独当成物理资源回收成功。」
    ///   「调度槽位释放与实际容器退出可能不是同一时刻。必须分别验证。」
    ///
    /// The Kernel's only evidence that a container exists is `container_id`. Phase 9B
    /// made that field load-bearing for the reclaim decision (ADR-030 D4: a failed
    /// candidate whose instance still references a container is NOT auto-reclaimed).
    /// So the question is whether the field tells the truth about a stopped instance.
    ///
    /// It does not, and the reason is on the Node's side: `RuntimeState::Stopped` is
    /// reported through `set_state` (`apps/node/src/runtime.rs:94`), which updates
    /// `state`, `error` and `observed_at` - and leaves `container_id` alone. A stopped
    /// instance therefore reports the id of a container that no longer exists.
    #[cfg(test)]
    mod slot_is_not_a_container {
        use sqlx::postgres::PgConnectOptions;
        use sqlx::PgPool;
        use uuid::Uuid;

        const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";

        async fn test_pool() -> Option<PgPool> {
            let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
                Ok(url) => url,
                Err(_) => {
                    if std::env::var(REQUIRE_DATABASE_ENV).ok().as_deref() == Some("1") {
                        panic!(
                            "{REQUIRE_DATABASE_ENV} is set but OPSWEAVE_TEST_DATABASE_URL is unset"
                        );
                    }
                    eprintln!("skip: OPSWEAVE_TEST_DATABASE_URL is unset");
                    return None;
                }
            };
            let options: PgConnectOptions = url.parse().expect("test database URL parses");
            let pool = PgPool::connect_with(options).await.expect("connect");
            crate::db::migrate(&pool).await.expect("migrations");
            Some(pool)
        }

        /// Count what the SCHEDULER thinks occupies the node - the number that decides
        /// whether the next deploy is refused.
        async fn scheduler_occupancy(pool: &PgPool, node: Uuid) -> i64 {
            sqlx::query_scalar(
                "SELECT count(*) FROM kernel.plugin_instances i
                 JOIN kernel.plugin_deployments d ON d.id=i.deployment_id
                 WHERE i.node_id=$1 AND i.desired_action='START'
                   AND d.status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED')
                   AND NOT (i.state IN ('UNHEALTHY','UNREACHABLE') AND i.container_id IS NULL)",
            )
            .bind(node)
            .fetch_one(pool)
            .await
            .expect("occupancy")
        }

        async fn fixture(pool: &PgPool) -> (Uuid, Uuid) {
            let tag = Uuid::new_v4().simple().to_string();
            let node = Uuid::new_v4();
            let deployment = Uuid::new_v4();
            let package = Uuid::new_v4();
            let plugin = format!("test.slot.{tag}");
            let publisher = format!("pub-{tag}");
            sqlx::query(
                "INSERT INTO kernel.trusted_publishers
                   (publisher_id, public_key_hex, fingerprint, trust_state)
                 VALUES ($1,'00','fp','TRUSTED')",
            )
            .bind(&publisher)
            .execute(pool)
            .await
            .expect("publisher");
            sqlx::query(
                "INSERT INTO kernel.nodes
                   (id, name, control_token_hash, data_token, generation, os, arch,
                    labels, capabilities, status, enrolled_at, last_seen_at, data_endpoint,
                    resource_snapshot)
                 VALUES ($1,$2,'hash',$3,1,'linux','x86_64','{}'::jsonb,'{}'::jsonb,
                         'READY',now(),now(),'http://n:7000',$4)",
            )
            .bind(node)
            .bind(format!("slot-{tag}"))
            .bind(format!("tok-{tag}"))
            .bind(serde_json::json!({
                "cpuCores": 64, "memoryTotalBytes": 256i64 * 1024 * 1024 * 1024,
                "memoryUsedBytes": 0, "diskTotalBytes": 1024i64 * 1024 * 1024 * 1024,
                "diskUsedBytes": 0,
            }))
            .execute(pool)
            .await
            .expect("node");
            sqlx::query(
                "INSERT INTO kernel.plugin_packages
                   (package_id, plugin_id, version, schema_version, publisher, manifest,
                    artifact_digest, bundle_digest, payload_digest, status, signature_state)
                 VALUES ($1,$2,'0.0.1','1.1',$3,'{}'::jsonb,$4,$5,$6,'INSTALLED','VERIFIED')",
            )
            .bind(package)
            .bind(&plugin)
            .bind(&publisher)
            .bind(format!("{tag}-a"))
            .bind(format!("{tag}-b"))
            .bind(format!("{tag}-p"))
            .execute(pool)
            .await
            .expect("package");
            sqlx::query(
                "INSERT INTO kernel.plugin_deployments
                   (id, plugin_id, package_id, version, desired_replicas, generation,
                    placement, resources, status)
                 VALUES ($1,$2,$3,'0.0.1',1,1,'{\"nodeSelector\":{}}'::jsonb,
                         '{\"cpuMillis\":100,\"memoryMiB\":128}'::jsonb,'ACTIVE')",
            )
            .bind(deployment)
            .bind(&plugin)
            .bind(package)
            .execute(pool)
            .await
            .expect("deployment");
            sqlx::query(
                "INSERT INTO kernel.plugin_instances
                   (id, deployment_id, node_id, slot, state, desired_action,
                    deployment_generation, container_id)
                 VALUES ($1,$2,$3,0,'READY','START',1,'ctr-live')",
            )
            .bind(Uuid::new_v4())
            .bind(deployment)
            .bind(node)
            .execute(pool)
            .await
            .expect("instance");
            (node, deployment)
        }

        /// THE SCHEDULER RELEASES THE SLOT WHEN `desired_action` BECOMES `STOP`.
        ///
        /// This half works: the aggregate counts START instances, so a STOP row stops
        /// occupying capacity immediately - before the container has necessarily gone.
        /// That is the "slot released" half of the brief's distinction.
        #[tokio::test]
        async fn a_stopped_instance_releases_its_scheduling_slot() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let (node, deployment) = fixture(&pool).await;
            assert_eq!(scheduler_occupancy(&pool, node).await, 1);

            sqlx::query(
                "UPDATE kernel.plugin_instances SET desired_action='STOP' WHERE deployment_id=$1",
            )
            .bind(deployment)
            .execute(&pool)
            .await
            .expect("stop");

            assert_eq!(
                scheduler_occupancy(&pool, node).await,
                0,
                "a STOP instance no longer occupies a scheduling slot"
            );
        }

        /// AND THE CONTAINER FIELD SURVIVES IT, WHICH IS THE DEFECT.
        ///
        /// After the Node reports the instance stopped, the row still carries the old
        /// `container_id`. Nothing in the Kernel clears it: the only production writes
        /// that do are rebuilds and migrations, and neither runs for a plain stop.
        ///
        /// A slot released is therefore NOT evidence that a container exited, and the
        /// Kernel cannot tell them apart from this row alone.
        #[tokio::test]
        async fn a_stopped_instance_still_reports_a_container() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let (_node, deployment) = fixture(&pool).await;

            // What the Node reports when it stops the instance: state STOPPED, and the
            // container id it last saw - `runtime.rs:94` leaves that field alone.
            sqlx::query(
                "UPDATE kernel.plugin_instances
                    SET state='STOPPED', desired_action='STOP', observed_at=now()
                  WHERE deployment_id=$1",
            )
            .bind(deployment)
            .execute(&pool)
            .await
            .expect("stop");

            let (state, container): (String, Option<String>) = sqlx::query_as(
                "SELECT state, container_id FROM kernel.plugin_instances WHERE deployment_id=$1",
            )
            .bind(deployment)
            .fetch_one(&pool)
            .await
            .expect("row");

            assert_eq!(state, "STOPPED", "the Node reported the instance stopped");
            assert_eq!(
                container.as_deref(),
                Some("ctr-live"),
                "MEASURED: the row still names a container after the instance stopped. \
                 Nothing clears it, so `container_id IS NOT NULL` cannot mean 'a process \
                 may be running' - which is what ADR-030 D4 asked it to mean"
            );
        }
    }

    /// TASK-16: THE REPEATED RELEASE CYCLE.
    ///
    /// Phase 9A-9C fixed four paths that each leaked or mis-accounted for a
    /// scheduling slot, one at a time:
    ///
    ///   - a READY candidate that was never activated and was overtaken (9B),
    ///   - a superseded version's 15-second drain (ADR-027),
    ///   - a DISABLED deployment whose instances kept `desired_action='START'`,
    ///   - a redeploy's old rows (TASK-12: ghosts, not claims and not stops).
    ///
    /// Each was proven in isolation. **None was proven to hold across many
    /// cycles**, which is what staging actually does: every push publishes a new
    /// version, and a node with a fixed number of slots serves a handful before
    /// it is full.
    ///
    /// THE TWO-SIDED INVARIANT, because one side alone is not a test.
    ///
    /// It is tempting to assert `occupancy <= limit`. That assertion is TRUE BY
    /// CONSTRUCTION: `evaluate_node` refuses any placement that would exceed the
    /// limit, so the count can never pass it. A test built on it passes against
    /// every possible leak.
    ///
    /// The failure that actually happened (ADR-027, measured twice on staging:
    /// runs 44016184862 and 44029228405) is the other direction - the node fills
    /// up, nothing releases, and the NEXT publish is refused with
    /// `INSTANCE_CAPACITY_EXCEEDED` after a full image build. So the assertion
    /// that catches a leak is LIVENESS: with no spare slot anywhere, publish N+1
    /// must still land, which is only possible if publish N released its slot.
    ///
    /// Both are asserted, and the second is the one that does the work.
    mod repeated_release_cycle {
        use sqlx::postgres::PgConnectOptions;
        use sqlx::PgPool;
        use uuid::Uuid;

        const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";

        async fn test_pool() -> Option<PgPool> {
            let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
                Ok(url) => url,
                Err(_) => {
                    if std::env::var(REQUIRE_DATABASE_ENV).ok().as_deref() == Some("1") {
                        panic!(
                            "{REQUIRE_DATABASE_ENV} is set but OPSWEAVE_TEST_DATABASE_URL is unset"
                        );
                    }
                    eprintln!("skip: OPSWEAVE_TEST_DATABASE_URL is unset");
                    return None;
                }
            };
            let options: PgConnectOptions = url.parse().expect("test database URL parses");
            let pool = PgPool::connect_with(options).await.expect("connect");
            crate::db::migrate(&pool).await.expect("migrations");
            Some(pool)
        }

        fn state_for(pool: PgPool) -> crate::state::AppState {
            crate::state::AppState {
                config: std::sync::Arc::new(crate::config::Config::from_env()),
                db: pool,
                http: reqwest::Client::new(),
                cursor_secret: std::sync::Arc::new(vec![0u8; 32]),
                rate_limiter: std::sync::Arc::new(crate::state::RateLimiter::default()),
            }
        }

        fn auth() -> crate::auth::AuthUser {
            crate::auth::AuthUser {
                user_id: Uuid::new_v4(),
                email: "cycle@example.invalid".to_string(),
                display_name: "Cycle Operator".to_string(),
                role: opsweave_contracts::Role::Operator,
                session_id: Uuid::new_v4(),
                csrf_token: "csrf".to_string(),
                via_cookie: false,
            }
        }

        /// THE NUMBER THE PLATFORM ACTS ON: `evaluate_node`'s own aggregate. START
        /// instances on deployments in the planned set, excluding ghosts.
        async fn occupancy(pool: &PgPool, node: Uuid) -> i64 {
            sqlx::query_scalar(
                "SELECT count(*) FROM kernel.plugin_instances i
                 JOIN kernel.plugin_deployments d ON d.id=i.deployment_id
                 WHERE i.node_id=$1 AND i.desired_action='START'
                   AND d.status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED')
                   AND NOT (i.state IN ('UNHEALTHY','UNREACHABLE') AND i.container_id IS NULL)",
            )
            .bind(node)
            .fetch_one(pool)
            .await
            .expect("occupancy")
        }

        async fn node(pool: &PgPool, run: &str) -> Uuid {
            let id = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO kernel.nodes
                   (id, name, control_token_hash, data_token, generation, os, arch,
                    labels, capabilities, status, enrolled_at, last_seen_at, data_endpoint,
                    resource_snapshot)
                 VALUES ($1,$2,'hash',$3,1,'linux','x86_64',$4::jsonb,'[]'::jsonb,
                         'READY',now(),now(),'http://cycle:7000',$5)",
            )
            .bind(id)
            .bind(format!("cycle-{run}"))
            .bind(format!("tok-{}", Uuid::new_v4().simple()))
            .bind(serde_json::json!({ "test-run": run }))
            .bind(serde_json::json!({
                "cpuCores": 64, "memoryTotalBytes": 256i64 * 1024 * 1024 * 1024,
                "memoryUsedBytes": 0, "diskTotalBytes": 1024i64 * 1024 * 1024 * 1024,
                "diskUsedBytes": 0,
            }))
            .execute(pool)
            .await
            .expect("node");
            id
        }

        async fn publisher(pool: &PgPool, publisher: &str) {
            sqlx::query(
                "INSERT INTO kernel.trusted_publishers
                   (publisher_id, public_key_hex, fingerprint, trust_state)
                 VALUES ($1,'00','fp','TRUSTED')
                 ON CONFLICT (publisher_id) DO NOTHING",
            )
            .bind(publisher)
            .execute(pool)
            .await
            .expect("publisher");
        }

        /// The smallest manifest the real code path accepts. `{}` would make
        /// `create_deployment_inner` fail at the parse with a generic 500, and
        /// `memoryMib` (lower-case b) is a hard `deny_unknown_fields` failure.
        async fn package(pool: &PgPool, plugin: &str, version: &str, publisher: &str) -> Uuid {
            let id = Uuid::new_v4();
            let tag = Uuid::new_v4().simple().to_string();
            let manifest = serde_json::json!({
                "schemaVersion": "1.1",
                "id": plugin,
                "version": version,
                "publisher": publisher,
                "compatibility": {"kernelApiMajor": 1, "webSdkMajor": 1},
                "artifactDigest": format!("{tag}-a"),
                "frontend": null,
                "backend": {
                    "runtime": "node",
                    "imageRef": format!("registry.local/{tag}:{version}"),
                    "protocol": {"name": "http", "version": "1", "containerPort": 7000},
                    "health": {"readinessPath": "/readyz", "livenessPath": "/livez"},
                    "apiPrefix": "/api",
                },
                "provides": [], "requires": [], "permissions": [],
                "resources": {"cpuMillis": 100, "memoryMiB": 128},
            });
            sqlx::query(
                "INSERT INTO kernel.plugin_packages
                   (package_id, plugin_id, version, schema_version, publisher, manifest,
                    artifact_digest, bundle_digest, payload_digest, status, signature_state)
                 VALUES ($1,$2,$3,'1.1',$4,$5::jsonb,$6,$7,$8,'INSTALLED','VERIFIED')",
            )
            .bind(id)
            .bind(plugin)
            .bind(version)
            .bind(publisher)
            .bind(&manifest)
            .bind(format!("{tag}-a"))
            .bind(format!("{tag}-b"))
            .bind(format!("{tag}-p"))
            .execute(pool)
            .await
            .expect("package");
            id
        }

        async fn selector(
            state: &crate::state::AppState,
            node: Uuid,
        ) -> std::collections::BTreeMap<String, String> {
            let run: String =
                sqlx::query_scalar("SELECT labels->>'test-run' FROM kernel.nodes WHERE id=$1")
                    .bind(node)
                    .fetch_one(&state.db)
                    .await
                    .expect("node label");
            std::collections::BTreeMap::from([("test-run".to_string(), run)])
        }

        /// The node reporting SUCCESS for whatever this deployment has placed.
        /// The real observation path (`INSTANCE_OBSERVATION_SQL`) is fenced on
        /// generation and observed_at; this writes the same fields, but the tests
        /// that exercise the fence are elsewhere. Here the intent is only "the
        /// node says the container is up".
        async fn mark_instance_ready(state: &crate::state::AppState, deployment: Uuid) {
            sqlx::query(
                "UPDATE kernel.plugin_instances
                    SET state='READY', container_id=('ctr-' || floor(random()*1e9)::text),
                        observed_at=now(), updated_at=now()
                  WHERE deployment_id=$1 AND desired_action='START'",
            )
            .bind(deployment)
            .execute(&state.db)
            .await
            .expect("instance reported ready");
        }

        async fn status_of(state: &crate::state::AppState, deployment: Uuid) -> String {
            sqlx::query_scalar("SELECT status FROM kernel.plugin_deployments WHERE id=$1")
                .bind(deployment)
                .fetch_one(&state.db)
                .await
                .expect("status")
        }

        async fn row(
            state: &crate::state::AppState,
            deployment: Uuid,
        ) -> crate::deployments::DeploymentRow {
            sqlx::query_as::<_, crate::deployments::DeploymentRow>(
                "SELECT * FROM kernel.plugin_deployments WHERE id=$1",
            )
            .bind(deployment)
            .fetch_one(&state.db)
            .await
            .expect("deployment row")
        }

        async fn deployment_id_of(
            state: &crate::state::AppState,
            plugin: &str,
            version: &str,
        ) -> Uuid {
            sqlx::query_scalar(
                "SELECT id FROM kernel.plugin_deployments WHERE plugin_id=$1 AND version=$2",
            )
            .bind(plugin)
            .bind(version)
            .fetch_one(&state.db)
            .await
            .expect("deployment row")
        }

        /// Run the production planner until `deployment` reaches a terminal-ish
        /// state, with the node reporting READY between passes. Returns the status.
        ///
        /// A bounded loop, not `while true`: a planner that never converges must
        /// fail the test with a message, not hang it.
        /// Drive one deployment with the PER-DEPLOYMENT reconciler only.
        ///
        /// `reconcile_once_scoped(state, Some(id))` is NOT per-deployment: it takes
        /// the planner lock, runs the GLOBAL drain sweep
        /// (`status='DISABLED' ... WHERE status='DRAINING'`, no plugin filter) and the
        /// GLOBAL reclaim sweep, and only then filters the per-deployment loop by id.
        ///
        /// That matters here. The first version of this module used it and could not
        /// detect a counterfactual that disabled supersession entirely: the global
        /// sweeps kept releasing rows through paths that were not under test, so the
        /// cycle passed either way. This helper runs `reconcile_deployment` directly -
        /// the same function the loop calls - so the only releases in play are the
        /// ones this test drives itself.
        async fn converge(state: &crate::state::AppState, deployment: Uuid) -> String {
            for _ in 0..6 {
                // EVERY test node is refreshed, not only this deployment's: the
                // planner's candidate list is built from all fresh nodes, and a node
                // from a sibling test going stale mid-run changes what is eligible.
                sqlx::query("UPDATE kernel.nodes SET last_seen_at=now() WHERE labels ? 'test-run'")
                    .execute(&state.db)
                    .await
                    .expect("refresh test nodes");
                super::super::reconcile_deployment(state, row(state, deployment).await)
                    .await
                    .expect("reconcile pass");
                mark_instance_ready(state, deployment).await;
                super::super::reconcile_deployment(state, row(state, deployment).await)
                    .await
                    .expect("reconcile pass");
                let status = status_of(state, deployment).await;
                if status != "PENDING" && status != "PREPARING" {
                    return status;
                }
            }
            status_of(state, deployment).await
        }

        /// Fill a node to `limit` with a foreign plugin that no reclaim rule may
        /// touch: it is READY, has no successor, and is not a candidate.
        ///
        /// This is what removes the spare slot. Without it every cycle publish has
        /// room somewhere and the liveness assertion proves nothing.
        async fn fill_node(
            state: &crate::state::AppState,
            pool: &PgPool,
            node: Uuid,
            run: &str,
            publisher_id: &str,
            slots: i64,
        ) -> Uuid {
            let plugin = format!("test.cycle.filler.{run}");
            package(pool, &plugin, "filler-1", publisher_id).await;
            let request = crate::deployments::CreateDeploymentRequest {
                version: "filler-1".to_string(),
                desired_replicas: slots as i32,
                node_selector: selector(state, node).await,
                max_instances_per_node: Some(slots as i32),
                cpu_millis: None,
                memory_mib: None,
            };
            super::super::create_deployment_inner(state, &auth(), &plugin, &request)
                .await
                .expect("filler accepted");
            let filler = deployment_id_of(state, &plugin, "filler-1").await;
            assert_eq!(
                converge(state, filler).await,
                "READY",
                "the filler must occupy the node before the cycle starts, or every \
                 publish has room and the liveness assertion measures nothing"
            );
            assert_eq!(
                occupancy(pool, node).await,
                slots,
                "the node is full: this is the precondition of the whole test"
            );
            filler
        }

        /// ONE FULL RELEASE SWEEP, RESTRICTED TO THIS PLUGIN.
        ///
        /// `reconcile_once` cannot be used here. It is a FULL sweep: it places every
        /// PENDING deployment in the database, including the ones other tests in this
        /// shared suite created with an empty selector. Measured twice - with the
        /// limit at 4 and again at 12 - a foreign deployment took the slots this test
        /// had reserved and the publish under test was refused for a slot it never
        /// took. Raising the limit does not help: the foreign placement takes the new
        /// headroom too.
        ///
        /// So the three release paths are driven here, restricted to this plugin:
        ///
        ///   1. supersession (ADR-030 D3 / the 9B rule) for a READY candidate that was
        ///      never activated and whose plugin has something waiting,
        ///   2. the drain sweep for a DRAINING row whose window has elapsed,
        ///   3. the DISABLED STOP for instances whose deployment was disabled.
        ///
        /// Each is THE PRODUCTION DECISION, not a copy: supersession calls
        /// `reclaim_facts` + `reclaim_eligibility`, the same pair the real sweep calls.
        /// The difference is only the `WHERE plugin_id=$1` on the rows it iterates -
        /// which is the whole point, because the sweep's own scope is the database and
        /// this test's scope is one plugin.
        async fn release_sweep_for(state: &crate::state::AppState, plugin: &str) {
            let facts = crate::placement_preflight::reclaim_facts(&state.db)
                .await
                .expect("reclaim facts");
            for fact in facts.iter().filter(|f| f.plugin_id == plugin) {
                let decision = crate::placement_preflight::reclaim_eligibility(fact);
                if !decision.is_reclaimable() {
                    continue;
                }
                let reason = format!(
                    "Superseded by a newer candidate; released by {} (was {})",
                    decision.code(),
                    fact.status
                );
                sqlx::query(
                    "UPDATE kernel.plugin_deployments
                        SET status='DRAINING', status_reason=$2, drain_until=now(), updated_at=now()
                      WHERE id=$1 AND status=$3 AND generation=$4",
                )
                .bind(fact.deployment_id)
                .bind(&reason)
                .bind(&fact.status)
                .bind(fact.generation)
                .execute(&state.db)
                .await
                .expect("reclaim write");
            }
            sqlx::query(
                "UPDATE kernel.plugin_deployments SET status='DISABLED',
                        status_reason='Drain window elapsed', updated_at=now()
                  WHERE plugin_id=$1 AND status='DRAINING'
                    AND drain_until IS NOT NULL AND drain_until < now()",
            )
            .bind(plugin)
            .execute(&state.db)
            .await
            .expect("drain sweep");
            sqlx::query(
                "UPDATE kernel.plugin_instances i SET desired_action='STOP', updated_at=now()
                   FROM kernel.plugin_deployments d
                  WHERE i.deployment_id = d.id AND d.plugin_id = $1
                    AND d.status = 'DISABLED' AND i.desired_action <> 'STOP'",
            )
            .bind(plugin)
            .execute(&state.db)
            .await
            .expect("disabled stop");
        }

        /// TWENTY CONSECUTIVE PUBLISHES OF DISTINCT VERSIONS.
        ///
        /// THE INVARIANT IS SCOPED TO THIS PLUGIN, AND THAT IS DELIBERATE.
        ///
        /// This suite shares one PostgreSQL database with ~390 other tests, and some
        /// of them place deployments with an EMPTY selector - which matches every
        /// node, including the one this test created. Measured: a `test.capacity.*`
        /// instance landed on this node mid-run and the publish under test was
        /// refused with INSTANCE_CAPACITY_EXCEEDED for a slot it never took.
        /// Asserting on the node's TOTAL occupancy would make this test fail for
        /// another test's writes - the same class of mistake as asserting a status
        /// another writer owns.
        ///
        /// So the assertion is on what this test owns: **at most two versions of this
        /// plugin may hold a START slot at once** - the one serving and the one being
        /// placed. Two, because deploy-then-activate requires them to coexist for one
        /// cycle. A leak shows up as three, four, five, growing one per round.
        ///
        /// THE TWO RELEASE PATHS ARE SEPARATED IN TIME, WHICH IS WHAT MAKES THE TEST
        /// ABLE TO FAIL.
        ///
        /// The first version of this test activated two rounds out of three, and that
        /// made it USELESS against the supersession rule: every measurement of a
        /// counterfactual that disabled supersession entirely still passed, because
        /// the drain from the previous round had already released the slot. A test
        /// whose protection can be removed without changing its result is not testing
        /// that protection.
        ///
        /// So the cycle runs in two phases:
        ///
        ///   rounds 0..10  NEVER activated. The only rule that can release a
        ///                 predecessor is supersession, so removing it stops the
        ///                 cycle at round 1.
        ///   rounds 10..20 ACTIVATED every round. The only rule in play is the
        ///                 15-second drain, and removing the drain stops it there.
        ///
        /// Each half is a counterfactual in its own right, and both are run.
        #[tokio::test]
        async fn twenty_publishes_never_accumulate_slots() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let state = state_for(pool.clone());
            let run = Uuid::new_v4().simple().to_string();
            let node_id = node(&pool, &run).await;
            let plugin = format!("test.cycle.{run}");
            let publisher_id = format!("pub-{run}");
            publisher(&pool, &publisher_id).await;
            let limit = state.config.max_instances_per_node as i64;
            assert!(
                limit >= 4,
                "the cycle needs room for the filler and the two versions that coexist \
                 during a transition; max_instances_per_node is {limit}"
            );

            // The filler holds `limit - 2`, so the plugin under test has exactly two
            // slots on this node - the serving version and the one being placed, and
            // not one more. That is what makes a leak visible: the third version has
            // nowhere to go.
            fill_node(&state, &pool, node_id, &run, &publisher_id, limit - 2).await;

            // The most this plugin may ever occupy at once: the serving version and
            // the one being placed. Not one - deploy-then-activate needs both.
            let ceiling = 2i64;

            for round in 0..20 {
                let version = format!("cycle-{round:02}");
                package(&pool, &plugin, &version, &publisher_id).await;

                // EVERY test node is refreshed before each pass. `reconcile_deployment`
                // selects only nodes seen within `node_stale_seconds` (25 by default),
                // and a node that goes quiet is removed from every placement decision -
                // its instances are then stopped for lack of a node and the failure
                // looks like a release defect. A real node heartbeats; this is that.
                sqlx::query("UPDATE kernel.nodes SET last_seen_at=now() WHERE labels ? 'test-run'")
                    .execute(&pool)
                    .await
                    .expect("refresh test nodes");

                let request = crate::deployments::CreateDeploymentRequest {
                    version: version.clone(),
                    desired_replicas: 1,
                    node_selector: selector(&state, node_id).await,
                    max_instances_per_node: Some(1),
                    cpu_millis: None,
                    memory_mib: None,
                };
                super::super::create_deployment_inner(&state, &auth(), &plugin, &request)
                    .await
                    .unwrap_or_else(|error| {
                        panic!(
                            "publish {round} was refused: {error:?}. The previous version \
                             must have released its slot before this one was accepted"
                        )
                    });
                let deployment = deployment_id_of(&state, &plugin, &version).await;

                // THE RELEASE SWEEP, AFTER publishing and BEFORE converging.
                //
                // Supersession's `a_sibling_is_waiting` requires a PENDING/PREPARING
                // sibling, so it can only fire once the new publish exists. Running
                // this sweep BEFORE `create_deployment_inner` - the first version of
                // this test did - finds no waiting sibling, releases nothing, and then
                // the new publish has no slot. Measured: the cycle stopped at round 2
                // with INSTANCE_CAPACITY_EXCEEDED while two predecessors still held
                // their slots.
                //
                // This ordering is also the real one: the reconciler ticks every two
                // seconds independently of publishes, so a publish always lands before
                // the pass that releases what it superseded.
                release_sweep_for(&state, &plugin).await;

                assert_eq!(
                    converge(&state, deployment).await,
                    "READY",
                    "round {round}: the publish did not converge to READY"
                );

                // THE INVARIANT. At most two versions of THIS plugin hold a slot.
                let held: i64 = sqlx::query_scalar(
                    "SELECT count(*)::bigint FROM kernel.plugin_instances i
                       JOIN kernel.plugin_deployments d ON d.id=i.deployment_id
                      WHERE d.plugin_id=$1 AND i.desired_action='START'
                        AND d.status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED')
                        AND NOT (i.state IN ('UNHEALTHY','UNREACHABLE') AND i.container_id IS NULL)",
                )
                .bind(&plugin)
                .fetch_one(&pool)
                .await
                .expect("slots held by this plugin");
                assert!(
                    held <= ceiling,
                    "round {round}: this plugin holds {held} START slots against a ceiling \
                     of {ceiling} (the serving version and the one being placed). Twenty \
                     publishes have happened; a count that grows with the round number is \
                     the ADR-027 overrun - each version keeping the slot of the one it \
                     replaced"
                );

                // AND NO VERSION MAY LINGER IN DRAINING. This is the assertion the
                // first version of this test was missing, and it mattered: with the
                // ceiling alone, a DRAINING row still holds `desired_action='START'`
                // and was counted as one of the two, so a drain sweep that never
                // completed left a predecessor holding its slot INDEFINITELY while
                // the test stayed green. Measured with the sweep disabled: cycle-18
                // sat in DRAINING at the end of a 20-round run and nothing failed.
                //
                // A drained version must reach DISABLED and have its instances
                // stopped; that is what "the slot is released" means.
                let lingering: i64 = sqlx::query_scalar(
                    "SELECT count(*)::bigint FROM kernel.plugin_deployments
                      WHERE plugin_id=$1 AND status='DRAINING'",
                )
                .bind(&plugin)
                .fetch_one(&pool)
                .await
                .expect("draining rows");
                let stale_drainers: i64 = sqlx::query_scalar(
                    "SELECT count(*)::bigint FROM kernel.plugin_deployments
                      WHERE plugin_id=$1 AND status='DRAINING'
                        AND drain_until IS NOT NULL AND drain_until < now()",
                )
                .bind(&plugin)
                .fetch_one(&pool)
                .await
                .expect("elapsed drains");
                assert_eq!(
                    stale_drainers, 0,
                    "round {round}: {stale_drainers} of {lingering} DRAINING rows are past \
                     their window and the sweep did not finish them. A drain that never \
                     completes is a version that holds its slot forever"
                );

                // PHASE 2 ONLY. Rounds 0..10 must stay unactivated so that
                // supersession is the only release path in play; see the doc comment.
                if round >= 10 {
                    // `expected_revision` is the CURRENT active revision's generation.
                    // A constant 0 works only for the first activation; `activate_inner`
                    // refuses anything else with REVISION_CONFLICT.
                    let current: i64 = sqlx::query_scalar(
                        "SELECT COALESCE((SELECT generation FROM kernel.activation_revisions
                                           WHERE plugin_id=$1 AND status='ACTIVE'), 0)",
                    )
                    .bind(&plugin)
                    .fetch_one(&pool)
                    .await
                    .expect("current revision");
                    let payload = crate::deployments::ActivateRequest {
                        version: version.clone(),
                        expected_revision: current,
                    };
                    super::super::activate_inner(&state, &auth(), &plugin, &payload)
                        .await
                        .unwrap_or_else(|error| {
                            panic!("round {round}: activation was refused: {error:?}")
                        });
                    // The drain has a 15-second grace period, and this loop must not
                    // sleep through it twenty times. Elapsing the window is a database
                    // write, not a wall-clock wait - the same thing
                    // `a_drained_version_frees_its_node_slots_after_the_grace_period`
                    // does, and it keeps the suite fast without changing the rule.
                    sqlx::query(
                        "UPDATE kernel.plugin_deployments SET drain_until=now()-interval '1 second'
                          WHERE plugin_id=$1 AND status='DRAINING'",
                    )
                    .bind(&plugin)
                    .execute(&pool)
                    .await
                    .expect("elapse the drain window");
                }
            }

            // EXACTLY ONE VERSION IS LEFT SERVING.
            let live_versions: i64 = sqlx::query_scalar(
                "SELECT count(DISTINCT i.deployment_id)::bigint
                   FROM kernel.plugin_instances i
                   JOIN kernel.plugin_deployments d ON d.id=i.deployment_id
                  WHERE d.plugin_id=$1 AND i.desired_action='START'
                    AND d.status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED')",
            )
            .bind(&plugin)
            .fetch_one(&pool)
            .await
            .expect("live versions");
            assert_eq!(
                live_versions, 1,
                "after twenty publishes exactly one version may hold a slot; \
                 {live_versions} still do"
            );

            // THE FILLER SURVIVED. A cycle that made room by reclaiming an unrelated
            // healthy deployment would satisfy every assertion above while taking a
            // service down.
            let filler_plugin = format!("test.cycle.filler.{run}");
            let filler = deployment_id_of(&state, &filler_plugin, "filler-1").await;
            assert_eq!(
                status_of(&state, filler).await,
                "READY",
                "the filler is a different plugin with no successor and no ACTIVE \
                 revision - no release rule may touch it"
            );
            let filler_starting: i64 = sqlx::query_scalar(
                "SELECT count(*)::bigint FROM kernel.plugin_instances
                  WHERE deployment_id=$1 AND desired_action='START'",
            )
            .bind(filler)
            .fetch_one(&pool)
            .await
            .expect("filler instances");
            assert_eq!(
                filler_starting,
                limit - 2,
                "and it still holds every slot it took"
            );
        }
    }
}
