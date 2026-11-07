//! G13-B1.4: the workspace claim queue for automation incidents.
//!
//! An automation incident is created with `owner =` the non-login automation
//! service user (0028). The operator row rule is `OwnedRows` (`owner = caller`,
//! crate::scope), so an operator cannot see, investigate, append evidence to or
//! conclude an automation incident in its own workspace. Widening `OwnedRows`
//! would hand every operator every row of every workspace they belong to, which
//! is the grant the D5 scope model exists to refuse.
//!
//! The queue is therefore a deliberate second READ of the same rows, bounded by
//! membership and by the exact state that means "no human owns this yet":
//!
//!     origin = 'AUTOMATION' AND owner = service-user
//!     AND status IN ('OPEN','INVESTIGATING')
//!
//! It returns a minimal summary (never evidence, verdict or timeline), and the
//! only write it permits is an atomic ownership claim. After a claim the
//! incident is an ordinary operator-owned record and every existing route,
//! predicate and lifecycle rule applies unchanged. A release puts it back.
//!
//! Concurrency: the claim reads the incident row `FOR UPDATE` and then updates
//! it through a compare-and-set on `(owner, status, revision)`. Two operators
//! claiming at the same instant are serialized by the row lock; the second one
//! observes the first owner and is answered `409 INCIDENT_CLAIM_TAKEN`. The
//! database, not a read-then-write in Rust, is the arbiter.
//!
//! A viewer never reaches any of this: `require_operator` refuses at the handler
//! before a row is read. A non-member's read is bounded by `workspace_id =
//! ANY(caller.workspaces)`, so workspace B cannot list or claim workspace A's
//! queue, and a claim answer does not distinguish "another workspace" from
//! "does not exist".

use crate::audit;
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::scope::DataScope;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

/// How many queue rows one read returns. The queue is worked from the top, so a
/// bounded newest-first page is the useful shape; there is deliberately no
/// cursor until a real deployment needs one.
const CLAIMABLE_LIMIT: i64 = 50;

fn service_user_id() -> Uuid {
    Uuid::parse_str(crate::automation::AUTOMATION_USER_ID)
        .expect("service user id is a literal uuid")
}

