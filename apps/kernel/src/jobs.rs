//! Durable typed-pipeline store, revision pinning and fenced jobs.
//!
//! PostgreSQL is the only durable authority. There is no process-local job
//! queue; every claim, heartbeat, checkpoint and result is a transaction.

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::pipeline::{
    canonical_json, digest_without_field, trusted_registry, validate_pipeline, PipelineDefinition,
    PipelineExecutionPlan, SchemaCatalog, SchemaDataset, SchemaField, SchemaRevision,
};
use crate::state::AppState;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineValidationIssue {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineValidationResponse {
    pub valid: bool,
    pub errors: Vec<PipelineValidationIssue>,
    pub warnings: Vec<PipelineValidationIssue>,
    pub canonical_order: Vec<String>,
    pub plan_digest: Option<String>,
    pub digest: Option<String>,
}

/// Pure server-side validation: no revision, job, receipt or catalog write.
pub async fn validate_pipeline_definition(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(mut definition): Json<PipelineDefinition>,
) -> AppResult<Json<PipelineValidationResponse>> {
    auth.require_operator()?;
    let catalog = match live_schema_catalog(&state, &mut definition).await {
        Ok(catalog) => catalog,
        Err(error) => {
            return Ok(Json(PipelineValidationResponse {
                valid: false,
                errors: vec![PipelineValidationIssue {
                    code: error.code.to_string(),
                    message: error.message,
                    node_id: None,
                    port: None,
                }],
                warnings: Vec::new(),
                canonical_order: Vec::new(),
                plan_digest: None,
                digest: None,
            }))
        }
    };
    let definition_value = serde_json::to_value(&definition)
        .map_err(|error| AppError::bad_request(error.to_string()))?;
    definition.digest = digest_without_field(&definition_value, "digest");
    let (registry, _) = match trusted_registry() {
        Ok(registry) => registry,
        Err(error) => {
            return Ok(Json(PipelineValidationResponse {
                valid: false,
                errors: vec![PipelineValidationIssue {
                    code: error.code,
                    message: error.message,
                    node_id: None,
                    port: None,
                }],
                warnings: Vec::new(),
                canonical_order: Vec::new(),
                plan_digest: None,
                digest: None,
            }))
        }
    };
    match validate_pipeline(&definition, &registry, &catalog) {
        Ok(plan) => Ok(Json(PipelineValidationResponse {
            valid: true,
            errors: Vec::new(),
            warnings: Vec::new(),
            canonical_order: plan.ordered_nodes,
            plan_digest: Some(plan.plan_digest),
            digest: Some(definition.digest),
        })),
        Err(error) => Ok(Json(PipelineValidationResponse {
            valid: false,
            errors: vec![PipelineValidationIssue {
                code: error.code,
                message: error.message,
                node_id: None,
                port: None,
            }],
            warnings: Vec::new(),
            canonical_order: Vec::new(),
            plan_digest: None,
            digest: None,
        })),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftView {
    pub draft_id: Uuid,
    pub pipeline_id: String,
    pub base_revision: i32,
    pub definition: Value,
    pub definition_digest: String,
    pub version: i64,
    pub status: String,
    pub created_by: Uuid,
    pub updated_by: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDraftRequest {
    #[serde(default)]
    pub base_revision: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDraftRequest {
    pub definition: PipelineDefinition,
}

fn draft_view(row: &sqlx::postgres::PgRow) -> DraftView {
    DraftView {
        draft_id: row.get("draft_id"),
        pipeline_id: row.get("pipeline_id"),
        base_revision: row.get("base_revision"),
        definition: row.get("definition"),
        definition_digest: row.get("definition_digest"),
        version: row.get("version"),
        status: row.get("status"),
        created_by: row.get("created_by"),
        updated_by: row.get("updated_by"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn draft_definition(
    mut definition: PipelineDefinition,
    pipeline_id: &str,
) -> AppResult<(PipelineDefinition, Value, String)> {
    definition.pipeline_id = pipeline_id.to_string();
    definition.status = "DRAFT".to_string();
    let mut value = serde_json::to_value(&definition)
        .map_err(|error| AppError::bad_request(error.to_string()))?;
    value["digest"] = Value::String(String::new());
    let digest = digest_without_field(&value, "digest");
    value["digest"] = Value::String(digest.clone());
    definition.digest = digest.clone();
    Ok((definition, value, digest))
}

pub async fn create_draft(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(pipeline_id): Path<String>,
    Json(request): Json<CreateDraftRequest>,
) -> AppResult<(StatusCode, Json<DraftView>)> {
    auth.require_operator()?;
    let latest: Option<i32> = sqlx::query_scalar(
        "SELECT latest_revision FROM kernel.pipeline_definitions WHERE pipeline_id=$1",
    )
    .bind(&pipeline_id)
    .fetch_optional(&state.db)
    .await?;
    let latest = latest.ok_or_else(|| {
        AppError::new(
            StatusCode::NOT_FOUND,
            "PIPELINE_NOT_FOUND",
            "pipeline not found",
        )
    })?;
    let base_revision = request.base_revision.unwrap_or(latest as u32) as i32;
    if base_revision < 1 || base_revision > latest {
        return Err(AppError::bad_request("baseRevision is not published"));
    }
    let stored: Option<Value> = sqlx::query_scalar(
        "SELECT definition FROM kernel.pipeline_revisions WHERE pipeline_id=$1 AND revision=$2",
    )
    .bind(&pipeline_id)
    .bind(base_revision)
    .fetch_optional(&state.db)
    .await?;
    let stored = stored.ok_or_else(|| AppError::bad_request("baseRevision is not published"))?;
    let definition: PipelineDefinition = serde_json::from_value(stored)
        .map_err(|error| AppError::bad_request(format!("stored definition is invalid: {error}")))?;
    let (_, value, digest) = draft_definition(definition, &pipeline_id)?;
    let row = sqlx::query(
        "INSERT INTO kernel.pipeline_drafts
           (pipeline_id,base_revision,definition,definition_digest,version,status,created_by,updated_by)
         VALUES ($1,$2,$3,$4,1,'DRAFT',$5,$5)
         RETURNING draft_id,pipeline_id,base_revision,definition,definition_digest,version,status,created_by,updated_by,created_at,updated_at",
    )
    .bind(&pipeline_id)
    .bind(base_revision)
    .bind(&value)
    .bind(&digest)
    .bind(auth.user_id)
    .fetch_one(&state.db)
    .await?;
    let _ = crate::audit::record(
        &state.db,
        "pipeline.draft_created",
        "USER",
        &auth.user_id.to_string(),
        "pipeline_draft",
        &row.get::<Uuid, _>("draft_id").to_string(),
        "create",
        "ACCEPTED",
        json!({"pipelineId": pipeline_id, "baseRevision": base_revision}),
        None,
    )
    .await;
    Ok((StatusCode::CREATED, Json(draft_view(&row))))
}

pub async fn list_drafts(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(pipeline_id): Path<String>,
) -> AppResult<Json<Vec<DraftView>>> {
    auth.require_operator()?;
    let rows = sqlx::query(
        "SELECT draft_id,pipeline_id,base_revision,definition,definition_digest,version,status,created_by,updated_by,created_at,updated_at
         FROM kernel.pipeline_drafts WHERE pipeline_id=$1 AND created_by=$2 ORDER BY updated_at DESC",
    )
    .bind(&pipeline_id)
    .bind(auth.user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.iter().map(draft_view).collect()))
}

pub async fn get_draft(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((pipeline_id, draft_id)): Path<(String, Uuid)>,
) -> AppResult<Json<DraftView>> {
    auth.require_operator()?;
    let row = sqlx::query(
        "SELECT draft_id,pipeline_id,base_revision,definition,definition_digest,version,status,created_by,updated_by,created_at,updated_at
         FROM kernel.pipeline_drafts WHERE pipeline_id=$1 AND draft_id=$2 AND (created_by=$3 OR $4)",
    )
    .bind(&pipeline_id)
    .bind(draft_id)
    .bind(auth.user_id)
    .bind(auth.role.is_admin())
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "DRAFT_NOT_FOUND", "draft not found"))?;
    Ok(Json(draft_view(&row)))
}

pub async fn update_draft(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((pipeline_id, draft_id)): Path<(String, Uuid)>,
    headers: HeaderMap,
    Json(request): Json<UpdateDraftRequest>,
) -> AppResult<Json<DraftView>> {
    auth.require_operator()?;
    let if_match = headers
        .get("if-match")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().trim_matches('"'))
        .ok_or_else(|| AppError::bad_request("If-Match is required"))?;
    let expected: i64 = if_match
        .parse()
        .map_err(|_| AppError::bad_request("If-Match must be a draft version"))?;
    let (_, value, digest) = draft_definition(request.definition, &pipeline_id)?;
    let row = sqlx::query(
        "UPDATE kernel.pipeline_drafts
         SET definition=$1,definition_digest=$2,version=version+1,updated_by=$3,updated_at=now()
         WHERE pipeline_id=$4 AND draft_id=$5 AND version=$6 AND status='DRAFT'
           AND (created_by=$7 OR $8)
         RETURNING draft_id,pipeline_id,base_revision,definition,definition_digest,version,status,created_by,updated_by,created_at,updated_at",
    )
    .bind(&value)
    .bind(&digest)
    .bind(auth.user_id)
    .bind(&pipeline_id)
    .bind(draft_id)
    .bind(expected)
    .bind(auth.user_id)
    .bind(auth.role.is_admin())
    .fetch_optional(&state.db)
    .await?;
    let Some(row) = row else {
        let exists: Option<String> = sqlx::query_scalar(
            "SELECT status FROM kernel.pipeline_drafts WHERE pipeline_id=$1 AND draft_id=$2 AND (created_by=$3 OR $4)",
        )
        .bind(&pipeline_id)
        .bind(draft_id)
        .bind(auth.user_id)
        .bind(auth.role.is_admin())
        .fetch_optional(&state.db)
        .await?;
        return match exists.as_deref() {
            None => Err(AppError::new(
                StatusCode::NOT_FOUND,
                "DRAFT_NOT_FOUND",
                "draft not found",
            )),
            Some("DRAFT") => Err(AppError::conflict(
                "DRAFT_VERSION_CONFLICT",
                "draft was updated by another editor",
            )),
            Some(_) => Err(AppError::conflict(
                "DRAFT_NOT_EDITABLE",
                "draft is no longer editable",
            )),
        };
    };
    let _ = crate::audit::record(
        &state.db,
        "pipeline.draft_updated",
        "USER",
        &auth.user_id.to_string(),
        "pipeline_draft",
        &draft_id.to_string(),
        "update",
        "ACCEPTED",
        json!({"pipelineId": pipeline_id, "version": row.get::<i64,_>("version")}),
        None,
    )
    .await;
    Ok(Json(draft_view(&row)))
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
    let stale: bool = sqlx::query_scalar(
        "SELECT last_seen_at IS NULL OR last_seen_at < now() - ($2 || ' seconds')::interval FROM kernel.nodes WHERE id=$1",
    )
    .bind(node_id)
    .bind(state.config.node_stale_seconds)
    .fetch_one(&state.db)
    .await?;
    if stale {
        return Err(AppError::forbidden("node heartbeat is stale"));
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

async fn live_schema_catalog(
    state: &AppState,
    definition: &mut PipelineDefinition,
) -> AppResult<SchemaCatalog> {
    let sink = definition
        .nodes
        .iter_mut()
        .find(|node| node.node_type == "builtin.sink.dataset")
        .ok_or_else(|| AppError::bad_request("pipeline has no dataset sink"))?;
    let dataset_id = sink
        .config
        .get("datasetId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::bad_request("sink datasetId is required"))?
        .to_string();
    Uuid::parse_str(&dataset_id)
        .map_err(|_| AppError::bad_request("sink datasetId must be a UUID"))?;
    let dataset = crate::capabilities::service_catalog_get(
        state,
        &format!("/api/data-catalog/datasets/{dataset_id}"),
    )
    .await
    .map_err(|error| {
        AppError::new(
            error.status,
            "CATALOG_UNAVAILABLE",
            format!("Catalog dataset lookup failed: {}", error.message),
        )
    })?;
    if dataset.get("datasetId").and_then(Value::as_str) != Some(dataset_id.as_str()) {
        return Err(AppError::bad_request(
            "Catalog returned a different dataset",
        ));
    }
    let schemas = crate::capabilities::service_catalog_get(
        state,
        &format!("/api/data-catalog/datasets/{dataset_id}/schemas"),
    )
    .await?;
    let requested_revision = sink
        .config
        .get("schemaRevision")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| {
            dataset
                .get("schemaRevision")
                .and_then(Value::as_u64)
                .unwrap_or(1)
        }) as u32;
    let schema = schemas
        .as_array()
        .and_then(|rows| {
            rows.iter().find(|row| {
                row.get("schemaRevision").and_then(Value::as_u64) == Some(requested_revision as u64)
            })
        })
        .ok_or_else(|| AppError::bad_request("schema revision does not exist in Catalog"))?;
    if schema.get("status").and_then(Value::as_str) != Some("PUBLISHED") {
        return Err(AppError::bad_request("schema revision is not PUBLISHED"));
    }
    let declared_digest = schema
        .get("digest")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::bad_request("Catalog schema digest is missing"))?
        .to_string();
    let mut fields_value = schema
        .get("fields")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| AppError::bad_request("Catalog schema fields are missing"))?;
    fields_value.sort_by(|a, b| {
        a.get("name")
            .and_then(Value::as_str)
            .cmp(&b.get("name").and_then(Value::as_str))
    });
    let actual_digest = format!(
        "sha256:{}",
        hex::encode(<sha2::Sha256 as sha2::Digest>::digest(
            canonical_json(&Value::Array(fields_value.clone())).as_bytes()
        ))
    );
    if actual_digest != declared_digest {
        return Err(AppError::bad_request(
            "Catalog schema digest is inconsistent",
        ));
    }
    let fields: Vec<SchemaField> = serde_json::from_value(Value::Array(fields_value))
        .map_err(|_| AppError::bad_request("Catalog schema fields are invalid"))?;
    sink.config
        .as_object_mut()
        .ok_or_else(|| AppError::bad_request("sink config must be an object"))?
        .insert(
            "schemaDigest".to_string(),
            Value::String(declared_digest.clone()),
        );
    sink.config
        .as_object_mut()
        .ok_or_else(|| AppError::bad_request("sink config must be an object"))?
        .insert(
            "schemaRevision".to_string(),
            Value::from(requested_revision),
        );
    let latest = dataset
        .get("schemaRevision")
        .and_then(Value::as_u64)
        .unwrap_or(requested_revision as u64) as u32;
    Ok(SchemaCatalog {
        catalog_version: "schema-catalog.opsweave.io/live-v1".to_string(),
        datasets: vec![SchemaDataset {
            dataset_id,
            latest_published_revision: latest,
            revisions: vec![SchemaRevision {
                schema_revision: requested_revision,
                status: "PUBLISHED".to_string(),
                digest: declared_digest,
                fields,
            }],
        }],
    })
}

async fn validate_and_plan(
    state: &AppState,
    definition: &mut PipelineDefinition,
) -> AppResult<PipelineExecutionPlan> {
    let catalog = live_schema_catalog(state, definition).await?;
    let definition_value = serde_json::to_value(&*definition)
        .map_err(|error| AppError::bad_request(error.to_string()))?;
    definition.digest = digest_without_field(&definition_value, "digest");
    let (registry, _) = trusted_registry()
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineListQuery {
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineSummary {
    pub pipeline_id: String,
    pub name: String,
    pub latest_revision: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineListResponse {
    pub items: Vec<PipelineSummary>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionSummary {
    pub revision: i32,
    pub digest: String,
    pub status: String,
    pub published_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionView {
    pub pipeline_id: String,
    pub revision: i32,
    pub digest: String,
    pub status: String,
    pub published_at: DateTime<Utc>,
    pub definition: Value,
    pub plan: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineDetailResponse {
    pub pipeline_id: String,
    pub name: String,
    pub latest_revision: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub latest: Option<RevisionView>,
    pub revisions: Vec<RevisionSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionListQuery {
    pub limit: Option<u32>,
    pub before: Option<i32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionListResponse {
    pub items: Vec<RevisionSummary>,
    pub next_before: Option<i32>,
}

fn page_limit(limit: Option<u32>) -> i64 {
    i64::from(limit.unwrap_or(20).clamp(1, 100))
}

fn decode_pipeline_cursor(cursor: &str) -> AppResult<Option<String>> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| AppError::bad_request("invalid pipeline cursor"))?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| AppError::bad_request("invalid pipeline cursor"))
}

fn encode_pipeline_cursor(pipeline_id: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(pipeline_id.as_bytes())
}

fn revision_view(row: &sqlx::postgres::PgRow) -> RevisionView {
    RevisionView {
        pipeline_id: row.get("pipeline_id"),
        revision: row.get("revision"),
        digest: row.get("digest"),
        status: row.get("status"),
        published_at: row.get("published_at"),
        definition: row.get("definition"),
        plan: row.get("plan"),
    }
}

pub async fn list_pipelines(
    State(state): State<AppState>,
    _auth: AuthUser,
    Query(query): Query<PipelineListQuery>,
) -> AppResult<Json<PipelineListResponse>> {
    let limit = page_limit(query.limit);
    let after = match query.cursor.as_deref() {
        Some(value) => decode_pipeline_cursor(value)?,
        None => None,
    };
    // Fetch one extra row to produce a truthful next cursor. Pipeline IDs are
    // stable, unique and used as the opaque cursor payload; no user fields leak.
    let rows = sqlx::query(
        r#"
        SELECT d.pipeline_id, d.latest_revision, d.created_at, d.updated_at,
               COALESCE(r.definition->>'name', d.pipeline_id) AS name
        FROM kernel.pipeline_definitions d
        LEFT JOIN kernel.pipeline_revisions r
          ON r.pipeline_id=d.pipeline_id AND r.revision=d.latest_revision
        WHERE ($1::text IS NULL OR d.pipeline_id > $1)
        ORDER BY d.pipeline_id ASC
        LIMIT $2
        "#,
    )
    .bind(after)
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;
    let has_more = rows.len() as i64 > limit;
    let visible = if has_more {
        &rows[..rows.len() - 1]
    } else {
        &rows[..]
    };
    let items: Vec<PipelineSummary> = visible
        .iter()
        .map(|row| PipelineSummary {
            pipeline_id: row.get("pipeline_id"),
            name: row.get("name"),
            latest_revision: row.get("latest_revision"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
        })
        .collect();
    let next_cursor = if has_more {
        items
            .last()
            .map(|item| encode_pipeline_cursor(&item.pipeline_id))
    } else {
        None
    };
    Ok(Json(PipelineListResponse { items, next_cursor }))
}

pub async fn get_pipeline(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path(pipeline_id): Path<String>,
) -> AppResult<Json<PipelineDetailResponse>> {
    let row = sqlx::query(
        r#"
        SELECT d.pipeline_id, d.latest_revision, d.created_at, d.updated_at,
               COALESCE(r.definition->>'name', d.pipeline_id) AS name
        FROM kernel.pipeline_definitions d
        LEFT JOIN kernel.pipeline_revisions r
          ON r.pipeline_id=d.pipeline_id AND r.revision=d.latest_revision
        WHERE d.pipeline_id=$1
        "#,
    )
    .bind(&pipeline_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        AppError::new(
            StatusCode::NOT_FOUND,
            "PIPELINE_NOT_FOUND",
            "pipeline not found",
        )
    })?;

    let latest_row = sqlx::query(
        "SELECT pipeline_id,revision,digest,status,published_at,definition,plan
         FROM kernel.pipeline_revisions WHERE pipeline_id=$1 AND revision=$2",
    )
    .bind(&pipeline_id)
    .bind(row.get::<i32, _>("latest_revision"))
    .fetch_optional(&state.db)
    .await?;
    let revision_rows = sqlx::query(
        "SELECT revision,digest,status,published_at FROM kernel.pipeline_revisions
         WHERE pipeline_id=$1 ORDER BY revision DESC LIMIT 20",
    )
    .bind(&pipeline_id)
    .fetch_all(&state.db)
    .await?;
    let revisions = revision_rows
        .iter()
        .map(|r| RevisionSummary {
            revision: r.get("revision"),
            digest: r.get("digest"),
            status: r.get("status"),
            published_at: r.get("published_at"),
        })
        .collect();
    Ok(Json(PipelineDetailResponse {
        pipeline_id: row.get("pipeline_id"),
        name: row.get("name"),
        latest_revision: row.get("latest_revision"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        latest: latest_row.as_ref().map(revision_view),
        revisions,
    }))
}

pub async fn list_revisions(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path(pipeline_id): Path<String>,
    Query(query): Query<RevisionListQuery>,
) -> AppResult<Json<RevisionListResponse>> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM kernel.pipeline_definitions WHERE pipeline_id=$1)",
    )
    .bind(&pipeline_id)
    .fetch_one(&state.db)
    .await?;
    if !exists {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "PIPELINE_NOT_FOUND",
            "pipeline not found",
        ));
    }
    let limit = page_limit(query.limit);
    let before = query.before.unwrap_or(i32::MAX);
    let rows = sqlx::query(
        "SELECT revision,digest,status,published_at FROM kernel.pipeline_revisions
         WHERE pipeline_id=$1 AND revision < $2 ORDER BY revision DESC LIMIT $3",
    )
    .bind(&pipeline_id)
    .bind(before)
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;
    let has_more = rows.len() as i64 > limit;
    let visible = if has_more {
        &rows[..rows.len() - 1]
    } else {
        &rows[..]
    };
    let items: Vec<RevisionSummary> = visible
        .iter()
        .map(|r| RevisionSummary {
            revision: r.get("revision"),
            digest: r.get("digest"),
            status: r.get("status"),
            published_at: r.get("published_at"),
        })
        .collect();
    let next_before = if has_more {
        items.last().map(|r| r.revision)
    } else {
        None
    };
    Ok(Json(RevisionListResponse { items, next_before }))
}

pub async fn get_revision(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path((pipeline_id, revision)): Path<(String, i32)>,
) -> AppResult<Json<RevisionView>> {
    let row = sqlx::query(
        "SELECT pipeline_id,revision,digest,status,published_at,definition,plan
         FROM kernel.pipeline_revisions WHERE pipeline_id=$1 AND revision=$2",
    )
    .bind(&pipeline_id)
    .bind(revision)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        AppError::new(
            StatusCode::NOT_FOUND,
            "PIPELINE_REVISION_NOT_FOUND",
            "revision not found",
        )
    })?;
    Ok(Json(revision_view(&row)))
}

pub async fn create_pipeline(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(mut definition): Json<PipelineDefinition>,
) -> AppResult<Json<PipelineResponse>> {
    auth.require_operator()?;
    let plan = validate_and_plan(&state, &mut definition).await?;
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
    let plan = validate_and_plan(&state, &mut definition).await?;
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

pub async fn publish_draft(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((pipeline_id, draft_id)): Path<(String, Uuid)>,
    headers: HeaderMap,
) -> AppResult<Json<PipelineResponse>> {
    auth.require_operator()?;
    let idempotency_key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .ok_or_else(|| AppError::bad_request("Idempotency-Key is required"))?
        .to_string();
    let if_match = headers
        .get("if-match")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().trim_matches('"'))
        .ok_or_else(|| AppError::bad_request("If-Match is required"))?;
    let expected: i64 = if_match
        .parse()
        .map_err(|_| AppError::bad_request("If-Match must be a draft version"))?;

    let mut tx = state.db.begin().await?;
    let draft = sqlx::query(
        "SELECT definition,version,status,created_by,published_revision,publish_idempotency_key
         FROM kernel.pipeline_drafts
         WHERE pipeline_id=$1 AND draft_id=$2 AND (created_by=$3 OR $4)
         FOR UPDATE",
    )
    .bind(&pipeline_id)
    .bind(draft_id)
    .bind(auth.user_id)
    .bind(auth.role.is_admin())
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "DRAFT_NOT_FOUND", "draft not found"))?;
    if draft.get::<String, _>("status") == "PUBLISHED" {
        let stored_key: Option<String> = draft.get("publish_idempotency_key");
        if stored_key.as_deref() != Some(idempotency_key.as_str()) {
            return Err(AppError::conflict(
                "IDEMPOTENCY_CONFLICT",
                "draft was already published with a different operation",
            ));
        }
        let revision = draft
            .get::<Option<i32>, _>("published_revision")
            .ok_or_else(|| AppError::internal("published draft has no revision"))?;
        tx.rollback().await?;
        return load_revision(&state, &pipeline_id, revision as u32)
            .await?
            .map(Json)
            .ok_or_else(|| AppError::internal("published revision is missing"));
    }
    if draft.get::<i64, _>("version") != expected {
        return Err(AppError::conflict(
            "DRAFT_VERSION_CONFLICT",
            "draft was updated by another editor",
        ));
    }
    let key_owner: Option<Uuid> = sqlx::query_scalar(
        "SELECT draft_id FROM kernel.pipeline_drafts
         WHERE publish_idempotency_key=$1 AND draft_id <> $2",
    )
    .bind(&idempotency_key)
    .bind(draft_id)
    .fetch_optional(&mut *tx)
    .await?;
    if key_owner.is_some() {
        return Err(AppError::conflict(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency-Key belongs to a different publish operation",
        ));
    }
    let stored_definition: Value = draft.get("definition");
    let mut definition: PipelineDefinition = serde_json::from_value(stored_definition)
        .map_err(|error| AppError::bad_request(format!("stored draft is invalid: {error}")))?;
    let revision: i32 = sqlx::query_scalar(
        "UPDATE kernel.pipeline_definitions
         SET latest_revision=latest_revision+1, updated_at=now()
         WHERE pipeline_id=$1
         RETURNING latest_revision",
    )
    .bind(&pipeline_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        AppError::new(
            StatusCode::NOT_FOUND,
            "PIPELINE_NOT_FOUND",
            "pipeline not found",
        )
    })?;
    definition.pipeline_id = pipeline_id.clone();
    definition.revision = revision as u32;
    definition.status = "PUBLISHED".to_string();
    let plan = match validate_and_plan(&state, &mut definition).await {
        Ok(plan) => plan,
        Err(error) => {
            tx.rollback().await?;
            return Err(error);
        }
    };
    let definition_value = serde_json::to_value(&definition)
        .map_err(|error| AppError::bad_request(error.to_string()))?;
    sqlx::query(
        "INSERT INTO kernel.pipeline_revisions (pipeline_id,revision,digest,definition,plan,status)
         VALUES ($1,$2,$3,$4,$5,'PUBLISHED')",
    )
    .bind(&pipeline_id)
    .bind(revision)
    .bind(&definition.digest)
    .bind(&definition_value)
    .bind(serde_json::to_value(&plan).unwrap_or(Value::Null))
    .execute(&mut *tx)
    .await?;
    if let Err(error) = sqlx::query(
        "UPDATE kernel.pipeline_drafts
         SET status='PUBLISHED', published_revision=$1, publish_idempotency_key=$2,
             version=version+1, updated_by=$3, updated_at=now()
         WHERE draft_id=$4",
    )
    .bind(revision)
    .bind(&idempotency_key)
    .bind(auth.user_id)
    .bind(draft_id)
    .execute(&mut *tx)
    .await
    {
        // A concurrent publish of a different draft may win the unique
        // idempotency-key index between our pre-check and this UPDATE. Roll back
        // the revision allocation and return a deterministic conflict.
        let unique_violation = error
            .as_database_error()
            .map(|db| db.code().as_deref() == Some("23505"))
            .unwrap_or(false);
        tx.rollback().await?;
        if unique_violation {
            return Err(AppError::conflict(
                "IDEMPOTENCY_CONFLICT",
                "Idempotency-Key belongs to a different publish operation",
            ));
        }
        return Err(AppError::internal(error));
    }
    tx.commit().await?;
    let _ = crate::audit::record(
        &state.db,
        "pipeline.draft_published",
        "USER",
        &auth.user_id.to_string(),
        "pipeline",
        &pipeline_id,
        "publish",
        "ACCEPTED",
        json!({"revision": revision, "digest": definition.digest, "draftId": draft_id}),
        None,
    )
    .await;
    Ok(Json(PipelineResponse {
        pipeline_id,
        revision: revision as u32,
        digest: definition.digest.clone(),
        status: "PUBLISHED".to_string(),
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
        "SELECT job_id,pipeline_id,pipeline_revision,status,current_fence,current_lease_id,attempts,max_attempts,last_error_code,submitted_by,created_at,updated_at FROM kernel.pipeline_jobs WHERE idempotency_key=$1",
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
        "INSERT INTO kernel.pipeline_jobs (job_id,pipeline_id,pipeline_revision,pipeline_digest,idempotency_key,request_digest,status,input,max_attempts,timeout_seconds,submitted_by,deadline_at) VALUES ($1,$2,$3,$4,$5,$6,'QUEUED',$7,$8,$9,$10, now() + make_interval(secs => $9))",
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
    .bind(auth.user_id)
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
        "SELECT job_id,pipeline_id,pipeline_revision,status,current_fence,current_lease_id,attempts,max_attempts,last_error_code,submitted_by,created_at,updated_at FROM kernel.pipeline_jobs WHERE job_id=$1",
    )
    .bind(job_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found("job not found"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobListQuery {
    pub limit: Option<u32>,
    pub cursor: Option<String>,
    pub pipeline_id: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobListResponse {
    pub items: Vec<JobView>,
    pub next_cursor: Option<String>,
}

fn decode_job_cursor(cursor: &str) -> AppResult<(DateTime<Utc>, Uuid)> {
    use base64::Engine;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| AppError::bad_request("invalid job cursor"))?;
    let text = String::from_utf8(raw).map_err(|_| AppError::bad_request("invalid job cursor"))?;
    let (timestamp, id) = text
        .split_once('|')
        .ok_or_else(|| AppError::bad_request("invalid job cursor"))?;
    let timestamp = DateTime::parse_from_rfc3339(timestamp)
        .map_err(|_| AppError::bad_request("invalid job cursor"))?
        .with_timezone(&Utc);
    let id = Uuid::parse_str(id).map_err(|_| AppError::bad_request("invalid job cursor"))?;
    Ok((timestamp, id))
}

fn encode_job_cursor(job: &JobView) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(format!("{}|{}", job.created_at.to_rfc3339(), job.job_id).as_bytes())
}

pub async fn list_jobs(
    State(state): State<AppState>,
    auth: AuthUser,
    Query(query): Query<JobListQuery>,
) -> AppResult<Json<JobListResponse>> {
    let limit = i64::from(query.limit.unwrap_or(20).clamp(1, 100));
    if let Some(status) = query.status.as_deref() {
        if !matches!(
            status,
            "QUEUED" | "CLAIMED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED"
        ) {
            return Err(AppError::bad_request("invalid job status filter"));
        }
    }
    let (cursor_time, cursor_id) = match query.cursor.as_deref() {
        Some(value) => {
            let (time, id) = decode_job_cursor(value)?;
            (Some(time), Some(id))
        }
        None => (None, None),
    };
    let rows = sqlx::query(
        r#"
        SELECT job_id,pipeline_id,pipeline_revision,status,current_fence,current_lease_id,
               attempts,max_attempts,last_error_code,submitted_by,created_at,updated_at
        FROM kernel.pipeline_jobs
        WHERE ($1::text IS NULL OR pipeline_id=$1)
          AND ($2::text IS NULL OR status=$2)
          AND ($3::timestamptz IS NULL OR (created_at,job_id) < ($3,$4::uuid))
          AND ($5::boolean OR submitted_by=$6)
        ORDER BY created_at DESC, job_id DESC
        LIMIT $7
        "#,
    )
    .bind(query.pipeline_id.as_deref())
    .bind(query.status.as_deref())
    .bind(cursor_time)
    .bind(cursor_id)
    .bind(!auth.role.can_operate())
    .bind(auth.user_id)
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;
    let has_more = rows.len() as i64 > limit;
    let visible = if has_more {
        &rows[..rows.len() - 1]
    } else {
        &rows[..]
    };
    let items: Vec<JobView> = visible
        .iter()
        .map(JobView::from_row)
        .collect::<Result<_, _>>()?;
    let next_cursor = if has_more {
        items.last().map(encode_job_cursor)
    } else {
        None
    };
    Ok(Json(JobListResponse { items, next_cursor }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobResultView {
    pub job_id: Uuid,
    pub status: String,
    pub output: Value,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub result_digest: Option<String>,
    pub completed_at: DateTime<Utc>,
}

pub async fn get_job_result(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(job_id): Path<Uuid>,
) -> AppResult<Json<JobResultView>> {
    require_job_access(&state, &auth, job_id, true).await?;
    let row = sqlx::query(
        "SELECT job_id,status,output,error_code,error_message,result_digest,completed_at
         FROM kernel.pipeline_job_results WHERE job_id=$1",
    )
    .bind(job_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        AppError::new(
            StatusCode::NOT_FOUND,
            "JOB_RESULT_NOT_FOUND",
            "job result not available",
        )
    })?;
    Ok(Json(JobResultView {
        job_id: row.get("job_id"),
        status: row.get("status"),
        output: row.get("output"),
        error_code: row.get("error_code"),
        error_message: row.get("error_message"),
        result_digest: row.get("result_digest"),
        completed_at: row.get("completed_at"),
    }))
}

async fn job_owner(state: &AppState, job_id: Uuid) -> AppResult<Option<Uuid>> {
    let owner: Option<Option<Uuid>> =
        sqlx::query_scalar("SELECT submitted_by FROM kernel.pipeline_jobs WHERE job_id=$1")
            .bind(job_id)
            .fetch_optional(&state.db)
            .await?;
    owner.ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "JOB_NOT_FOUND", "job not found"))
}

async fn require_job_access(
    state: &AppState,
    auth: &AuthUser,
    job_id: Uuid,
    sensitive: bool,
) -> AppResult<()> {
    let owner = job_owner(state, job_id).await?;
    if auth.role.is_admin() {
        return Ok(());
    }
    if auth.role.can_operate() {
        return if owner == Some(auth.user_id) {
            Ok(())
        } else {
            Err(AppError::new(
                StatusCode::NOT_FOUND,
                "JOB_NOT_FOUND",
                "job not found",
            ))
        };
    }
    // Viewers may read summary metadata only. Sensitive result/cancel access is
    // explicitly forbidden rather than inferred from a hidden UI button.
    if sensitive {
        return Err(AppError::forbidden(
            "job result requires operator ownership",
        ));
    }
    Ok(())
}

pub async fn get_job(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(job_id): Path<Uuid>,
) -> AppResult<Json<JobView>> {
    require_job_access(&state, &auth, job_id, false).await?;
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
    let deadline_expired: bool = sqlx::query_scalar(
        "SELECT deadline_at IS NOT NULL AND clock_timestamp() >= deadline_at FROM kernel.pipeline_jobs WHERE job_id=$1",
    )
    .bind(job_id)
    .fetch_one(&state.db)
    .await?;
    if deadline_expired {
        return Err(AppError::conflict(
            "JOB_DEADLINE_EXCEEDED",
            "snapshot access after job deadline",
        ));
    }
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

/// Result of the single authoritative terminalization transition.
#[derive(Debug, Clone, PartialEq, Eq)]
enum TerminalizeOutcome {
    Applied {
        status: &'static str,
        event_created: bool,
    },
    AlreadyTerminal {
        status: String,
    },
}

/// Everything needed to atomically record one terminal Job transition.
struct TerminalizeSpec<'a> {
    status: &'static str,
    error_code: Option<&'a str>,
    error_message: Option<&'a str>,
    output: Value,
    result_digest: Option<&'a str>,
    receipt: Option<Value>,
    lease_id: Option<Uuid>,
    worker_id: Option<&'a str>,
    event_type: &'a str,
    details: Value,
    lease_final_status: &'a str,
}

/// The only writer for a Job terminal state.
///
/// Callers must already be inside a transaction. This function takes the Job
/// row lock, so a Result, Claim, Reaper and Cancel racing on the same Job all
/// serialize here. The first terminal transition wins; later attempts become
/// idempotent no-ops (or an explicit conflict for a different terminal state).
#[allow(clippy::too_many_arguments)]
async fn terminalize_job(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    job_id: Uuid,
    spec: &TerminalizeSpec<'_>,
) -> AppResult<TerminalizeOutcome> {
    if !matches!(spec.status, "SUCCEEDED" | "FAILED" | "CANCELLED") {
        return Err(AppError::bad_request("terminal status is required"));
    }
    let row = sqlx::query(
        "SELECT status,current_fence,current_lease_id FROM kernel.pipeline_jobs WHERE job_id=$1 FOR UPDATE",
    )
    .bind(job_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| AppError::not_found("job not found"))?;
    let current_status: String = row.get("status");
    let current_fence: i64 = row.get("current_fence");
    let current_lease: Option<Uuid> = row.get("current_lease_id");
    if matches!(
        current_status.as_str(),
        "SUCCEEDED" | "FAILED" | "CANCELLED"
    ) {
        return Ok(TerminalizeOutcome::AlreadyTerminal {
            status: current_status,
        });
    }

    let existing_result: Option<String> =
        sqlx::query_scalar("SELECT status FROM kernel.pipeline_job_results WHERE job_id=$1")
            .bind(job_id)
            .fetch_optional(&mut **tx)
            .await?;
    if let Some(existing) = existing_result {
        if existing == spec.status && current_status == spec.status {
            return Ok(TerminalizeOutcome::AlreadyTerminal {
                status: current_status,
            });
        }
        return Err(AppError::conflict(
            "TERMINAL_RESULT_CONFLICT",
            "job already has a different terminal result",
        ));
    }

    sqlx::query(
        "UPDATE kernel.pipeline_jobs SET status=$2,last_error_code=$3,updated_at=now() WHERE job_id=$1",
    )
    .bind(job_id)
    .bind(spec.status)
    .bind(spec.error_code)
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        "UPDATE kernel.pipeline_job_leases SET status=$2 WHERE job_id=$1 AND status='ACTIVE'",
    )
    .bind(job_id)
    .bind(spec.lease_final_status)
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        "UPDATE kernel.pipeline_job_attempts SET status=$2,finished_at=now(),error_code=$3 WHERE job_id=$1 AND status IN ('CLAIMED','RUNNING')",
    )
    .bind(job_id)
    .bind(spec.status)
    .bind(spec.error_code)
    .execute(&mut **tx)
    .await?;

    let lease_id = spec.lease_id.or(current_lease);
    let inserted = sqlx::query(
        "INSERT INTO kernel.pipeline_job_results (job_id,fencing_sequence,status,output,error_code,error_message,result_digest,receipt,lease_id,worker_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (job_id) DO NOTHING",
    )
    .bind(job_id)
    .bind(current_fence)
    .bind(spec.status)
    .bind(&spec.output)
    .bind(spec.error_code)
    .bind(spec.error_message)
    .bind(spec.result_digest)
    .bind(spec.receipt.as_ref())
    .bind(lease_id)
    .bind(spec.worker_id)
    .execute(&mut **tx)
    .await?;
    if inserted.rows_affected() == 0 {
        let existing: String =
            sqlx::query_scalar("SELECT status FROM kernel.pipeline_job_results WHERE job_id=$1")
                .bind(job_id)
                .fetch_one(&mut **tx)
                .await?;
        if existing != spec.status {
            return Err(AppError::conflict(
                "TERMINAL_RESULT_CONFLICT",
                "job already has a different terminal result",
            ));
        }
    }

    sqlx::query(
        "INSERT INTO kernel.pipeline_job_events (job_id,event_type,from_status,to_status,fencing_sequence,worker_id,details)
         VALUES ($1,$2,$3,$4,$5,$6,$7)",
    )
    .bind(job_id)
    .bind(spec.event_type)
    .bind(&current_status)
    .bind(spec.status)
    .bind(current_fence)
    .bind(spec.worker_id)
    .bind(&spec.details)
    .execute(&mut **tx)
    .await?;

    Ok(TerminalizeOutcome::Applied {
        status: spec.status,
        event_created: true,
    })
}

async fn audit_terminalization(
    state: &AppState,
    job_id: Uuid,
    status: &str,
    error_code: Option<&str>,
    actor_type: &str,
    actor_id: &str,
) {
    // Audit is intentionally after the Job transaction commits: no external
    // HTTP/audit operation runs while holding the Job row lock.
    let _ = crate::audit::record(
        &state.db,
        "pipeline.job_terminalized",
        actor_type,
        actor_id,
        "job",
        &job_id.to_string(),
        "terminalize",
        if status == "SUCCEEDED" {
            "ACCEPTED"
        } else {
            "REJECTED"
        },
        json!({"status": status, "errorCode": error_code}),
        None,
    )
    .await;
}

async fn audit_reaped(state: &AppState, reaped: &[(Uuid, &'static str)]) {
    for (job_id, code) in reaped {
        audit_terminalization(state, *job_id, "FAILED", Some(*code), "SYSTEM", "reaper").await;
    }
}

/// Bounded reaper. Candidate rows are locked with SKIP LOCKED and terminalized
/// individually through the same service used by Claim/Result/Cancel.
async fn reap_terminal_jobs(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    limit: i64,
) -> AppResult<Vec<(Uuid, &'static str)>> {
    let rows = sqlx::query(
        "SELECT j.job_id,
                CASE
                  WHEN j.deadline_at IS NOT NULL AND j.deadline_at <= clock_timestamp()
                    THEN 'JOB_DEADLINE_EXCEEDED'
                  ELSE 'JOB_ATTEMPTS_EXHAUSTED'
                END AS terminal_code
         FROM kernel.pipeline_jobs j
         WHERE j.status IN ('QUEUED','CLAIMED','RUNNING')
           AND (
             (j.deadline_at IS NOT NULL AND j.deadline_at <= clock_timestamp())
             OR (j.attempts >= j.max_attempts
                 AND NOT EXISTS (
                   SELECT 1 FROM kernel.pipeline_job_leases l
                   WHERE l.job_id=j.job_id AND l.status='ACTIVE'
                     AND l.expires_at > clock_timestamp()
                 ))
           )
         ORDER BY j.created_at ASC, j.job_id ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED",
    )
    .bind(limit)
    .fetch_all(&mut **tx)
    .await?;
    let mut reaped = Vec::new();
    for row in rows {
        let job_id: Uuid = row.get("job_id");
        let code: String = row.get("terminal_code");
        let code: &'static str = if code == "JOB_DEADLINE_EXCEEDED" {
            "JOB_DEADLINE_EXCEEDED"
        } else {
            "JOB_ATTEMPTS_EXHAUSTED"
        };
        let outcome = terminalize_job(
            tx,
            job_id,
            &TerminalizeSpec {
                status: "FAILED",
                error_code: Some(code),
                error_message: Some("job terminalized by durable reaper"),
                output: json!({}),
                result_digest: None,
                receipt: None,
                lease_id: None,
                worker_id: None,
                event_type: code,
                details: json!({"reaped": true, "reason": code}),
                lease_final_status: "REVOKED",
            },
        )
        .await?;
        if let TerminalizeOutcome::Applied { .. } = outcome {
            reaped.push((job_id, code));
        }
    }
    Ok(reaped)
}

pub async fn claim_next(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(worker): Json<WorkerIdentity>,
) -> AppResult<axum::response::Response> {
    let trusted = authenticate_worker(&state, &headers, &worker).await?;
    let mut tx = state.db.begin().await?;
    // Bounded reaper: never a full-table UPDATE. Candidate rows are locked with
    // SKIP LOCKED and each transition goes through the single service below.
    let reaped = match reap_terminal_jobs(&mut tx, 100).await {
        Ok(reaped) => reaped,
        Err(error) => {
            tx.rollback().await.ok();
            return Err(error);
        }
    };
    let mut attempts = 0u8;
    loop {
        attempts += 1;
        let job_id: Option<Uuid> = sqlx::query_scalar(
            "SELECT j.job_id FROM kernel.pipeline_jobs j
             WHERE j.status IN ('QUEUED','CLAIMED','RUNNING')
               AND j.attempts < j.max_attempts
               AND (j.deadline_at IS NULL OR j.deadline_at > clock_timestamp())
               AND NOT EXISTS (
                 SELECT 1 FROM kernel.pipeline_job_leases l
                 WHERE l.job_id=j.job_id AND l.status='ACTIVE' AND l.expires_at > clock_timestamp()
               )
             ORDER BY j.created_at ASC, j.job_id ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 1",
        )
        .fetch_optional(&mut *tx)
        .await?;
        let Some(job_id) = job_id else {
            tx.commit().await?;
            audit_reaped(&state, &reaped).await;
            return Ok(StatusCode::NO_CONTENT.into_response());
        };
        match claim_core(&mut tx, job_id, &trusted, &worker.version).await {
            Ok(ClaimOutcome::Claimed(response)) => {
                tx.commit().await?;
                audit_reaped(&state, &reaped).await;
                return Ok(Json(response).into_response());
            }
            Ok(ClaimOutcome::Terminalized(code)) => {
                tx.commit().await?;
                audit_reaped(&state, &reaped).await;
                audit_terminalization(&state, job_id, "FAILED", Some(code), "SYSTEM", "claim")
                    .await;
                return Err(AppError::conflict(code, "job reached a terminal state"));
            }
            Err(error)
                if matches!(
                    error.code,
                    "JOB_ALREADY_CLAIMED" | "JOB_NOT_CLAIMABLE" | "JOB_NOT_RUNNING"
                ) =>
            {
                // A concurrent claimant won this candidate. The row stays locked
                // by this transaction, so the next SKIP LOCKED probe chooses a
                // different queued Job. Bounded retry avoids a spurious 409 for a
                // claim-next request that still has work available.
                if attempts >= 8 {
                    tx.rollback().await.ok();
                    return Err(AppError::conflict(
                        "CLAIM_CONTENTION",
                        "claim-next could not find an uncontended job",
                    ));
                }
                continue;
            }
            Err(error) => {
                tx.rollback().await.ok();
                return Err(error);
            }
        }
    }
}

enum ClaimOutcome {
    Claimed(ClaimResponse),
    Terminalized(&'static str),
}

async fn claim_core(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    job_id: Uuid,
    trusted: &WorkerContext,
    worker_version: &str,
) -> AppResult<ClaimOutcome> {
    let row = sqlx::query(
        "SELECT status,current_fence,current_lease_id,attempts,max_attempts,deadline_at FROM kernel.pipeline_jobs WHERE job_id=$1 FOR UPDATE",
    )
    .bind(job_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| AppError::not_found("job not found"))?;
    let status: String = row.get("status");
    let current_fence: i64 = row.get("current_fence");
    let current_lease: Option<Uuid> = row.get("current_lease_id");
    let attempts: i32 = row.get("attempts");
    let max_attempts: i32 = row.get("max_attempts");
    let deadline_at: Option<DateTime<Utc>> = row.get("deadline_at");
    let deadline_expired: bool = sqlx::query_scalar(
        "SELECT deadline_at IS NOT NULL AND clock_timestamp() >= deadline_at FROM kernel.pipeline_jobs WHERE job_id=$1",
    )
    .bind(job_id)
    .fetch_one(&mut **tx)
    .await?;
    if deadline_expired {
        let outcome = terminalize_job(
            tx,
            job_id,
            &TerminalizeSpec {
                status: "FAILED",
                error_code: Some("JOB_DEADLINE_EXCEEDED"),
                error_message: Some("job execution deadline has passed"),
                output: json!({}),
                result_digest: None,
                receipt: None,
                lease_id: None,
                worker_id: None,
                event_type: "JOB_DEADLINE_EXCEEDED",
                details: json!({"deadlineAt": deadline_at}),
                lease_final_status: "REVOKED",
            },
        )
        .await?;
        return match outcome {
            TerminalizeOutcome::Applied { .. } => {
                Ok(ClaimOutcome::Terminalized("JOB_DEADLINE_EXCEEDED"))
            }
            TerminalizeOutcome::AlreadyTerminal { .. } => Err(AppError::conflict(
                "JOB_NOT_CLAIMABLE",
                "job reached a terminal state",
            )),
        };
    }
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
        .fetch_optional(&mut **tx)
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
        let outcome = terminalize_job(
            tx,
            job_id,
            &TerminalizeSpec {
                status: "FAILED",
                error_code: Some("JOB_ATTEMPTS_EXHAUSTED"),
                error_message: Some("job attempts are exhausted"),
                output: json!({}),
                result_digest: None,
                receipt: None,
                lease_id: None,
                worker_id: None,
                event_type: "JOB_ATTEMPTS_EXHAUSTED",
                details: json!({"attempts": attempts, "maxAttempts": max_attempts}),
                lease_final_status: "REVOKED",
            },
        )
        .await?;
        return match outcome {
            TerminalizeOutcome::Applied { .. } => {
                Ok(ClaimOutcome::Terminalized("JOB_ATTEMPTS_EXHAUSTED"))
            }
            TerminalizeOutcome::AlreadyTerminal { .. } => Err(AppError::conflict(
                "JOB_NOT_CLAIMABLE",
                "job reached a terminal state",
            )),
        };
    }
    sqlx::query("UPDATE kernel.pipeline_job_leases SET status='EXPIRED' WHERE job_id=$1 AND status='ACTIVE'")
        .bind(job_id)
        .execute(&mut **tx)
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
    .execute(&mut **tx)
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
    .execute(&mut **tx)
    .await?;
    sqlx::query("UPDATE kernel.pipeline_jobs SET status='CLAIMED',current_fence=$2,current_lease_id=$3,attempts=$4,updated_at=now() WHERE job_id=$1")
        .bind(job_id)
        .bind(fence)
        .bind(lease_id)
        .bind(attempt)
        .execute(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO kernel.pipeline_job_events (job_id,event_type,from_status,to_status,fencing_sequence,worker_id,details) VALUES ($1,'JOB_CLAIMED',$2,'CLAIMED',$3,$4,$5)")
        .bind(job_id)
        .bind(&status)
        .bind(fence)
        .bind(&trusted.worker_id)
        .bind(json!({"workerVersion": worker_version}))
        .execute(&mut **tx)
        .await?;
    Ok(ClaimOutcome::Claimed(ClaimResponse {
        lease_id,
        job_id,
        attempt_number: attempt,
        fencing_sequence: fence,
        expires_at,
        worker_id: trusted.worker_id.clone(),
    }))
}

pub async fn claim_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<Uuid>,
    Json(worker): Json<WorkerIdentity>,
) -> AppResult<Json<ClaimResponse>> {
    let trusted = authenticate_worker(&state, &headers, &worker).await?;
    let mut tx = state.db.begin().await?;
    let response = match claim_core(&mut tx, job_id, &trusted, &worker.version).await {
        Ok(ClaimOutcome::Claimed(response)) => {
            tx.commit().await?;
            response
        }
        Ok(ClaimOutcome::Terminalized(code)) => {
            tx.commit().await?;
            audit_terminalization(&state, job_id, "FAILED", Some(code), "SYSTEM", "claim").await;
            return Err(AppError::conflict(code, "job reached a terminal state"));
        }
        Err(error) => {
            tx.rollback().await.ok();
            return Err(error);
        }
    };
    Ok(Json(response))
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
    let deadline_expired: bool = sqlx::query_scalar(
        "SELECT deadline_at IS NOT NULL AND clock_timestamp() >= deadline_at FROM kernel.pipeline_jobs WHERE job_id=$1",
    )
    .bind(job_id)
    .fetch_one(&mut **tx)
    .await?;
    if deadline_expired {
        return Err(AppError::conflict(
            "JOB_DEADLINE_EXCEEDED",
            "job execution deadline has passed",
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
    let deadline_at: Option<DateTime<Utc>> =
        sqlx::query_scalar("SELECT deadline_at FROM kernel.pipeline_jobs WHERE job_id=$1")
            .bind(job_id)
            .fetch_one(&mut *tx)
            .await?;
    if deadline_at.is_some_and(|deadline| deadline <= Utc::now()) {
        return Err(AppError::conflict(
            "JOB_DEADLINE_EXCEEDED",
            "job execution deadline has passed",
        ));
    }
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

async fn verify_effect_set(
    state: &AppState,
    job_id: Uuid,
    effects: &[Value],
    batch_count: u64,
    accepted_total: u64,
) -> AppResult<()> {
    let row = sqlx::query(
        "SELECT j.pipeline_id,j.pipeline_revision,r.definition FROM kernel.pipeline_jobs j JOIN kernel.pipeline_revisions r ON r.pipeline_id=j.pipeline_id AND r.revision=j.pipeline_revision WHERE j.job_id=$1",
    )
    .bind(job_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::bad_request("job revision is not pinned"))?;
    let pipeline_id: String = row.get("pipeline_id");
    let revision: i32 = row.get("pipeline_revision");
    let definition: Value = row.get("definition");
    let sink = definition
        .get("nodes")
        .and_then(Value::as_array)
        .and_then(|nodes| {
            nodes.iter().find(|node| {
                node.get("type").and_then(Value::as_str) == Some("builtin.sink.dataset")
            })
        })
        .ok_or_else(|| AppError::bad_request("pinned revision has no sink"))?;
    let sink_node_id = sink
        .get("nodeId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::bad_request("pinned sink has no node id"))?;
    let config = sink.get("config").unwrap_or(&Value::Null);
    let dataset_id = config
        .get("datasetId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::bad_request("pinned sink has no dataset"))?;
    let schema_revision = config
        .get("schemaRevision")
        .and_then(Value::as_u64)
        .unwrap_or(1);
    if effects.len() as u64 != batch_count || effects.is_empty() {
        return Err(AppError::bad_request(
            "effect set does not match batch count",
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut verified_accepted = 0u64;
    for (index, effect) in effects.iter().enumerate() {
        let expected_logical = format!("batch-{}", index + 1);
        let expected_effect = format!(
            "efx:{}",
            hex::encode(<sha2::Sha256 as sha2::Digest>::digest(
                canonical_json(&json!({
                    "jobId": job_id,
                    "pipelineId": pipeline_id,
                    "pipelineRevision": revision,
                    "sinkNodeId": sink_node_id,
                    "logicalBatchId": expected_logical
                }))
                .as_bytes()
            ))
        );
        let claimed_id = effect
            .get("effectId")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::bad_request("effect id is missing"))?;
        let claimed_digest = effect
            .get("requestDigest")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::bad_request("effect digest is missing"))?;
        if claimed_id != expected_effect || !seen.insert(claimed_id.to_string()) {
            return Err(AppError::bad_request(
                "effect identity is not the pinned batch identity",
            ));
        }
        let receipt = crate::capabilities::service_catalog_get(
            state,
            &format!(
                "/api/data-catalog/datasets/{dataset_id}/effect-receipts?effectId={expected_effect}"
            ),
        )
        .await
        .map_err(|_| {
            AppError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "EFFECT_VERIFICATION_UNAVAILABLE",
                "Catalog effect verification failed",
            )
        })?;
        let committed = receipt.get("status").and_then(Value::as_str) == Some("COMMITTED")
            && receipt.get("jobId").and_then(Value::as_str) == Some(job_id.to_string().as_str())
            && receipt.get("pipelineId").and_then(Value::as_str) == Some(pipeline_id.as_str())
            && receipt.get("pipelineRevision").and_then(Value::as_u64) == Some(revision as u64)
            && receipt.get("sinkNodeId").and_then(Value::as_str) == Some(sink_node_id)
            && receipt.get("datasetId").and_then(Value::as_str) == Some(dataset_id)
            && receipt.get("schemaRevision").and_then(Value::as_u64) == Some(schema_revision)
            && receipt.get("requestDigest").and_then(Value::as_str) == Some(claimed_digest);
        if !committed {
            return Err(AppError::conflict(
                "EFFECT_NOT_COMMITTED",
                "Catalog receipt does not prove the committed effect set",
            ));
        }
        if receipt.get("rejected").and_then(Value::as_u64) != Some(0)
            || receipt.get("unknown").and_then(Value::as_u64) != Some(0)
        {
            return Err(AppError::conflict(
                "EFFECT_PARTIAL_COMMIT",
                "Catalog receipt is not a full-success receipt",
            ));
        }
        verified_accepted += receipt
            .get("accepted")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                AppError::conflict("EFFECT_NOT_COMMITTED", "receipt accepted is missing")
            })?;
    }
    if verified_accepted != accepted_total {
        return Err(AppError::conflict(
            "ACCEPTED_TOTAL_MISMATCH",
            "receipt accepted totals do not match the job output",
        ));
    }
    Ok(())
}

pub async fn result(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<Uuid>,
    Json(request): Json<ResultRequest>,
) -> AppResult<Json<JobView>> {
    let trusted = authenticate_worker_header_only(&state, &headers).await?;
    let terminal: &'static str = match request.status.as_str() {
        "SUCCEEDED" => "SUCCEEDED",
        "FAILED" => "FAILED",
        "CANCELLED" => "CANCELLED",
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
    if terminal == "SUCCEEDED" {
        let batches = request
            .output
            .get("batches")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let accepted = request
            .output
            .get("accepted")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        verify_effect_set(&state, job_id, &request.effects, batches, accepted).await?;
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
    let outcome = terminalize_job(
        &mut tx,
        job_id,
        &TerminalizeSpec {
            status: terminal,
            error_code: request.error_code.as_deref(),
            error_message: request.error_message.as_deref(),
            output: request.output.clone(),
            result_digest: request.result_digest.as_deref(),
            receipt: request.receipt.clone(),
            lease_id: Some(request.lease_id),
            worker_id: Some(&trusted.worker_id),
            event_type: "JOB_COMPLETED",
            details: json!({"status": terminal, "errorCode": request.error_code}),
            lease_final_status: "RELEASED",
        },
    )
    .await?;
    if let TerminalizeOutcome::AlreadyTerminal { status } = outcome {
        tx.rollback().await.ok();
        return Err(AppError::conflict(
            "RESULT_ALREADY_COMMITTED",
            format!("job is already terminal: {status}"),
        ));
    }
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
    require_job_access(&state, &auth, job_id, true).await?;
    let mut tx = state.db.begin().await?;
    let outcome = match terminalize_job(
        &mut tx,
        job_id,
        &TerminalizeSpec {
            status: "CANCELLED",
            error_code: None,
            error_message: None,
            output: json!({}),
            result_digest: None,
            receipt: None,
            lease_id: None,
            worker_id: None,
            event_type: "JOB_CANCELLED",
            details: json!({"cancelledBy": "API"}),
            lease_final_status: "REVOKED",
        },
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => {
            tx.rollback().await.ok();
            return Err(error);
        }
    };
    tx.commit().await?;
    if let TerminalizeOutcome::Applied { .. } = outcome {
        audit_terminalization(
            &state,
            job_id,
            "CANCELLED",
            None,
            "USER",
            &auth.user_id.to_string(),
        )
        .await;
    }
    Ok(Json(fetch_job(&state, job_id).await?))
}

#[cfg(test)]
mod terminalization_tests {
    use super::*;
    use sqlx::PgPool;
    use tokio::sync::Mutex;

    static TEST_LOCK: Mutex<()> = Mutex::const_new(());

    #[test]
    fn pipeline_cursor_is_opaque_and_round_trips() {
        let id = "host-metrics-pipeline";
        let encoded = encode_pipeline_cursor(id);
        assert_ne!(encoded, id);
        assert_eq!(
            decode_pipeline_cursor(&encoded).unwrap().as_deref(),
            Some(id)
        );
        assert!(decode_pipeline_cursor("not*base64").is_err());
    }

    fn test_url() -> Option<String> {
        std::env::var("OPSWEAVE_TEST_DATABASE_URL").ok()
    }

    async fn test_pool() -> Option<PgPool> {
        let url = test_url()?;
        let pool = PgPool::connect(&url).await.ok()?;
        crate::db::migrate(&pool).await.ok()?;
        Some(pool)
    }

    async fn cleanup_test_data(pool: &PgPool) {
        let pipelines = "SELECT pipeline_id FROM kernel.pipeline_definitions WHERE pipeline_id LIKE 'test.terminalize.%'";
        let jobs =
            format!("SELECT job_id FROM kernel.pipeline_jobs WHERE pipeline_id IN ({pipelines})");
        for table in [
            "kernel.pipeline_job_events",
            "kernel.pipeline_job_results",
            "kernel.pipeline_job_snapshots",
            "kernel.pipeline_job_checkpoints",
            "kernel.pipeline_job_leases",
            "kernel.pipeline_job_attempts",
        ] {
            let sql = format!("DELETE FROM {table} WHERE job_id IN ({jobs})");
            sqlx::query(&sql).execute(pool).await.unwrap();
        }
        let sql = format!("DELETE FROM kernel.pipeline_jobs WHERE pipeline_id IN ({pipelines})");
        sqlx::query(&sql).execute(pool).await.unwrap();
        let sql =
            format!("DELETE FROM kernel.pipeline_revisions WHERE pipeline_id IN ({pipelines})");
        sqlx::query(&sql).execute(pool).await.unwrap();
        let sql =
            format!("DELETE FROM kernel.pipeline_definitions WHERE pipeline_id IN ({pipelines})");
        sqlx::query(&sql).execute(pool).await.unwrap();
    }

    async fn new_pipeline(pool: &PgPool) -> String {
        let pipeline = format!("test.terminalize.{}", Uuid::new_v4());
        sqlx::query(
            "INSERT INTO kernel.pipeline_definitions (pipeline_id,latest_revision) VALUES ($1,1)",
        )
        .bind(&pipeline)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO kernel.pipeline_revisions (pipeline_id,revision,digest,definition,plan,status) VALUES ($1,1,$2,'{}'::jsonb,'{}'::jsonb,'PUBLISHED')")
            .bind(&pipeline)
            .bind(format!("sha256:{}", "a".repeat(64)))
            .execute(pool)
            .await
            .unwrap();
        pipeline
    }

    async fn add_job(
        pool: &PgPool,
        pipeline: &str,
        attempts: i32,
        max_attempts: i32,
        deadline: Option<DateTime<Utc>>,
    ) -> Uuid {
        let job = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.pipeline_jobs
             (job_id,pipeline_id,pipeline_revision,pipeline_digest,idempotency_key,request_digest,status,input,attempts,max_attempts,deadline_at)
             VALUES ($1,$2,1,$3,$4,$5,'QUEUED','{}'::jsonb,$6,$7,$8)",
        )
        .bind(job)
        .bind(pipeline)
        .bind(format!("sha256:{}", "a".repeat(64)))
        .bind(format!("terminalize-key-{job}"))
        .bind(format!("sha256:{}", "b".repeat(64)))
        .bind(attempts)
        .bind(max_attempts)
        .bind(deadline)
        .execute(pool)
        .await
        .unwrap();
        job
    }

    async fn add_active_lease(
        pool: &PgPool,
        job: Uuid,
        worker: &WorkerContext,
        fence: i64,
    ) -> Uuid {
        let lease = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.pipeline_job_leases
             (lease_id,job_id,attempt_number,worker_id,node_id,instance_id,boot_id,fencing_sequence,status,expires_at)
             VALUES ($1,$2,1,$3,$4,$5,$6,$7,'ACTIVE',now()+interval '60 seconds')",
        )
        .bind(lease)
        .bind(job)
        .bind(&worker.worker_id)
        .bind(worker.node_id)
        .bind(worker.instance_id)
        .bind(worker.boot_id)
        .bind(fence)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO kernel.pipeline_job_attempts
             (job_id,attempt_number,worker_id,node_id,instance_id,boot_id,lease_id,fencing_sequence,status)
             VALUES ($1,1,$2,$3,$4,$5,$6,$7,'RUNNING')",
        )
        .bind(job)
        .bind(&worker.worker_id)
        .bind(worker.node_id)
        .bind(worker.instance_id)
        .bind(worker.boot_id)
        .bind(lease)
        .bind(fence)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("UPDATE kernel.pipeline_jobs SET status='RUNNING',current_fence=$2,current_lease_id=$3,attempts=1 WHERE job_id=$1")
            .bind(job)
            .bind(fence)
            .bind(lease)
            .execute(pool)
            .await
            .unwrap();
        lease
    }

    fn worker() -> WorkerContext {
        WorkerContext {
            node_id: Uuid::new_v4(),
            instance_id: Uuid::new_v4(),
            boot_id: Uuid::new_v4(),
            worker_id: format!(
                "n:{}:i:{}:b:{}",
                Uuid::new_v4(),
                Uuid::new_v4(),
                Uuid::new_v4()
            ),
        }
    }

    async fn row_counts(pool: &PgPool, job: Uuid) -> (String, i64, i64, i64, i64) {
        let status: String =
            sqlx::query_scalar("SELECT status FROM kernel.pipeline_jobs WHERE job_id=$1")
                .bind(job)
                .fetch_one(pool)
                .await
                .unwrap();
        let leases: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.pipeline_job_leases WHERE job_id=$1 AND status='ACTIVE'",
        )
        .bind(job)
        .fetch_one(pool)
        .await
        .unwrap();
        let attempts: i64 = sqlx::query_scalar("SELECT count(*) FROM kernel.pipeline_job_attempts WHERE job_id=$1 AND status IN ('CLAIMED','RUNNING')")
            .bind(job).fetch_one(pool).await.unwrap();
        let results: i64 =
            sqlx::query_scalar("SELECT count(*) FROM kernel.pipeline_job_results WHERE job_id=$1")
                .bind(job)
                .fetch_one(pool)
                .await
                .unwrap();
        let events: i64 =
            sqlx::query_scalar("SELECT count(*) FROM kernel.pipeline_job_events WHERE job_id=$1")
                .bind(job)
                .fetch_one(pool)
                .await
                .unwrap();
        (status, leases, attempts, results, events)
    }

    #[tokio::test]
    async fn terminalize_is_single_writer_and_idempotent() {
        let _guard = TEST_LOCK.lock().await;
        let Some(pool) = test_pool().await else {
            return;
        };
        cleanup_test_data(&pool).await;
        let pipeline = new_pipeline(&pool).await;
        let job = add_job(&pool, &pipeline, 0, 3, None).await;
        let w = worker();
        add_active_lease(&pool, job, &w, 1).await;
        let mut tx = pool.begin().await.unwrap();
        let first = terminalize_job(
            &mut tx,
            job,
            &TerminalizeSpec {
                status: "FAILED",
                error_code: Some("WORKER_FAILED"),
                error_message: Some("test"),
                output: json!({}),
                result_digest: None,
                receipt: None,
                lease_id: None,
                worker_id: Some(&w.worker_id),
                event_type: "JOB_COMPLETED",
                details: json!({"test": true}),
                lease_final_status: "REVOKED",
            },
        )
        .await
        .unwrap();
        assert!(matches!(first, TerminalizeOutcome::Applied { .. }));
        tx.commit().await.unwrap();
        let mut tx = pool.begin().await.unwrap();
        let second = terminalize_job(
            &mut tx,
            job,
            &TerminalizeSpec {
                status: "FAILED",
                error_code: Some("WORKER_FAILED"),
                error_message: Some("test"),
                output: json!({}),
                result_digest: None,
                receipt: None,
                lease_id: None,
                worker_id: Some(&w.worker_id),
                event_type: "JOB_COMPLETED",
                details: json!({"test": true}),
                lease_final_status: "REVOKED",
            },
        )
        .await
        .unwrap();
        assert!(matches!(second, TerminalizeOutcome::AlreadyTerminal { .. }));
        tx.commit().await.unwrap();
        let (status, leases, attempts, results, events) = row_counts(&pool, job).await;
        assert_eq!(status, "FAILED");
        assert_eq!((leases, attempts, results, events), (0, 0, 1, 1));
    }

    #[tokio::test]
    async fn reaper_deadline_wins_and_is_bounded() {
        let _guard = TEST_LOCK.lock().await;
        let Some(pool) = test_pool().await else {
            return;
        };
        cleanup_test_data(&pool).await;
        let pipeline = new_pipeline(&pool).await;
        let both = add_job(
            &pool,
            &pipeline,
            3,
            3,
            Some(Utc::now() - Duration::seconds(1)),
        )
        .await;
        let attempts = add_job(&pool, &pipeline, 3, 3, None).await;
        let deadline = add_job(
            &pool,
            &pipeline,
            0,
            3,
            Some(Utc::now() - Duration::seconds(1)),
        )
        .await;
        let mut tx = pool.begin().await.unwrap();
        let reaped = reap_terminal_jobs(&mut tx, 100).await.unwrap();
        tx.commit().await.unwrap();
        let ours: Vec<_> = reaped
            .iter()
            .filter(|(job, _)| [both, attempts, deadline].contains(job))
            .collect();
        assert_eq!(ours.len(), 3);
        assert_eq!(
            ours.iter()
                .filter(|(_, code)| *code == "JOB_DEADLINE_EXCEEDED")
                .count(),
            2
        );
        assert_eq!(
            ours.iter()
                .filter(|(_, code)| *code == "JOB_ATTEMPTS_EXHAUSTED")
                .count(),
            1
        );
        for job in [both, attempts, deadline] {
            let (status, leases, attempts_active, results, events) = row_counts(&pool, job).await;
            assert_eq!(status, "FAILED");
            assert_eq!((leases, attempts_active, results, events), (0, 0, 1, 1));
        }
        let mut tx = pool.begin().await.unwrap();
        assert!(reap_terminal_jobs(&mut tx, 100).await.unwrap().is_empty());
        tx.commit().await.unwrap();
    }

    #[tokio::test]
    async fn reaper_batch_is_bounded() {
        let _guard = TEST_LOCK.lock().await;
        let Some(pool) = test_pool().await else {
            return;
        };
        cleanup_test_data(&pool).await;
        let pipeline = new_pipeline(&pool).await;
        for _ in 0..105 {
            add_job(
                &pool,
                &pipeline,
                0,
                3,
                Some(Utc::now() - Duration::seconds(1)),
            )
            .await;
        }
        let mut terminal = 0i64;
        for _ in 0..4 {
            let mut tx = pool.begin().await.unwrap();
            let batch = reap_terminal_jobs(&mut tx, 100).await.unwrap();
            tx.commit().await.unwrap();
            assert!(batch.len() <= 100);
            terminal = sqlx::query_scalar(
                "SELECT count(*) FROM kernel.pipeline_jobs WHERE pipeline_id=$1 AND status='FAILED'",
            )
            .bind(&pipeline)
            .fetch_one(&pool)
            .await
            .unwrap();
            if terminal == 105 {
                break;
            }
        }
        assert_eq!(terminal, 105);
    }

    #[tokio::test]
    async fn reaper_and_claim_serialize_on_job_lock() {
        let _guard = TEST_LOCK.lock().await;
        let Some(pool) = test_pool().await else {
            return;
        };
        cleanup_test_data(&pool).await;
        let pipeline = new_pipeline(&pool).await;
        let job = add_job(
            &pool,
            &pipeline,
            0,
            3,
            Some(Utc::now() - Duration::seconds(1)),
        )
        .await;
        let mut reap_tx = pool.begin().await.unwrap();
        assert_eq!(reap_terminal_jobs(&mut reap_tx, 10).await.unwrap().len(), 1);
        let claim_pool = pool.clone();
        let claim_worker = worker();
        let claim = tokio::spawn(async move {
            let mut tx = claim_pool.begin().await.unwrap();
            claim_core(&mut tx, job, &claim_worker, "test").await
        });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        reap_tx.commit().await.unwrap();
        let result = claim.await.unwrap();
        assert!(
            matches!(result, Err(AppError { .. }))
                || matches!(result, Ok(ClaimOutcome::Terminalized(_)))
        );
        let (status, leases, attempts_active, results, events) = row_counts(&pool, job).await;
        assert_eq!(status, "FAILED");
        assert_eq!((leases, attempts_active, results, events), (0, 0, 1, 1));
    }

    #[tokio::test]
    async fn reaper_and_cancel_have_one_authority() {
        let _guard = TEST_LOCK.lock().await;
        let Some(pool) = test_pool().await else {
            return;
        };
        cleanup_test_data(&pool).await;
        let pipeline = new_pipeline(&pool).await;
        let job = add_job(
            &pool,
            &pipeline,
            0,
            3,
            Some(Utc::now() - Duration::seconds(1)),
        )
        .await;
        let mut reap_tx = pool.begin().await.unwrap();
        assert_eq!(reap_terminal_jobs(&mut reap_tx, 10).await.unwrap().len(), 1);
        let cancel_pool = pool.clone();
        let cancel = tokio::spawn(async move {
            let mut tx = cancel_pool.begin().await.unwrap();
            terminalize_job(
                &mut tx,
                job,
                &TerminalizeSpec {
                    status: "CANCELLED",
                    error_code: None,
                    error_message: None,
                    output: json!({}),
                    result_digest: None,
                    receipt: None,
                    lease_id: None,
                    worker_id: None,
                    event_type: "JOB_CANCELLED",
                    details: json!({}),
                    lease_final_status: "REVOKED",
                },
            )
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        reap_tx.commit().await.unwrap();
        let result = cancel.await.unwrap();
        assert!(matches!(
            result,
            Ok(TerminalizeOutcome::AlreadyTerminal { .. })
        ));
        let (status, leases, attempts_active, results, events) = row_counts(&pool, job).await;
        assert_eq!(status, "FAILED");
        assert_eq!((leases, attempts_active, results, events), (0, 0, 1, 1));
    }

    #[tokio::test]
    async fn reaper_and_result_have_one_terminal_authority() {
        let _guard = TEST_LOCK.lock().await;
        let Some(pool) = test_pool().await else {
            return;
        };
        cleanup_test_data(&pool).await;
        let pipeline = new_pipeline(&pool).await;
        let job = add_job(
            &pool,
            &pipeline,
            0,
            3,
            Some(Utc::now() - Duration::seconds(1)),
        )
        .await;
        let w = worker();
        add_active_lease(&pool, job, &w, 1).await;
        let mut reap_tx = pool.begin().await.unwrap();
        assert_eq!(reap_terminal_jobs(&mut reap_tx, 10).await.unwrap().len(), 1);
        let result_pool = pool.clone();
        let result = tokio::spawn(async move {
            let mut tx = result_pool.begin().await.unwrap();
            terminalize_job(
                &mut tx,
                job,
                &TerminalizeSpec {
                    status: "SUCCEEDED",
                    error_code: None,
                    error_message: None,
                    output: json!({}),
                    result_digest: Some("sha256:test"),
                    receipt: None,
                    lease_id: None,
                    worker_id: None,
                    event_type: "JOB_COMPLETED",
                    details: json!({}),
                    lease_final_status: "RELEASED",
                },
            )
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        reap_tx.commit().await.unwrap();
        assert!(matches!(
            result.await.unwrap(),
            Ok(TerminalizeOutcome::AlreadyTerminal { .. })
        ));
        let (status, leases, attempts_active, results, events) = row_counts(&pool, job).await;
        assert_eq!(status, "FAILED");
        assert_eq!((leases, attempts_active, results, events), (0, 0, 1, 1));
        let result_status: String =
            sqlx::query_scalar("SELECT status FROM kernel.pipeline_job_results WHERE job_id=$1")
                .bind(job)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(result_status, "FAILED");
    }

    #[tokio::test]
    async fn concurrent_reapers_do_not_duplicate_transitions() {
        let _guard = TEST_LOCK.lock().await;
        let Some(pool) = test_pool().await else {
            return;
        };
        cleanup_test_data(&pool).await;
        let pipeline = new_pipeline(&pool).await;
        let mut jobs = Vec::new();
        for _ in 0..20 {
            jobs.push(
                add_job(
                    &pool,
                    &pipeline,
                    0,
                    3,
                    Some(Utc::now() - Duration::seconds(1)),
                )
                .await,
            );
        }
        let pool_a = pool.clone();
        let pool_b = pool.clone();
        let a = tokio::spawn(async move {
            let mut tx = pool_a.begin().await.unwrap();
            let n = reap_terminal_jobs(&mut tx, 20).await.unwrap().len();
            tx.commit().await.unwrap();
            n
        });
        let b = tokio::spawn(async move {
            let mut tx = pool_b.begin().await.unwrap();
            let n = reap_terminal_jobs(&mut tx, 20).await.unwrap().len();
            tx.commit().await.unwrap();
            n
        });
        let mut total = a.await.unwrap() + b.await.unwrap();
        if total < jobs.len() {
            let mut tx = pool.begin().await.unwrap();
            total += reap_terminal_jobs(&mut tx, 100).await.unwrap().len();
            tx.commit().await.unwrap();
        }
        assert!(total >= jobs.len());
        for job in jobs {
            let (status, leases, attempts_active, results, events) = row_counts(&pool, job).await;
            assert_eq!(status, "FAILED");
            assert_eq!((leases, attempts_active, results, events), (0, 0, 1, 1));
        }
    }

    #[tokio::test]
    async fn terminalization_sql_failure_rolls_back_everything() {
        let _guard = TEST_LOCK.lock().await;
        let Some(pool) = test_pool().await else {
            return;
        };
        cleanup_test_data(&pool).await;
        let pipeline = new_pipeline(&pool).await;
        let job = add_job(&pool, &pipeline, 0, 3, None).await;
        let w = worker();
        add_active_lease(&pool, job, &w, 1).await;
        let trigger = format!("fail_term_event_{}", Uuid::new_v4().simple());
        let function = format!("fail_term_fn_{}", Uuid::new_v4().simple());
        sqlx::query(&format!(
            "CREATE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.job_id = '{job}' THEN RAISE EXCEPTION 'injected terminal event failure'; END IF; RETURN NEW; END $$"
        )).execute(&pool).await.unwrap();
        sqlx::query(&format!(
            "CREATE TRIGGER {trigger} BEFORE INSERT ON kernel.pipeline_job_events FOR EACH ROW EXECUTE FUNCTION {function}()"
        )).execute(&pool).await.unwrap();
        let mut tx = pool.begin().await.unwrap();
        let result = terminalize_job(
            &mut tx,
            job,
            &TerminalizeSpec {
                status: "FAILED",
                error_code: Some("INJECTED"),
                error_message: None,
                output: json!({}),
                result_digest: None,
                receipt: None,
                lease_id: None,
                worker_id: None,
                event_type: "JOB_FAILED",
                details: json!({}),
                lease_final_status: "REVOKED",
            },
        )
        .await;
        assert!(result.is_err());
        tx.rollback().await.unwrap();
        let (status, leases, attempts_active, results, events) = row_counts(&pool, job).await;
        assert_eq!(status, "RUNNING");
        assert_eq!((leases, attempts_active, results, events), (1, 1, 0, 0));
        sqlx::query(&format!(
            "DROP TRIGGER {trigger} ON kernel.pipeline_job_events"
        ))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(&format!("DROP FUNCTION {function}()"))
            .execute(&pool)
            .await
            .unwrap();
    }
}
