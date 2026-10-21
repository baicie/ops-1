use crate::error::{AppError, AppResult};
use crate::packages::package_dir_for;
use crate::state::AppState;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::Response;

pub async fn serve_asset(
    State(state): State<AppState>,
    Path((publisher, plugin_id, version, path)): Path<(String, String, String, String)>,
) -> AppResult<Response> {
    if !path.starts_with("frontend/")
        || path.contains("..")
        || path.contains('\\')
        || path.starts_with('/')
    {
        return Err(AppError::not_found("asset not found"));
    }
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT bundle_digest, publisher FROM kernel.plugin_packages WHERE plugin_id=$1 AND version=$2 AND status <> 'REJECTED'",
    )
    .bind(&plugin_id)
    .bind(&version)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found("plugin asset version not found"))?;
    if row.1 != publisher {
        return Err(AppError::not_found("asset not found"));
    }
    let root = package_dir_for(&state, &plugin_id, &version, &row.0).await;
    let file_path = root.join(&path);
    let canonical_root = root
        .canonicalize()
        .map_err(|_| AppError::not_found("asset store is unavailable"))?;
    let canonical_file = file_path
        .canonicalize()
        .map_err(|_| AppError::not_found("asset not found"))?;
    if !canonical_file.starts_with(&canonical_root) {
        return Err(AppError::not_found("asset not found"));
    }
    let content = tokio::fs::read(&canonical_file)
        .await
        .map_err(|_| AppError::not_found("asset not found"))?;
    let mime = mime_guess::from_path(&canonical_file)
        .first_or_octet_stream()
        .to_string();
    let mut response = Response::new(Body::from(content));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_str(&mime)
            .unwrap_or_else(|_| header::HeaderValue::from_static("application/octet-stream")),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    response.headers_mut().insert(
        header::HeaderName::from_static("x-content-type-options"),
        header::HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}
