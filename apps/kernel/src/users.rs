use crate::audit;
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHasher, SaltString};
use argon2::Argon2;
use axum::extract::{Path, State};
use axum::Json;
use chrono::{DateTime, Utc};
use opsweave_contracts::Role;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct UserView {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
    pub role: String,
    pub disabled: bool,
    pub created_at: DateTime<Utc>,
}

pub async fn list_users(
    State(state): State<AppState>,
    auth: AuthUser,
) -> AppResult<Json<Vec<UserView>>> {
    auth.require_admin()?;
    let rows = sqlx::query_as::<_, UserView>(
        "SELECT id, email, display_name, role, disabled, created_at FROM kernel.users ORDER BY created_at",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateUserRequest {
    pub email: String,
    pub display_name: String,
    pub password: String,
    pub role: String,
}

pub async fn create_user(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(payload): Json<CreateUserRequest>,
) -> AppResult<Json<UserView>> {
    auth.require_admin()?;
    let role: Role = payload.role.parse().map_err(AppError::bad_request)?;
    if payload.email.trim().len() < 5 || !payload.email.contains('@') {
        return Err(AppError::bad_request("valid email is required"));
    }
    if payload.password.len() < 10 {
        return Err(AppError::bad_request(
            "password must be at least 10 characters",
        ));
    }
    if payload.display_name.trim().len() < 2 {
        return Err(AppError::bad_request("displayName is required"));
    }
    let exists: i64 =
        sqlx::query_scalar("SELECT count(*) FROM kernel.users WHERE lower(email)=lower($1)")
            .bind(payload.email.trim())
            .fetch_one(&state.db)
            .await?;
    if exists > 0 {
        return Err(AppError::conflict(
            "USER_ALREADY_EXISTS",
            "a user with this email already exists",
        ));
    }
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(payload.password.as_bytes(), &salt)
        .map_err(|error| AppError::internal(format!("password hash failed: {error}")))?
        .to_string();
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO kernel.users (id, email, display_name, password_hash, role) VALUES ($1,$2,$3,$4,$5)",
    )
    .bind(id)
    .bind(payload.email.trim().to_lowercase())
    .bind(payload.display_name.trim())
    .bind(hash)
    .bind(role.to_string())
    .execute(&state.db)
    .await?;
    audit::record(
        &state.db,
        "user.created",
        "USER",
        &auth.user_id.to_string(),
        "user",
        &id.to_string(),
        "user.create",
        "CONFIRMED",
        serde_json::json!({"email": payload.email, "role": role.to_string()}),
        None,
    )
    .await?;
    let row = fetch_user(&state, id).await?;
    Ok(Json(row))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateUserRequest {
    pub role: Option<String>,
    pub disabled: Option<bool>,
}

pub async fn update_user(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(user_id): Path<Uuid>,
    Json(payload): Json<UpdateUserRequest>,
) -> AppResult<Json<UserView>> {
    auth.require_admin()?;
    if user_id == auth.user_id && payload.disabled == Some(true) {
        return Err(AppError::bad_request("cannot disable your own account"));
    }
    if let Some(role) = &payload.role {
        let parsed: Role = role.parse().map_err(AppError::bad_request)?;
        sqlx::query("UPDATE kernel.users SET role=$2 WHERE id=$1")
            .bind(user_id)
            .bind(parsed.to_string())
            .execute(&state.db)
            .await?;
    }
    if let Some(disabled) = payload.disabled {
        sqlx::query("UPDATE kernel.users SET disabled=$2 WHERE id=$1")
            .bind(user_id)
            .bind(disabled)
            .execute(&state.db)
            .await?;
        if disabled {
            sqlx::query("DELETE FROM kernel.sessions WHERE user_id=$1")
                .bind(user_id)
                .execute(&state.db)
                .await?;
        }
    }
    audit::record(
        &state.db,
        "user.updated",
        "USER",
        &auth.user_id.to_string(),
        "user",
        &user_id.to_string(),
        "user.update",
        "CONFIRMED",
        serde_json::json!({"role": payload.role, "disabled": payload.disabled}),
        None,
    )
    .await?;
    let row = fetch_user(&state, user_id).await?;
    Ok(Json(row))
}

async fn fetch_user(state: &AppState, id: Uuid) -> AppResult<UserView> {
    sqlx::query_as::<_, UserView>(
        "SELECT id, email, display_name, role, disabled, created_at FROM kernel.users WHERE id=$1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found("user not found"))
}