/// The minimal summary an operator needs to decide whether to claim.
///
/// Deliberately not `IncidentView`: an unclaimed row has no human-readable
/// owner, and its evidence/verdict detail is not part of the queue's question.
/// A field added here is a field every operator in the workspace may read, so
/// the struct stays the smallest thing that answers "what is this, how bad, how
/// old, and which version am I claiming".
#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ClaimableIncidentView {
    pub id: Uuid,
    pub title: String,
    pub severity: String,
    pub status: String,
    pub native_id: Option<String>,
    pub workspace_id: Uuid,
    pub started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub revision: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimableIncidentList {
    pub items: Vec<ClaimableIncidentView>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimIncidentRequest {
    /// The revision the operator saw in the queue. A claim decided against a
    /// revision that has since moved (a release, a second claim, a closure) is
    /// not the claim the operator made.
    pub expected_revision: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimIncidentView {
    /// The incident as the caller may now read it: the existing detail payload,
    /// so the UI can navigate straight into the investigation it just claimed.
    #[serde(flatten)]
    pub incident: crate::incidents::IncidentView,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseIncidentRequest {
    pub expected_revision: i64,
}

/// What a release answers with.
///
/// Deliberately not the incident: after a release the operator is, by design, no
/// longer allowed to read it (the owner column is the operator read scope), so
/// answering with the record would either leak a row the caller just gave up or
/// have to be built as if it still had access.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseIncidentView {
    pub incident_id: Uuid,
    pub revision: i64,
    pub released_at: DateTime<Utc>,
}

/// `GET /api/v1/incidents/claimable`
pub async fn list_claimable(
    State(state): State<AppState>,
    auth: AuthUser,
) -> AppResult<Json<ClaimableIncidentList>> {
    auth.require_operator()?;
    let scope = DataScope::resolve(&state.db, &auth).await?;
    Ok(Json(ClaimableIncidentList {
        items: query_claimable(&state.db, &scope).await?,
    }))
}

/// `POST /api/v1/incidents/{incident_id}/claim`
pub async fn claim_incident(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(incident_id): Path<Uuid>,
    Json(payload): Json<ClaimIncidentRequest>,
) -> AppResult<Json<ClaimIncidentView>> {
    auth.require_operator()?;
    if payload.expected_revision < 1 {
        return Err(AppError::bad_request(
            "expectedRevision must be the revision you read, which is 1 or greater",
        ));
    }
    let scope = DataScope::resolve(&state.db, &auth).await?;
    let incident = claim(
        &state,
        scope.clone(),
        incident_id,
        payload.expected_revision,
    )
    .await?;
    Ok(Json(ClaimIncidentView { incident }))
}

/// `POST /api/v1/incidents/{incident_id}/release`
pub async fn release_incident(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(incident_id): Path<Uuid>,
    Json(payload): Json<ReleaseIncidentRequest>,
) -> AppResult<Json<ReleaseIncidentView>> {
    auth.require_operator()?;
    if payload.expected_revision < 1 {
        return Err(AppError::bad_request(
            "expectedRevision must be the revision you read, which is 1 or greater",
        ));
    }
    let scope = DataScope::resolve(&state.db, &auth).await?;
    Ok(Json(
        release(&state, scope, incident_id, payload.expected_revision).await?,
    ))
}

/// The queue read. Membership bounds the rows; the partial index in 0031 bounds
/// the work. No `RowRule` applies here because the row is precisely the one the
/// rule hides; the WHERE clause below is the whole authorization, and it is
/// never offered as a general incident read.
pub(crate) async fn query_claimable(
    db: &PgPool,
    scope: &DataScope,
) -> AppResult<Vec<ClaimableIncidentView>> {
    Ok(sqlx::query_as::<_, ClaimableIncidentView>(
        "SELECT incident_id AS id, title, severity, status, native_id, workspace_id,
                started_at, updated_at, revision
           FROM kernel.incidents
          WHERE workspace_id = ANY($1::uuid[])
            AND origin = 'AUTOMATION'
            AND owner = $2
            AND status IN ('OPEN','INVESTIGATING')
          ORDER BY started_at DESC, incident_id DESC
          LIMIT $3",
    )
    .bind(&scope.workspaces)
    .bind(service_user_id())
    .bind(CLAIMABLE_LIMIT)
    .fetch_all(db)
    .await?)
}

/// The atomic claim.
///
/// The read is `FOR UPDATE` and bounded by membership; the write is a
/// compare-and-set on `(owner, status, revision)`. The row lock serializes two
/// claimers, so exactly one commits and the other observes the new owner.
pub(crate) async fn claim(
    state: &AppState,
    scope: DataScope,
    incident_id: Uuid,
    expected_revision: i64,
) -> AppResult<crate::incidents::IncidentView> {
    let db = &state.db;
    let service = service_user_id();
    let mut tx = db.begin().await?;
    let current: Option<(String, i64, Uuid, Uuid, Option<String>)> = sqlx::query_as(
        "SELECT status, revision, owner, workspace_id, origin
           FROM kernel.incidents
          WHERE incident_id=$1 AND workspace_id = ANY($2::uuid[])
          FOR UPDATE",
    )
    .bind(incident_id)
    .bind(&scope.workspaces)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((status, revision, owner, _workspace_id, origin)) = current else {
        tx.rollback().await?;
        return Err(incident_not_found());
    };

    // Anything that was never an automation incident answers 404, exactly like a
    // row in another workspace: the claim route must not become a second way to
    // discover incidents the caller's normal read hides. This holds even when the
    // caller happens to own the manual row.
    if origin.as_deref() != Some("AUTOMATION") {
        tx.rollback().await?;
        return Err(incident_not_found());
    }
    // The lifecycle is decided before ownership and revision. A concluded or
    // closed record is history: whether the caller owns it, another operator owns
    // it or it is still unclaimed, a claim is not the operation that applies.
    if !matches!(status.as_str(), "OPEN" | "INVESTIGATING") {
        tx.rollback().await?;
        audit_claim_refusal(
            state,
            &scope,
            incident_id,
            "INCIDENT_CLAIM_NOT_AVAILABLE",
            json!({"status": status, "revision": revision}),
        )
        .await?;
        return Err(AppError::conflict(
            "INCIDENT_CLAIM_NOT_AVAILABLE",
            "this incident is no longer claimable: a human has concluded or closed it",
        ));
    }
    // A replay of this same claim is answered with the record the caller now
    // owns. This is what makes a double-click, or a retry after a timed-out
    // response, idempotent instead of a conflict.
    if owner == scope.user_id {
        tx.rollback().await?;
        return crate::incidents::query_incident(db, scope, incident_id).await;
    }
    // A queue row that another operator has already claimed is a conflict, not a
    // 404: the caller saw it in the queue, so telling it the row moved leaks
    // nothing it did not already have, and the UI has a conflict to explain.
    if owner != service {
        tx.rollback().await?;
        audit_claim_refusal(
            state,
            &scope,
            incident_id,
            "INCIDENT_CLAIM_TAKEN",
            json!({"status": status, "revision": revision}),
        )
        .await?;
        return Err(AppError::conflict(
            "INCIDENT_CLAIM_TAKEN",
            "another operator claimed this incident; refresh the queue",
        ));
    }
    if revision != expected_revision {
        tx.rollback().await?;
        audit_claim_refusal(
            state,
            &scope,
            incident_id,
            "INCIDENT_CLAIM_CONFLICT",
            json!({"currentRevision": revision, "expectedRevision": expected_revision}),
        )
        .await?;
        return Err(AppError::conflict(
            "INCIDENT_CLAIM_CONFLICT",
            format!(
                "this incident is at revision {revision} and the claim was decided against revision {expected_revision}; re-read the queue and repeat the claim"
            ),
        ));
    }

    let updated: Option<i64> = sqlx::query_scalar(
        "UPDATE kernel.incidents
            SET owner=$2, owner_assigned_at=now(), revision=revision+1, updated_at=now()
          WHERE incident_id=$1 AND owner=$3 AND status IN ('OPEN','INVESTIGATING')
            AND revision=$4
          RETURNING revision",
    )
    .bind(incident_id)
    .bind(scope.user_id)
    .bind(service)
    .bind(expected_revision)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(revision_to) = updated else {
        // The lock above makes this unreachable through this function; keeping it
        // means the compare-and-set, not the lock, is the authority.
        tx.rollback().await?;
        return Err(AppError::conflict(
            "INCIDENT_CLAIM_TAKEN",
            "another operator claimed this incident; refresh the queue",
        ));
    };
    audit::record_in_tx(
        &mut tx,
        "INCIDENT_CLAIMED",
        "USER",
        &scope.user_id.to_string(),
        "INCIDENT",
        &incident_id.to_string(),
        "CLAIM",
        "ACCEPTED",
        json!({
            "fromOwner": service,
            "toOwner": scope.user_id,
            "revisionFrom": expected_revision,
            "revisionTo": revision_to,
        }),
        None,
    )
    .await?;
    tx.commit().await?;

    crate::incidents::query_incident(db, scope, incident_id).await
}

/// Return an automation incident to the workspace queue.
///
/// Only the current owner may release. Anything else is 404: the row is not
/// readable under the operator predicate any more, and a release route must not
/// say "that exists but is not yours".
pub(crate) async fn release(
    state: &AppState,
    scope: DataScope,
    incident_id: Uuid,
    expected_revision: i64,
) -> AppResult<ReleaseIncidentView> {
    let db = &state.db;
    let service = service_user_id();
    let mut tx = db.begin().await?;
    let current: Option<(String, i64, Uuid, Option<String>)> = sqlx::query_as(
        "SELECT status, revision, owner, origin
           FROM kernel.incidents
          WHERE incident_id=$1 AND workspace_id = ANY($2::uuid[])
          FOR UPDATE",
    )
    .bind(incident_id)
    .bind(&scope.workspaces)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((status, revision, owner, origin)) = current else {
        tx.rollback().await?;
        return Err(incident_not_found());
    };
    if owner != scope.user_id {
        tx.rollback().await?;
        return Err(incident_not_found());
    }
    if origin.as_deref() != Some("AUTOMATION") {
        tx.rollback().await?;
        return Err(AppError::conflict(
            "INCIDENT_RELEASE_NOT_AUTOMATION",
            "this incident was filed by a person: hand it over with the owner transfer instead of releasing it to the automation queue",
        ));
    }
    if !matches!(status.as_str(), "OPEN" | "INVESTIGATING") {
        tx.rollback().await?;
        return Err(AppError::conflict(
            "INCIDENT_RELEASE_NOT_AVAILABLE",
            "an incident with a signed verdict or a closure is history and cannot go back to the queue",
        ));
    }
    if revision != expected_revision {
        tx.rollback().await?;
        return Err(AppError::conflict(
            "INCIDENT_RELEASE_CONFLICT",
            format!(
                "this incident is at revision {revision} and the release was decided against revision {expected_revision}; re-read it and repeat the release"
            ),
        ));
    }
    let released_at: Option<DateTime<Utc>> = sqlx::query_scalar(
        "UPDATE kernel.incidents
            SET owner=$2, owner_assigned_at=now(), revision=revision+1, updated_at=now()
          WHERE incident_id=$1 AND owner=$3 AND revision=$4
            AND status IN ('OPEN','INVESTIGATING')
          RETURNING updated_at",
    )
    .bind(incident_id)
    .bind(service)
    .bind(scope.user_id)
    .bind(expected_revision)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(released_at) = released_at else {
        tx.rollback().await?;
        return Err(AppError::conflict(
            "INCIDENT_STATE_CONFLICT",
            "the incident changed while the release was being recorded; reload before retrying",
        ));
    };
    audit::record_in_tx(
        &mut tx,
        "INCIDENT_RELEASED",
        "USER",
        &scope.user_id.to_string(),
        "INCIDENT",
        &incident_id.to_string(),
        "RELEASE",
        "ACCEPTED",
        json!({
            "fromOwner": scope.user_id,
            "toOwner": service,
            "revisionFrom": expected_revision,
            "revisionTo": expected_revision + 1,
        }),
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(ReleaseIncidentView {
        incident_id,
        revision: expected_revision + 1,
        released_at,
    })
}

/// A refused claim is an operation on a queue row the caller legitimately saw,
/// so it is recorded. It deliberately names no other owner: the trail says that
/// the row moved, not who holds it now.
async fn audit_claim_refusal(
    state: &AppState,
    scope: &DataScope,
    incident_id: Uuid,
    code: &str,
    details: serde_json::Value,
) -> AppResult<()> {
    let mut details = details;
    if let Some(object) = details.as_object_mut() {
        object.insert("code".into(), json!(code));
    }
    audit::record(
        &state.db,
        "INCIDENT_CLAIM_REFUSED",
        "USER",
        &scope.user_id.to_string(),
        "INCIDENT",
        &incident_id.to_string(),
        "CLAIM",
        "REJECTED",
        details,
        None,
    )
    .await?;
    Ok(())
}

fn incident_not_found() -> AppError {
    AppError::new(
        StatusCode::NOT_FOUND,
        "INCIDENT_NOT_FOUND",
        "no incident with this id is visible to you",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scope::{DataScope, RowRule};
    use opsweave_contracts::Role;
    use sqlx::postgres::PgConnectOptions;
    use sqlx::PgPool;

    const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";

    async fn test_pool() -> Option<PgPool> {
        let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(std::env::VarError::NotPresent) => {
                if std::env::var(REQUIRE_DATABASE_ENV).ok().as_deref() == Some("1") {
                    panic!("{REQUIRE_DATABASE_ENV} is set but OPSWEAVE_TEST_DATABASE_URL is unset");
                }
                eprintln!("skip: OPSWEAVE_TEST_DATABASE_URL is unset");
                return None;
            }
            Err(std::env::VarError::NotUnicode(_)) => {
                panic!("OPSWEAVE_TEST_DATABASE_URL is not valid UTF-8")
            }
        };
        let options: PgConnectOptions = url.parse().unwrap();
        let pool = PgPool::connect_with(options).await.unwrap();
        crate::db::migrate(&pool).await.unwrap();
        Some(pool)
    }

    fn state(pool: PgPool) -> AppState {
        AppState::new(
            crate::config::Config::from_env(),
            pool,
            b"incident-claims-test".to_vec(),
        )
        .unwrap()
    }

    fn operator_scope(user: Uuid, workspaces: Vec<Uuid>) -> DataScope {
        DataScope::for_test(user, workspaces, RowRule::for_role(Role::Operator))
    }

    async fn seed_workspace(pool: &PgPool, key: &str) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.business_workspaces (workspace_id,key,name)
             VALUES ($1,$2,$3)",
        )
        .bind(id)
        .bind(format!("{key}-{id}"))
        .bind(format!("claim test {key}"))
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn seed_user(pool: &PgPool, role: &str) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.users (id,email,display_name,password_hash,role)
             VALUES ($1,$2,$3,'not-a-real-hash',$4)",
        )
        .bind(id)
        .bind(format!("claim-{id}@example.invalid"))
        .bind(format!("claim {role}"))
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn join(pool: &PgPool, workspace: Uuid, user: Uuid) {
        sqlx::query(
            "INSERT INTO kernel.business_workspace_members (workspace_id,user_id)
             VALUES ($1,$2) ON CONFLICT DO NOTHING",
        )
        .bind(workspace)
        .bind(user)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn seed_automation_incident(pool: &PgPool, workspace: Uuid, status: &str) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.incidents
               (incident_id,title,severity,status,source,native_id,started_at,owner,workspace_id,origin)
             VALUES ($1,$2,'MAJOR',$3,'ZABBIX',$4,now(),$5,$6,'AUTOMATION')",
        )
        .bind(id)
        .bind(format!("automation failure {id}"))
        .bind(status)
        .bind(format!("native-{id}"))
        .bind(service_user_id())
        .bind(workspace)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn owner_of(pool: &PgPool, incident: Uuid) -> Uuid {
        sqlx::query_scalar("SELECT owner FROM kernel.incidents WHERE incident_id=$1")
            .bind(incident)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    async fn audit_count(pool: &PgPool, incident: Uuid, event_type: &str) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM kernel.audit_events
              WHERE subject_type='INCIDENT' AND subject_id=$1 AND event_type=$2",
        )
        .bind(incident.to_string())
        .bind(event_type)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    async fn cleanup(pool: &PgPool, workspaces: &[Uuid], users: &[Uuid], incidents: &[Uuid]) {
        let _ = sqlx::query("DELETE FROM kernel.audit_events WHERE subject_type='INCIDENT' AND subject_id = ANY($1)")
            .bind(incidents.iter().map(|id| id.to_string()).collect::<Vec<_>>())
            .execute(pool)
            .await;
        for incident in incidents {
            let _ = sqlx::query("DELETE FROM kernel.incidents WHERE incident_id=$1")
                .bind(incident)
                .execute(pool)
                .await;
        }
        for workspace in workspaces {
            let _ = sqlx::query("DELETE FROM kernel.business_workspaces WHERE workspace_id=$1")
                .bind(workspace)
                .execute(pool)
                .await;
        }
        for user in users {
            let _ = sqlx::query("DELETE FROM kernel.users WHERE id=$1")
                .bind(user)
                .execute(pool)
                .await;
        }
    }

    #[tokio::test]
    async fn operator_claims_and_completes_the_whole_lifecycle() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let workspace = seed_workspace(&pool, "lifecycle").await;
        let operator = seed_user(&pool, "operator").await;
        let viewer = seed_user(&pool, "viewer").await;
        join(&pool, workspace, operator).await;
        join(&pool, workspace, viewer).await;
        let incident = seed_automation_incident(&pool, workspace, "OPEN").await;
        let state = state(pool.clone());

        let scope = operator_scope(operator, vec![workspace]);
        let queue = query_claimable(&pool, &scope).await.unwrap();
        assert_eq!(queue.len(), 1, "the operator sees the unclaimed row");
        assert_eq!(queue[0].id, incident);
        assert_eq!(queue[0].status, "OPEN");
        assert_eq!(queue[0].workspace_id, workspace);

        // A viewer is refused at the handler before any row is read.
        let (status, body) = send_as(
            state.clone(),
            viewer,
            Role::Viewer,
            "GET",
            "/api/v1/incidents/claimable",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        let (status, body) = send_as(
            state.clone(),
            viewer,
            Role::Viewer,
            "POST",
            &format!("/api/v1/incidents/{incident}/claim"),
            Some(json!({"expectedRevision": 1})),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(
            owner_of(&pool, incident).await,
            service_user_id(),
            "a refused claim changes nothing"
        );

        let claimed = claim(&state, scope.clone(), incident, 1).await.unwrap();
        assert_eq!(claimed.owner, operator);
        assert_eq!(claimed.revision, 2);
        assert_eq!(audit_count(&pool, incident, "INCIDENT_CLAIMED").await, 1);

        // The claimed incident is now an ordinary operator-owned record: the
        // existing evidence, verdict and close handlers accept it unchanged.
        let (status, body) = send_as(
            state.clone(),
            operator,
            Role::Operator,
            "POST",
            &format!("/api/v1/incidents/{incident}/evidence"),
            Some(json!({
                "kind": "OPERATOR_NOTE",
                "source": "operator:claim-follow-up",
                "collectedAt": Utc::now().to_rfc3339(),
                "contentRef": "note:claim-follow-up"
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        let (status, body) = send_as(
            state.clone(),
            operator,
            Role::Operator,
            "POST",
            &format!("/api/v1/incidents/{incident}/verdict"),
            Some(json!({
                "verdict": "CONFIRMED",
                "rationale": "the automation snapshot matches the reported window"
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        let current = crate::incidents::query_incident(&pool, scope, incident)
            .await
            .unwrap();
        assert_eq!(current.status, "CONCLUDED");
        let (status, body) = send_as(
            state.clone(),
            operator,
            Role::Operator,
            "POST",
            &format!("/api/v1/incidents/{incident}/close"),
            Some(json!({
                "expectedRevision": current.revision,
                "note": "the operator closed the automation incident after review"
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.contains("\"status\":\"CLOSED\""), "{body}");
        assert_eq!(
            audit_count(&pool, incident, "INCIDENT_EVIDENCE_ADDED").await,
            1
        );
        assert_eq!(audit_count(&pool, incident, "INCIDENT_CLOSED").await, 1);

        cleanup(&pool, &[workspace], &[operator, viewer], &[incident]).await;
    }

    #[tokio::test]
    async fn two_operators_claiming_at_once_have_exactly_one_winner() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let workspace = seed_workspace(&pool, "race").await;
        let first = seed_user(&pool, "operator").await;
        let second = seed_user(&pool, "operator").await;
        join(&pool, workspace, first).await;
        join(&pool, workspace, second).await;
        let incident = seed_automation_incident(&pool, workspace, "OPEN").await;
        let state = state(pool.clone());

        let left = claim(&state, operator_scope(first, vec![workspace]), incident, 1);
        let right = claim(&state, operator_scope(second, vec![workspace]), incident, 1);
        let (left, right) = tokio::join!(left, right);
        let winners = [&left, &right]
            .iter()
            .filter(|result| result.is_ok())
            .count();
        assert_eq!(
            winners, 1,
            "exactly one claim commits: {left:?} / {right:?}"
        );
        let loser = [&left, &right]
            .into_iter()
            .find_map(|result| result.as_ref().err())
            .expect("one loser");
        assert_eq!(loser.code, "INCIDENT_CLAIM_TAKEN", "{loser:?}");
        assert_eq!(audit_count(&pool, incident, "INCIDENT_CLAIMED").await, 1);
        assert_eq!(
            audit_count(&pool, incident, "INCIDENT_CLAIM_REFUSED").await,
            1
        );
        assert!(
            [first, second].contains(&owner_of(&pool, incident).await),
            "the owner is the winner, never the service user"
        );

        cleanup(&pool, &[workspace], &[first, second], &[incident]).await;
    }

    #[tokio::test]
    async fn another_workspace_cannot_list_or_claim_and_dual_membership_can() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let workspace_a = seed_workspace(&pool, "a").await;
        let workspace_b = seed_workspace(&pool, "b").await;
        let outsider = seed_user(&pool, "operator").await;
        let dual = seed_user(&pool, "operator").await;
        join(&pool, workspace_b, outsider).await;
        join(&pool, workspace_a, dual).await;
        join(&pool, workspace_b, dual).await;
        let incident = seed_automation_incident(&pool, workspace_a, "OPEN").await;
        let state = state(pool.clone());

        let outsider_scope = operator_scope(outsider, vec![workspace_b]);
        assert!(
            query_claimable(&pool, &outsider_scope)
                .await
                .unwrap()
                .is_empty(),
            "workspace B's operator sees nothing of workspace A's queue"
        );
        let denied = claim(&state, outsider_scope, incident, 1)
            .await
            .unwrap_err();
        assert_eq!(denied.status, StatusCode::NOT_FOUND, "{denied:?}");
        assert_eq!(owner_of(&pool, incident).await, service_user_id());

        let dual_scope = operator_scope(dual, vec![workspace_a, workspace_b]);
        assert_eq!(query_claimable(&pool, &dual_scope).await.unwrap().len(), 1);
        let claimed = claim(&state, dual_scope, incident, 1).await.unwrap();
        assert_eq!(claimed.owner, dual);

        cleanup(
            &pool,
            &[workspace_a, workspace_b],
            &[outsider, dual],
            &[incident],
        )
        .await;
    }

    #[tokio::test]
    async fn release_returns_the_row_to_the_queue_and_removes_read_access() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let workspace = seed_workspace(&pool, "release").await;
        let operator = seed_user(&pool, "operator").await;
        join(&pool, workspace, operator).await;
        let incident = seed_automation_incident(&pool, workspace, "OPEN").await;
        let state = state(pool.clone());
        let scope = operator_scope(operator, vec![workspace]);

        let claimed = claim(&state, scope.clone(), incident, 1).await.unwrap();
        let released = release(&state, scope.clone(), incident, claimed.revision)
            .await
            .unwrap();
        assert_eq!(released.revision, 3);
        assert_eq!(owner_of(&pool, incident).await, service_user_id());
        assert_eq!(audit_count(&pool, incident, "INCIDENT_RELEASED").await, 1);
        assert_eq!(query_claimable(&pool, &scope).await.unwrap().len(), 1);
        let read = crate::incidents::query_incident(&pool, scope, incident)
            .await
            .unwrap_err();
        assert_eq!(
            read.status,
            StatusCode::NOT_FOUND,
            "after release the operator no longer reads the row"
        );

        cleanup(&pool, &[workspace], &[operator], &[incident]).await;
    }

    #[tokio::test]
    async fn stale_revision_concluded_rows_and_manual_rows_are_refused_with_stable_codes() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let workspace = seed_workspace(&pool, "refusals").await;
        let operator = seed_user(&pool, "operator").await;
        join(&pool, workspace, operator).await;
        let open = seed_automation_incident(&pool, workspace, "OPEN").await;
        let concluded = seed_automation_incident(&pool, workspace, "CONCLUDED").await;
        let manual = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.incidents
               (incident_id,title,severity,status,source,native_id,started_at,owner,workspace_id,origin)
             VALUES ($1,'a person filed this','MAJOR','OPEN','MANUAL',$2,now(),$3,$4,'USER')",
        )
        .bind(manual)
        .bind(format!("manual-{manual}"))
        .bind(operator)
        .bind(workspace)
        .execute(&pool)
        .await
        .unwrap();
        let state = state(pool.clone());
        let scope = operator_scope(operator, vec![workspace]);

        let stale = claim(&state, scope.clone(), open, 9).await.unwrap_err();
        assert_eq!(stale.code, "INCIDENT_CLAIM_CONFLICT", "{stale:?}");
        assert_eq!(audit_count(&pool, open, "INCIDENT_CLAIM_REFUSED").await, 1);

        let unavailable = claim(&state, scope.clone(), concluded, 1)
            .await
            .unwrap_err();
        assert_eq!(
            unavailable.code, "INCIDENT_CLAIM_NOT_AVAILABLE",
            "{unavailable:?}"
        );

        let unknown = claim(&state, scope.clone(), manual, 1).await.unwrap_err();
        assert_eq!(
            unknown.status,
            StatusCode::NOT_FOUND,
            "a manual incident must not become discoverable through the claim route"
        );
        assert!(
            query_claimable(&pool, &scope)
                .await
                .unwrap()
                .iter()
                .all(|row| row.id != manual),
            "the queue shows automation incidents only"
        );

        cleanup(&pool, &[workspace], &[operator], &[open, concluded, manual]).await;
    }

    #[tokio::test]
    async fn a_replayed_claim_is_idempotent_and_a_different_operator_loses() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let workspace = seed_workspace(&pool, "replay").await;
        let owner = seed_user(&pool, "operator").await;
        let other = seed_user(&pool, "operator").await;
        join(&pool, workspace, owner).await;
        join(&pool, workspace, other).await;
        let incident = seed_automation_incident(&pool, workspace, "OPEN").await;
        let state = state(pool.clone());

        let first = claim(&state, operator_scope(owner, vec![workspace]), incident, 1)
            .await
            .unwrap();
        let replay = claim(&state, operator_scope(owner, vec![workspace]), incident, 1)
            .await
            .unwrap();
        assert_eq!(first.revision, replay.revision);
        assert_eq!(
            audit_count(&pool, incident, "INCIDENT_CLAIMED").await,
            1,
            "a replay writes no second claim"
        );

        let lost = claim(&state, operator_scope(other, vec![workspace]), incident, 1)
            .await
            .unwrap_err();
        assert_eq!(lost.code, "INCIDENT_CLAIM_TAKEN", "{lost:?}");

        cleanup(&pool, &[workspace], &[owner, other], &[incident]).await;
    }

    /// Drives the real axum handlers; the middleware inserts the same `AuthUser`
    /// the session layer would, so the role gate under test is the production one.
    async fn send_as(
        state: AppState,
        user: Uuid,
        role: Role,
        method: &str,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> (StatusCode, String) {
        use axum::body::Body;
        use axum::http::Request;
        use axum::routing::{get, post};
        use tower::ServiceExt;

        let router = axum::Router::new()
            .route("/api/v1/incidents/claimable", get(list_claimable))
            .route("/api/v1/incidents/{incident_id}/claim", post(claim_incident))
            .route(
                "/api/v1/incidents/{incident_id}/release",
                post(release_incident),
            )
            .route(
                "/api/v1/incidents/{incident_id}/evidence",
                post(crate::incidents::append_evidence),
            )
            .route(
                "/api/v1/incidents/{incident_id}/verdict",
                post(crate::incidents::create_verdict),
            )
            .route(
                "/api/v1/incidents/{incident_id}/close",
                post(crate::incidents::close_incident),
            )
            .layer(axum::middleware::from_fn(
                move |mut request: axum::extract::Request, next: axum::middleware::Next| async move {
                    request.extensions_mut().insert(crate::auth::AuthUser {
                        user_id: user,
                        email: format!("{user}@example.invalid"),
                        display_name: "claim test".into(),
                        role,
                        session_id: Uuid::new_v4(),
                        csrf_token: "csrf".into(),
                        via_cookie: true,
                    });
                    next.run(request).await
                },
            ))
            .with_state(state);
        let mut builder = Request::builder().method(method).uri(path);
        let body = match body {
            Some(value) => {
                builder = builder.header("content-type", "application/json");
                Body::from(value.to_string())
            }
            None => Body::empty(),
        };
        let response = router.oneshot(builder.body(body).unwrap()).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&bytes).to_string())
    }
}
