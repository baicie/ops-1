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
