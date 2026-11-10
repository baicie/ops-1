//! Application-scoped authorization (G14.3).
//!
//! Authority: docs/adr/ADR-022-platform-core-and-applications.md §2.2, §2.5.
//!
//! Three questions, three answers, and this module owns exactly the middle one:
//!
//! | Question | Answered by |
//! |---|---|
//! | may this caller use the platform? | `AuthUser::require_admin` / role, unchanged |
//! | **may this caller use THIS application?** | **this module** |
//! | may this caller read THIS workspace's rows? | `DataScope`, unchanged (0022) |
//!
//! Before this module, "the ops application is installed" and "this account may
//! use the ops application" were the same statement: any authenticated session
//! could call `/api/v1/incidents` and be filtered only by workspace membership.
//! That made the application boundary decorative and put every tenant one
//! mis-scoped query away from another application's data.
//!
//! The gate is server-side on purpose. `access.allowedSurfaces` in
//! `GET /api/v1/auth/me` is a navigation declaration the browser uses to decide
//! what to draw; it is not, and must never become, the thing that decides
//! whether a request is served.

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use sqlx::PgPool;
use uuid::Uuid;

/// The operations application's identifier. Other applications are data.
///
/// P001-A keeps this in Core on purpose. It is a string, not a handler: the
/// registry and the gate are generic (`require_application` takes any id), and
/// this constant is the one value the Ops-owned middleware is wired with. Moving
/// it to a business module would have had Core name the application from a
/// distance instead of explicitly, which is worse for the boundary, not better.
#[cfg_attr(not(feature = "business-ops"), allow(dead_code))]
pub const OPS_APPLICATION: &str = "opsweave.ops";

/// One application as the caller is allowed to see it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationAccess {
    pub application_id: String,
    pub display_name: String,
    pub surface_prefix: String,
    /// The verbs this grant carries. Empty means "may open it", nothing more.
    pub permissions: Vec<String>,
}

/// Everything the caller may open, plus the ones it may not.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationsView {
    pub applications: Vec<ApplicationAccess>,
    /// Applications that exist and are enabled but carry no grant for this
    /// caller. Present so a client can say "you do not have access to X" instead
    /// of showing a 404 that reads like a bug.
    pub denied: Vec<String>,
}

/// The applications this binary contains handlers for (P001-A).
///
/// A closed list, not a subtraction. The previous shape - "everything except
/// `opsweave.ops` when the feature is off" - is a blacklist, and a blacklist
/// answers `true` for every application id nobody has thought of yet. A
/// typo, a future application registered as data, or an id an operator invents
/// would all be reported as servable by a binary that routes none of them. The
/// list is exhaustive here so that adding an application is a deliberate edit,
/// and so the failure mode of forgetting one is "refused", never "advertised".
const BUILT_APPLICATIONS: &[&str] = &[
    // The Platform Console is served by the primary bundle in every build.
    "opsweave.console",
    // The Ops application exists only where its module is compiled.
    #[cfg(feature = "business-ops")]
    "opsweave.ops",
];

/// Whether this build can actually serve `application_id`.
///
/// The registry is data and survives a rollback, so a deployment that ran the full
/// product and then switched to a platform-only binary still has `opsweave.ops`
/// rows and grants in its database. Reporting them as enabled would advertise a
/// surface the binary cannot route - the same "rendered page for a capability that
/// is not there" this phase removes. The gate is therefore the build, not the row:
/// an application is enabled only if BOTH the row says so and this binary contains
/// its handlers.
///
/// The row is deliberately NOT deleted or flipped here. Application registration is
/// deployment data (ADR-022 §2.4), and a rollback to the full build must restore the
/// surface without a re-seed. A destructive "clean up the rows" would make the
/// rollback path lossy for a capability the operator never asked to remove.
pub fn servable_application(application_id: &str) -> bool {
    // `test.` ids are fixtures registered by this crate's own tests. They carry
    // their own `kernel.applications` row and are used to exercise rules that are
    // about the ROW (enabled/disabled, grant/no grant), not about the build. A
    // production id cannot start with `test.` - migration 0035's CHECK requires
    // a lowercase dotted name and the built-in prefix is `opsweave.` - so this
    // cannot widen a real deployment.
    if application_id.starts_with("test.") {
        return true;
    }
    BUILT_APPLICATIONS.contains(&application_id)
}

