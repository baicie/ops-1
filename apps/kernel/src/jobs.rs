//! Durable typed-pipeline store, revision pinning and fenced jobs.
//!
//! PostgreSQL is the only durable authority. There is no process-local job
//! queue; every claim, heartbeat, checkpoint and result is a transaction.

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::pipeline::{
    digest_without_field, schema_catalog, trusted_registry, validate_pipeline, PipelineDefinition,
    PipelineExecutionPlan,
};
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, Row};
use uuid::Uuid;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineResponse {
    pub pipeline_id: String,
    pub revision: u32,
    pub digest: String,
    pub status: String,
    pub definition: PipelineDefinition,
    pub plan: PipelineExecutionPlan,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerIdentity {
    pub worker_id: String,
    pub node_id: Uuid,
    pub instance_id: Uuid,
    pub boot_id: Uuid,
    #[serde(default)]
    pub version: String,
}

#[derive(Debug, Clone)]
pub struct WorkerContext {
    pub node_id: Uuid,
    pub instance_id: Uuid,
    pub boot_id: Uuid,
    pub worker_id: String,
}

fn worker_header(headers: &HeaderMap, name: &str) -> AppResult<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .map(str::to_string)
        .ok_or_else(|| AppError::unauthorized(format!("missing {name}")))
}

