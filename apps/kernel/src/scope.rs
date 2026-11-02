//! Data visibility for business records: one definition, in one place.
//!
//! G12 D5 (docs/design/g12-scope/d5-business-workspace-adr.md, ADR-G11-001 section 4.6).
//!
//! Before this module, "may this caller read this row" had three spellings that
//! disagreed: incidents::Caller answered yes for a viewer through its
//! !can_operate() half, audit::AuditScope answered no for the same viewer, and
//! jobs had its own copy of the first. A viewer therefore read every incident on
//! the platform while the ledger told it that INCIDENT events are visible only
//! where it owns the subject - a set that is empty by construction, because a
//! viewer cannot be made an owner. Two faces, two answers, one role.
//!
//! The model here separates the two questions that were being answered by one
//! expression:
//!
//! - WHICH rows live in a place this caller may read? Answer: DataScope::workspaces,
//!   from kernel.business_workspace_members, read at the instant of the call. Membership
//!   is data an administrator grants; it is not an attribute of a role, so a new role, a
//!   new deployment setting or a new workspace cannot silently widen it.
//! - WHICH of those rows does this caller see, inside an authorized workspace? Answer:
//!   RowRule, from the role. An operator sees what it owns; an admin and a viewer see the
//!   workspace's rows. That is a row rule inside an already authorized workspace and
//!   NEVER a grant of one.
//!
//! Both answers are needed, and neither can substitute for the other: a viewer's
//! RowRule::AllRows is exactly what was mistaken for a scope grant, and membership
//! is what now bounds it. A caller with no membership reads nothing, whatever its
//! role.
//!
//! The verb question (may this caller create / append / conclude?) does not live
//! here: that is AuthUser::require_operator / require_admin, unchanged. An
//! operator's ability to write and its ability to see are decided separately,
//! which is the ruling this phase implements.

use crate::auth::AuthUser;
use crate::error::AppResult;
use opsweave_contracts::Role;
use sqlx::PgPool;
use uuid::Uuid;

/// The workspace the migration put every pre-D5 incident in, as SQL text.
///
/// Test-only on purpose: production code never names a workspace by constant, because
/// which workspaces exist is data. A constant the handlers could read would be a second,
/// silent way to reach a workspace the caller was never granted.
#[cfg(test)]
pub(crate) const LEGACY_WORKSPACE: &str = "00000000-0000-4000-8000-000000000001";

/// The same value as a Uuid.
#[cfg(test)]
pub(crate) fn legacy_workspace() -> Uuid {
    Uuid::parse_str(LEGACY_WORKSPACE).expect("LEGACY_WORKSPACE is a literal uuid")
}

/// Which rows inside an authorized workspace this caller sees.
///
/// Written as an exhaustive match on the role rather than as a predicate over
/// can_operate(): adding a fourth role to the contract then fails to compile here
/// instead of silently inheriting whatever the expression happened to answer. That
/// is the difference between the old is_admin() || !can_operate() - which no
/// decision chose and which every reader read as a scope grant - and this.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RowRule {
    /// Every row in the authorized workspaces.
    AllRows,
    /// Only the rows this caller owns, inside the authorized workspaces.
    OwnedRows,
}

impl RowRule {
    pub(crate) fn for_role(role: Role) -> Self {
        match role {
            // Platform administration is not a business data grant: an admin sees
            // the rows of the workspaces it is a MEMBER of, and no others. Its
            // platform abilities (the Admin Console: users, nodes, plugins) are
            // untouched by this file, because none of them is a business row.
            Role::Admin => RowRule::AllRows,
            // An operator acts inside its workspace but answers for its own
            // records, exactly as it did before this phase (no widening).
            Role::Operator => RowRule::OwnedRows,
            // A viewer reads its authorized workspaces and writes nothing; the
            // read-only half is the role gate, not this rule.
            Role::Viewer => RowRule::AllRows,
        }
    }
}

/// Who is asking, reduced to the facts the SQL layer needs.
///
/// Deliberately not Copy: it carries the membership set resolved for THIS call, and
/// a scope that outlives its resolution is the bug that would make a revocation
/// take effect one request late.
#[derive(Debug, Clone)]
pub(crate) struct DataScope {
    pub(crate) user_id: Uuid,
    /// The business workspaces this caller may read, resolved from membership.
    /// Empty is a meaningful answer, not a missing value: it says this caller may
    /// read no business row at all, and every query this scope reaches returns
    /// nothing.
    pub(crate) workspaces: Vec<Uuid>,
    rows: RowRule,
}

impl DataScope {
    /// Resolve the scope of the authenticated caller of an HTTP request.
    pub(crate) async fn resolve(db: &PgPool, auth: &AuthUser) -> AppResult<Self> {
        Self::resolve_for(db, auth.user_id, auth.role).await
    }

