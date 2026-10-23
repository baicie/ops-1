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
    if plugin_id == "opsweave.data-catalog" {
        sqlx::query(&format!(
            "GRANT EXECUTE ON FUNCTION kernel.fence_authorize(uuid, uuid, bigint) TO \"{role_name}\""
        ))
        .execute(&state.db)
        .await
        .map_err(|error| {
            tracing::error!(plugin = %plugin_id, error = %error, "grant fence function failed");
            AppError::internal("could not grant fence authorization")
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

fn skip_line_comment(sql: &str, index: usize) -> usize {
    sql[index..]
        .find('\n')
        .map(|relative| index + relative + 1)
        .unwrap_or(sql.len())
}

fn skip_block_comment(sql: &str, index: usize) -> usize {
    let mut cursor = index + 2;
    let mut depth = 1usize;
    while cursor < sql.len() {
        let Some(character) = sql[cursor..].chars().next() else {
            break;
        };
        if sql[cursor..].starts_with("/*") {
            depth += 1;
            cursor += 2;
        } else if sql[cursor..].starts_with("*/") {
            depth -= 1;
            cursor += 2;
            if depth == 0 {
                return cursor;
            }
        } else {
            cursor += character.len_utf8();
        }
    }
    sql.len()
}

fn skip_single_quoted(sql: &str, index: usize) -> usize {
    let mut cursor = index + 1;
    while cursor < sql.len() {
        let Some(character) = sql[cursor..].chars().next() else {
            break;
        };
        if character == '\\' {
            cursor += 1;
            if cursor < sql.len() {
                if let Some(next) = sql[cursor..].chars().next() {
                    cursor += next.len_utf8();
                }
            }
            continue;
        }
        if character == '\'' {
            if sql[cursor + 1..].starts_with('\'') {
                cursor += 2;
                continue;
            }
            return cursor + 1;
        }
        cursor += character.len_utf8();
    }
    sql.len()
}

fn skip_double_quoted(sql: &str, index: usize) -> usize {
    let mut cursor = index + 1;
    while cursor < sql.len() {
        let Some(character) = sql[cursor..].chars().next() else {
            break;
        };
        if character == '"' {
            if sql[cursor + 1..].starts_with('"') {
                cursor += 2;
                continue;
            }
            return cursor + 1;
        }
        cursor += character.len_utf8();
    }
    sql.len()
}

fn dollar_quote_end(sql: &str, index: usize) -> Option<usize> {
    let relative_end = sql[index + 1..].find('$')?;
    let tag_end = index + 1 + relative_end;
    let tag = &sql[index + 1..tag_end];
    let valid_tag = tag.is_empty()
        || tag
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
            && tag
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_');
    if !valid_tag {
        return None;
    }
    let delimiter = &sql[index..=tag_end];
    let content_start = tag_end + 1;
    sql[content_start..]
        .find(delimiter)
        .map(|relative| content_start + relative + delimiter.len())
        .or(Some(sql.len()))
}

fn split_sql_statements(sql: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut start = 0usize;
    let mut index = 0usize;
    while index < sql.len() {
        let Some(character) = sql[index..].chars().next() else {
            break;
        };
        if character == '-' && sql[index..].starts_with("--") {
            index = skip_line_comment(sql, index);
            continue;
        }
        if character == '/' && sql[index..].starts_with("/*") {
            index = skip_block_comment(sql, index);
            continue;
        }
        if character == '\'' {
            index = skip_single_quoted(sql, index);
            continue;
        }
        if character == '"' {
            index = skip_double_quoted(sql, index);
            continue;
        }
        if character == '$' {
            if let Some(end) = dollar_quote_end(sql, index) {
                index = end;
                continue;
            }
        }
        if character == ';' {
            statements.push(sql[start..index].to_string());
            start = index + 1;
        }
        index += character.len_utf8();
    }
    if start < sql.len() {
        statements.push(sql[start..].to_string());
    }
    statements
}

fn has_transaction_control(sql: &str) -> bool {
    let mut index = 0usize;
    while index < sql.len() {
        let Some(character) = sql[index..].chars().next() else {
            break;
        };
        if character == '-' && sql[index..].starts_with("--") {
            index = skip_line_comment(sql, index);
            continue;
        }
        if character == '/' && sql[index..].starts_with("/*") {
            index = skip_block_comment(sql, index);
            continue;
        }
        if character == '\'' {
            index = skip_single_quoted(sql, index);
            continue;
        }
        if character == '"' {
            index = skip_double_quoted(sql, index);
            continue;
        }
        if character == '$' {
            if let Some(end) = dollar_quote_end(sql, index) {
                index = end;
                continue;
            }
        }
        if character.is_ascii_alphabetic() || character == '_' {
            let word_start = index;
            index += character.len_utf8();
            while index < sql.len() {
                let Some(next) = sql[index..].chars().next() else {
                    break;
                };
                if next.is_ascii_alphanumeric() || next == '_' {
                    index += next.len_utf8();
                } else {
                    break;
                }
            }
            let word = sql[word_start..index].to_ascii_uppercase();
            if matches!(
                word.as_str(),
                "COMMIT" | "ROLLBACK" | "BEGIN" | "ABORT" | "SAVEPOINT" | "RELEASE"
            ) {
                return true;
            }
            continue;
        }
        index += character.len_utf8();
    }
    false
}

async fn record_failed_migration(
    state: &AppState,
    plugin_id: &str,
    payload: &ApplyMigrationRequest,
    error: &str,
) {
    let _ = sqlx::query(
        "INSERT INTO kernel.plugin_migrations (id,plugin_id,version,migration_id,checksum,status,phase,plan_digest,details) VALUES ($1,$2,$3,$4,$5,'FAILED',$6,NULL,$7) ON CONFLICT (plugin_id,version,migration_id) DO UPDATE SET status='FAILED', details=EXCLUDED.details WHERE kernel.plugin_migrations.status <> 'APPLIED'",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(plugin_id)
    .bind(&payload.version)
    .bind(&payload.migration_id)
    .bind(&payload.checksum)
    .bind(&payload.phase)
    .bind(serde_json::json!({"error": error}))
    .execute(&state.db)
    .await;
}

#[cfg(test)]
mod tests {
    use super::{has_transaction_control, safe_names, split_sql_statements};

    #[test]
    fn migration_sql_is_split_without_breaking_quoted_semicolons() {
        let statements = split_sql_statements("CREATE TABLE t(id int); SELECT 'a;b'; SELECT 1;");
        assert_eq!(statements.len(), 3);
        assert!(statements[1].contains("'a;b'"));
    }

    #[test]
    fn migration_sql_handles_comments_utf8_and_dollar_quotes() {
        let sql = "-- semicolon ; in a comment\n                   CREATE TABLE t(id int); /* block ; comment */\n                   SELECT '中文;字符串';\n                   DO $$ BEGIN RAISE NOTICE '中文;内容'; END $$;";
        let statements = split_sql_statements(sql);
        assert_eq!(statements.len(), 3, "statements: {statements:?}");
        assert!(statements[0].contains("-- semicolon ; in a comment"));
        assert!(statements[1].contains("block ; comment"));
        assert!(statements[1].contains("中文;字符串"));
        assert!(statements[2].contains("$$ BEGIN RAISE NOTICE '中文;内容'; END $$"));
        assert!(!has_transaction_control(sql));
    }

    #[test]
    fn transaction_control_inside_strings_and_comments_is_not_control() {
        assert!(!has_transaction_control(
            "SELECT 'COMMIT; 中文' -- COMMIT ;\n; /* ROLLBACK; */"
        ));
        assert!(!has_transaction_control(
            "DO $$ BEGIN RAISE NOTICE 'COMMIT;'; END $$;"
        ));
        assert!(has_transaction_control("CREATE TABLE t(id int); COMMIT;"));
        assert!(has_transaction_control("ROLLBACK"));
    }

    #[test]
    fn migration_sql_rejects_transaction_control() {
        assert!(has_transaction_control("CREATE TABLE t(id int); COMMIT;"));
        assert!(has_transaction_control("ROLLBACK"));
        assert!(!has_transaction_control("CREATE TABLE t(id int)"));
        assert!(!has_transaction_control(
            "SELECT CASE WHEN true THEN 1 ELSE 0 END"
        ));
    }

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
        "SELECT migration_id,version,checksum,phase,status,applied_at FROM kernel.plugin_migrations WHERE plugin_id=$1 ORDER BY migration_id",
    )
    .bind(&plugin_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyMigrationRequest {
    pub version: String,
    pub migration_id: String,
    pub phase: String,
    pub checksum: String,
    pub sql: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyMigrationResponse {
    pub plugin_id: String,
    pub migration_id: String,
    pub status: String,
    pub checksum: String,
    pub replay: bool,
}

pub async fn apply_migration(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(plugin_id): Path<String>,
    Json(payload): Json<ApplyMigrationRequest>,
) -> AppResult<Json<ApplyMigrationResponse>> {
    auth.require_admin()?;
    if !matches!(payload.phase.as_str(), "EXPAND" | "MIGRATE" | "CONTRACT") {
        return Err(AppError::bad_request("invalid migration phase"));
    }
    if payload.phase == "CONTRACT" {
        let active: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.plugin_instances i JOIN kernel.plugin_deployments d ON d.id=i.deployment_id WHERE d.plugin_id=$1 AND i.desired_action='START'",
        )
        .bind(&plugin_id)
        .fetch_one(&state.db)
        .await?;
        if active > 0 {
            return Err(AppError::conflict(
                "MIGRATION_CONTRACT_BLOCKED",
                "CONTRACT migration requires all plugin instances to have drained",
            ));
        }
    }
    if payload.migration_id.len() < 3 || payload.migration_id.len() > 64 {
        return Err(AppError::bad_request("invalid migration id"));
    }
    let actual = opsweave_bundle::sha256_digest(payload.sql.as_bytes());
    if actual != payload.checksum {
        return Err(AppError::conflict(
            "MIGRATION_CHECKSUM_MISMATCH",
            "migration checksum does not match SQL bytes",
        ));
    }
    let binding = sqlx::query_as::<_, StorageBindingRow>(
        "SELECT plugin_id,schema_name,role_name,credential_ref,state,migration_plan_digest,created_at,updated_at FROM kernel.plugin_storage_bindings WHERE plugin_id=$1 AND state='READY'",
    )
    .bind(&plugin_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::conflict("STORAGE_NOT_BOUND", "plugin storage binding is not ready"))?;
    let existing: Option<(String, String)> = sqlx::query_as(
        "SELECT checksum,status FROM kernel.plugin_migrations WHERE plugin_id=$1 AND version=$2 AND migration_id=$3",
    )
    .bind(&plugin_id)
    .bind(&payload.version)
    .bind(&payload.migration_id)
    .fetch_optional(&state.db)
    .await?;
    if let Some((checksum, status)) = existing {
        if checksum != payload.checksum {
            return Err(AppError::conflict(
                "MIGRATION_CHECKSUM_MISMATCH",
                "an applied migration has a different checksum",
            ));
        }
        if status == "APPLIED" {
            return Ok(Json(ApplyMigrationResponse {
                plugin_id,
                migration_id: payload.migration_id,
                status,
                checksum,
                replay: true,
            }));
        }
        return Err(AppError::conflict(
            "MIGRATION_BLOCKED",
            format!("migration is already in status {status}"),
        ));
    }

    if has_transaction_control(&payload.sql) {
        return Err(AppError::bad_request(
            "migration SQL must not contain transaction-control statements",
        ));
    }

    let mut tx = state.db.begin().await?;
    // Serialize migration attempts per plugin. The advisory lock is
    // transaction-scoped, so a crashed request cannot leave a stuck lock.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("plugin-migration:{plugin_id}"))
        .execute(&mut *tx)
        .await?;

    let existing: Option<(String, String)> = sqlx::query_as(
        "SELECT checksum,status FROM kernel.plugin_migrations WHERE plugin_id=$1 AND version=$2 AND migration_id=$3",
    )
    .bind(&plugin_id)
    .bind(&payload.version)
    .bind(&payload.migration_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((checksum, status)) = existing {
        tx.rollback().await.ok();
        if checksum != payload.checksum {
            return Err(AppError::conflict(
                "MIGRATION_CHECKSUM_MISMATCH",
                "an applied migration has a different checksum",
            ));
        }
        if status == "APPLIED" {
            return Ok(Json(ApplyMigrationResponse {
                plugin_id,
                migration_id: payload.migration_id,
                status,
                checksum,
                replay: true,
            }));
        }
        return Err(AppError::conflict(
            "MIGRATION_BLOCKED",
            format!("migration is already in status {status}"),
        ));
    }

    let pending = sqlx::query(
        "INSERT INTO kernel.plugin_migrations (id,plugin_id,version,migration_id,checksum,status,phase,plan_digest,details) VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$7,$8)",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(&plugin_id)
    .bind(&payload.version)
    .bind(&payload.migration_id)
    .bind(&payload.checksum)
    .bind(&payload.phase)
    .bind(&binding.migration_plan_digest)
    .bind(serde_json::json!({"execution": "started"}))
    .execute(&mut *tx)
    .await;
    if let Err(error) = pending {
        tx.rollback().await.ok();
        record_failed_migration(&state, &plugin_id, &payload, &error.to_string()).await;
        return Err(AppError::conflict(
            "MIGRATION_FAILED",
            "migration ledger entry could not be created; no SQL was applied",
        ));
    }

    let migration_sql = payload.sql.clone();
    let set_role = format!("SET LOCAL ROLE \"{}\"", binding.role_name);
    let set_path = format!("SET LOCAL search_path = \"{}\"", binding.schema_name);
    let execution = async {
        sqlx::query(&set_role).execute(&mut *tx).await?;
        sqlx::query(&set_path).execute(&mut *tx).await?;
        for statement in split_sql_statements(&migration_sql) {
            if !statement.trim().is_empty() {
                sqlx::query(&statement).execute(&mut *tx).await?;
            }
        }
        sqlx::query("RESET ROLE").execute(&mut *tx).await?;
        sqlx::query(
            "UPDATE kernel.plugin_migrations SET status='APPLIED',applied_at=now(),details='{}'::jsonb WHERE plugin_id=$1 AND version=$2 AND migration_id=$3 AND status='PENDING'",
        )
        .bind(&plugin_id)
        .bind(&payload.version)
        .bind(&payload.migration_id)
        .execute(&mut *tx)
        .await?;
        Ok::<(), sqlx::Error>(())
    }
    .await;
    if let Err(error) = execution {
        tx.rollback().await.ok();
        record_failed_migration(&state, &plugin_id, &payload, &error.to_string()).await;
        return Err(AppError::conflict(
            "MIGRATION_FAILED",
            "migration failed and was rolled back; manual recovery is required",
        ));
    }
    tx.commit().await?;
    Ok(Json(ApplyMigrationResponse {
        plugin_id,
        migration_id: payload.migration_id,
        status: "APPLIED".into(),
        checksum: payload.checksum,
        replay: false,
    }))
}