async fn authenticate_worker_headers(
    state: &AppState,
    headers: &HeaderMap,
) -> AppResult<WorkerContext> {
    let node_id = Uuid::parse_str(&worker_header(headers, "x-opsweave-node-id")?)
        .map_err(|_| AppError::unauthorized("invalid node identity"))?;
    let instance_id = Uuid::parse_str(&worker_header(headers, "x-opsweave-instance-id")?)
        .map_err(|_| AppError::unauthorized("invalid instance identity"))?;
    let boot_id = Uuid::parse_str(&worker_header(headers, "x-opsweave-boot-id")?)
        .map_err(|_| AppError::unauthorized("invalid boot identity"))?;
    let worker_id = worker_header(headers, "x-opsweave-worker-id")?;
    let generation: i64 = worker_header(headers, "x-opsweave-node-generation")?
        .parse()
        .map_err(|_| AppError::unauthorized("invalid node generation"))?;
    let expected_worker = format!("n:{node_id}:i:{instance_id}:b:{boot_id}");
    if worker_id != expected_worker {
        return Err(AppError::forbidden(
            "workerId is not bound to node/instance",
        ));
    }
    let node = crate::nodes::authenticate_node(state, node_id, headers).await?;
    if node.revoked_at.is_some() || node.status != "READY" {
        return Err(AppError::forbidden("node is not READY"));
    }
    if node.generation != generation {
        return Err(AppError::conflict(
            "STALE_NODE_GENERATION",
            "node generation does not match",
        ));
    }
    let instance: Option<(String, String)> = sqlx::query_as(
        "SELECT state,desired_action FROM kernel.plugin_instances WHERE id=$1 AND node_id=$2",
    )
    .bind(instance_id)
    .bind(node_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((instance_state, desired_action)) = instance else {
        return Err(AppError::forbidden("instance is not assigned to this node"));
    };
    if instance_state != "READY" || desired_action != "START" {
        return Err(AppError::forbidden("instance is not READY"));
    }
    Ok(WorkerContext {
        node_id,
        instance_id,
        boot_id,
        worker_id,
    })
}

async fn authenticate_worker(
    state: &AppState,
    headers: &HeaderMap,
    body: &WorkerIdentity,
) -> AppResult<WorkerContext> {
    let trusted = authenticate_worker_headers(state, headers).await?;
    if body.node_id != trusted.node_id
        || body.instance_id != trusted.instance_id
        || body.boot_id != trusted.boot_id
        || body.worker_id != trusted.worker_id
    {
        return Err(AppError::forbidden(
            "worker declaration does not match trusted identity",
        ));
    }
    Ok(trusted)
}

async fn authenticate_worker_header_only(
    state: &AppState,
    headers: &HeaderMap,
) -> AppResult<WorkerContext> {
    authenticate_worker_headers(state, headers).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FenceRequest {
    pub lease_id: Uuid,
    pub fencing_sequence: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitJobRequest {
    pub pipeline_id: String,
    pub pipeline_revision: u32,
    #[serde(default)]
    pub input: Value,
    #[serde(default = "default_max_attempts")]
    pub max_attempts: i32,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: i32,
}

fn default_max_attempts() -> i32 {
    3
}
fn default_timeout() -> i32 {
    300
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub job_id: Uuid,
    pub pipeline_id: String,
    pub pipeline_revision: i32,
    pub status: String,
    pub current_fence: i64,
    pub current_lease_id: Option<Uuid>,
    pub attempts: i32,
    pub max_attempts: i32,
    pub last_error_code: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimResponse {
    pub lease_id: Uuid,
    pub job_id: Uuid,
    pub attempt_number: i32,
    pub fencing_sequence: i64,
    pub expires_at: DateTime<Utc>,
    pub worker_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRequest {
    pub lease_id: Uuid,
    pub fencing_sequence: i64,
    pub sequence: i64,
    pub input_cursor: Option<String>,
    pub state_digest: String,
    #[serde(default)]
    pub state: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRequest {
    pub lease_id: Uuid,
    pub fencing_sequence: i64,
    pub source_digest: String,
    pub source_length: i64,
    pub source: Value,
    pub etag: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotResponse {
    pub source_digest: String,
    pub source_length: i64,
    pub source: Value,
    pub etag: Option<String>,
    pub fetched_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultRequest {
    pub lease_id: Uuid,
    pub fencing_sequence: i64,
    pub status: String,
    #[serde(default)]
    pub output: Value,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub result_digest: Option<String>,
    pub receipt: Option<Value>,
    #[serde(default)]
    pub effects: Vec<Value>,
}

async fn validate_and_plan(
    definition: &mut PipelineDefinition,
) -> AppResult<PipelineExecutionPlan> {
    let definition_value = serde_json::to_value(&*definition)
        .map_err(|error| AppError::bad_request(error.to_string()))?;
    definition.digest = digest_without_field(&definition_value, "digest");
    let (registry, _) = trusted_registry()
        .map_err(|error| AppError::bad_request(format!("{}: {}", error.code, error.message)))?;
    let catalog = schema_catalog()
        .map_err(|error| AppError::bad_request(format!("{}: {}", error.code, error.message)))?;
    validate_pipeline(definition, &registry, &catalog)
        .map_err(|error| AppError::bad_request(format!("{}: {}", error.code, error.message)))
}

async fn load_revision(
    state: &AppState,
    pipeline_id: &str,
    revision: u32,
) -> AppResult<Option<PipelineResponse>> {
    let row = sqlx::query(
        "SELECT digest,definition,plan FROM kernel.pipeline_revisions WHERE pipeline_id=$1 AND revision=$2",
    )
    .bind(pipeline_id)
    .bind(revision as i32)
    .fetch_optional(&state.db)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let definition: PipelineDefinition = serde_json::from_value(row.get("definition"))
        .map_err(|error| AppError::internal(error.to_string()))?;
    let plan: PipelineExecutionPlan = serde_json::from_value(row.get("plan"))
        .map_err(|error| AppError::internal(error.to_string()))?;
    Ok(Some(PipelineResponse {
        pipeline_id: definition.pipeline_id.clone(),
        revision: definition.revision,
        digest: row.get("digest"),
        status: definition.status.clone(),
        definition,
        plan,
    }))
}

pub async fn create_pipeline(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(mut definition): Json<PipelineDefinition>,
) -> AppResult<Json<PipelineResponse>> {
    auth.require_operator()?;
    let plan = validate_and_plan(&mut definition).await?;
    if definition.status != "DRAFT" && definition.status != "PUBLISHED" {
        return Err(AppError::bad_request(
            "pipeline status must be DRAFT or PUBLISHED",
        ));
    }
    if let Some(existing) =
        load_revision(&state, &definition.pipeline_id, definition.revision).await?
    {
        if existing.digest == definition.digest {
            return Ok(Json(existing));
        }
        return Err(AppError::conflict(
            "PIPELINE_REVISION_IMMUTABLE",
            "revision already exists with a different digest",
        ));
    }
    let definition_value = serde_json::to_value(&definition)
        .map_err(|error| AppError::bad_request(error.to_string()))?;
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO kernel.pipeline_definitions (pipeline_id,latest_revision) VALUES ($1,0)
         ON CONFLICT (pipeline_id) DO NOTHING",
    )
    .bind(&definition.pipeline_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO kernel.pipeline_revisions (pipeline_id,revision,digest,definition,plan,status)
         VALUES ($1,$2,$3,$4,$5,'PUBLISHED')",
    )
    .bind(&definition.pipeline_id)
    .bind(definition.revision as i32)
    .bind(&definition.digest)
    .bind(&definition_value)
    .bind(serde_json::to_value(&plan).unwrap_or(Value::Null))
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE kernel.pipeline_definitions SET latest_revision=GREATEST(latest_revision,$2),updated_at=now() WHERE pipeline_id=$1",
    )
    .bind(&definition.pipeline_id)
    .bind(definition.revision as i32)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let _ = crate::audit::record(
        &state.db,
        "pipeline.created",
        "USER",
        &auth.user_id.to_string(),
        "pipeline",
        &definition.pipeline_id,
        "create",
        "ACCEPTED",
        json!({"revision": definition.revision, "digest": definition.digest}),
        None,
    )
    .await;
    Ok(Json(PipelineResponse {
        pipeline_id: definition.pipeline_id.clone(),
        revision: definition.revision,
        digest: definition.digest.clone(),
        status: definition.status.clone(),
        definition,
        plan,
    }))
}

pub async fn publish_revision(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(pipeline_id): Path<String>,
    Json(mut definition): Json<PipelineDefinition>,
) -> AppResult<Json<PipelineResponse>> {
    auth.require_operator()?;
    if definition.pipeline_id != pipeline_id {
        return Err(AppError::bad_request("pipelineId does not match path"));
    }
    let plan = validate_and_plan(&mut definition).await?;
    if definition.status != "PUBLISHED" {
        return Err(AppError::bad_request(
            "published revision must have status PUBLISHED",
        ));
    }
    if let Some(existing) = load_revision(&state, &pipeline_id, definition.revision).await? {
        if existing.digest == definition.digest {
            return Ok(Json(existing));
        }
        return Err(AppError::conflict(
            "PIPELINE_REVISION_IMMUTABLE",
            "revision already exists with a different digest",
        ));
    }
    let definition_value = serde_json::to_value(&definition)
        .map_err(|error| AppError::bad_request(error.to_string()))?;
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO kernel.pipeline_definitions (pipeline_id,latest_revision) VALUES ($1,0)
         ON CONFLICT (pipeline_id) DO NOTHING",
    )
    .bind(&pipeline_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO kernel.pipeline_revisions (pipeline_id,revision,digest,definition,plan,status)
         VALUES ($1,$2,$3,$4,$5,'PUBLISHED')",
    )
    .bind(&pipeline_id)
    .bind(definition.revision as i32)
    .bind(&definition.digest)
    .bind(&definition_value)
    .bind(serde_json::to_value(&plan).unwrap_or(Value::Null))
    .execute(&mut *tx)
    .await
    .map_err(|error| {
        if error.to_string().contains("duplicate") {
            AppError::conflict(
                "PIPELINE_REVISION_IMMUTABLE",
                "pipeline revision already exists",
            )
        } else {
            AppError::internal(error)
        }
    })?;
    sqlx::query(
        "UPDATE kernel.pipeline_definitions SET latest_revision=GREATEST(latest_revision,$2),updated_at=now() WHERE pipeline_id=$1",
    )
    .bind(&pipeline_id)
    .bind(definition.revision as i32)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let _ = crate::audit::record(
        &state.db,
        "pipeline.revision_published",
        "USER",
        &auth.user_id.to_string(),
        "pipeline",
        &pipeline_id,
        "publish",
        "ACCEPTED",
        json!({"revision": definition.revision, "digest": definition.digest}),
        None,
    )
    .await;
    Ok(Json(PipelineResponse {
        pipeline_id: definition.pipeline_id.clone(),
        revision: definition.revision,
        digest: definition.digest.clone(),
        status: definition.status.clone(),
        definition,
        plan,
    }))
}

pub async fn get_plan(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path((pipeline_id, revision)): Path<(String, i32)>,
) -> AppResult<Json<Value>> {
    let plan: Option<Value> = sqlx::query_scalar(
        "SELECT plan FROM kernel.pipeline_revisions WHERE pipeline_id=$1 AND revision=$2",
    )
    .bind(&pipeline_id)
    .bind(revision)
    .fetch_optional(&state.db)
    .await?;
    plan.map(Json)
        .ok_or_else(|| AppError::not_found("pipeline revision not found"))
}

pub async fn submit_job(
    State(state): State<AppState>,
    auth: AuthUser,
    headers: axum::http::HeaderMap,
    Json(request): Json<SubmitJobRequest>,
) -> AppResult<(StatusCode, Json<JobView>)> {
    auth.require_operator()?;
    let idempotency_key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .ok_or_else(|| AppError::bad_request("Idempotency-Key is required"))?
        .to_string();
    if request.max_attempts < 1
        || request.max_attempts > 8
        || request.timeout_seconds < 1
        || request.timeout_seconds > 3600
    {
        return Err(AppError::bad_request("invalid retry or timeout bound"));
    }
    let revision: Option<(String, Value)> = sqlx::query_as(
        "SELECT digest,definition FROM kernel.pipeline_revisions WHERE pipeline_id=$1 AND revision=$2",
    )
    .bind(&request.pipeline_id)
    .bind(request.pipeline_revision as i32)
    .fetch_optional(&state.db)
    .await?;
    let (pipeline_digest, definition) =
        revision.ok_or_else(|| AppError::not_found("pipeline revision not found"))?;
    let definition: PipelineDefinition = serde_json::from_value(definition)
        .map_err(|error| AppError::internal(error.to_string()))?;
    if definition.pipeline_id != request.pipeline_id
        || definition.revision != request.pipeline_revision
    {
        return Err(AppError::bad_request("pipeline revision pin mismatch"));
    }
    let request_digest = crate::pipeline::digest_value(&json!({
        "pipelineId": request.pipeline_id,
        "pipelineRevision": request.pipeline_revision,
        "input": request.input
    }));
    if let Some(existing) = sqlx::query_as::<_, JobView>(
        "SELECT job_id,pipeline_id,pipeline_revision,status,current_fence,current_lease_id,attempts,max_attempts,last_error_code,created_at,updated_at FROM kernel.pipeline_jobs WHERE idempotency_key=$1",
    )
    .bind(&idempotency_key)
    .fetch_optional(&state.db)
    .await?
    {
        let existing_digest: String = sqlx::query_scalar("SELECT request_digest FROM kernel.pipeline_jobs WHERE job_id=$1")
            .bind(existing.job_id)
            .fetch_one(&state.db)
            .await?;
        if existing_digest == request_digest {
            return Ok((StatusCode::OK, Json(existing)));
        }
        return Err(AppError::conflict("JOB_IDEMPOTENCY_CONFLICT", "idempotency key was used with different input"));
    }
    let job_id = Uuid::new_v4();
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO kernel.pipeline_jobs (job_id,pipeline_id,pipeline_revision,pipeline_digest,idempotency_key,request_digest,status,input,max_attempts,timeout_seconds) VALUES ($1,$2,$3,$4,$5,$6,'QUEUED',$7,$8,$9)",
    )
    .bind(job_id)
    .bind(&request.pipeline_id)
    .bind(request.pipeline_revision as i32)
    .bind(&pipeline_digest)
    .bind(&idempotency_key)
    .bind(&request_digest)
    .bind(&request.input)
    .bind(request.max_attempts)
    .bind(request.timeout_seconds)
    .execute(&mut *tx)
    .await
    .map_err(|error| {
        if error.to_string().contains("duplicate") {
            AppError::conflict("JOB_IDEMPOTENCY_CONFLICT", "idempotency key already exists")
        } else {
            AppError::internal(error)
        }
    })?;
    sqlx::query(
        "INSERT INTO kernel.pipeline_job_events (job_id,event_type,to_status,details) VALUES ($1,'JOB_SUBMITTED','QUEUED',$2)",
    )
    .bind(job_id)
    .bind(json!({"idempotencyKey": idempotency_key}))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let job = fetch_job(&state, job_id).await?;
    Ok((StatusCode::CREATED, Json(job)))
}

async fn fetch_job(state: &AppState, job_id: Uuid) -> AppResult<JobView> {
    sqlx::query_as::<_, JobView>(
        "SELECT job_id,pipeline_id,pipeline_revision,status,current_fence,current_lease_id,attempts,max_attempts,last_error_code,created_at,updated_at FROM kernel.pipeline_jobs WHERE job_id=$1",
    )
    .bind(job_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found("job not found"))
}

pub async fn get_job(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path(job_id): Path<Uuid>,
) -> AppResult<Json<JobView>> {
    Ok(Json(fetch_job(&state, job_id).await?))
}

pub async fn get_snapshot(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<Uuid>,
) -> AppResult<Json<SnapshotResponse>> {
    let trusted = authenticate_worker_header_only(&state, &headers).await?;
    let row = sqlx::query(
        "SELECT source_digest,source_length,source,etag,fetched_at FROM kernel.pipeline_job_snapshots WHERE job_id=$1",
    )
    .bind(job_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "SNAPSHOT_NOT_FOUND", "job snapshot not found"))?;
    let lease_worker: Option<String> = sqlx::query_scalar(
        "SELECT worker_id FROM kernel.pipeline_job_leases WHERE lease_id=(SELECT current_lease_id FROM kernel.pipeline_jobs WHERE job_id=$1)",
    )
    .bind(job_id)
    .fetch_optional(&state.db)
    .await?;
    if lease_worker.as_deref() != Some(trusted.worker_id.as_str()) {
        return Err(AppError::forbidden("lease belongs to a different worker"));
    }
    let lease_state: Option<(String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT status,expires_at FROM kernel.pipeline_job_leases WHERE lease_id=(SELECT current_lease_id FROM kernel.pipeline_jobs WHERE job_id=$1)",
    )
    .bind(job_id)
    .fetch_optional(&state.db)
    .await?;
    match lease_state {
        Some((status, expires_at)) if status == "ACTIVE" && expires_at > Utc::now() => {}
        _ => {
            return Err(AppError::conflict(
                "STALE_FENCE",
                "snapshot requires the current active lease",
            ));
        }
    }
    let stored_source: Value = row.get("source");
    let canonical = crate::pipeline::canonical_json(&stored_source).into_bytes();
    let stored_digest: String = row.get("source_digest");
    let actual_digest = format!(
        "sha256:{}",
        hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&canonical))
    );
    if actual_digest != stored_digest
        || canonical.len() as i64 != row.get::<i64, _>("source_length")
    {
        return Err(AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "SNAPSHOT_CORRUPT",
            "stored source snapshot failed integrity verification",
        ));
    }
    Ok(Json(SnapshotResponse {
        source_digest: stored_digest,
        source_length: row.get("source_length"),
        source: stored_source,
        etag: row.get("etag"),
        fetched_at: row.get("fetched_at"),
    }))
}

