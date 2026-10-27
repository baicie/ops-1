use crate::audit;
use crate::auth::{hash_token, random_token, AuthUser};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use chrono::{DateTime, Duration, Utc};
use opsweave_contracts::{
    DesiredBackend, DesiredNodeState, DesiredWorkload, NodeEnrollRequest, NodeEnrollResponse,
    NodeHeartbeatRequest, NodeStatus, ResourceRequirements,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;
use uuid::Uuid;

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct NodeRow {
    pub id: Uuid,
    pub name: String,
    pub control_token_hash: String,
    pub data_token: String,
    pub generation: i64,
    pub os: String,
    pub arch: String,
    pub labels: Value,
    pub capabilities: Value,
    pub status: String,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub data_endpoint: Option<String>,
    pub runtime_adapter_version: Option<String>,
    pub resource_snapshot: Option<Value>,
    pub enrolled_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub cert_expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeView {
    pub id: Uuid,
    pub name: String,
    pub generation: i64,
    pub os: String,
    pub arch: String,
    pub labels: Value,
    pub capabilities: Value,
    pub status: String,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub data_endpoint: Option<String>,
    pub runtime_adapter_version: Option<String>,
    pub resource_snapshot: Option<Value>,
    pub enrolled_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub stale: bool,
    pub instances_ready: i64,
    pub instances_total: i64,
}

impl NodeView {
    pub fn from_row(row: &NodeRow, stale_seconds: i64, ready: i64, total: i64) -> Self {
        let stale = row
            .last_seen_at
            .map(|seen| Utc::now() - seen > Duration::seconds(stale_seconds))
            .unwrap_or(true);
        Self {
            id: row.id,
            name: row.name.clone(),
            generation: row.generation,
            os: row.os.clone(),
            arch: row.arch.clone(),
            labels: row.labels.clone(),
            capabilities: row.capabilities.clone(),
            status: if row.revoked_at.is_some() || (stale && row.status == "READY") {
                "UNREACHABLE".into()
            } else {
                row.status.clone()
            },
            last_seen_at: row.last_seen_at,
            data_endpoint: row.data_endpoint.clone(),
            runtime_adapter_version: row.runtime_adapter_version.clone(),
            resource_snapshot: row.resource_snapshot.clone(),
            enrolled_at: row.enrolled_at,
            revoked_at: row.revoked_at,
            stale,
            instances_ready: ready,
            instances_total: total,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEnrollmentTokenRequest {
    pub label: Option<String>,
    pub ttl_minutes: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollmentTokenView {
    pub token: String,
    pub expires_at: DateTime<Utc>,
    pub label: Option<String>,
}

pub async fn create_enrollment_token(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(payload): Json<CreateEnrollmentTokenRequest>,
) -> AppResult<Json<EnrollmentTokenView>> {
    auth.require_admin()?;
    let token = format!("ow_enroll_{}", random_token(32));
    let ttl = payload.ttl_minutes.unwrap_or(30).clamp(5, 24 * 60);
    let expires_at = Utc::now() + Duration::minutes(ttl);
    sqlx::query(
        "INSERT INTO kernel.node_enrollment_tokens (id, token_hash, label, created_by, expires_at) VALUES ($1,$2,$3,$4,$5)",
    )
    .bind(Uuid::new_v4())
    .bind(hash_token(&token))
    .bind(&payload.label)
    .bind(auth.user_id)
    .bind(expires_at)
    .execute(&state.db)
    .await?;
    audit::record(
        &state.db,
        "node.enrollment_token.created",
        "USER",
        &auth.user_id.to_string(),
        "enrollment_token",
        &payload.label.clone().unwrap_or_else(|| "unlabeled".into()),
        "node.enrollment_token.create",
        "CONFIRMED",
        serde_json::json!({"expiresAt": expires_at, "label": payload.label}),
        None,
    )
    .await?;
    Ok(Json(EnrollmentTokenView {
        token,
        expires_at,
        label: payload.label,
    }))
}

pub fn validate_node_data_endpoint(
    config: &crate::config::Config,
    endpoint: &str,
) -> AppResult<()> {
    let parsed = url::Url::parse(endpoint).map_err(|_| {
        AppError::bad_request("NODE_DATA_ENDPOINT_INVALID: data endpoint must be an absolute URL")
    })?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::bad_request(
            "NODE_DATA_ENDPOINT_INVALID: data endpoint must use http or https",
        ));
    }
    if parsed.username() != "" || parsed.password().is_some() {
        return Err(AppError::bad_request(
            "NODE_DATA_ENDPOINT_INVALID: userinfo is not allowed in a node endpoint",
        ));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(AppError::bad_request(
            "NODE_DATA_ENDPOINT_INVALID: query and fragment are not allowed",
        ));
    }
    if parsed.path() != "/" && !parsed.path().is_empty() {
        return Err(AppError::bad_request(
            "NODE_DATA_ENDPOINT_INVALID: data endpoint must be an origin, not a path",
        ));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| AppError::bad_request("NODE_DATA_ENDPOINT_INVALID: host is required"))?
        .trim_matches(['[', ']'])
        .to_ascii_lowercase();
    let loopback = host == "localhost"
        || host
            .parse::<std::net::IpAddr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false);
    if !loopback
        && !config
            .allowed_node_data_hosts
            .iter()
            .any(|allowed| allowed == &host)
    {
        return Err(AppError::bad_request(
            "NODE_DATA_ENDPOINT_NOT_ALLOWED: host is not in OPSWEAVE_ALLOWED_NODE_DATA_HOSTS",
        ));
    }
    if parsed.scheme() == "http" && (!config.allow_insecure_node_transport || !loopback) {
        return Err(AppError::bad_request(
            "NODE_DATA_ENDPOINT_INSECURE: plaintext HTTP is only allowed for loopback development",
        ));
    }
    Ok(())
}

pub async fn redeem_enrollment(
    State(state): State<AppState>,
    Json(payload): Json<NodeEnrollRequest>,
) -> AppResult<(StatusCode, Json<NodeEnrollResponse>)> {
    if payload.token.trim().is_empty() || payload.name.trim().len() < 2 {
        return Err(AppError::bad_request("token and node name are required"));
    }
    let node_id = Uuid::new_v4();
    let credential = format!("ow_node_{}", random_token(40));
    let data_token = format!("ow_data_{}", random_token(40));
    let mut tx = state.db.begin().await?;
    // Lock the one-time token before checking it. The conditional UPDATE below is
    // the second half of the compare-and-swap so two concurrent redemptions can
    // never both create a Node.
    let row = sqlx::query_as::<_, (Uuid, Option<DateTime<Utc>>, DateTime<Utc>)>(
        "SELECT id, used_at, expires_at FROM kernel.node_enrollment_tokens WHERE token_hash = $1 FOR UPDATE",
    )
    .bind(hash_token(payload.token.trim()))
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::unauthorized("Enrollment token is invalid"))?;
    if row.1.is_some() {
        return Err(AppError::unauthorized(
            "Enrollment token has already been used",
        ));
    }
    if row.2 <= Utc::now() {
        return Err(AppError::unauthorized("Enrollment token has expired"));
    }
    sqlx::query(
        r#"
        INSERT INTO kernel.nodes
          (id, name, control_token_hash, data_token, generation, os, arch, labels, capabilities, status)
        VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,'READY')
        "#,
    )
    .bind(node_id)
    .bind(payload.name.trim())
    .bind(hash_token(&credential))
    .bind(&data_token)
    .bind(&payload.os)
    .bind(&payload.arch)
    .bind(serde_json::to_value(&payload.labels).unwrap_or_else(|_| serde_json::json!({})))
    .bind(serde_json::to_value(&payload.capabilities).unwrap_or_else(|_| serde_json::json!([])))
    .execute(&mut *tx)
    .await?;
    let consumed = sqlx::query(
        "UPDATE kernel.node_enrollment_tokens SET used_at = now(), used_by_node = $1 WHERE id = $2 AND used_at IS NULL AND expires_at > now()",
    )
    .bind(node_id)
    .bind(row.0)
    .execute(&mut *tx)
    .await?;
    if consumed.rows_affected() != 1 {
        return Err(AppError::unauthorized(
            "Enrollment token was consumed by another request",
        ));
    }
    sqlx::query(
        r#"
        INSERT INTO kernel.audit_events
          (id, event_type, actor_type, actor_id, subject_type, subject_id, action, result, details, request_id, occurred_at)
        VALUES ($1,'node.enrolled','NODE',$2,'node',$2,'node.enroll','CONFIRMED',$3,NULL,now())
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(node_id.to_string())
    .bind(serde_json::json!({"name": payload.name, "os": payload.os, "arch": payload.arch}))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(NodeEnrollResponse {
            node_id,
            credential,
            data_token,
            heartbeat_interval_seconds: state.config.heartbeat_interval_seconds,
        }),
    ))
}

