use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::Serialize;
use sqlx::FromRow;
use url::Url;

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct StorageBindingView {
    pub plugin_id: String,
    pub schema_name: String,
    pub role_name: String,
    pub state: String,
    pub migration_plan_digest: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct StorageBindingRow {
    plugin_id: String,
    schema_name: String,
    role_name: String,
    #[allow(dead_code)]
    credential_ref: String,
    state: String,
    migration_plan_digest: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl From<StorageBindingRow> for StorageBindingView {
    fn from(row: StorageBindingRow) -> Self {
        Self {
            plugin_id: row.plugin_id,
            schema_name: row.schema_name,
            role_name: row.role_name,
            state: row.state,
            migration_plan_digest: row.migration_plan_digest,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

pub async fn get_binding(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path(plugin_id): Path<String>,
) -> AppResult<Json<StorageBindingView>> {
    let row = sqlx::query_as::<_, StorageBindingRow>(
        "SELECT plugin_id,schema_name,role_name,credential_ref,state,migration_plan_digest,created_at,updated_at FROM kernel.plugin_storage_bindings WHERE plugin_id=$1",
    )
    .bind(plugin_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found("plugin storage binding not found"))?;
    Ok(Json(row.into()))
}

pub async fn ensure_binding(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(plugin_id): Path<String>,
) -> AppResult<(StatusCode, Json<StorageBindingView>)> {
    auth.require_admin()?;
    let view = provision_binding(&state, &plugin_id).await?;
    Ok((StatusCode::CREATED, Json(view)))
}

pub async fn provision_binding(state: &AppState, plugin_id: &str) -> AppResult<StorageBindingView> {
    let (schema_name, role_name) = safe_names(plugin_id)?;
    if let Some(existing) = sqlx::query_as::<_, StorageBindingRow>(
        "SELECT plugin_id,schema_name,role_name,credential_ref,state,migration_plan_digest,created_at,updated_at FROM kernel.plugin_storage_bindings WHERE plugin_id=$1",
    )
    .bind(plugin_id)
    .fetch_optional(&state.db)
    .await?
    {
        return Ok(existing.into());
    }

    let mut password_bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut password_bytes);
    let password = password_bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let credential_ref = plugin_database_url(state, &role_name, &password)?;
    let db_name = database_name(&state.config.database_url)?;
    let role_exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=$1)")
            .bind(&role_name)
            .fetch_one(&state.db)
            .await?;
    let role_statement = if role_exists {
        format!("ALTER ROLE \"{role_name}\" LOGIN PASSWORD '{password}'")
    } else {
        format!("CREATE ROLE \"{role_name}\" LOGIN PASSWORD '{password}'")
    };
    sqlx::query(&role_statement).execute(&state.db).await.map_err(|error| {
        tracing::error!(plugin = %plugin_id, error = %error, "create plugin storage role failed");
        AppError::conflict("STORAGE_BIND_FAILED", "could not create plugin storage role")
    })?;
    let create_schema =
        format!("CREATE SCHEMA IF NOT EXISTS \"{schema_name}\" AUTHORIZATION \"{role_name}\"");
    sqlx::query(&create_schema)
        .execute(&state.db)
        .await
        .map_err(|error| {
            tracing::error!(plugin = %plugin_id, error = %error, "create plugin schema failed");
            AppError::internal("could not create plugin schema")
        })?;
    let grant_connect = format!("GRANT CONNECT ON DATABASE \"{db_name}\" TO \"{role_name}\"");
    let grant_schema =
        format!("GRANT USAGE, CREATE ON SCHEMA \"{schema_name}\" TO \"{role_name}\"");
    let set_path = format!("ALTER ROLE \"{role_name}\" SET search_path = \"{schema_name}\"");
    for statement in [grant_connect, grant_schema, set_path] {
        sqlx::query(&statement).execute(&state.db).await.map_err(|error| {
            tracing::error!(plugin = %plugin_id, error = %error, "grant plugin schema privileges failed");
            AppError::internal("could not grant plugin schema privileges")
        })?;
    }
    let row = sqlx::query_as::<_, StorageBindingRow>(
        r#"
        INSERT INTO kernel.plugin_storage_bindings
          (plugin_id,schema_name,role_name,credential_ref,state)
        VALUES ($1,$2,$3,$4,'READY')
        RETURNING plugin_id,schema_name,role_name,credential_ref,state,migration_plan_digest,created_at,updated_at
        "#,
    )
    .bind(plugin_id)
    .bind(&schema_name)
    .bind(&role_name)
    .bind(&credential_ref)
    .fetch_one(&state.db)
    .await?;
    tracing::info!(plugin = %plugin_id, schema = %schema_name, "plugin storage binding provisioned");
    Ok(row.into())
}

fn safe_names(plugin_id: &str) -> AppResult<(String, String)> {
    if plugin_id.len() < 3
        || plugin_id.len() > 100
        || !plugin_id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
    {
        return Err(AppError::bad_request("invalid plugin id for storage"));
    }
    let safe = plugin_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect::<String>();
    let stem = if safe.len() <= 45 {
        safe
    } else {
        safe[..45].to_string()
    };
    Ok((format!("plugin_{stem}"), format!("plugin_{stem}_role")))
}

fn database_name(database_url: &str) -> AppResult<String> {
    let url = Url::parse(database_url).map_err(|_| AppError::internal("invalid database URL"))?;
    let name = url.path().trim_start_matches('/').trim();
    if name.is_empty() {
        return Err(AppError::internal("database URL has no database name"));
    }
    Ok(name.to_string())
}

fn plugin_database_url(state: &AppState, role: &str, password: &str) -> AppResult<String> {
    let url = Url::parse(&state.config.database_url)
        .map_err(|_| AppError::internal("invalid database URL"))?;
    let port = url.port().unwrap_or(5432);
    let db = database_name(&state.config.database_url)?;
    Ok(format!(
        "postgres://{}:{}@{}:{}/{}?sslmode=disable",
        urlencoding::encode(role),
        urlencoding::encode(password),
        state.config.plugin_db_host,
        port,
        urlencoding::encode(&db)
    ))
}

#[cfg(test)]
mod tests {
    use super::safe_names;

    #[test]
    fn storage_names_are_bounded_and_safe() {
        let (schema, role) = safe_names("opsweave.data-catalog").unwrap();
        assert_eq!(schema, "plugin_opsweave_data_catalog");
        assert_eq!(role, "plugin_opsweave_data_catalog_role");
        assert!(safe_names("../bad").is_err());
    }
}

#[derive(Debug, serde::Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MigrationView {
    pub migration_id: String,
    pub version: String,
    pub checksum: String,
    pub phase: String,
    pub status: String,
    pub applied_at: Option<chrono::DateTime<Utc>>,
}

pub async fn list_migrations(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path(plugin_id): Path<String>,
) -> AppResult<Json<Vec<MigrationView>>> {
    let rows = sqlx::query_as::<_, MigrationView>(
        "SELECT migration_id,version,checksum,phase,status,applied_at FROM kernel.plugin_migrations WHERE plugin_id=$1 ORDER BY created_at, migration_id",
    )
    .bind(&plugin_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}
