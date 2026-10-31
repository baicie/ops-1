use crate::audit;
use crate::auth::AuthUser;
use crate::error::AppResult;
use crate::state::AppState;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::Value;

pub async fn livez() -> impl IntoResponse {
    (StatusCode::OK, Json(serde_json::json!({"status": "live"})))
}

pub async fn readyz(State(state): State<AppState>) -> Response {
    match sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.db)
        .await
    {
        Ok(_) => (
            StatusCode::OK,
            Json(serde_json::json!({"status": "ready", "database": "connected"})),
        )
            .into_response(),
        Err(error) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "status": "not_ready",
                "database": "unavailable",
                "error": error.to_string()
            })),
        )
            .into_response(),
    }
}

pub async fn diagnostics(State(state): State<AppState>, auth: AuthUser) -> AppResult<Json<Value>> {
    auth.require_admin()?;
    let db_ok = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.db)
        .await
        .is_ok();
    let nodes = sqlx::query_as::<
        _,
        (
            uuid::Uuid,
            String,
            String,
            Option<chrono::DateTime<chrono::Utc>>,
        ),
    >("SELECT id, name, status, last_seen_at FROM kernel.nodes ORDER BY name")
    .fetch_all(&state.db)
    .await?;
    let counts: (i64, i64, i64, i64, i64) = sqlx::query_as(
        r#"
        SELECT
          (SELECT count(*) FROM kernel.plugin_packages)::bigint,
          (SELECT count(*) FROM kernel.plugin_installations WHERE state='INSTALLED')::bigint,
          (SELECT count(*) FROM kernel.plugin_deployments WHERE status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED'))::bigint,
          (SELECT count(*) FROM kernel.plugin_instances WHERE state='READY')::bigint,
          (SELECT count(*) FROM kernel.audit_events)::bigint
        "#,
    )
    .fetch_one(&state.db)
    .await?;
    // This page is admin-only (require_admin above), and the scope says so rather than
    // relying on the gate having run: the ledger read is the same call the public route
    // makes, with the scope that route would need to be allowed to see everything.
    let recent_failures = audit::list_scoped(
        &state.db,
        audit::AuditScope::from_auth(&auth),
        20,
        None,
        None,
    )
    .await?;
    Ok(Json(serde_json::json!({
        "kernel": {
            "version": env!("CARGO_PKG_VERSION"),
            "apiMajor": 1,
            "runtimeProtocol": "http-json-v1",
            "uptimeSeconds": crate::uptime_seconds(),
            "database": if db_ok { "connected" } else { "unavailable" },
            "dataDir": state.config.data_dir,
            "webDist": state.config.web_dist,
        },
        "counts": {
            "packages": counts.0,
            "installedPlugins": counts.1,
            "deployments": counts.2,
            "readyInstances": counts.3,
            "auditEvents": counts.4
        },
        "nodes": nodes.iter().map(|node| serde_json::json!({
            "id": node.0,
            "name": node.1,
            "status": node.2,
            "lastSeenAt": node.3
        })).collect::<Vec<_>>(),
        "recentEvents": recent_failures,
        "policies": {
            "heartbeatIntervalSeconds": state.config.heartbeat_interval_seconds,
            "nodeStaleSeconds": state.config.node_stale_seconds,
            "maxInstancesPerNode": state.config.max_instances_per_node,
            "requestTimeoutSeconds": state.config.request_timeout_seconds,
            "sessionHours": state.config.session_hours
        },
        "bootstrap": {
            "availableWithoutPlugins": true,
            "recoveryCli": "opsctl doctor",
            "note": "Bootstrap diagnostics are kernel-owned and do not load plugin JavaScript."
        }
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditQuery {
    pub subject_type: Option<String>,
    pub subject_id: Option<String>,
    pub limit: Option<i64>,
}

pub async fn audit_events(
    State(state): State<AppState>,
    auth: AuthUser,
    Query(query): Query<AuditQuery>,
) -> AppResult<Json<Vec<audit::AuditEventView>>> {
    // G12 F (P0-1). This handler used to hold an empty `if auth.role == Viewer { }`
    // whose comment said viewers read summaries but not secrets. It checked nothing and
    // the query below had no scope predicate at all, so the lowest-privileged role read
    // every actor's rows over the whole platform - including the closure notes G12 made
    // part of an incident event. The gate is now the read itself: audit::list_scoped
    // decides per row whether this caller may read the subject the event is about, and
    // it is the only ledger read the codebase has.
    let events = audit::list_scoped(
        &state.db,
        audit::AuditScope::from_auth(&auth),
        query.limit.unwrap_or(100),
        query.subject_type.as_deref(),
        query.subject_id.as_deref(),
    )
    .await?;
    Ok(Json(events))
}

pub async fn settings_policies(
    State(state): State<AppState>,
    auth: AuthUser,
) -> AppResult<Json<Value>> {
    auth.require_admin()?;
    Ok(Json(serde_json::json!({
        "heartbeatIntervalSeconds": state.config.heartbeat_interval_seconds,
        "nodeStaleSeconds": state.config.node_stale_seconds,
        "maxInstancesPerNode": state.config.max_instances_per_node,
        "requestTimeoutSeconds": state.config.request_timeout_seconds,
        "sessionHours": state.config.session_hours,
        "environment": if state.config.secure_cookies() { "production-locked" } else { "local-development" }
    })))
}

pub async fn bootstrap_page(
    State(state): State<AppState>,
    auth: AuthUser,
) -> AppResult<axum::response::Html<String>> {
    auth.require_operator()?;
    let db_ok = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.db)
        .await
        .is_ok();
    let nodes = sqlx::query_as::<_, (String, String, Option<chrono::DateTime<chrono::Utc>>)>(
        "SELECT name, status, last_seen_at FROM kernel.nodes ORDER BY name",
    )
    .fetch_all(&state.db)
    .await?;
    let counts: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM kernel.plugin_instances WHERE state='READY')::bigint, (SELECT count(*) FROM kernel.audit_events)::bigint",
    )
    .fetch_one(&state.db)
    .await?;
    let rows = nodes
        .iter()
        .map(|node| {
            format!(
                "<tr><td>{}</td><td>{}</td><td>{}</td></tr>",
                escape_html(&node.0),
                escape_html(&node.1),
                node.2
                    .map(|value| value.to_rfc3339())
                    .unwrap_or_else(|| "never".into())
            )
        })
        .collect::<String>();
    let html = format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpsWeave Bootstrap Diagnostics</title><style>body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f4f5f7;color:#161a20}}main{{max-width:860px;margin:40px auto;padding:0 20px}}h1{{font-size:24px}}h2{{font-size:16px;margin-top:28px}}.banner{{padding:14px 16px;border:1px solid #e0e4ea;border-left:4px solid {};border-radius:8px;background:#fff}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:14px}}.card{{background:#fff;border:1px solid #e0e4ea;border-radius:8px;padding:12px 14px}}.label{{font-size:12px;color:#6b7380}}.value{{font-size:18px;font-weight:650;margin-top:3px}}table{{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e0e4ea;border-radius:8px;overflow:hidden}}td,th{{text-align:left;padding:9px 12px;border-bottom:1px solid #e0e4ea;font-size:13px}}th{{background:#f8f9fb;color:#6b7380}}a{{color:#3457d5}}code{{background:#f8f9fb;border:1px solid #e0e4ea;padding:1px 5px;border-radius:4px}}p{{line-height:1.55;color:#4b5563}}</style></head><body><main><p style="font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#6b7380">Kernel-owned · no plugin JavaScript</p><h1>Bootstrap Diagnostics</h1><div class="banner">Kernel <strong>{}</strong> · API v1 · Database <strong>{}</strong> · READY instances <strong>{}</strong> · audit events <strong>{}</strong></div><div class="grid"><div class="card"><div class="label">Data directory</div><div class="value" style="font-size:12px;word-break:break-all">{}</div></div><div class="card"><div class="label">Web distribution</div><div class="value" style="font-size:12px;word-break:break-all">{}</div></div><div class="card"><div class="label">Recovery CLI</div><div class="value" style="font-size:13px"><code>opsctl doctor</code></div></div></div><h2>Nodes</h2><table><thead><tr><th>Name</th><th>Status</th><th>Last observed</th></tr></thead><tbody>{}</tbody></table><h2>Recovery</h2><p>This page is served by the Kernel and remains available when the React Shell or a business plugin fails. Use <code>opsctl status</code>, <code>opsctl doctor</code>, <code>opsctl nodes</code> and <code>opsctl plugin disable &lt;id&gt;</code> from an authorized terminal. <a href="/settings/diagnostics">Open the full Shell diagnostics</a>.</p><p><a href="/">Back to OpsWeave</a></p></main></body></html>"#,
        if db_ok { "#0f8a5f" } else { "#c03636" },
        env!("CARGO_PKG_VERSION"),
        if db_ok { "connected" } else { "unavailable" },
        counts.0,
        counts.1,
        escape_html(&state.config.data_dir.display().to_string()),
        escape_html(&state.config.web_dist.display().to_string()),
        rows
    );
    Ok(axum::response::Html(html))
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