pub async fn list_nodes(
    State(state): State<AppState>,
    _auth: AuthUser,
) -> AppResult<Json<Vec<NodeView>>> {
    let rows = sqlx::query_as::<_, NodeRow>("SELECT * FROM kernel.nodes ORDER BY name")
        .fetch_all(&state.db)
        .await?;
    let mut views = Vec::new();
    for row in rows {
        let counts: (i64, i64) = sqlx::query_as(
            r#"
            SELECT count(*) FILTER (WHERE i.state = 'READY')::bigint,
                   count(*)::bigint
            FROM kernel.plugin_instances i
            JOIN kernel.plugin_deployments d ON d.id=i.deployment_id
            WHERE i.node_id = $1 AND i.desired_action = 'START'
              AND d.status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED')
            "#,
        )
        .bind(row.id)
        .fetch_one(&state.db)
        .await?;
        views.push(NodeView::from_row(
            &row,
            state.config.node_stale_seconds,
            counts.0,
            counts.1,
        ));
    }
    Ok(Json(views))
}

pub async fn get_node(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path(node_id): Path<Uuid>,
) -> AppResult<Json<NodeView>> {
    let row = fetch_node(&state, node_id).await?;
    let counts: (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE i.state='READY')::bigint, count(*)::bigint FROM kernel.plugin_instances i JOIN kernel.plugin_deployments d ON d.id=i.deployment_id WHERE i.node_id=$1 AND i.desired_action='START' AND d.status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED')",
    )
    .bind(node_id)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(NodeView::from_row(
        &row,
        state.config.node_stale_seconds,
        counts.0,
        counts.1,
    )))
}

