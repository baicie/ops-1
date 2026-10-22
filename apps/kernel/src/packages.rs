use crate::audit;
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use chrono::{DateTime, Utc};
use opsweave_bundle::{parse_public_key, verify_bundle, BundleLimits, VerifiedBundle};
use opsweave_contracts::{AssetIndex, ManifestV11};
use serde::Serialize;
use serde_json::Value;
use sqlx::FromRow;
use uuid::Uuid;

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct PackageRow {
    pub package_id: Uuid,
    pub plugin_id: String,
    pub version: String,
    pub schema_version: String,
    pub publisher: String,
    pub manifest: Value,
    pub artifact_digest: String,
    pub bundle_digest: String,
    pub payload_digest: String,
    pub frontend_index: Option<Value>,
    pub backend_image_ref: Option<String>,
    pub status: String,
    pub signature_state: String,
    pub rejection_reason: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageView {
    pub package_id: Uuid,
    pub plugin_id: String,
    pub version: String,
    pub publisher: String,
    pub status: String,
    pub signature_state: String,
    pub artifact_digest: String,
    pub bundle_digest: String,
    pub payload_digest: String,
    pub image_ref: Option<String>,
    pub frontend_index: Option<Value>,
    pub manifest: Value,
    pub rejection_reason: Option<String>,
    pub created_at: DateTime<Utc>,
}

impl From<&PackageRow> for PackageView {
    fn from(row: &PackageRow) -> Self {
        Self {
            package_id: row.package_id,
            plugin_id: row.plugin_id.clone(),
            version: row.version.clone(),
            publisher: row.publisher.clone(),
            status: row.status.clone(),
            signature_state: row.signature_state.clone(),
            artifact_digest: row.artifact_digest.clone(),
            bundle_digest: row.bundle_digest.clone(),
            payload_digest: row.payload_digest.clone(),
            image_ref: row.backend_image_ref.clone(),
            frontend_index: row.frontend_index.clone(),
            manifest: row.manifest.clone(),
            rejection_reason: row.rejection_reason.clone(),
            created_at: row.created_at,
        }
    }
}

pub async fn upload(
    State(state): State<AppState>,
    auth: AuthUser,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> AppResult<(StatusCode, Json<PackageView>)> {
    auth.require_operator()?;
    if let Some(value) = headers.get("idempotency-key") {
        if value.to_str().unwrap_or_default().trim().len() < 8 {
            return Err(AppError::bad_request(
                "Idempotency-Key must be at least 8 characters",
            ));
        }
    } else {
        return Err(AppError::bad_request("Idempotency-Key header is required"));
    }
    if body.is_empty() {
        return Err(AppError::bad_request("empty bundle"));
    }
    let limits = BundleLimits::default();

    // Read the manifest without trusting it, only to resolve the publisher key.
    let files = opsweave_bundle::read_zip(&body, &limits)?;
    let manifest_bytes = files
        .get(opsweave_bundle::MANIFEST_PATH)
        .ok_or_else(|| AppError::bad_request("bundle is missing manifest.json"))?;
    let unsigned_manifest: ManifestV11 = serde_json::from_slice(manifest_bytes)
        .map_err(|error| AppError::bad_request(format!("manifest.json: {error}")))?;
    let publisher_row = sqlx::query_as::<_, (String, String, String)>(
        "SELECT public_key_hex, fingerprint, trust_state FROM kernel.trusted_publishers WHERE publisher_id = $1",
    )
    .bind(&unsigned_manifest.publisher)
    .fetch_optional(&state.db)
    .await?;
    let Some(publisher_row) = publisher_row else {
        audit_rejection(
            &state,
            &auth,
            &unsigned_manifest,
            "publisher is not in the trusted publisher store",
        )
        .await;
        return Err(AppError::forbidden(format!(
            "publisher '{}' is not in the trusted publisher store",
            unsigned_manifest.publisher
        )));
    };
    if publisher_row.2 != "TRUSTED" {
        audit_rejection(&state, &auth, &unsigned_manifest, "publisher is revoked").await;
        return Err(AppError::forbidden(format!(
            "publisher '{}' has been revoked",
            unsigned_manifest.publisher
        )));
    }
    let key = parse_public_key(&publisher_row.0)
        .map_err(|_| AppError::internal("trusted publisher key is corrupt"))?;
    let verified = match verify_bundle(&body, &key, &limits) {
        Ok(verified) => verified,
        Err(error) => {
            audit_rejection(&state, &auth, &unsigned_manifest, &error.to_string()).await;
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                "SIGNATURE_OR_BUNDLE_INVALID",
                error.to_string(),
            ));
        }
    };

    let existing_bundle: Option<PackageRow> = sqlx::query_as::<_, PackageRow>(
        "SELECT * FROM kernel.plugin_packages WHERE bundle_digest = $1",
    )
    .bind(&verified.bundle_digest)
    .fetch_optional(&state.db)
    .await?;
    if let Some(existing) = existing_bundle {
        return Ok((StatusCode::ACCEPTED, Json(PackageView::from(&existing))));
    }
    let existing_version: Option<PackageRow> = sqlx::query_as::<_, PackageRow>(
        "SELECT * FROM kernel.plugin_packages WHERE plugin_id = $1 AND version = $2",
    )
    .bind(&verified.manifest.id)
    .bind(&verified.manifest.version)
    .fetch_optional(&state.db)
    .await?;
    if let Some(existing) = existing_version {
        audit_rejection(
            &state,
            &auth,
            &verified.manifest,
            "same id+version already exists with a different bundle digest",
        )
        .await;
        return Err(AppError::conflict(
            "PACKAGE_VERSION_CONFLICT",
            format!(
                "{}@{} already exists with bundle {}; immutable versions cannot point to new bytes",
                existing.plugin_id, existing.version, existing.bundle_digest
            ),
        ));
    }

    let package_path = package_dir(&state, &verified);
    if let Err(error) = opsweave_bundle::extract_verified(&verified, &package_path) {
        return Err(AppError::internal(format!(
            "store verified package: {error}"
        )));
    }
    let frontend_index = verified.manifest.frontend.as_ref().and_then(|frontend| {
        verified
            .files
            .get(&frontend.asset_index)
            .and_then(|bytes| serde_json::from_slice::<AssetIndex>(bytes).ok())
            .and_then(|index| serde_json::to_value(index).ok())
    });
    let package_id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO kernel.plugin_packages
          (package_id, plugin_id, version, schema_version, publisher, manifest, artifact_digest,
           bundle_digest, payload_digest, frontend_index, backend_image_ref, status,
           signature_state, uploaded_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'STAGED','VERIFIED',$12)
        "#,
    )
    .bind(package_id)
    .bind(&verified.manifest.id)
    .bind(&verified.manifest.version)
    .bind(&verified.manifest.schema_version)
    .bind(&verified.manifest.publisher)
    .bind(serde_json::to_value(&verified.manifest).map_err(AppError::from)?)
    .bind(&verified.artifact_digest)
    .bind(&verified.bundle_digest)
    .bind(&verified.artifact_digest)
    .bind(frontend_index)
    .bind(
        verified
            .manifest
            .backend
            .as_ref()
            .map(|backend| backend.image_ref.clone()),
    )
    .bind(auth.user_id)
    .execute(&state.db)
    .await?;
    sqlx::query(
        r#"
        INSERT INTO kernel.plugin_installations (plugin_id, state)
        VALUES ($1,'STAGED')
        ON CONFLICT (plugin_id) DO UPDATE SET updated_at = now()
        "#,
    )
    .bind(&verified.manifest.id)
    .execute(&state.db)
    .await?;
    audit::record(
        &state.db,
        "plugin.staged",
        "USER",
        &auth.user_id.to_string(),
        "plugin",
        &verified.manifest.id,
        "plugin.stage",
        "CONFIRMED",
        serde_json::json!({
            "version": verified.manifest.version,
            "publisher": verified.manifest.publisher,
            "bundleDigest": verified.bundle_digest,
            "artifactDigest": verified.artifact_digest,
            "imageRef": verified.manifest.backend.as_ref().map(|backend| &backend.image_ref),
        }),
        None,
    )
    .await?;
    let row: PackageRow = sqlx::query_as::<_, PackageRow>(
        "SELECT * FROM kernel.plugin_packages WHERE package_id = $1",
    )
    .bind(package_id)
    .fetch_one(&state.db)
    .await?;
    tracing::info!(
        plugin = %row.plugin_id,
        version = %row.version,
        digest = %row.bundle_digest,
        "plugin package staged"
    );
    Ok((StatusCode::ACCEPTED, Json(PackageView::from(&row))))
}