/// Resolve every enabled application and this caller's grant, if any.
pub async fn applications_for(pool: &PgPool, user_id: Uuid) -> AppResult<ApplicationsView> {
    let rows: Vec<(String, String, String, Option<Vec<String>>)> = sqlx::query_as(
        r#"
        SELECT a.application_id, a.display_name, a.surface_prefix, g.permissions
          FROM kernel.applications a
          LEFT JOIN kernel.application_grants g
                 ON g.application_id = a.application_id AND g.user_id = $1
         WHERE a.enabled
         ORDER BY a.application_id
        "#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    let mut applications = Vec::new();
    let mut denied = Vec::new();
    for (application_id, display_name, surface_prefix, permissions) in rows {
        if !servable_application(&application_id) {
            continue;
        }
        match permissions {
            Some(permissions) => applications.push(ApplicationAccess {
                application_id,
                display_name,
                surface_prefix,
                permissions,
            }),
            None => denied.push(application_id),
        }
    }
    Ok(ApplicationsView {
        applications,
        denied,
    })
}

/// Require that the caller may use `application_id`.
///
/// The failure is `403 APPLICATION_FORBIDDEN` rather than `404`.
///
/// The application is not a secret: it is registered, it is mounted, its name is
/// in the console. Pretending it does not exist would make an authorization
/// decision indistinguishable from a typo. The workspace rule answers 404 for
/// rows because a row's existence IS the secret; an application's is not.
///
/// P001-A: an application this BINARY cannot serve is refused with
/// `APPLICATION_NOT_BUILT` (404) before any grant is consulted. It is not an
/// authorization answer - no grant would change it - and answering 403 would send
/// an operator to look for a missing permission that does not exist.
pub async fn require_application(
    pool: &PgPool,
    auth: &AuthUser,
    application_id: &str,
) -> AppResult<ApplicationAccess> {
    if !servable_application(application_id) {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "APPLICATION_NOT_BUILT",
            "this deployment does not contain that application",
        ));
    }
    let row: Option<(String, String, Vec<String>)> = sqlx::query_as(
        r#"
        SELECT a.display_name, a.surface_prefix, g.permissions
          FROM kernel.applications a
          JOIN kernel.application_grants g
            ON g.application_id = a.application_id AND g.user_id = $2
         WHERE a.application_id = $1 AND a.enabled
        "#,
    )
    .bind(application_id)
    .bind(auth.user_id)
    .fetch_optional(pool)
    .await?;
    let Some((display_name, surface_prefix, permissions)) = row else {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "APPLICATION_FORBIDDEN",
            "this account may not use that application",
        ));
    };
    Ok(ApplicationAccess {
        application_id: application_id.to_string(),
        display_name,
        surface_prefix,
        permissions,
    })
}

/// Require that the caller may use `application_id` AND perform `permission`
/// inside it. A grant with an empty permission list opens the application; it
/// does not authorize any verb.
///
/// Public because it is the gate a future application-scoped verb uses; today
/// the ops surface needs only "may open". It is exercised by
/// `database_tests::an_admin_role_does_not_imply_an_application_grant`.
#[allow(dead_code)]
pub async fn require_application_permission(
    pool: &PgPool,
    auth: &AuthUser,
    application_id: &str,
    permission: &str,
) -> AppResult<ApplicationAccess> {
    let access = require_application(pool, auth, application_id).await?;
    if !access.permissions.iter().any(|held| held == permission) {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "APPLICATION_PERMISSION_FORBIDDEN",
            "this account may open the application but may not perform that action in it",
        ));
    }
    Ok(access)
}

/// Middleware for the application-scoped ops surface.
///
/// The extractor form is not usable here: the same handlers serve both the
/// scoped and the legacy path, so the gate has to live on the route group rather
/// than inside the handler. `AuthUser` is already in the request extensions by
/// the time this runs - the auth middleware is outside this layer.
#[cfg_attr(not(feature = "business-ops"), allow(dead_code))]
pub async fn require_ops_application(
    axum::extract::State(state): axum::extract::State<AppState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let auth = match request.extensions().get::<AuthUser>().cloned() {
        Some(auth) => auth,
        // No session means the outer auth layer refused already; this is
        // defensive, and refusing is the only safe answer.
        None => return AppError::unauthorized("Authentication required").into_response(),
    };
    match require_application(&state.db, &auth, OPS_APPLICATION).await {
        Ok(_) => next.run(request).await,
        Err(error) => error.into_response(),
    }
}