pub async fn save_snapshot(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<Uuid>,
    Json(request): Json<SnapshotRequest>,
) -> AppResult<Json<SnapshotResponse>> {
    let trusted = authenticate_worker_header_only(&state, &headers).await?;
    if request.source_length < 0 || request.source_digest.len() != 71 {
        return Err(AppError::bad_request("invalid source snapshot"));
    }
    let canonical = crate::pipeline::canonical_json(&request.source).into_bytes();
    if canonical.len() > 4 * 1024 * 1024 {
        return Err(AppError::bad_request("source snapshot exceeds limit"));
    }
    if canonical.len() as i64 != request.source_length {
        return Err(AppError::bad_request("source snapshot length mismatch"));
    }
    let actual_digest = format!(
        "sha256:{}",
        hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&canonical))
    );
    if actual_digest != request.source_digest {
        return Err(AppError::bad_request("source snapshot digest mismatch"));
    }
    let mut tx = state.db.begin().await?;
    let row = sqlx::query(
        "SELECT j.current_fence,l.worker_id,l.status,l.expires_at FROM kernel.pipeline_jobs j JOIN kernel.pipeline_job_leases l ON l.lease_id=$2 AND l.job_id=j.job_id WHERE j.job_id=$1 FOR UPDATE OF j",
    )
    .bind(job_id)
    .bind(request.lease_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::not_found("job or lease not found"))?;
    let fence: i64 = row.get("current_fence");
    let lease_worker: String = row.get("worker_id");
    let lease_status: String = row.get("status");
    let expires_at: DateTime<Utc> = row.get("expires_at");
    if fence != request.fencing_sequence
        || lease_worker != trusted.worker_id
        || lease_status != "ACTIVE"
        || expires_at <= Utc::now()
    {
        return Err(AppError::conflict(
            "STALE_FENCE",
            "snapshot requires the current active fence",
        ));
    }
    let existing = sqlx::query(
        "SELECT source_digest,source_length,source,etag,fetched_at FROM kernel.pipeline_job_snapshots WHERE job_id=$1",
    )
    .bind(job_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(existing) = existing {
        if existing.get::<String, _>("source_digest") != request.source_digest {
            return Err(AppError::conflict(
                "SNAPSHOT_CONFLICT",
                "source changed after snapshot pin",
            ));
        }
        tx.commit().await?;
        return Ok(Json(SnapshotResponse {
            source_digest: existing.get("source_digest"),
            source_length: existing.get("source_length"),
            source: existing.get("source"),
            etag: existing.get("etag"),
            fetched_at: existing.get("fetched_at"),
        }));
    }
    sqlx::query(
        "INSERT INTO kernel.pipeline_job_snapshots (job_id,source_digest,source_length,source,etag) VALUES ($1,$2,$3,$4,$5)",
    )
    .bind(job_id)
    .bind(&request.source_digest)
    .bind(request.source_length)
    .bind(&request.source)
    .bind(&request.etag)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO kernel.pipeline_job_events (job_id,event_type,fencing_sequence,details) VALUES ($1,'JOB_SNAPSHOT_PINNED',$2,$3)")
        .bind(job_id)
        .bind(fence)
        .bind(json!({"sourceDigest": request.source_digest, "sourceLength": request.source_length}))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(SnapshotResponse {
        source_digest: request.source_digest,
        source_length: request.source_length,
        source: request.source,
        etag: request.etag,
        fetched_at: Utc::now(),
    }))
}

