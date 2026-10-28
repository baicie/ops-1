use crate::audit::{self, AuditEventView};
use crate::auth::AuthUser;
use crate::deployments::{self, ActivationRow, DeploymentRow, DeploymentView};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::Json;
use chrono::{DateTime, Utc};
use opsweave_contracts::{
    deliverable_contributions, ContributionRejection, DeliveredContribution, ManifestV11,
};
use serde::Serialize;
use serde_json::Value;
use sqlx::FromRow;
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSummary {
    pub id: String,
    pub name: String,
    pub publisher: Option<String>,
    pub latest_version: Option<String>,
    pub active_version: Option<String>,
    pub state: String,
    pub signature_state: Option<String>,
    pub has_frontend: bool,
    pub has_backend: bool,
    pub image_ref: Option<String>,
    pub desired_replicas: i64,
    pub ready_instances: i64,
    pub total_instances: i64,
    pub updated_at: Option<DateTime<Utc>>,
    pub is_system: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageVersionView {
    pub version: String,
    pub status: String,
    pub signature_state: String,
    pub bundle_digest: String,
    pub artifact_digest: String,
    pub image_ref: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDetail {
    pub id: String,
    pub name: String,
    pub publisher: Option<String>,
    pub state: String,
    pub active_version: Option<String>,
    pub active_revision: Option<ActivationRevisionView>,
    pub manifest: Option<Value>,
    pub permissions: Vec<String>,
    pub provides: Vec<CapabilityView>,
    pub requires: Vec<CapabilityView>,
    pub resources: Option<Value>,
    pub package_versions: Vec<PackageVersionView>,
    pub deployments: Vec<DeploymentView>,
    pub is_system: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationRevisionView {
    pub id: Uuid,
    pub version: String,
    pub generation: i64,
    pub status: String,
    pub activated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityView {
    pub plugin_id: String,
    pub version: String,
    pub name: String,
    pub major: i64,
    pub direction: String,
    pub activation_revision: Option<i64>,
}

#[derive(Debug, FromRow)]
struct PackageLite {
    plugin_id: String,
    version: String,
    publisher: String,
    manifest: Value,
    status: String,
    signature_state: String,
    artifact_digest: String,
    bundle_digest: String,
    backend_image_ref: Option<String>,
    created_at: DateTime<Utc>,
}

pub async fn list_plugins(
    State(state): State<AppState>,
    auth: AuthUser,
) -> AppResult<Json<Vec<PluginSummary>>> {
    auth.require_operator()?;
    let packages = sqlx::query_as::<_, PackageLite>(
        "SELECT plugin_id, version, publisher, manifest, status, signature_state, artifact_digest, bundle_digest, backend_image_ref, created_at FROM kernel.plugin_packages ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await?;
    let installations = sqlx::query_as::<_, (String, String)>(
        "SELECT plugin_id, state FROM kernel.plugin_installations",
    )
    .fetch_all(&state.db)
    .await?;
    let installation_map: BTreeMap<String, String> = installations.into_iter().collect();
    let revisions = sqlx::query_as::<_, ActivationRow>(
        "SELECT * FROM kernel.activation_revisions WHERE status='ACTIVE'",
    )
    .fetch_all(&state.db)
    .await?;
    let revision_map: BTreeMap<String, ActivationRow> = revisions
        .into_iter()
        .map(|row| (row.plugin_id.clone(), row))
        .collect();
    let deployments = sqlx::query_as::<_, DeploymentRow>(
        "SELECT * FROM kernel.plugin_deployments ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await?;
    let mut latest_deployment: BTreeMap<String, DeploymentRow> = BTreeMap::new();
    for deployment in &deployments {
        latest_deployment
            .entry(deployment.plugin_id.clone())
            .or_insert_with(|| deployment.clone());
    }

    let mut ids: Vec<String> = Vec::new();
    for package in &packages {
        if !ids.contains(&package.plugin_id) {
            ids.push(package.plugin_id.clone());
        }
    }
    for id in installation_map.keys() {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    ids.sort();

    let mut summaries = Vec::new();
    for id in ids {
        let package = packages.iter().find(|row| row.plugin_id == id);
        let active_deployment_id = revision_map.get(&id).map(|row| row.deployment_id);
        let deployment = active_deployment_id
            .and_then(|deployment_id| deployments.iter().find(|row| row.id == deployment_id))
            .or_else(|| latest_deployment.get(&id));
        let (ready, total) = if let Some(deployment) = deployment {
            count_instances(&state, deployment.id, deployment.desired_replicas).await?
        } else {
            (0, 0)
        };
        let manifest = package.and_then(|package| {
            serde_json::from_value::<ManifestV11>(package.manifest.clone()).ok()
        });
        summaries.push(PluginSummary {
            id: id.clone(),
            name: display_name(&id),
            publisher: package.map(|row| row.publisher.clone()),
            latest_version: package.map(|row| row.version.clone()),
            active_version: revision_map.get(&id).map(|row| row.version.clone()),
            state: installation_map
                .get(&id)
                .cloned()
                .unwrap_or_else(|| "AVAILABLE".into()),
            signature_state: package.map(|row| row.signature_state.clone()),
            has_frontend: manifest
                .as_ref()
                .map(|value| value.frontend.is_some())
                .unwrap_or(false),
            has_backend: manifest
                .as_ref()
                .map(|value| value.backend.is_some())
                .unwrap_or(false),
            image_ref: package.and_then(|row| row.backend_image_ref.clone()),
            desired_replicas: deployment
                .map(|row| row.desired_replicas as i64)
                .unwrap_or(0),
            ready_instances: ready,
            total_instances: total,
            updated_at: package.map(|row| row.created_at),
            is_system: false,
        });
    }
    let systems = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT plugin_id, name, version, description FROM kernel.system_plugins ORDER BY name",
    )
    .fetch_all(&state.db)
    .await?;
    for system in systems {
        summaries.push(PluginSummary {
            id: system.0,
            name: system.1,
            publisher: Some("opsweave".into()),
            latest_version: Some(system.2.clone()),
            active_version: Some(system.2.clone()),
            state: "INSTALLED".into(),
            signature_state: Some("SYSTEM".into()),
            has_frontend: true,
            has_backend: false,
            image_ref: None,
            desired_replicas: 0,
            ready_instances: 0,
            total_instances: 0,
            updated_at: None,
            is_system: true,
        });
    }
    Ok(Json(summaries))
}

async fn count_instances(
    state: &AppState,
    deployment_id: Uuid,
    desired_replicas: i32,
) -> AppResult<(i64, i64)> {
    let counts: (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE state='READY' AND slot < $2)::bigint, count(*) FILTER (WHERE slot < $2)::bigint FROM kernel.plugin_instances WHERE deployment_id=$1 AND desired_action='START'",
    )
    .bind(deployment_id)
    .bind(desired_replicas)
    .fetch_one(&state.db)
    .await?;
    Ok(counts)
}

pub async fn get_plugin(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(plugin_id): Path<String>,
) -> AppResult<Json<PluginDetail>> {
    auth.require_operator()?;
    if let Ok(system) = sqlx::query_as::<_, (String, String, String, String, Option<String>)>(
        "SELECT plugin_id, name, version, description, ui_route FROM kernel.system_plugins WHERE plugin_id=$1",
    )
    .bind(&plugin_id)
    .fetch_one(&state.db)
    .await
    {
        return Ok(Json(PluginDetail {
            id: system.0,
            name: system.1,
            publisher: Some("opsweave".into()),
            state: "INSTALLED".into(),
            active_version: Some(system.2.clone()),
            active_revision: Some(ActivationRevisionView {
                id: Uuid::nil(),
                version: system.2,
                generation: 1,
                status: "ACTIVE".into(),
                activated_at: None,
            }),
            manifest: Some(serde_json::json!({
                "system": true,
                "description": system.3,
                "uiRoute": system.4,
            })),
            permissions: vec![],
            provides: vec![],
            requires: vec![],
            resources: None,
            package_versions: vec![],
            deployments: vec![],
            is_system: true,
        }));
    }
    let packages = sqlx::query_as::<_, PackageLite>(
        "SELECT plugin_id, version, publisher, manifest, status, signature_state, artifact_digest, bundle_digest, backend_image_ref, created_at FROM kernel.plugin_packages WHERE plugin_id=$1 ORDER BY created_at DESC",
    )
    .bind(&plugin_id)
    .fetch_all(&state.db)
    .await?;
    if packages.is_empty() {
        return Err(AppError::not_found("plugin not found"));
    }
    let installation: Option<(String, Option<Uuid>)> = sqlx::query_as(
        "SELECT state, active_revision_id FROM kernel.plugin_installations WHERE plugin_id=$1",
    )
    .bind(&plugin_id)
    .fetch_optional(&state.db)
    .await?;
    let active: Option<ActivationRow> = sqlx::query_as::<_, ActivationRow>(
        "SELECT * FROM kernel.activation_revisions WHERE plugin_id=$1 AND status='ACTIVE'",
    )
    .bind(&plugin_id)
    .fetch_optional(&state.db)
    .await?;
    let deployments = sqlx::query_as::<_, DeploymentRow>(
        "SELECT * FROM kernel.plugin_deployments WHERE plugin_id=$1 ORDER BY created_at DESC",
    )
    .bind(&plugin_id)
    .fetch_all(&state.db)
    .await?;
    let latest = packages.first().unwrap();
    let manifest: ManifestV11 = serde_json::from_value(latest.manifest.clone())
        .map_err(|error| AppError::internal(format!("stored manifest invalid: {error}")))?;
    let mut deployment_views = Vec::new();
    for deployment in deployments {
        deployment_views.push(deployments::deployment_view(&state, deployment).await?);
    }
    Ok(Json(PluginDetail {
        id: plugin_id.clone(),
        name: display_name(&plugin_id),
        publisher: Some(latest.publisher.clone()),
        state: installation
            .map(|row| row.0)
            .unwrap_or_else(|| "AVAILABLE".into()),
        active_version: active.as_ref().map(|row| row.version.clone()),
        active_revision: active.as_ref().map(|row| ActivationRevisionView {
            id: row.id,
            version: row.version.clone(),
            generation: row.generation,
            status: row.status.clone(),
            activated_at: row.activated_at,
        }),
        manifest: Some(latest.manifest.clone()),
        permissions: manifest.permissions.clone(),
        provides: manifest
            .provides
            .iter()
            .map(|capability| CapabilityView {
                plugin_id: plugin_id.clone(),
                version: latest.version.clone(),
                name: capability.name.clone(),
                major: capability.major,
                direction: "PROVIDES".into(),
                activation_revision: active.as_ref().map(|row| row.generation),
            })
            .collect(),
        requires: manifest
            .requires
            .iter()
            .map(|capability| CapabilityView {
                plugin_id: plugin_id.clone(),
                version: latest.version.clone(),
                name: capability.name.clone(),
                major: capability.major,
                direction: "REQUIRES".into(),
                activation_revision: active.as_ref().map(|row| row.generation),
            })
            .collect(),
        resources: Some(serde_json::to_value(&manifest.resources).unwrap_or(Value::Null)),
        package_versions: packages
            .iter()
            .map(|row| PackageVersionView {
                version: row.version.clone(),
                status: row.status.clone(),
                signature_state: row.signature_state.clone(),
                bundle_digest: row.bundle_digest.clone(),
                artifact_digest: row.artifact_digest.clone(),
                image_ref: row.backend_image_ref.clone(),
                created_at: row.created_at,
            })
            .collect(),
        deployments: deployment_views,
        is_system: false,
    }))
}

pub async fn list_packages(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path(plugin_id): Path<String>,
) -> AppResult<Json<Vec<PackageVersionView>>> {
    let packages = sqlx::query_as::<_, PackageLite>(
        "SELECT plugin_id, version, publisher, manifest, status, signature_state, artifact_digest, bundle_digest, backend_image_ref, created_at FROM kernel.plugin_packages WHERE plugin_id=$1 ORDER BY created_at DESC",
    )
    .bind(&plugin_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        packages
            .iter()
            .map(|row| PackageVersionView {
                version: row.version.clone(),
                status: row.status.clone(),
                signature_state: row.signature_state.clone(),
                bundle_digest: row.bundle_digest.clone(),
                artifact_digest: row.artifact_digest.clone(),
                image_ref: row.backend_image_ref.clone(),
                created_at: row.created_at,
            })
            .collect(),
    ))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionView {
    pub plugin_id: String,
    pub publisher: String,
    pub version: String,
    pub activation_revision: i64,
    pub asset_base: String,
    pub remote_entry: String,
    pub contributions: Vec<DeliveredContribution>,
    /// Contributions the manifest declared but the contract refused, with the
    /// code and detail an operator needs. A refused contribution is never
    /// dispatched; it is reported instead of being dropped silently.
    pub rejections: Vec<ContributionRejection>,
}

/// One active extension row: plugin id, publisher, version, activation
/// generation, the stored manifest, and how many instances of the active
/// revision's deployment are READY.
type ExtensionRow = (String, String, String, i64, Value, i64);

/// Plugins whose contributions may be offered at all: trusted publisher, ACTIVE
/// activation revision, and a shipped frontend. Instance readiness is decided in
/// `extension_views` because a frontend-only plugin has no instances to wait for.
const ACTIVE_EXTENSIONS_SQL: &str = r#"
        SELECT r.plugin_id, p.publisher, r.version, r.generation, p.manifest,
               (SELECT count(*) FROM kernel.plugin_instances i
                 WHERE i.deployment_id=r.deployment_id
                   AND i.desired_action='START'
                   AND i.state='READY')::bigint
        FROM kernel.activation_revisions r
        JOIN kernel.plugin_packages p ON p.package_id=r.package_id
        JOIN kernel.trusted_publishers tp ON tp.publisher_id=p.publisher
        WHERE r.status='ACTIVE' AND tp.trust_state='TRUSTED' AND p.manifest->'frontend' IS NOT NULL AND p.manifest->'frontend' <> 'null'::jsonb
        ORDER BY r.plugin_id
        "#;

pub async fn extensions(
    State(state): State<AppState>,
    auth: AuthUser,
) -> AppResult<Json<Vec<ExtensionView>>> {
    let rows = sqlx::query_as::<_, ExtensionRow>(ACTIVE_EXTENSIONS_SQL)
        .fetch_all(&state.db)
        .await?;
    let access = crate::auth::access_for(auth.role, &state.config.admin_surface_roles);
    Ok(Json(extension_views(rows, &access.capabilities)))
}

/// Narrows active manifests down to what one session may be handed.
///
/// A contribution this session is not authorised for never reaches the response
/// (the client's own filter is UX only), and an extension with nothing left to
/// deliver is omitted rather than disclosed with an empty list.
fn extension_views(rows: Vec<ExtensionRow>, capabilities: &[&str]) -> Vec<ExtensionView> {
    let mut result = Vec::new();
    for (plugin_id, publisher, version, generation, manifest_value, ready_instances) in rows {
        let manifest: ManifestV11 = match serde_json::from_value(manifest_value) {
            Ok(manifest) => manifest,
            Err(error) => {
                tracing::warn!(plugin = %plugin_id, error = %error, "active manifest invalid");
                continue;
            }
        };
        if manifest.backend.is_some() && ready_instances <= 0 {
            tracing::warn!(
                plugin = %plugin_id,
                "active plugin has no READY instance; contributions withheld"
            );
            continue;
        }
        let Some(frontend) = manifest.frontend else {
            continue;
        };
        let delivery = deliverable_contributions(&plugin_id, &frontend.contributions, capabilities);
        for rejection in &delivery.rejections {
            tracing::warn!(
                plugin = %plugin_id,
                contribution = %rejection.contribution_id,
                code = rejection.code.as_str(),
                detail = %rejection.detail,
                "extension contribution rejected"
            );
        }
        if delivery.delivered.is_empty() && delivery.rejections.is_empty() {
            continue;
        }
        result.push(ExtensionView {
            asset_base: format!(
                "/assets/{}/{}/{}",
                urlencoding::encode(&publisher),
                urlencoding::encode(&plugin_id),
                urlencoding::encode(&version)
            ),
            remote_entry: frontend.remote_entry,
            contributions: delivery.delivered,
            rejections: delivery.rejections,
            plugin_id,
            publisher,
            version,
            activation_revision: generation,
        });
    }
    result
}

pub async fn capabilities(
    State(state): State<AppState>,
    _auth: AuthUser,
) -> AppResult<Json<Vec<CapabilityView>>> {
    let rows = sqlx::query_as::<_, (String, String, String, i64, String, i64)>(
        r#"
        SELECT c.plugin_id, c.version, c.name, c.major::bigint, c.direction, r.generation::bigint
        FROM kernel.capability_registrations c
        JOIN kernel.activation_revisions r ON r.id=c.revision_id AND r.status='ACTIVE'
        JOIN kernel.plugin_packages p ON p.package_id=r.package_id
        JOIN kernel.trusted_publishers tp ON tp.publisher_id=p.publisher
        WHERE tp.trust_state='TRUSTED'
        ORDER BY c.name, c.plugin_id
        "#,
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|row| CapabilityView {
                plugin_id: row.0,
                version: row.1,
                name: row.2,
                major: row.3,
                direction: row.4,
                activation_revision: Some(row.5),
            })
            .collect(),
    ))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub health: String,
    pub nodes_total: i64,
    pub nodes_ready: i64,
    pub plugins_installed: i64,
    pub plugins_available: i64,
    pub instances_ready: i64,
    pub instances_total: i64,
    pub active_deployments: i64,
    pub attention: Vec<AttentionItem>,
    pub recent_events: Vec<AuditEventView>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionItem {
    pub severity: String,
    pub title: String,
    pub detail: String,
    pub link: String,
}

pub async fn overview(State(state): State<AppState>, _auth: AuthUser) -> AppResult<Json<Overview>> {
    let nodes: Vec<crate::nodes::NodeRow> =
        sqlx::query_as::<_, crate::nodes::NodeRow>("SELECT * FROM kernel.nodes ORDER BY name")
            .fetch_all(&state.db)
            .await?;
    let plugins_installed: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM kernel.plugin_installations WHERE state='INSTALLED'",
    )
    .fetch_one(&state.db)
    .await?;
    let plugins_available: i64 =
        sqlx::query_scalar("SELECT count(DISTINCT plugin_id) FROM kernel.plugin_packages")
            .fetch_one(&state.db)
            .await?;
    let (instances_ready, instances_total): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE i.state='READY')::bigint, count(*)::bigint FROM kernel.plugin_instances i JOIN kernel.plugin_deployments d ON d.id=i.deployment_id WHERE i.desired_action='START' AND d.status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED')",
    )
    .fetch_one(&state.db)
    .await?;
    let active_deployments: i64 =
        sqlx::query_scalar("SELECT count(*) FROM kernel.plugin_deployments WHERE status='ACTIVE'")
            .fetch_one(&state.db)
            .await?;
    let mut attention = Vec::new();
    let stale_before = Utc::now() - chrono::Duration::seconds(state.config.node_stale_seconds);
    for node in &nodes {
        if node.revoked_at.is_some() {
            attention.push(AttentionItem {
                severity: "critical".into(),
                title: format!("Node {} was revoked", node.name),
                detail: "Revoked node credentials can no longer deploy or report.".into(),
                link: format!("/nodes/{}", node.id),
            });
        } else if node
            .last_seen_at
            .map(|seen| seen < stale_before)
            .unwrap_or(true)
        {
            attention.push(AttentionItem {
                severity: "warning".into(),
                title: format!("Node {} heartbeat is stale", node.name),
                detail: node
                    .last_seen_at
                    .map(|seen| {
                        format!("Last observed at {seen}. State is UNREACHABLE, not STOPPED.")
                    })
                    .unwrap_or_else(|| "Node has never reported a heartbeat.".into()),
                link: format!("/nodes/{}", node.id),
            });
        }
    }
    let problem_deployments = sqlx::query_as::<_, (Uuid, String, String, Option<String>)>(
        "SELECT id, plugin_id, status, status_reason FROM kernel.plugin_deployments WHERE status IN ('DEGRADED','FAILED') ORDER BY updated_at DESC LIMIT 10",
    )
    .fetch_all(&state.db)
    .await?;
    for deployment in problem_deployments {
        attention.push(AttentionItem {
            severity: "critical".into(),
            title: format!("Deployment {} is {}", deployment.1, deployment.2),
            detail: deployment
                .3
                .unwrap_or_else(|| "Open diagnostics for details.".into()),
            link: format!("/plugins/{}", deployment.1),
        });
    }
    let revoked_publishers = sqlx::query_as::<_, (String, String)>(
        "SELECT r.plugin_id, p.publisher FROM kernel.activation_revisions r JOIN kernel.plugin_packages p ON p.package_id=r.package_id JOIN kernel.trusted_publishers tp ON tp.publisher_id=p.publisher WHERE r.status='ACTIVE' AND tp.trust_state='REVOKED' ORDER BY r.plugin_id",
    )
    .fetch_all(&state.db)
    .await?;
    for (plugin_id, publisher) in revoked_publishers {
        attention.push(AttentionItem {
            severity: "critical".into(),
            title: format!("Active plugin {plugin_id} has a revoked publisher"),
            detail: format!(
                "Publisher {publisher} is revoked. Gateway, assets and extensions now fail closed; activate a trusted replacement or disable the plugin."
            ),
            link: format!("/plugins/{plugin_id}"),
        });
    }
    if nodes.is_empty() {
        attention.push(AttentionItem {
            severity: "info".into(),
            title: "No nodes enrolled".into(),
            detail: "Create an enrollment token and join a Linux node before deploying plugins."
                .into(),
            link: "/nodes".into(),
        });
    }
    let health = if attention.iter().any(|item| item.severity == "critical") {
        "DEGRADED"
    } else if attention.is_empty() {
        "READY"
    } else {
        "ATTENTION"
    };
    let recent_events = audit::list(&state.db, 8, None, None).await?;
    Ok(Json(Overview {
        health: health.into(),
        nodes_total: nodes.len() as i64,
        nodes_ready: nodes
            .iter()
            .filter(|node| {
                node.status == "READY"
                    && node.revoked_at.is_none()
                    && node
                        .last_seen_at
                        .map(|seen| seen >= stale_before)
                        .unwrap_or(false)
            })
            .count() as i64,
        plugins_installed,
        plugins_available,
        instances_ready,
        instances_total,
        active_deployments,
        attention,
        recent_events,
    }))
}

fn display_name(id: &str) -> String {
    let suffix = id.rsplit('.').next().unwrap_or(id);
    if suffix == "hello" {
        return "Hello Ops".to_string();
    }
    suffix
        .split('-')
        .map(|part| {
            let mut chars = part.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::{extension_views, get_plugin, list_plugins, ExtensionRow};
    use crate::auth::AuthUser;
    use crate::error::AppResult;
    use crate::state::AppState;
    use axum::body::Body;
    use axum::extract::{Path, State};
    use axum::http::StatusCode;
    use axum::routing::get;
    use axum::Router;
    use opsweave_contracts::{
        ContributionRejectionCode, ContributionSurface, FrontendContributionKind, Role,
    };
    use serde_json::Value;
    use tower::ServiceExt;
    use uuid::Uuid;

    /// The paths `routes.rs` wires for the platform maintenance plugin reads.
    const PLATFORM_PLUGIN_READ_PATHS: [&str; 2] =
        ["/api/v1/plugins", "/api/v1/plugins/{plugin_id}"];

    fn auth_user(role: Role) -> AuthUser {
        AuthUser {
            user_id: Uuid::nil(),
            email: "user@example.invalid".to_string(),
            display_name: "Test User".to_string(),
            role,
            session_id: Uuid::nil(),
            csrf_token: "csrf-token".to_string(),
            via_cookie: false,
        }
    }

    /// A pool that never dials: every gate under test decides before the first
    /// query, so `cargo test` stays free of a live database.
    fn state() -> AppState {
        let db = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://opsweave.invalid:1/opsweave")
            .expect("lazy pool");
        AppState::new(crate::config::Config::from_env(), db, vec![0u8; 32]).expect("app state")
    }

    /// The handler bodies are reached with a viewer token: each must stop at the
    /// `require_operator` gate before touching the database.
    #[tokio::test]
    async fn viewer_is_forbidden_from_every_platform_plugin_read() {
        let state = state();
        let viewer = auth_user(Role::Viewer);
        let denied = [
            list_plugins(State(state.clone()), viewer.clone())
                .await
                .err(),
            get_plugin(
                State(state.clone()),
                viewer.clone(),
                Path("example".to_string()),
            )
            .await
            .err(),
        ];
        for (index, error) in denied.into_iter().enumerate() {
            let path = PLATFORM_PLUGIN_READ_PATHS[index];
            let error = error.unwrap_or_else(|| panic!("{path} must be denied for viewer"));
            assert_eq!(error.status, StatusCode::FORBIDDEN, "{path}");
            assert_eq!(error.code, "FORBIDDEN", "{path}");
        }
    }

    async fn probe_operator_gate(auth: AuthUser) -> AppResult<&'static str> {
        auth.require_operator()?;
        Ok("operator-gated")
    }

    fn gated_router(role: Role) -> Router {
        let mut router = Router::new();
        for path in PLATFORM_PLUGIN_READ_PATHS {
            router = router.route(path, get(probe_operator_gate));
        }
        router.layer(axum::middleware::from_fn(
            move |mut request: axum::extract::Request, next: axum::middleware::Next| {
                let user = auth_user(role);
                async move {
                    request.extensions_mut().insert(user);
                    next.run(request).await
                }
            },
        ))
    }

    #[tokio::test]
    async fn platform_plugin_reads_answer_403_for_viewer_and_200_for_operator_and_admin() {
        async fn status(role: Role, path: &str) -> StatusCode {
            let uri = path.replace("{plugin_id}", "example");
            gated_router(role)
                .oneshot(
                    axum::http::Request::builder()
                        .uri(uri)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
                .status()
        }

        for path in PLATFORM_PLUGIN_READ_PATHS {
            assert_eq!(
                status(Role::Viewer, path).await,
                StatusCode::FORBIDDEN,
                "{path}"
            );
            assert_eq!(status(Role::Operator, path).await, StatusCode::OK, "{path}");
            assert_eq!(status(Role::Admin, path).await, StatusCode::OK, "{path}");
        }
    }

    // -- /api/v1/extensions delivery: surfaces, capabilities, readiness -------

    const PLUGIN: &str = "opsweave.data-catalog";
    const ADMIN_PATH: &str = "/admin/ext/opsweave.data-catalog/manage";
    const WORKSPACE_PATH: &str = "/app/ext/opsweave.data-catalog/quality";

    fn manifest(plugin_id: &str, contributions: Value, with_backend: bool) -> Value {
        let backend = if with_backend {
            serde_json::json!({
                "runtime": "oci",
                "imageRef": format!("127.0.0.1:15001/opsweave/data-catalog@sha256:{}", "a".repeat(64)),
                "protocol": {"name": "http-json", "version": "1", "containerPort": 8080},
                "health": {
                    "readinessPath": "/_opsweave/health/ready",
                    "livenessPath": "/_opsweave/health/live"
                },
                "apiPrefix": "/api/data-catalog"
            })
        } else {
            Value::Null
        };
        serde_json::json!({
            "schemaVersion": "1.1",
            "id": plugin_id,
            "version": "0.0.1",
            "publisher": "trusted-team",
            "compatibility": {"kernelApiMajor": 1, "webSdkMajor": 1},
            "artifactDigest": format!("sha256:{}", "b".repeat(64)),
            "frontend": {
                "remoteEntry": "frontend/remoteEntry.js",
                "remoteEntryDigest": format!("sha256:{}", "c".repeat(64)),
                "assetIndex": "frontend/asset-index.json",
                "assetIndexDigest": format!("sha256:{}", "d".repeat(64)),
                "contributions": contributions
            },
            "backend": backend,
            "provides": [],
            "requires": [],
            "permissions": [],
            "resources": {"cpuMillis": 100, "memoryMiB": 64}
        })
    }

    fn row(
        plugin_id: &str,
        contributions: Value,
        with_backend: bool,
        ready_instances: i64,
    ) -> ExtensionRow {
        (
            plugin_id.to_string(),
            "trusted-team".to_string(),
            "0.0.1".to_string(),
            1,
            manifest(plugin_id, contributions, with_backend),
            ready_instances,
        )
    }

    fn both_surfaces() -> Value {
        serde_json::json!([
            {
                "kind": "navigation.item.v2",
                "id": "catalog-manage",
                "surface": "admin",
                "path": ADMIN_PATH,
                "titleKey": "catalog.nav.manage"
            },
            {
                "kind": "navigation.item.v2",
                "id": "catalog-quality",
                "surface": "workspace",
                "path": WORKSPACE_PATH,
                "titleKey": "catalog.nav.quality"
            }
        ])
    }

    /// Rule 5: the server, not the client, decides what a session receives.
    #[test]
    fn workspace_only_session_receives_no_admin_contribution() {
        let rows = vec![row(PLUGIN, both_surfaces(), false, 0)];

        let views = extension_views(rows.clone(), &["workspace:access"]);
        assert_eq!(
            views.len(),
            1,
            "the workspace contribution is still offered"
        );
        assert_eq!(views[0].contributions.len(), 1);
        assert_eq!(views[0].contributions[0].path, WORKSPACE_PATH);
        assert!(
            views[0]
                .contributions
                .iter()
                .all(|contribution| contribution.surface != ContributionSurface::Admin),
            "a session without platform:access must never receive an admin contribution"
        );
        assert!(
            views[0].rejections.is_empty(),
            "a missing capability is not a contract violation and is not reported"
        );

        let platform = extension_views(rows, &["platform:access", "workspace:access"]);
        assert_eq!(platform[0].contributions.len(), 2);
    }

    /// Rule 6: an already signed v1 contribution is delivered unchanged, as admin.
    #[test]
    fn platform_session_receives_legacy_v1_contribution_unchanged() {
        let rows = vec![row(
            PLUGIN,
            serde_json::json!([
                {
                    "kind": "navigation.item.v1",
                    "id": "data-catalog-nav",
                    "path": "/ext/trusted-team/data-catalog"
                },
                {
                    "kind": "navigation.item.v2",
                    "id": "catalog-manage",
                    "surface": "admin",
                    "path": ADMIN_PATH
                }
            ]),
            false,
            0,
        )];
        let views = extension_views(rows, &["platform:access", "workspace:access"]);
        assert_eq!(views[0].contributions.len(), 2);
        let legacy = views[0]
            .contributions
            .iter()
            .find(|contribution| contribution.kind == FrontendContributionKind::NavigationItem)
            .expect("the v1 contribution is delivered");
        assert_eq!(legacy.path, "/ext/trusted-team/data-catalog");
        assert_eq!(legacy.surface, ContributionSurface::Admin);
        assert_eq!(legacy.id, "data-catalog-nav");
    }

    /// Rule 7: an active plugin with a backend that has no READY instance is
    /// withheld; a frontend-only plugin has no instance to wait for.
    #[test]
    fn backend_without_a_ready_instance_withholds_its_contributions() {
        let capabilities = ["platform:access", "workspace:access"];
        let degraded = vec![row(PLUGIN, both_surfaces(), true, 0)];
        assert!(
            extension_views(degraded, &capabilities).is_empty(),
            "an ACTIVE revision with no READY instance must not route navigation"
        );
        let ready = vec![row(PLUGIN, both_surfaces(), true, 1)];
        assert_eq!(extension_views(ready, &capabilities).len(), 1);
        let frontend_only = vec![row(PLUGIN, both_surfaces(), false, 0)];
        assert_eq!(extension_views(frontend_only, &capabilities).len(), 1);
    }

    /// Rules 2/3: a refused contribution is reported with its code, not dropped.
    #[test]
    fn invalid_v2_contribution_is_reported_instead_of_dropped() {
        let rows = vec![row(
            PLUGIN,
            serde_json::json!([
                {
                    "kind": "navigation.item.v2",
                    "id": "catalog-manage",
                    "surface": "admin",
                    "path": "/admin/plugins"
                }
            ]),
            false,
            0,
        )];
        let views = extension_views(rows, &["platform:access", "workspace:access"]);
        assert_eq!(views.len(), 1);
        assert!(views[0].contributions.is_empty());
        assert_eq!(views[0].rejections.len(), 1);
        assert_eq!(
            views[0].rejections[0].code,
            ContributionRejectionCode::ReservedPrefix
        );
        assert_eq!(views[0].rejections[0].contribution_id, "catalog-manage");
        assert_eq!(views[0].rejections[0].plugin_id, PLUGIN);
        assert!(!views[0].rejections[0].detail.is_empty());
    }

    /// Nothing to deliver and nothing to report: the extension is not disclosed.
    #[test]
    fn extension_with_nothing_to_deliver_is_omitted() {
        let admin_only = serde_json::json!([
            {
                "kind": "navigation.item.v2",
                "id": "catalog-manage",
                "surface": "admin",
                "path": ADMIN_PATH
            }
        ]);
        let rows = vec![row(PLUGIN, admin_only, false, 0)];
        assert!(extension_views(rows, &["workspace:access"]).is_empty());
    }
}
