//! Business workspaces: the unit of business data visibility (G12 D5).
//!
//! Authority: docs/design/g12-scope/d5-business-workspace-adr.md. Three rules live here
//! and nowhere else:
//!
//!   1. Membership is how a caller gets to read a business row. It is granted by an
//!      administrator, never requested by the caller, and never implied by a role.
//!   2. Creating a workspace does NOT put its creator inside it. The Admin Console
//!      administers the container; the container's records are business data, and the
//!      ruling for D5 is that platform administration is not a data grant. The second
//!      call - grant membership - is what makes anything readable.
//!   3. Listing workspace METADATA is platform administration and is not the same read
//!      as listing workspace ROWS. An admin sees every workspace's name and key so it
//!      has an id to grant against; the `member` field says which of them it may
//!      actually read.
//!
//! Every route here is either admin-gated (a write) or scoped to the caller's own
//! memberships (a read). No route lets a caller name a scope it does not already hold.

use crate::audit;
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

/// The subject type membership changes are recorded under. Deliberately its own type
/// rather than folded into user or workspace writes: who could read what, and when that
/// changed, is the question this whole phase is about.
pub(crate) const MEMBER_SUBJECT_TYPE: &str = "business_workspace_member";

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BusinessWorkspaceView {
    pub workspace_id: Uuid,
    pub key: String,
    pub name: String,
    pub created_at: DateTime<Utc>,
    /// Whether the CALLER is a member, which is what decides whether the business records
    /// inside this workspace can reach it. False for an admin that has not been granted
    /// - the case this field exists to make visible instead of surprising.
    pub member: bool,
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MembershipView {
    pub workspace_id: Uuid,
    pub user_id: Uuid,
    pub granted_at: DateTime<Utc>,
}

/// GET /api/v1/business-workspaces
///
/// The caller's own memberships, plus - for an admin - every workspace's metadata. The
/// extra rows are names and keys, not records: an admin that has not been granted a
/// workspace reads `member: false` and no incident inside it.
pub async fn list_workspaces(
    State(state): State<AppState>,
    auth: AuthUser,
) -> AppResult<Json<Vec<BusinessWorkspaceView>>> {
    let rows = if auth.role.is_admin() {
        sqlx::query_as::<_, BusinessWorkspaceView>(
            "SELECT w.workspace_id, w.key, w.name, w.created_at,
                    (m.user_id IS NOT NULL) AS member
               FROM kernel.business_workspaces w
               LEFT JOIN kernel.business_workspace_members m
                      ON m.workspace_id = w.workspace_id AND m.user_id = $1
              ORDER BY w.key",
        )
        .bind(auth.user_id)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, BusinessWorkspaceView>(
            "SELECT w.workspace_id, w.key, w.name, w.created_at, true AS member
               FROM kernel.business_workspaces w
               JOIN kernel.business_workspace_members m
                 ON m.workspace_id = w.workspace_id
              WHERE m.user_id = $1
              ORDER BY w.key",
        )
        .bind(auth.user_id)
        .fetch_all(&state.db)
        .await?
    };
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateWorkspaceRequest {
    pub key: String,
    pub name: String,
}

/// POST /api/v1/business-workspaces (admin)
pub async fn create_workspace(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(payload): Json<CreateWorkspaceRequest>,
) -> AppResult<(StatusCode, Json<BusinessWorkspaceView>)> {
    auth.require_admin()?;
    let key = payload.key.trim().to_ascii_lowercase();
    if key.len() < 2
        || key.len() > 63
        || !key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        || !key
            .chars()
            .next()
            .map(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            .unwrap_or(false)
    {
        return Err(AppError::bad_request(
            "key must be 2-63 lowercase letters, digits or hyphens, and start with a letter or digit",
        ));
    }
    let name = payload.name.trim();
    if name.chars().count() < 2 || name.chars().count() > 120 {
        return Err(AppError::bad_request(
            "name must be between 2 and 120 characters",
        ));
    }
    let workspace_id = Uuid::new_v4();
    let created: Option<(Uuid, String, String, DateTime<Utc>)> = sqlx::query_as(
        "INSERT INTO kernel.business_workspaces (workspace_id,key,name,created_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING
         RETURNING workspace_id, key, name, created_at",
    )
    .bind(workspace_id)
    .bind(&key)
    .bind(name)
    .bind(auth.user_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((workspace_id, key, name, created_at)) = created else {
        return Err(AppError::conflict(
            "BUSINESS_WORKSPACE_KEY_TAKEN",
            "another business workspace already uses this key",
        ));
    };
    Ok((
        StatusCode::CREATED,
        Json(BusinessWorkspaceView {
            workspace_id,
            key,
            name,
            created_at,
            // Not a member. Creating the container is not entering it: the grant below is
            // the only thing that makes this workspace's records readable, and it is a
            // separate, audited act.
            member: false,
        }),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantMemberRequest {
    pub user_id: Uuid,
}

/// POST /api/v1/business-workspaces/{workspace_id}/members (admin)
///
/// Idempotent: a replay answers 200 with the membership that already exists, because the
/// caller's intent ("this account must be able to read this workspace") is already
/// satisfied and refusing the replay would turn a retry into an error.
pub async fn add_member(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(workspace_id): Path<Uuid>,
    Json(payload): Json<GrantMemberRequest>,
) -> AppResult<(StatusCode, Json<MembershipView>)> {
    auth.require_admin()?;
    let mut tx = state.db.begin().await?;
    ensure_workspace(&mut tx, workspace_id).await?;
    let known: Option<Uuid> = sqlx::query_scalar("SELECT id FROM kernel.users WHERE id=$1")
        .bind(payload.user_id)
        .fetch_optional(&mut *tx)
        .await?;
    if known.is_none() {
        tx.rollback().await?;
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "BUSINESS_WORKSPACE_MEMBER_UNKNOWN",
            "no such user account",
        ));
    }
    let inserted: Option<DateTime<Utc>> = sqlx::query_scalar(
        "INSERT INTO kernel.business_workspace_members (workspace_id,user_id,granted_by)
         VALUES ($1,$2,$3)
         ON CONFLICT (workspace_id,user_id) DO NOTHING
         RETURNING granted_at",
    )
    .bind(workspace_id)
    .bind(payload.user_id)
    .bind(auth.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let granted_at = match inserted {
        Some(granted_at) => granted_at,
        None => {
            sqlx::query_scalar(
                "SELECT granted_at FROM kernel.business_workspace_members
              WHERE workspace_id=$1 AND user_id=$2",
            )
            .bind(workspace_id)
            .bind(payload.user_id)
            .fetch_one(&mut *tx)
            .await?
        }
    };
    if inserted.is_some() {
        audit::record_in_tx(
            &mut tx,
            "BUSINESS_WORKSPACE_MEMBER_GRANTED",
            "USER",
            &auth.user_id.to_string(),
            MEMBER_SUBJECT_TYPE,
            &format!("{workspace_id}:{}", payload.user_id),
            "GRANT_MEMBER",
            "ACCEPTED",
            serde_json::json!({
                "workspaceId": workspace_id,
                "userId": payload.user_id,
                "grantedBy": auth.user_id,
            }),
            None,
        )
        .await?;
    }
    tx.commit().await?;
    Ok((
        if inserted.is_some() {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(MembershipView {
            workspace_id,
            user_id: payload.user_id,
            granted_at,
        }),
    ))
}

/// DELETE /api/v1/business-workspaces/{workspace_id}/members/{user_id} (admin)
///
/// The revocation. It takes effect on the next request and on the next tool call of an
/// investigation that is already running: the scope is re-read per call and never stored
/// in a session or a run.
pub async fn remove_member(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((workspace_id, user_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    auth.require_admin()?;
    let mut tx = state.db.begin().await?;
    let removed = sqlx::query(
        "DELETE FROM kernel.business_workspace_members
          WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(workspace_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if removed == 0 {
        tx.rollback().await?;
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "BUSINESS_WORKSPACE_MEMBER_NOT_FOUND",
            "that account is not a member of this business workspace",
        ));
    }
    audit::record_in_tx(
        &mut tx,
        "BUSINESS_WORKSPACE_MEMBER_REVOKED",
        "USER",
        &auth.user_id.to_string(),
        MEMBER_SUBJECT_TYPE,
        &format!("{workspace_id}:{user_id}"),
        "REVOKE_MEMBER",
        "ACCEPTED",
        serde_json::json!({
            "workspaceId": workspace_id,
            "userId": user_id,
            "revokedBy": auth.user_id,
        }),
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// 404 for a workspace id that does not exist, in the same shape an out-of-scope incident
/// answers with: a caller that may not act on a workspace and a caller that named a
/// workspace that does not exist get one answer, so neither can probe the other.
pub(crate) async fn ensure_workspace(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
) -> AppResult<()> {
    let exists: Option<Uuid> = sqlx::query_scalar(
        "SELECT workspace_id FROM kernel.business_workspaces WHERE workspace_id=$1",
    )
    .bind(workspace_id)
    .fetch_optional(&mut **tx)
    .await?;
    if exists.is_none() {
        return Err(crate::incidents::workspace_not_found());
    }
    Ok(())
}
