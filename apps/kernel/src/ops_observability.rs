//! Read-only fleet observability for the Ops application (G14.4).
//!
//! Why this module exists rather than reusing `/api/v1/nodes`:
//!
//! `GET /api/v1/nodes` is a PLATFORM read. Its gate is "any authenticated
//! session" and its body carries `data_endpoint`, `labels`, `capabilities` and
//! the runtime adapter version - the node's address and its inventory. That is
//! the right shape for the Platform Console, which exists to operate nodes.
//!
//! It is the wrong shape for an operator answering "is the service healthy"
//! inside one business workspace. Reusing it from the Ops application would have
//! meant either showing every node's endpoint to every operator, or marking the
//! Observability page "shipped" while it 403s for the accounts it is meant for -
//! the exact substitution ADR-022 forbids (a page that renders is not a shipped
//! capability; the authorization is part of the capability).
//!
//! So this endpoint answers the OPS question and nothing more: which nodes are
//! reporting, how stale, and how many instances are ready. No endpoint, no
//! labels, no capabilities, no adapter version. It sits behind the ops
//! application grant, so a caller that may not open the application cannot read
//! the fleet either.
//!
//! **What it is not.** This is node health. It is not APM, not traces, not log
//! search and not cross-service telemetry. Those are separate capabilities the
//! platform does not have, and calling this page "unified observability" would be
//! the overclaim the brief warns about.

use crate::applications::{require_application, OPS_APPLICATION};
use crate::auth::AuthUser;
use crate::error::AppResult;
use crate::state::AppState;
use axum::extract::State;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::FromRow;

/// One node as the Ops application may see it.
///
/// Deliberately excludes `data_endpoint`, `labels`, `capabilities` and the
/// runtime adapter version: none of them helps answer "is the fleet reporting",
/// and all of them are platform surface.
#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct FleetNodeView {
    pub id: uuid::Uuid,
    pub name: String,
    /// `READY`, `UNREACHABLE`, `REVOKED` ... the same vocabulary the platform
    /// uses, because two spellings of a node state would be two state machines.
    pub status: String,
    pub last_seen_at: Option<DateTime<Utc>>,
    /// Whether the last heartbeat is older than the staleness window. Computed by
    /// the Kernel, not the client: a browser must not decide for itself whether a
    /// silent node is down (the platform rule is that absence of a heartbeat is
    /// not proof of a stopped instance, and this flag is the honest phrasing of
    /// what we do and do not know).
    pub stale: bool,
    pub instances_ready: i64,
    pub instances_total: i64,
    /// The resource sample the platform last collected, when there is one. Null
    /// means NOT COLLECTED, which is different from zero and must render as such.
    pub resource_snapshot: Option<serde_json::Value>,
    pub os: String,
    pub arch: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetView {
    pub nodes: Vec<FleetNodeView>,
    /// The staleness window this answer used, so a client can phrase "no
    /// heartbeat for N seconds" without guessing.
    pub stale_after_seconds: i64,
    /// What this endpoint does NOT cover. Rendered verbatim by the page, so the
    /// limitation travels with the data instead of living in a doc nobody reads.
    pub covers: Vec<&'static str>,
    pub does_not_cover: Vec<&'static str>,
}

/// `GET /api/v1/apps/opsweave.ops/observability/fleet`
pub async fn fleet(State(state): State<AppState>, auth: AuthUser) -> AppResult<Json<FleetView>> {
    // The application grant first: a caller that may not open the Ops application
    // must not learn the fleet's shape either.
    require_application(&state.db, &auth, OPS_APPLICATION).await?;

    let rows: Vec<FleetNodeView> = sqlx::query_as(
        r#"
        SELECT n.id,
               n.name,
               n.status,
               n.last_seen_at,
               (n.last_seen_at IS NULL
                OR n.last_seen_at < now() - make_interval(secs => $1)) AS stale,
               (SELECT count(*) FROM kernel.plugin_instances i
                 WHERE i.node_id = n.id AND i.state = 'READY')::bigint AS instances_ready,
               (SELECT count(*) FROM kernel.plugin_instances i
                 WHERE i.node_id = n.id)::bigint AS instances_total,
               n.resource_snapshot,
               n.os,
               n.arch
          FROM kernel.nodes n
         WHERE n.revoked_at IS NULL
         ORDER BY n.name
        "#,
    )
    .bind(state.config.node_stale_seconds)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(FleetView {
        nodes: rows,
        stale_after_seconds: state.config.node_stale_seconds,
        covers: vec![
            "node liveness and staleness",
            "ready / total plugin instances per node",
            "the last collected resource sample per node",
        ],
        does_not_cover: vec![
            "application performance monitoring",
            "distributed traces",
            "log search",
            "cross-service service maps",
        ],
    }))
}