    /// The same resolution for a caller that is not the request's actor: the
    /// subject of an investigation run, whose tool calls must be authorized by
    /// what the kernel can establish about that account AT THE INSTANT OF THE CALL.
    ///
    /// Both role and membership are read here, per call, for the same reason: a
    /// revoked membership or a demoted role has to be answered with on the next
    /// tool call, and a value captured when the run started would keep answering
    /// with the old one.
    pub(crate) async fn resolve_for(db: &PgPool, user_id: Uuid, role: Role) -> AppResult<Self> {
        let workspaces: Vec<Uuid> = sqlx::query_scalar(
            "SELECT workspace_id FROM kernel.business_workspace_members
              WHERE user_id = $1 ORDER BY workspace_id",
        )
        .bind(user_id)
        .fetch_all(db)
        .await?;
        Ok(Self {
            user_id,
            workspaces,
            rows: RowRule::for_role(role),
        })
    }

    /// A scope for unit tests, built without a database round trip. It is the
    /// constructor the tests use, so a test that forgets the workspace half cannot
    /// accidentally read what it meant to hide.
    #[cfg(test)]
    pub(crate) fn for_test(user_id: Uuid, workspaces: Vec<Uuid>, rows: RowRule) -> Self {
        Self {
            user_id,
            workspaces,
            rows,
        }
    }

    pub(crate) fn sees_every_row(&self) -> bool {
        self.rows == RowRule::AllRows
    }

    /// How many workspaces bounded this read, as the route reports it beside the
    /// rows. A count and not a boolean: zero is the one value that explains an
    /// otherwise inexplicable empty page ("you are a member of no workspace, so no
    /// read can return a row"), and it changes when membership changes.
    pub(crate) fn workspace_count(&self) -> usize {
        self.workspaces.len()
    }

    /// Whether this caller may read the given row at all. The Rust mirror of
    /// predicate(), used where there is no SQL predicate to apply (the
    /// create-conflict branch, which asks about a row it has already read).
    /// the_rust_mirror_and_the_sql_predicate_agree keeps the two from drifting.
    pub(crate) fn covers(&self, workspace_id: Uuid, owner: Uuid) -> bool {
        self.may_enter(workspace_id) && (self.sees_every_row() || owner == self.user_id)
    }

    /// Whether this caller may put a row INTO this workspace, or read anything in
    /// it regardless of the row rule.
    pub(crate) fn may_enter(&self, workspace_id: Uuid) -> bool {
        self.workspaces.contains(&workspace_id)
    }
}