pub async fn revoke_node(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(node_id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    auth.require_admin()?;
    let row = fetch_node(&state, node_id).await?;
    let revoked_data_token = format!("revoked-{}", Uuid::new_v4());
    sqlx::query(
        "UPDATE kernel.nodes SET revoked_at = now(), status = 'UNREACHABLE', data_token = $2 WHERE id = $1",
    )
    .bind(node_id)
    .bind(&revoked_data_token)
    .execute(&state.db)
    .await?;
    sqlx::query(
        "UPDATE kernel.plugin_instances SET state='UNREACHABLE', updated_at=now() WHERE node_id=$1 AND desired_action='START'",
    )
    .bind(node_id)
    .execute(&state.db)
    .await?;
    audit::record(
        &state.db,
        "node.revoked",
        "USER",
        &auth.user_id.to_string(),
        "node",
        &node_id.to_string(),
        "node.revoke",
        "CONFIRMED",
        serde_json::json!({"name": row.name}),
        None,
    )
    .await?;
    Ok(Json(serde_json::json!({"ok": true})))
}

pub async fn heartbeat(
    State(state): State<AppState>,
    Path(node_id): Path<Uuid>,
    headers: HeaderMap,
    Json(payload): Json<NodeHeartbeatRequest>,
) -> AppResult<Json<DesiredNodeState>> {
    let node = authenticate_node(&state, node_id, &headers).await?;
    validate_node_data_endpoint(&state.config, &payload.data_endpoint)?;
    if payload.generation < node.generation {
        return Err(AppError::conflict(
            "STALE_NODE_GENERATION",
            format!(
                "node generation {} is older than kernel generation {}",
                payload.generation, node.generation
            ),
        ));
    }
    let observed_at = payload.observed_at;
    let status = match payload.status {
        NodeStatus::Ready => "READY",
        NodeStatus::Degraded => "DEGRADED",
        NodeStatus::Unreachable => "UNREACHABLE",
        NodeStatus::Unknown => "UNKNOWN",
    };
    sqlx::query(
        r#"
        UPDATE kernel.nodes SET
          generation = $2, status = $3, last_seen_at = now(), data_endpoint = $4,
          runtime_adapter_version = $5, os = $6, arch = $7, labels = $8,
          capabilities = $9, resource_snapshot = $10
        WHERE id = $1
        "#,
    )
    .bind(node_id)
    .bind(payload.generation)
    .bind(status)
    .bind(&payload.data_endpoint)
    .bind(&payload.runtime_adapter_version)
    .bind(&payload.os)
    .bind(&payload.arch)
    .bind(serde_json::to_value(&payload.labels).unwrap_or_else(|_| serde_json::json!({})))
    .bind(serde_json::to_value(&payload.capabilities).unwrap_or_else(|_| serde_json::json!([])))
    .bind(serde_json::to_value(&payload.resource_snapshot).unwrap_or(Value::Null))
    .execute(&state.db)
    .await?;

    let sample = &payload.resource_snapshot;
    if let Err(error) = sqlx::query(
        r#"
        INSERT INTO kernel.node_resource_samples
          (node_id,generation,observed_at,sampled_at,cpu_utilization,memory_used_bytes,
           memory_total_bytes,cpu_cores,filesystem_used_bytes,filesystem_total_bytes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (node_id, sampled_at) DO NOTHING
        "#,
    )
    .bind(node_id)
    .bind(payload.generation)
    .bind(observed_at)
    .bind(sample.sampled_at)
    .bind(sample.cpu_utilization)
    .bind(sample.memory_used_bytes)
    .bind(sample.memory_total_bytes)
    .bind(sample.cpu_cores)
    .bind(sample.filesystem_used_bytes)
    .bind(sample.filesystem_total_bytes)
    .execute(&state.db)
    .await
    {
        tracing::warn!(%node_id, error = %error, "node resource sample was not persisted; heartbeat remains authoritative");
    }

    for observation in &payload.instances {
        if observation.deployment_id.is_nil() {
            continue;
        }
        let updated = sqlx::query(
            r#"
            UPDATE kernel.plugin_instances SET
              state = $3, observed_at = $4, container_id = $5, image_digest = $6,
              host_port = $7, restart_count = $8, last_error = $9,
              runtime_adapter_version = $10, updated_at = now()
            WHERE id = $1 AND node_id = $2 AND deployment_generation = $11
            "#,
        )
        .bind(observation.instance_id)
        .bind(node_id)
        .bind(instance_state_str(observation.state))
        .bind(observation.observed_at)
        .bind(&observation.container_id)
        .bind(&observation.image_digest)
        .bind(observation.host_port.map(i32::from))
        .bind(observation.restart_count)
        .bind(&observation.error)
        .bind(&observation.runtime_adapter_version)
        .bind(observation.generation)
        .execute(&state.db)
        .await?;
        if updated.rows_affected() == 0 {
            tracing::debug!(
                node = %node_id,
                instance = %observation.instance_id,
                generation = observation.generation,
                "ignored observation for unknown or superseded instance"
            );
        }
    }

    let desired = desired_for_node(&state, node_id).await?;
    let _ = observed_at;
    Ok(Json(DesiredNodeState {
        node_id,
        node_generation: payload.generation,
        heartbeat_interval_seconds: state.config.heartbeat_interval_seconds,
        max_instances: state.config.max_instances_per_node,
        desired,
    }))
}

pub async fn desired_for_node(state: &AppState, node_id: Uuid) -> AppResult<Vec<DesiredWorkload>> {
    let rows = sqlx::query_as::<_, DesiredRow>(
        r#"
        SELECT i.id AS instance_id, i.deployment_id, d.plugin_id, d.version,
               i.deployment_generation AS generation,
               p.manifest->'backend' AS backend, p.manifest->'provides' AS provides,
               d.resources, i.desired_action
        FROM kernel.plugin_instances i
        JOIN kernel.plugin_deployments d ON d.id = i.deployment_id
        JOIN kernel.plugin_packages p ON p.package_id = d.package_id
        WHERE i.node_id = $1
          AND i.desired_action = 'START'
          AND (d.status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED')
               OR (d.status='DRAINING' AND (d.drain_until IS NULL OR d.drain_until > now())))
          AND p.manifest->'backend' IS NOT NULL
          AND p.manifest->'backend' <> 'null'::jsonb
        "#,
    )
    .bind(node_id)
    .fetch_all(&state.db)
    .await?;
    let mut desired = Vec::new();
    for row in rows {
        let backend_value = row.backend;
        let backend: opsweave_contracts::BackendSpec = serde_json::from_value(backend_value)
            .map_err(|error| {
                AppError::internal(format!("stored manifest backend is invalid: {error}"))
            })?;
        let resources: ResourceRequirements =
            serde_json::from_value(row.resources).map_err(|error| {
                AppError::internal(format!("stored deployment resources are invalid: {error}"))
            })?;
        let capability_digest =
            opsweave_bundle::sha256_digest(&opsweave_contracts::canonical_json(&row.provides));
        desired.push(DesiredWorkload {
            instance_id: row.instance_id,
            deployment_id: row.deployment_id,
            plugin_id: row.plugin_id.clone(),
            version: row.version,
            generation: row.generation,
            action: opsweave_contracts::DesiredAction::Start,
            backend: DesiredBackend {
                image_ref: backend.image_ref,
                container_port: backend.protocol.container_port,
                capability_digest,
                readiness_path: backend.health.readiness_path,
                liveness_path: backend.health.liveness_path,
                startup_path: backend.health.startup_path,
                api_prefix: backend.api_prefix,
            },
            resources,
            labels: std::collections::BTreeMap::from([
                ("opsweave.plugin".to_string(), row.plugin_id),
                (
                    "opsweave.deployment".to_string(),
                    row.deployment_id.to_string(),
                ),
            ]),
        });
    }
    Ok(desired)
}

#[derive(Debug, FromRow)]
struct DesiredRow {
    instance_id: Uuid,
    deployment_id: Uuid,
    plugin_id: String,
    version: String,
    generation: i64,
    backend: Value,
    provides: Value,
    resources: Value,
    #[allow(dead_code)]
    desired_action: String,
}

pub async fn authenticate_node(
    state: &AppState,
    node_id: Uuid,
    headers: &HeaderMap,
) -> AppResult<NodeRow> {
    let token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::unauthorized("node credential required"))?;
    let node = fetch_node(state, node_id).await?;
    if node.revoked_at.is_some() {
        return Err(AppError::forbidden("node identity has been revoked"));
    }
    if node.control_token_hash != hash_token(token) {
        return Err(AppError::unauthorized("node credential is invalid"));
    }
    Ok(node)
}

pub async fn fetch_node(state: &AppState, node_id: Uuid) -> AppResult<NodeRow> {
    sqlx::query_as::<_, NodeRow>("SELECT * FROM kernel.nodes WHERE id = $1")
        .bind(node_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found("node not found"))
}

pub fn instance_state_str(state: opsweave_contracts::InstanceState) -> &'static str {
    match state {
        opsweave_contracts::InstanceState::Starting => "STARTING",
        opsweave_contracts::InstanceState::Ready => "READY",
        opsweave_contracts::InstanceState::Unhealthy => "UNHEALTHY",
        opsweave_contracts::InstanceState::Unreachable => "UNREACHABLE",
        opsweave_contracts::InstanceState::Stopped => "STOPPED",
        opsweave_contracts::InstanceState::Unknown => "UNKNOWN",
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceHistoryQuery {
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct NodeResourceSampleView {
    pub sample_id: i64,
    pub node_id: Uuid,
    pub generation: i64,
    pub observed_at: DateTime<Utc>,
    pub sampled_at: DateTime<Utc>,
    pub cpu_utilization: Option<f64>,
    pub memory_used_bytes: Option<i64>,
    pub memory_total_bytes: Option<i64>,
    pub cpu_cores: Option<i64>,
    pub filesystem_used_bytes: Option<i64>,
    pub filesystem_total_bytes: Option<i64>,
}

pub async fn resource_history(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path(node_id): Path<Uuid>,
    Query(query): Query<ResourceHistoryQuery>,
) -> AppResult<Json<Vec<NodeResourceSampleView>>> {
    let _ = fetch_node(&state, node_id).await?;
    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    let rows = sqlx::query_as::<_, NodeResourceSampleView>(
        r#"
        SELECT sample_id,node_id,generation,observed_at,sampled_at,cpu_utilization,
               memory_used_bytes,memory_total_bytes,cpu_cores,filesystem_used_bytes,
               filesystem_total_bytes
        FROM kernel.node_resource_samples
        WHERE node_id=$1 AND ($2::timestamptz IS NULL OR observed_at >= $2)
          AND ($3::timestamptz IS NULL OR observed_at <= $3)
        ORDER BY observed_at DESC, sample_id DESC LIMIT $4
        "#,
    )
    .bind(node_id)
    .bind(query.from)
    .bind(query.to)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

pub async fn node_instances(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path(node_id): Path<Uuid>,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let _ = fetch_node(&state, node_id).await?;
    let rows = sqlx::query_as::<
        _,
        (
            Uuid,
            Uuid,
            String,
            String,
            i32,
            String,
            Option<DateTime<Utc>>,
            Option<String>,
            Option<i32>,
            i32,
            Option<String>,
        ),
    >(
        r#"
        SELECT i.id, i.deployment_id, d.plugin_id, d.version, i.slot, i.state,
               i.observed_at, i.container_id, i.host_port, i.restart_count, i.last_error
        FROM kernel.plugin_instances i
        JOIN kernel.plugin_deployments d ON d.id = i.deployment_id
        WHERE i.node_id = $1 AND i.desired_action = 'START'
        ORDER BY d.plugin_id, i.slot
        "#,
    )
    .bind(node_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|row| {
                serde_json::json!({
                    "id": row.0,
                    "deploymentId": row.1,
                    "pluginId": row.2,
                    "version": row.3,
                    "slot": row.4,
                    "state": row.5,
                    "observedAt": row.6,
                    "containerId": row.7,
                    "hostPort": row.8,
                    "restartCount": row.9,
                    "lastError": row.10
                })
            })
            .collect(),
    ))
}