pub async fn worker_definition(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let trusted = authenticate_worker_header_only(&state, &headers).await?;
    let row = sqlx::query(
        "SELECT j.pipeline_id,j.pipeline_revision,j.current_lease_id,j.input,r.definition,r.plan
         FROM kernel.pipeline_jobs j
         JOIN kernel.pipeline_revisions r ON r.pipeline_id=j.pipeline_id AND r.revision=j.pipeline_revision
         WHERE j.job_id=$1",
    )
    .bind(job_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found("job or pinned pipeline revision not found"))?;
    let lease_id: Option<Uuid> = row.get("current_lease_id");
    let lease_id = lease_id
        .ok_or_else(|| AppError::conflict("JOB_NOT_CLAIMED", "job has no current lease"))?;
    let lease_worker: String = sqlx::query_scalar(
        "SELECT worker_id FROM kernel.pipeline_job_leases WHERE lease_id=$1 AND job_id=$2",
    )
    .bind(lease_id)
    .bind(job_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::conflict("LEASE_NOT_ACTIVE", "lease is not active"))?;
    if lease_worker != trusted.worker_id {
        return Err(AppError::forbidden("lease belongs to a different worker"));
    }
    Ok(Json(json!({
        "jobId": job_id,
        "pipelineId": row.get::<String, _>("pipeline_id"),
        "pipelineRevision": row.get::<i32, _>("pipeline_revision"),
        "leaseId": lease_id,
        "input": row.get::<Value, _>("input"),
        "definition": row.get::<Value, _>("definition"),
        "plan": row.get::<Value, _>("plan")
    })))
}