/// Builds the row predicate. The only place that spells it.
///
/// Parameter positions are the caller's, because each query already numbers its own
/// binds; what is NOT the caller's is the shape of the clause. A read that wants
/// rows must name the alias and the three positions, and the two clauses come back
/// together: there is no way to apply the ownership half without the workspace half
/// (which is what the platform did for a viewer before D5), and there is no
/// unscoped variant to fall back to - the same rule that makes audit::list_scoped
/// the only ledger read.
pub(crate) fn predicate(
    alias: &str,
    workspace_param: usize,
    all_rows_param: usize,
    user_param: usize,
) -> String {
    format!(
        "{alias}.workspace_id = ANY(${workspace_param}::uuid[]) \
         AND (${all_rows_param}::boolean OR {alias}.owner = ${user_param})"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::postgres::PgConnectOptions;

    const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";

    fn database_required() -> bool {
        match std::env::var(REQUIRE_DATABASE_ENV) {
            Err(std::env::VarError::NotPresent) => false,
            Err(std::env::VarError::NotUnicode(_)) => {
                panic!("{REQUIRE_DATABASE_ENV} is set but is not valid UTF-8")
            }
            Ok(value) => matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            ),
        }
    }

    /// The counterfactual's anchor: the predicate this phase replaced must not be
    /// spelled anywhere in the kernel any more. It is a source scan on purpose - a
    /// predicate is text, and a text that came back has come back everywhere.
    #[test]
    fn the_old_predicate_is_gone_from_the_kernel() {
        let incidents = include_str!("incidents.rs");
        assert!(
            !incidents.contains("($1::boolean OR i.owner=$2)"),
            "the pre-D5 predicate is back in incidents.rs: a read without the workspace bound"
        );
        assert!(
            !incidents.contains("role.is_admin() || !role.can_operate()"),
            "the accidental viewer widening is back in incidents.rs"
        );
        let audit = include_str!("audit.rs");
        assert!(
            !audit.contains("AND i.owner = $4))"),
            "the audit ledger's INCIDENT clause lost its workspace bound"
        );
    }

    #[test]
    fn the_row_rule_is_decided_per_role_not_by_can_operate() {
        assert_eq!(RowRule::for_role(Role::Admin), RowRule::AllRows);
        assert_eq!(RowRule::for_role(Role::Operator), RowRule::OwnedRows);
        assert_eq!(RowRule::for_role(Role::Viewer), RowRule::AllRows);
    }

    #[test]
    fn the_predicate_never_offers_the_ownership_half_without_the_workspace_half() {
        let clause = predicate("i", 1, 2, 3);
        assert!(clause.contains("i.workspace_id = ANY($1::uuid[])"));
        assert!(clause.contains("($2::boolean OR i.owner = $3)"));
    }

    /// Rust mirror vs SQL predicate, over the whole matrix of (rule, membership
    /// set, row). Two spellings of one rule is a real risk; this is what keeps it
    /// from becoming two rules. The SQL half runs the very clause the queries run.
    #[tokio::test]
    async fn the_rust_mirror_and_the_sql_predicate_agree() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let caller_id = seed_user(&pool, "operator").await;
        let peer_id = seed_user(&pool, "operator").await;
        let other_workspace = Uuid::new_v4();
        seed_workspace(&pool, other_workspace).await;
        let mine = seed_incident(&pool, legacy_workspace(), caller_id).await;
        let theirs = seed_incident(&pool, other_workspace, peer_id).await;

        let worksets = vec![
            vec![],
            vec![legacy_workspace()],
            vec![legacy_workspace(), other_workspace],
            vec![other_workspace],
        ];
        let mut comparisons = 0;
        for rows in [RowRule::AllRows, RowRule::OwnedRows] {
            for workspaces in worksets.clone() {
                let scope = DataScope::for_test(caller_id, workspaces, rows);
                let sql = format!(
                    "SELECT incident_id FROM kernel.incidents i WHERE {}",
                    predicate("i", 1, 2, 3)
                );
                let visible: Vec<Uuid> = sqlx::query_scalar(&sql)
                    .bind(&scope.workspaces)
                    .bind(scope.sees_every_row())
                    .bind(scope.user_id)
                    .fetch_all(&pool)
                    .await
                    .unwrap();
                for (incident, workspace, owner) in [
                    (mine, legacy_workspace(), caller_id),
                    (theirs, other_workspace, peer_id),
                ] {
                    assert_eq!(
                        visible.contains(&incident),
                        scope.covers(workspace, owner),
                        "mirror and predicate disagree for rows={rows:?} \
                         workspaces={:?} incident={incident}",
                        scope.workspaces
                    );
                    comparisons += 1;
                }
            }
        }
        assert_eq!(
            comparisons, 16,
            "the matrix above is 2 row rules x 4 membership sets x 2 rows"
        );

        cleanup(
            &pool,
            &[caller_id, peer_id],
            &[mine, theirs],
            &[other_workspace],
        )
        .await;
    }

    async fn test_pool() -> Option<PgPool> {
        let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(std::env::VarError::NotPresent) => {
                if database_required() {
                    panic!(
                        "{REQUIRE_DATABASE_ENV} is set but OPSWEAVE_TEST_DATABASE_URL is unset: \
                         skipping these tests would count as a failure"
                    );
                }
                eprintln!(
                    "skip: OPSWEAVE_TEST_DATABASE_URL is unset and {REQUIRE_DATABASE_ENV} is not 1"
                );
                return None;
            }
            Err(std::env::VarError::NotUnicode(_)) => {
                panic!("OPSWEAVE_TEST_DATABASE_URL is set but is not valid UTF-8")
            }
        };
        let options: PgConnectOptions = url.parse().unwrap_or_else(|error| {
            panic!("OPSWEAVE_TEST_DATABASE_URL is not a PostgreSQL URL: {error}")
        });
        let pool = PgPool::connect_with(options)
            .await
            .unwrap_or_else(|error| panic!("cannot connect to the test database: {error}"));
        crate::db::migrate(&pool)
            .await
            .unwrap_or_else(|error| panic!("the test database rejected the migrations: {error:#}"));
        Some(pool)
    }

    async fn seed_user(pool: &PgPool, role: &str) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.users (id,email,display_name,password_hash,role)
             VALUES ($1,$2,$3,'not-a-real-hash',$4)",
        )
        .bind(id)
        .bind(format!("d5-scope-{id}@example.invalid"))
        .bind(format!("d5 scope {role}"))
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn seed_workspace(pool: &PgPool, workspace: Uuid) {
        sqlx::query(
            "INSERT INTO kernel.business_workspaces (workspace_id,key,name)
             VALUES ($1,$2,$3) ON CONFLICT (workspace_id) DO NOTHING",
        )
        .bind(workspace)
        .bind(format!("scope-test-{workspace}"))
        .bind("scope test workspace")
        .execute(pool)
        .await
        .unwrap();
    }

    async fn seed_incident(pool: &PgPool, workspace: Uuid, owner: Uuid) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.incidents
               (incident_id,title,severity,status,source,started_at,owner,workspace_id)
             VALUES ($1,'scope mirror fixture','MAJOR','OPEN','MANUAL',now(),$2,$3)",
        )
        .bind(id)
        .bind(owner)
        .bind(workspace)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn cleanup(pool: &PgPool, users: &[Uuid], incidents: &[Uuid], workspaces: &[Uuid]) {
        for incident in incidents {
            sqlx::query("DELETE FROM kernel.incidents WHERE incident_id=$1")
                .bind(incident)
                .execute(pool)
                .await
                .unwrap();
        }
        for workspace in workspaces {
            sqlx::query("DELETE FROM kernel.business_workspaces WHERE workspace_id=$1")
                .bind(workspace)
                .execute(pool)
                .await
                .unwrap();
        }
        for user in users {
            sqlx::query("DELETE FROM kernel.users WHERE id=$1")
                .bind(user)
                .execute(pool)
                .await
                .unwrap();
        }
    }
}