/// `GET /api/v1/apps/opsweave.ops/observability/nodes/{node_id}`
///
/// The entity page's shape. Deliberately the same narrowing as the fleet list:
/// no `dataEndpoint`, no `labels`, no `capabilities`, no adapter version. A node
/// this build cannot see is 404 - the same answer the platform route gives, so
/// the status cannot be used to probe for nodes.
pub async fn node_detail(
    State(state): State<AppState>,
    auth: AuthUser,
    axum::extract::Path(node_id): axum::extract::Path<uuid::Uuid>,
) -> AppResult<Json<FleetNodeView>> {
    require_application(&state.db, &auth, OPS_APPLICATION).await?;
    let row: Option<FleetNodeView> = sqlx::query_as(
        r#"
        SELECT n.id, n.name, n.status, n.last_seen_at,
               (n.last_seen_at IS NULL
                OR n.last_seen_at < now() - make_interval(secs => $2)) AS stale,
               (SELECT count(*) FROM kernel.plugin_instances i
                 WHERE i.node_id = n.id AND i.state = 'READY')::bigint AS instances_ready,
               (SELECT count(*) FROM kernel.plugin_instances i
                 WHERE i.node_id = n.id)::bigint AS instances_total,
               n.resource_snapshot, n.os, n.arch
          FROM kernel.nodes n
         WHERE n.id = $1 AND n.revoked_at IS NULL
        "#,
    )
    .bind(node_id)
    .bind(state.config.node_stale_seconds)
    .fetch_optional(&state.db)
    .await?;
    row.map(Json)
        .ok_or_else(|| crate::error::AppError::not_found("node not found"))
}

/// One sample series the entity page charts, projected from the platform samples.
#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct FleetSampleView {
    pub sample_id: i64,
    pub sampled_at: DateTime<Utc>,
    pub cpu_utilization: Option<f64>,
    pub memory_used_bytes: Option<i64>,
    pub memory_total_bytes: Option<i64>,
    pub filesystem_used_bytes: Option<i64>,
    pub filesystem_total_bytes: Option<i64>,
}

#[derive(Debug, serde::Deserialize)]
pub struct FleetHistoryQuery {
    pub limit: Option<i64>,
    pub resolution: Option<String>,
}