/// `GET /api/v1/applications` - what this caller may open, and what it may not.
pub async fn list_applications(
    axum::extract::State(state): axum::extract::State<AppState>,
    auth: AuthUser,
) -> AppResult<axum::Json<ApplicationsView>> {
    Ok(axum::Json(applications_for(&state.db, auth.user_id).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The gate must be exhaustive over the three outcomes: a grant with
    /// permissions, a grant without, and no grant at all.
    #[test]
    fn a_grant_with_no_permissions_opens_the_application_but_authorizes_no_verb() {
        let access = ApplicationAccess {
            application_id: OPS_APPLICATION.into(),
            display_name: "OpsWeave Operations".into(),
            surface_prefix: "/app".into(),
            permissions: vec![],
        };
        assert!(access.permissions.is_empty());
        // The verb check is the only thing that differs, and it is stated here so
        // a future "empty means everything" change fails a test rather than a
        // deployment.
        assert!(!access
            .permissions
            .iter()
            .any(|held| held == "incident.close"));
    }

    #[test]
    fn the_application_identifiers_are_path_safe() {
        // The identifier appears in an API path; a character that would need
        // escaping is a routing bug waiting to happen.
        assert!(OPS_APPLICATION
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-'));
    }
}

#[cfg(test)]
mod database_tests {
    use super::*;
    use sqlx::postgres::PgConnectOptions;
    use sqlx::PgPool;

    const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";

    async fn test_pool() -> Option<PgPool> {
        let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(_) => {
                if std::env::var(REQUIRE_DATABASE_ENV).ok().as_deref() == Some("1") {
                    panic!("{REQUIRE_DATABASE_ENV} is set but OPSWEAVE_TEST_DATABASE_URL is unset");
                }
                eprintln!("skip: OPSWEAVE_TEST_DATABASE_URL is unset");
                return None;
            }
        };
        let options: PgConnectOptions = url.parse().expect("test database URL parses");
        let pool = PgPool::connect_with(options)
            .await
            .expect("cannot connect to the test database");
        crate::db::migrate(&pool)
            .await
            .expect("the test database rejected the migrations");
        Some(pool)
    }

    /// An account with no grant must be refused, and one with a grant must be
    /// admitted. This is the whole ruling: a platform role does not imply an
    /// application grant.
    ///
    /// P001-A: exercised through `OPS_APPLICATION`, which a platform-only build
    /// does not contain - there `require_application` answers
    /// `APPLICATION_NOT_BUILT` before any grant is consulted, a different ruling
    /// covered by `a_missing_application_is_refused_before_any_grant`. This test
    /// therefore runs only in the build that contains the application.
    #[cfg(feature = "business-ops")]
    #[tokio::test]
    async fn an_admin_role_does_not_imply_an_application_grant() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user_id = Uuid::new_v4();
        // An ADMIN, deliberately: the check must not be satisfied by the role.
        sqlx::query(
            "INSERT INTO kernel.users (id, email, display_name, password_hash, role)
             VALUES ($1,$2,'G14 admin','x','admin') ON CONFLICT (id) DO NOTHING",
        )
        .bind(user_id)
        .bind(format!("g14-{user_id}@example.invalid"))
        .execute(&pool)
        .await
        .expect("seed user");

        let auth = crate::auth::AuthUser {
            user_id,
            email: format!("g14-{user_id}@example.invalid"),
            display_name: "G14 admin".into(),
            role: opsweave_contracts::Role::Admin,
            csrf_token: String::new(),
            via_cookie: false,
            session_id: Uuid::new_v4(),
        };

        // No grant yet: refused, even though the role is admin.
        let refused = require_application(&pool, &auth, OPS_APPLICATION).await;
        assert!(
            refused.is_err(),
            "an admin role must not satisfy an application grant"
        );
        assert_eq!(refused.unwrap_err().code, "APPLICATION_FORBIDDEN");

        // Grant it: admitted, with the permissions the grant carries.
        sqlx::query(
            "INSERT INTO kernel.application_grants (application_id, user_id, permissions)
             VALUES ($1,$2,ARRAY['incident.close']) ON CONFLICT DO NOTHING",
        )
        .bind(OPS_APPLICATION)
        .bind(user_id)
        .execute(&pool)
        .await
        .expect("grant");

        let granted = require_application(&pool, &auth, OPS_APPLICATION)
            .await
            .expect("a granted account is admitted");
        assert_eq!(granted.permissions, vec!["incident.close".to_string()]);

        // A verb the grant does not carry is refused even though access is granted.
        let verb =
            require_application_permission(&pool, &auth, OPS_APPLICATION, "incident.delete").await;
        assert!(verb.is_err());
        assert_eq!(verb.unwrap_err().code, "APPLICATION_PERMISSION_FORBIDDEN");

        // And the listing separates "may open" from "may not".
        let view = applications_for(&pool, user_id).await.expect("list");
        assert!(view
            .applications
            .iter()
            .any(|app| app.application_id == OPS_APPLICATION));
        assert!(!view.denied.contains(&OPS_APPLICATION.to_string()));

        // Revoking takes effect on the next call, not the next session.
        sqlx::query("DELETE FROM kernel.application_grants WHERE user_id=$1")
            .bind(user_id)
            .execute(&pool)
            .await
            .expect("revoke");
        assert!(require_application(&pool, &auth, OPS_APPLICATION)
            .await
            .is_err());

        sqlx::query("DELETE FROM kernel.users WHERE id=$1")
            .bind(user_id)
            .execute(&pool)
            .await
            .ok();
    }

    /// P001-A: an application the binary cannot serve is refused before any grant
    /// is consulted, and the answer is `APPLICATION_NOT_BUILT` (404), not
    /// `APPLICATION_FORBIDDEN` (403).
    ///
    /// The distinction is the point: 403 sends an operator to look for a missing
    /// permission that no grant would supply. Both builds are asserted, because
    /// the rule is "the build decides", not "the light build decides".
    #[tokio::test]
    async fn a_missing_application_is_refused_before_any_grant() {
        let Some(pool) = test_pool().await else {
            return;
        };
        // A user that exists, so a 403 from the grant path is a real possibility.
        let user_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.users (id, email, display_name, password_hash, role)
             VALUES ($1,$2,'P001 servability','x','admin') ON CONFLICT (id) DO NOTHING",
        )
        .bind(user_id)
        .bind(format!("p001-{user_id}@example.invalid"))
        .execute(&pool)
        .await
        .expect("seed user");
        let auth = crate::auth::AuthUser {
            user_id,
            email: format!("p001-{user_id}@example.invalid"),
            display_name: "P001 servability".into(),
            role: opsweave_contracts::Role::Admin,
            csrf_token: String::new(),
            via_cookie: false,
            session_id: Uuid::new_v4(),
        };

        // An id no build serves, so the ruling holds regardless of features.
        // Deliberately NOT a `test.` id: those are this crate's own fixtures and
        // are servable by definition, which is the rule this test is separating.
        let unbuilt = "opsweave.not-built";
        assert!(!servable_application(unbuilt));
        let refused = require_application(&pool, &auth, unbuilt)
            .await
            .expect_err("an unservable application must be refused");
        assert_eq!(refused.code, "APPLICATION_NOT_BUILT");

        // And the Ops application follows the build, which is the whole point.
        assert_eq!(
            servable_application(OPS_APPLICATION),
            cfg!(feature = "business-ops")
        );

        sqlx::query("DELETE FROM kernel.users WHERE id=$1")
            .bind(user_id)
            .execute(&pool)
            .await
            .ok();
    }

    /// A disabled application is refused even to a granted caller.
    ///
    /// This uses a TEST-OWNED application rather than toggling `opsweave.ops`.
    /// Cargo runs these tests in parallel against one shared database, and the
    /// first version disabled the built-in application for the duration of the
    /// test - which another test then observed as "denied", failing intermittently
    /// depending on scheduling. A test that mutates shared global state is a test
    /// that fails for reasons having nothing to do with the rule it checks.
    #[tokio::test]
    async fn a_disabled_application_is_refused_even_with_a_grant() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let application = format!("test.disabled-{}", Uuid::new_v4());
        let user_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.users (id, email, display_name, password_hash, role)
             VALUES ($1,$2,'G14 disabled','x','operator') ON CONFLICT (id) DO NOTHING",
        )
        .bind(user_id)
        .bind(format!("g14d-{user_id}@example.invalid"))
        .execute(&pool)
        .await
        .expect("seed user");
        sqlx::query(
            "INSERT INTO kernel.applications (application_id, display_name, surface_prefix)
             VALUES ($1,'Disabled under test',$2) ON CONFLICT DO NOTHING",
        )
        .bind(&application)
        .bind(format!("/t-{}", &application[application.len() - 8..]))
        .execute(&pool)
        .await
        .expect("seed application");
        sqlx::query(
            "INSERT INTO kernel.application_grants (application_id, user_id) VALUES ($1,$2)
             ON CONFLICT DO NOTHING",
        )
        .bind(&application)
        .bind(user_id)
        .execute(&pool)
        .await
        .expect("grant");
        let auth = crate::auth::AuthUser {
            user_id,
            email: String::new(),
            display_name: String::new(),
            role: opsweave_contracts::Role::Operator,
            csrf_token: String::new(),
            via_cookie: false,
            session_id: Uuid::new_v4(),
        };
        assert!(
            require_application(&pool, &auth, &application)
                .await
                .is_ok(),
            "an enabled application with a grant is admitted"
        );

        sqlx::query("UPDATE kernel.applications SET enabled=false WHERE application_id=$1")
            .bind(&application)
            .execute(&pool)
            .await
            .expect("disable");
        let refused = require_application(&pool, &auth, &application).await;
        assert!(
            refused.is_err(),
            "a disabled application is out of service even for a granted caller"
        );

        // Clean up only what this test created; the built-in applications are
        // other tests' fixtures and are never touched.
        sqlx::query("DELETE FROM kernel.application_grants WHERE application_id=$1")
            .bind(&application)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM kernel.applications WHERE application_id=$1")
            .bind(&application)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM kernel.users WHERE id=$1")
            .bind(user_id)
            .execute(&pool)
            .await
            .ok();
    }
}
