use crate::audit::{self, AuditEventView};
use crate::auth::AuthUser;
use crate::deployments::{self, ActivationRow, DeploymentRow, DeploymentView};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::Json;
use chrono::{DateTime, Utc};
use opsweave_contracts::ManifestV11;
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
    _auth: AuthUser,
) -> AppResult<Json<Vec<PluginSummary>>> {
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
    _auth: AuthUser,
    Path(plugin_id): Path<String>,
) -> AppResult<Json<PluginDetail>> {
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
    pub contributions: Value,
}

pub async fn extensions(
    State(state): State<AppState>,
    _auth: AuthUser,
) -> AppResult<Json<Vec<ExtensionView>>> {
    let rows = sqlx::query_as::<_, (String, String, String, i64, Value)>(
        r#"
        SELECT r.plugin_id, p.publisher, r.version, r.generation, p.manifest
        FROM kernel.activation_revisions r
        JOIN kernel.plugin_packages p ON p.package_id=r.package_id
        JOIN kernel.trusted_publishers tp ON tp.publisher_id=p.publisher
        WHERE r.status='ACTIVE' AND tp.trust_state='TRUSTED' AND p.manifest->'frontend' IS NOT NULL AND p.manifest->'frontend' <> 'null'::jsonb
        ORDER BY r.plugin_id
        "#,
    )
    .fetch_all(&state.db)
    .await?;
    let mut result = Vec::new();
    for (plugin_id, publisher, version, generation, manifest_value) in rows {
        let manifest: ManifestV11 = match serde_json::from_value(manifest_value) {
            Ok(manifest) => manifest,
            Err(error) => {
                tracing::warn!(plugin = %plugin_id, error = %error, "active manifest invalid");
                continue;
            }
        };
        let Some(frontend) = manifest.frontend else {
            continue;
        };
        result.push(ExtensionView {
            asset_base: format!(
                "/assets/{}/{}/{}",
                urlencoding::encode(&publisher),
                urlencoding::encode(&plugin_id),
                urlencoding::encode(&version)
            ),
            remote_entry: frontend.remote_entry,
            contributions: serde_json::to_value(frontend.contributions)
                .unwrap_or(Value::Array(vec![])),
            plugin_id,
            publisher,
            version,
            activation_revision: generation,
        });
    }
    Ok(Json(result))
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