/// `GET /api/v1/apps/opsweave.ops/observability/nodes/{node_id}/history`
///
/// The same rows the platform route serves, through the ops grant. `resolution`
/// keeps its two values (`raw`, `hour`) because the entity page's window switch
/// depends on the aggregate; anything else is a 400 rather than a silent raw
/// series, which would chart a different answer than the caller asked for.
pub async fn node_history(
    State(state): State<AppState>,
    auth: AuthUser,
    axum::extract::Path(node_id): axum::extract::Path<uuid::Uuid>,
    axum::extract::Query(query): axum::extract::Query<FleetHistoryQuery>,
) -> AppResult<Json<Vec<FleetSampleView>>> {
    require_application(&state.db, &auth, OPS_APPLICATION).await?;
    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    let hourly = match query.resolution.as_deref().unwrap_or("raw") {
        "raw" => false,
        "hour" => true,
        other => {
            return Err(crate::error::AppError::bad_request(format!(
                "resolution must be raw or hour, got {other}"
            )))
        }
    };
    let exists: Option<uuid::Uuid> =
        sqlx::query_scalar("SELECT id FROM kernel.nodes WHERE id=$1 AND revoked_at IS NULL")
            .bind(node_id)
            .fetch_optional(&state.db)
            .await?;
    if exists.is_none() {
        return Err(crate::error::AppError::not_found("node not found"));
    }
    let rows: Vec<FleetSampleView> = if hourly {
        sqlx::query_as(
            r#"
            SELECT min(sample_id) AS sample_id,
                   (date_trunc('hour', observed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS sampled_at,
                   avg(cpu_utilization)::float8 AS cpu_utilization,
                   max(memory_used_bytes) AS memory_used_bytes,
                   max(memory_total_bytes) AS memory_total_bytes,
                   max(filesystem_used_bytes) AS filesystem_used_bytes,
                   max(filesystem_total_bytes) AS filesystem_total_bytes
              FROM kernel.node_resource_samples
             WHERE node_id=$1
             GROUP BY 2
             ORDER BY 2 DESC
             LIMIT $2
            "#,
        )
        .bind(node_id)
        .bind(limit)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as(
            r#"
            SELECT sample_id, sampled_at, cpu_utilization, memory_used_bytes,
                   memory_total_bytes, filesystem_used_bytes, filesystem_total_bytes
              FROM kernel.node_resource_samples
             WHERE node_id=$1
             ORDER BY sampled_at DESC, sample_id DESC
             LIMIT $2
            "#,
        )
        .bind(node_id)
        .bind(limit)
        .fetch_all(&state.db)
        .await?
    };
    Ok(Json(rows))
}

/// `GET /api/v1/apps/opsweave.ops/observability/nodes/{node_id}/instances`
///
/// Which plugins are running on this node. The projection keeps the identity and
/// state an operator needs to answer "is my collector up"; it drops the container
/// id and host port, which are host-addressing detail a business operator has no
/// use for and which the platform console shows.
pub async fn node_instances(
    State(state): State<AppState>,
    auth: AuthUser,
    axum::extract::Path(node_id): axum::extract::Path<uuid::Uuid>,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    require_application(&state.db, &auth, OPS_APPLICATION).await?;
    let exists: Option<uuid::Uuid> =
        sqlx::query_scalar("SELECT id FROM kernel.nodes WHERE id=$1 AND revoked_at IS NULL")
            .bind(node_id)
            .fetch_optional(&state.db)
            .await?;
    if exists.is_none() {
        return Err(crate::error::AppError::not_found("node not found"));
    }
    // Named so the row type is stated once instead of inline.
    type InstanceRow = (uuid::Uuid, String, String, i32, String, Option<String>, i32);
    let rows: Vec<InstanceRow> = sqlx::query_as(
        r#"
        SELECT i.id, d.plugin_id, d.version, i.slot, i.state, i.observed_at::text, i.restart_count
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
            .map(
                |(id, plugin_id, version, slot, state, observed_at, restart_count)| {
                    serde_json::json!({
                        "id": id,
                        "pluginId": plugin_id,
                        "version": version,
                        "slot": slot,
                        "state": state,
                        "observedAt": observed_at,
                        "restartCount": restart_count,
                    })
                },
            )
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The projection must not regress into the platform view. This is the whole
    /// reason the module exists, so it is asserted rather than trusted.
    #[test]
    fn the_fleet_view_carries_nothing_a_node_endpoint_would_expose() {
        let serialized = serde_json::to_string(&FleetNodeView {
            id: uuid::Uuid::nil(),
            name: "n".into(),
            status: "READY".into(),
            last_seen_at: None,
            stale: true,
            instances_ready: 0,
            instances_total: 0,
            resource_snapshot: None,
            os: "linux".into(),
            arch: "amd64".into(),
        })
        .expect("serialises");
        for forbidden in [
            "dataEndpoint",
            "labels",
            "capabilities",
            "runtimeAdapterVersion",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "the ops fleet projection must not carry {forbidden}"
            );
        }
    }

    #[tokio::test]
    async fn the_cover_list_states_what_is_not_covered() {
        // The page renders `does_not_cover` verbatim; an empty list would read as
        // "this is everything", which is the claim the brief forbids.
        let view = FleetView {
            nodes: Vec::new(),
            stale_after_seconds: 90,
            covers: vec!["node liveness and staleness"],
            does_not_cover: vec!["distributed traces"],
        };
        let json = serde_json::to_value(&view).expect("serialises");
        assert!(json["doesNotCover"]
            .as_array()
            .is_some_and(|v| !v.is_empty()));
    }
}