pub async fn claim_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<Uuid>,
    Json(worker): Json<WorkerIdentity>,
) -> AppResult<Json<ClaimResponse>> {
    let trusted = authenticate_worker(&state, &headers, &worker).await?;
    let mut tx = state.db.begin().await?;
    let row = sqlx::query(
        "SELECT status,current_fence,current_lease_id,attempts,max_attempts FROM kernel.pipeline_jobs WHERE job_id=$1 FOR UPDATE",
    )
    .bind(job_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::not_found("job not found"))?;
    let status: String = row.get("status");
    let current_fence: i64 = row.get("current_fence");
    let current_lease: Option<Uuid> = row.get("current_lease_id");
    let attempts: i32 = row.get("attempts");
    let max_attempts: i32 = row.get("max_attempts");
    if !matches!(status.as_str(), "QUEUED" | "CLAIMED" | "RUNNING") {
        return Err(AppError::conflict(
            "JOB_NOT_CLAIMABLE",
            "job is not claimable",
        ));
    }
    if let Some(lease_id) = current_lease {
        let lease = sqlx::query(
            "SELECT status,expires_at FROM kernel.pipeline_job_leases WHERE lease_id=$1 AND job_id=$2",
        )
        .bind(lease_id)
        .bind(job_id)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(lease) = lease {
            let lease_status: String = lease.get("status");
            let expires_at: DateTime<Utc> = lease.get("expires_at");
            if lease_status == "ACTIVE" && expires_at > Utc::now() {
                return Err(AppError::conflict(
                    "JOB_ALREADY_CLAIMED",
                    "job has an active lease",
                ));
            }
        }
    }
    if attempts >= max_attempts {
        sqlx::query("UPDATE kernel.pipeline_jobs SET status='FAILED',last_error_code='JOB_ATTEMPTS_EXHAUSTED',updated_at=now() WHERE job_id=$1")
            .bind(job_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Err(AppError::conflict(
            "JOB_ATTEMPTS_EXHAUSTED",
            "job retry limit reached",
        ));
    }
    sqlx::query("UPDATE kernel.pipeline_job_leases SET status='EXPIRED' WHERE job_id=$1 AND status='ACTIVE'")
        .bind(job_id)
        .execute(&mut *tx)
        .await?;
    let lease_id = Uuid::new_v4();
    let fence = current_fence + 1;
    let attempt = attempts + 1;
    let expires_at = Utc::now() + Duration::seconds(60);
    let inserted_lease = sqlx::query(
        "INSERT INTO kernel.pipeline_job_leases (lease_id,job_id,attempt_number,worker_id,node_id,instance_id,boot_id,fencing_sequence,status,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9)",
    )
    .bind(lease_id)
    .bind(job_id)
    .bind(attempt)
    .bind(&trusted.worker_id)
    .bind(trusted.node_id)
    .bind(trusted.instance_id)
    .bind(trusted.boot_id)
    .bind(fence)
    .bind(expires_at)
    .execute(&mut *tx)
    .await;
    if let Err(error) = inserted_lease {
        return Err(AppError::internal(error));
    }
    sqlx::query(
        "INSERT INTO kernel.pipeline_job_attempts (job_id,attempt_number,worker_id,node_id,instance_id,boot_id,lease_id,fencing_sequence,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CLAIMED')",
    )
    .bind(job_id)
    .bind(attempt)
    .bind(&trusted.worker_id)
    .bind(trusted.node_id)
    .bind(trusted.instance_id)
    .bind(trusted.boot_id)
    .bind(lease_id)
    .bind(fence)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE kernel.pipeline_jobs SET status='CLAIMED',current_fence=$2,current_lease_id=$3,attempts=$4,updated_at=now() WHERE job_id=$1")
        .bind(job_id)
        .bind(fence)
        .bind(lease_id)
        .bind(attempt)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO kernel.pipeline_job_events (job_id,event_type,from_status,to_status,fencing_sequence,worker_id,details) VALUES ($1,'JOB_CLAIMED',$2,'CLAIMED',$3,$4,$5)")
        .bind(job_id)
        .bind(&status)
        .bind(fence)
        .bind(&trusted.worker_id)
        .bind(json!({"workerVersion": worker.version}))
        .execute(&mut *tx)
        .await?;
    let _ = worker.version.as_str();
    tx.commit().await?;
    Ok(Json(ClaimResponse {
        lease_id,
        job_id,
        attempt_number: attempt,
        fencing_sequence: fence,
        expires_at,
        worker_id: trusted.worker_id,
    }))
}

async fn authorize_lease(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    job_id: Uuid,
    worker_id: &str,
    request: &FenceRequest,
) -> AppResult<(String, i64)> {
    let row = sqlx::query(
        "SELECT j.status,j.current_fence,l.status AS lease_status,l.expires_at,l.worker_id AS lease_worker FROM kernel.pipeline_jobs j JOIN kernel.pipeline_job_leases l ON l.lease_id=$2 AND l.job_id=j.job_id WHERE j.job_id=$1 FOR UPDATE OF j",
    )
    .bind(job_id)
    .bind(request.lease_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| AppError::not_found("job or lease not found"))?;
    let status: String = row.get("status");
    let current_fence: i64 = row.get("current_fence");
    let lease_status: String = row.get("lease_status");
    let expires_at: DateTime<Utc> = row.get("expires_at");
    let lease_worker: String = row.get("lease_worker");
    if lease_worker != worker_id {
        return Err(AppError::forbidden("lease belongs to a different worker"));
    }
    if request.fencing_sequence != current_fence {
        return Err(AppError::conflict(
            "STALE_FENCE",
            "fencing sequence is stale",
        ));
    }
    if lease_status != "ACTIVE" || expires_at <= Utc::now() {
        return Err(AppError::conflict(
            "LEASE_NOT_ACTIVE",
            "lease is not active",
        ));
    }
    if !matches!(status.as_str(), "CLAIMED" | "RUNNING") {
        return Err(AppError::conflict("JOB_NOT_RUNNING", "job is not running"));
    }
    Ok((status, current_fence))
}

pub async fn start_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<Uuid>,
    Json(request): Json<FenceRequest>,
) -> AppResult<Json<JobView>> {
    let trusted = authenticate_worker_header_only(&state, &headers).await?;
    let mut tx = state.db.begin().await?;
    let (status, _) = authorize_lease(&mut tx, job_id, &trusted.worker_id, &request).await?;
    if status != "CLAIMED" && status != "RUNNING" {
        return Err(AppError::conflict(
            "JOB_NOT_STARTABLE",
            "job is not startable",
        ));
    }
    sqlx::query(
        "UPDATE kernel.pipeline_jobs SET status='RUNNING',updated_at=now() WHERE job_id=$1",
    )
    .bind(job_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE kernel.pipeline_job_attempts SET status='RUNNING' WHERE job_id=$1 AND lease_id=$2",
    )
    .bind(job_id)
    .bind(request.lease_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO kernel.pipeline_job_events (job_id,event_type,from_status,to_status,fencing_sequence) VALUES ($1,'JOB_STARTED',$2,'RUNNING',$3)").bind(job_id).bind(status).bind(request.fencing_sequence).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(fetch_job(&state, job_id).await?))
}

pub async fn heartbeat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<Uuid>,
    Json(request): Json<FenceRequest>,
) -> AppResult<Json<ClaimResponse>> {
    let trusted = authenticate_worker_header_only(&state, &headers).await?;
    let mut tx = state.db.begin().await?;
    let (_, fence) = authorize_lease(&mut tx, job_id, &trusted.worker_id, &request).await?;
    let expires_at = Utc::now() + Duration::seconds(60);
    sqlx::query(
        "UPDATE kernel.pipeline_job_leases SET heartbeat_at=now(),expires_at=$2 WHERE lease_id=$1",
    )
    .bind(request.lease_id)
    .bind(expires_at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let worker_id: String =
        sqlx::query_scalar("SELECT worker_id FROM kernel.pipeline_job_leases WHERE lease_id=$1")
            .bind(request.lease_id)
            .fetch_one(&state.db)
            .await?;
    Ok(Json(ClaimResponse {
        lease_id: request.lease_id,
        job_id,
        attempt_number: 0,
        fencing_sequence: fence,
        expires_at,
        worker_id,
    }))
}

pub async fn checkpoint(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<Uuid>,
    Json(request): Json<CheckpointRequest>,
) -> AppResult<Json<Value>> {
    let trusted = authenticate_worker_header_only(&state, &headers).await?;
    if request.sequence < 1 || request.state_digest.len() > 71 {
        return Err(AppError::bad_request("invalid checkpoint"));
    }
    let mut tx = state.db.begin().await?;
    let (_, fence) = authorize_lease(
        &mut tx,
        job_id,
        &trusted.worker_id,
        &FenceRequest {
            lease_id: request.lease_id,
            fencing_sequence: request.fencing_sequence,
        },
    )
    .await?;
    let previous: Option<i64> = sqlx::query_scalar("SELECT max(sequence) FROM kernel.pipeline_job_checkpoints WHERE job_id=$1 AND attempt_number=(SELECT attempts FROM kernel.pipeline_jobs WHERE job_id=$1)")
        .bind(job_id).fetch_one(&mut *tx).await?;
    if previous.unwrap_or(0) >= request.sequence {
        return Err(AppError::conflict(
            "CHECKPOINT_SEQUENCE_CONFLICT",
            "checkpoint sequence must increase",
        ));
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO kernel.pipeline_job_checkpoints (checkpoint_id,job_id,attempt_number,sequence,fencing_sequence,input_cursor,state_digest,state) VALUES ($1,$2,(SELECT attempts FROM kernel.pipeline_jobs WHERE job_id=$2),$3,$4,$5,$6,$7)")
        .bind(id).bind(job_id).bind(request.sequence).bind(fence).bind(&request.input_cursor).bind(&request.state_digest).bind(&request.state).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO kernel.pipeline_job_events (job_id,event_type,fencing_sequence,details) VALUES ($1,'JOB_CHECKPOINTED',$2,$3)")
        .bind(job_id).bind(fence).bind(json!({"checkpointId": id, "sequence": request.sequence})).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"checkpointId": id, "sequence": request.sequence, "fencingSequence": fence}),
    ))
}