async fn audit_rejection(state: &AppState, auth: &AuthUser, manifest: &ManifestV11, reason: &str) {
    let _ = audit::record(
        &state.db,
        "plugin.rejected",
        "USER",
        &auth.user_id.to_string(),
        "plugin",
        &manifest.id,
        "plugin.stage",
        "REJECTED",
        serde_json::json!({
            "version": manifest.version,
            "publisher": manifest.publisher,
            "reason": reason,
        }),
        None,
    )
    .await;
}

fn package_dir(state: &AppState, bundle: &VerifiedBundle) -> std::path::PathBuf {
    let digest = bundle.bundle_digest.trim_start_matches("sha256:");
    state
        .config
        .data_dir
        .join("packages")
        .join(&bundle.manifest.id)
        .join(&bundle.manifest.version)
        .join(&digest[..16])
}

pub async fn ensure_publisher_trusted(state: &AppState, publisher: &str) -> AppResult<()> {
    let trust_state: Option<String> = sqlx::query_scalar(
        "SELECT trust_state FROM kernel.trusted_publishers WHERE publisher_id = $1",
    )
    .bind(publisher)
    .fetch_optional(&state.db)
    .await?;
    match trust_state.as_deref() {
        Some("TRUSTED") => Ok(()),
        Some(_) => Err(AppError::conflict(
            "PUBLISHER_REVOKED",
            format!("publisher '{publisher}' is revoked; deploy and activation are blocked"),
        )),
        None => Err(AppError::conflict(
            "PUBLISHER_NOT_TRUSTED",
            format!("publisher '{publisher}' is not trusted"),
        )),
    }
}

pub async fn get_package(
    state: &AppState,
    plugin_id: &str,
    version: &str,
) -> AppResult<PackageRow> {
    sqlx::query_as::<_, PackageRow>(
        "SELECT * FROM kernel.plugin_packages WHERE plugin_id = $1 AND version = $2",
    )
    .bind(plugin_id)
    .bind(version)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found(format!("package {plugin_id}@{version} not found")))
}

#[allow(dead_code)]
pub async fn list_packages(
    state: &AppState,
    plugin_id: Option<&str>,
) -> AppResult<Vec<PackageRow>> {
    let rows = sqlx::query_as::<_, PackageRow>(
        r#"
        SELECT * FROM kernel.plugin_packages
        WHERE ($1::text IS NULL OR plugin_id = $1)
        ORDER BY created_at DESC
        "#,
    )
    .bind(plugin_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

pub async fn package_dir_for(
    state: &AppState,
    plugin_id: &str,
    version: &str,
    bundle_digest: &str,
) -> std::path::PathBuf {
    let digest = bundle_digest.trim_start_matches("sha256:");
    state
        .config
        .data_dir
        .join("packages")
        .join(plugin_id)
        .join(version)
        .join(&digest[..16])
}