pub async fn result(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<Uuid>,
    Json(request): Json<ResultRequest>,
) -> AppResult<Json<JobView>> {
    let trusted = authenticate_worker_header_only(&state, &headers).await?;
    let terminal = match request.status.as_str() {
        "SUCCEEDED" | "FAILED" | "CANCELLED" => request.status.as_str(),
        _ => return Err(AppError::bad_request("result status must be terminal")),
    };
    if terminal == "SUCCEEDED" {
        let batches = request
            .output
            .get("batches")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if request.effects.is_empty() || request.effects.len() as u64 != batches {
            return Err(AppError::bad_request(
                "SUCCEEDED requires one committed effect per batch",
            ));
        }
        for effect in &request.effects {
            if effect.get("status").and_then(Value::as_str) != Some("COMMITTED")
                || effect.get("effectId").and_then(Value::as_str).is_none()
                || effect
                    .get("requestDigest")
                    .and_then(Value::as_str)
                    .is_none()
            {
                return Err(AppError::bad_request("incomplete committed effect set"));
            }
        }
    }
    // A released lease must not block an authenticated idempotent result replay.
    let replay = sqlx::query(
        "SELECT status,result_digest,lease_id,fencing_sequence,worker_id FROM kernel.pipeline_job_results WHERE job_id=$1",
    )
    .bind(job_id)
    .fetch_optional(&state.db)
    .await?;
    if let Some(replay) = replay {
        let replay_worker: Option<String> = replay.get("worker_id");
        let replay_lease: Option<Uuid> = replay.get("lease_id");
        let replay_fence: i64 = replay.get("fencing_sequence");
        if replay_worker.as_deref() == Some(trusted.worker_id.as_str())
            && replay_lease == Some(request.lease_id)
            && replay_fence == request.fencing_sequence
            && replay.get::<String, _>("status") == terminal
            && replay.get::<Option<String>, _>("result_digest").as_deref()
                == request.result_digest.as_deref()
        {
            return Ok(Json(fetch_job(&state, job_id).await?));
        }
        return Err(AppError::conflict(
            "RESULT_CONFLICT",
            "result identity or digest does not match",
        ));
    }
    let mut tx = state.db.begin().await?;
    let (current_status, fence) = authorize_lease(
        &mut tx,
        job_id,
        &trusted.worker_id,
        &FenceRequest {
            lease_id: request.lease_id,
            fencing_sequence: request.fencing_sequence,
        },
    )
    .await?;
    let existing: Option<(String, i64)> = sqlx::query_as(
        "SELECT status,fencing_sequence FROM kernel.pipeline_job_results WHERE job_id=$1",
    )
    .bind(job_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((existing_status, existing_fence)) = existing {
        if existing_fence == fence && existing_status == terminal {
            tx.rollback().await.ok();
            return Ok(Json(fetch_job(&state, job_id).await?));
        }
        return Err(AppError::conflict(
            "RESULT_ALREADY_COMMITTED",
            "job already has a result",
        ));
    }
    sqlx::query("INSERT INTO kernel.pipeline_job_results (job_id,fencing_sequence,status,output,error_code,error_message,result_digest,receipt,lease_id,worker_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
        .bind(job_id).bind(fence).bind(terminal).bind(&request.output).bind(&request.error_code).bind(&request.error_message).bind(&request.result_digest).bind(&request.receipt).bind(request.lease_id).bind(&trusted.worker_id).execute(&mut *tx).await?;
    sqlx::query("UPDATE kernel.pipeline_jobs SET status=$2,last_error_code=$3,updated_at=now() WHERE job_id=$1")
        .bind(job_id).bind(terminal).bind(&request.error_code).execute(&mut *tx).await?;
    sqlx::query("UPDATE kernel.pipeline_job_leases SET status='RELEASED' WHERE lease_id=$1")
        .bind(request.lease_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE kernel.pipeline_job_attempts SET status=$3,finished_at=now(),error_code=$4 WHERE job_id=$1 AND lease_id=$2")
        .bind(job_id).bind(request.lease_id).bind(terminal).bind(&request.error_code).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO kernel.pipeline_job_events (job_id,event_type,from_status,to_status,fencing_sequence,details) VALUES ($1,'JOB_COMPLETED',$2,$3,$4,$5)")
        .bind(job_id).bind(current_status).bind(terminal).bind(fence).bind(json!({"errorCode": request.error_code})).execute(&mut *tx).await?;
    tx.commit().await?;
    let _ = crate::audit::record(
        &state.db,
        "pipeline.job_completed",
        "NODE",
        &trusted.worker_id,
        "job",
        &job_id.to_string(),
        "complete",
        if terminal == "SUCCEEDED" {
            "ACCEPTED"
        } else {
            "REJECTED"
        },
        json!({"status": terminal, "fencingSequence": fence, "errorCode": request.error_code}),
        None,
    )
    .await;
    Ok(Json(fetch_job(&state, job_id).await?))
}

pub async fn cancel_job(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(job_id): Path<Uuid>,
) -> AppResult<Json<JobView>> {
    auth.require_operator()?;
    let mut tx = state.db.begin().await?;
    let status: Option<String> =
        sqlx::query_scalar("SELECT status FROM kernel.pipeline_jobs WHERE job_id=$1 FOR UPDATE")
            .bind(job_id)
            .fetch_optional(&mut *tx)
            .await?;
    let status = status.ok_or_else(|| AppError::not_found("job not found"))?;
    if matches!(status.as_str(), "SUCCEEDED" | "FAILED" | "CANCELLED") {
        tx.rollback().await.ok();
        return Ok(Json(fetch_job(&state, job_id).await?));
    }
    sqlx::query(
        "UPDATE kernel.pipeline_jobs SET status='CANCELLED',updated_at=now() WHERE job_id=$1",
    )
    .bind(job_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE kernel.pipeline_job_leases SET status='REVOKED' WHERE job_id=$1 AND status='ACTIVE'").bind(job_id).execute(&mut *tx).await?;
    sqlx::query("UPDATE kernel.pipeline_job_attempts SET status='CANCELLED',finished_at=now() WHERE job_id=$1 AND status IN ('CLAIMED','RUNNING')").bind(job_id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO kernel.pipeline_job_events (job_id,event_type,from_status,to_status) VALUES ($1,'JOB_CANCELLED',$2,'CANCELLED')").bind(job_id).bind(status).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(fetch_job(&state, job_id).await?))
}
