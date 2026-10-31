use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

/// The audit row for a business write that must not survive without it.
///
/// Callers that already hold a transaction use this so the business row and its audit
/// row commit or roll back together; the pool-bound `record` below can only run after
/// the business write has committed, which turns a failed audit into a 5xx over a row
/// that exists.
#[allow(clippy::too_many_arguments)]
pub async fn record_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    event_type: &str,
    actor_type: &str,
    actor_id: &str,
    subject_type: &str,
    subject_id: &str,
    action: &str,
    result: &str,
    details: Value,
    request_id: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO kernel.audit_events
          (id, event_type, actor_type, actor_id, subject_type, subject_id, action, result, details, request_id, occurred_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(event_type)
    .bind(actor_type)
    .bind(actor_id)
    .bind(subject_type)
    .bind(subject_id)
    .bind(action)
    .bind(result)
    .bind(details)
    .bind(request_id)
    .bind(Utc::now())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn record(
    db: &PgPool,
    event_type: &str,
    actor_type: &str,
    actor_id: &str,
    subject_type: &str,
    subject_id: &str,
    action: &str,
    result: &str,
    details: Value,
    request_id: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO kernel.audit_events
          (id, event_type, actor_type, actor_id, subject_type, subject_id, action, result, details, request_id, occurred_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(event_type)
    .bind(actor_type)
    .bind(actor_id)
    .bind(subject_type)
    .bind(subject_id)
    .bind(action)
    .bind(result)
    .bind(details)
    .bind(request_id)
    .bind(Utc::now())
    .execute(db)
    .await?;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AuditEventView {
    pub id: Uuid,
    pub event_type: String,
    pub actor_type: String,
    pub actor_id: String,
    pub subject_type: String,
    pub subject_id: String,
    pub action: String,
    pub result: String,
    pub details: Value,
    pub request_id: Option<String>,
    pub occurred_at: DateTime<Utc>,
}

/// Who is asking the audit ledger, as the two facts the SQL needs.
///
/// The ledger is a cross-subject table: one row per event, whatever the event is about,
/// so there is no single column that decides whether a caller may read a row. The rule
/// this scope implements is: an event is visible to a caller iff the subject it is about
/// is readable by that caller, using the same predicate the subject's own endpoints use.
///
///   INCIDENT    \-\-> kernel.incidents.owner, the predicate incidents::incident_status
///                  applies to GET /api/v1/incidents/{id} and to the incident timeline;
///   job         \-\-> kernel.pipeline_jobs.submitted_by, the predicate jobs::list applies;
///   everything else  \-\-> admin only. The kernel has no per-caller read predicate for
///                  those subjects, and inventing one at the audit layer is how a ledger
///                  becomes a leak. A subject type added later is INVISIBLE until it is
///                  classified here: default deny, never default allow.
///
/// sees_all is Role::is_admin() and deliberately NOT incidents::Caller::sees_all, which
/// also answers "yes" for a viewer. That is sound on a route a viewer is refused at the
/// handler anyway; it is unsound here, where a viewer does reach the query. The property
/// this buys is the one that matters: the audit scope is always a SUBSET of the subject
/// predicate it mirrors, so tightening incidents' sees_all later cannot silently widen
/// this route, and a caller that is refused the incident is refused its events too.
#[derive(Debug, Clone, Copy)]
pub(crate) struct AuditScope {
    pub(crate) user_id: Uuid,
    pub(crate) sees_all: bool,
}

impl AuditScope {
    pub(crate) fn from_auth(auth: &crate::auth::AuthUser) -> Self {
        Self {
            user_id: auth.user_id,
            sees_all: auth.role.is_admin(),
        }
    }

    /// What this scope will show, reported beside the rows instead of inferred from them.
    ///
    /// `requested` is the subject type the query named, if it named one. The answer is
    /// "could a read of this kind ever return a row for this caller", which is exactly the
    /// question an empty list raises and exactly the question a browser cannot answer.
    pub(crate) fn view(&self, requested: Option<&str>) -> AuditScopeView {
        AuditScopeView {
            sees_all: self.sees_all,
            readable_subject_types: if self.sees_all {
                Vec::new()
            } else {
                SUBJECT_TYPES
                    .iter()
                    .filter(|entry| entry.1 != Visibility::AdminOnly)
                    .map(|entry| entry.0)
                    .collect()
            },
            requested: requested.map(|subject_type| RequestedSubject {
                subject_type: subject_type.to_string(),
                may_read: self.sees_all || visibility_of(subject_type) != Visibility::AdminOnly,
            }),
        }
    }
}

/// What a subject type's events are worth to a caller who is not an admin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Visibility {
    /// An event is visible to the caller that owns the subject it is about, and to nobody
    /// else. The ownership clause lives in `VISIBILITY` below, one clause per type.
    Owned,
    /// The kernel has no per-caller read predicate for this subject, so only an admin can
    /// read its events. This is what a type gets by being absent from the table.
    AdminOnly,
}

/// The classification `VISIBILITY` implements, written as data as well as SQL.
///
/// The SQL cannot be generated from this table - each `Owned` type needs an ownership
/// clause against its own table - so the two copies are held together by
/// `the_reported_scope_agrees_with_the_predicate` rather than by construction. A subject
/// type absent from here is `AdminOnly`, which is also what the SQL's `OR` chain does
/// with it: default deny in both places, or the hint becomes a map of what to go around.
pub(crate) const SUBJECT_TYPES: &[(&str, Visibility)] = &[
    ("INCIDENT", Visibility::Owned),
    ("job", Visibility::Owned),
    ("capability", Visibility::AdminOnly),
    ("deployment", Visibility::AdminOnly),
    ("enrollment_token", Visibility::AdminOnly),
    ("node", Visibility::AdminOnly),
    ("pipeline", Visibility::AdminOnly),
    ("plugin", Visibility::AdminOnly),
    ("publisher", Visibility::AdminOnly),
    ("user", Visibility::AdminOnly),
];

/// The classification's lookup. Exact match on purpose: it has to answer for the spelling
/// the SQL compares against, not for one that merely looks like it.
pub(crate) fn visibility_of(subject_type: &str) -> Visibility {
    SUBJECT_TYPES
        .iter()
        .find(|entry| entry.0 == subject_type)
        .map(|entry| entry.1)
        .unwrap_or(Visibility::AdminOnly)
}

/// What the ledger will show this caller, as the route reports it beside the rows.
///
/// An empty list has three causes and the UI has to name the right one: nothing is
/// recorded, nothing of this kind is readable by this caller, or the page's own filters hid
/// what came back. The first two are facts only this side knows. A browser that derived
/// them from the user's role would be restating a rule it cannot see, and the copy that
/// drifts does so in the direction that lies to the reader - which is how the next person
/// decides the predicate is broken and puts the leak back.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditScopeView {
    /// The ledger is not narrowed for this caller at all.
    pub sees_all: bool,
    /// When `sees_all` is false: every subject type some event of which can reach this
    /// caller. A type absent from this list reaches them never, which is a permission and
    /// not a filter. Empty when `sees_all`, where the set is "everything, classified here
    /// or not" and enumerating it would understate it.
    pub readable_subject_types: Vec<&'static str>,
    /// The subject type this request named, when it named one.
    pub requested: Option<RequestedSubject>,
}

/// Whether naming a subject type can return rows at all for the caller that named it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestedSubject {
    pub subject_type: String,
    pub may_read: bool,
}

/// The body of GET /api/v1/audit: the rows and the scope they were read under.
///
/// It was a bare array until the scope had to travel with it. The UI cannot tell "nothing
/// was recorded" from "you may not read this kind" out of `[]`, and the two answers leave
/// the reader with different next steps: nothing, or ask an administrator.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditListResponse {
    pub events: Vec<AuditEventView>,
    pub scope: AuditScopeView,
}

/// The visibility predicate, spelled once so no read path can be written without it.
///
/// The comparison is \`i.incident_id::text = e.subject_id\` rather than the reverse cast:
/// a malformed subject_id in a historical row must make that row invisible, not make the
/// whole request fail with a cast error. The incidents and jobs tables are small and the
/// lookups are primary-key seeks, so the cast costs nothing that matters here.
const VISIBILITY: &str = r#"
        (
          $5::boolean
          OR (e.subject_type = 'INCIDENT' AND EXISTS (
                SELECT 1 FROM kernel.incidents i
                 WHERE i.incident_id::text = e.subject_id AND i.owner = $4))
          OR (e.subject_type = 'job' AND EXISTS (
                SELECT 1 FROM kernel.pipeline_jobs j
                 WHERE j.job_id::text = e.subject_id AND j.submitted_by = $4))
        )"#;

/// The ledger read. There is no unscoped variant on purpose: the route that used to call
/// one carried an empty \`if auth.role == Viewer { }\` that read like a guard and scoped
/// nothing, so the signature now makes the omission a compile error instead.
pub async fn list_scoped(
    db: &PgPool,
    scope: AuditScope,
    limit: i64,
    subject_type: Option<&str>,
    subject_id: Option<&str>,
) -> Result<Vec<AuditEventView>, sqlx::Error> {
    let sql = format!(
        r#"
        SELECT e.id, e.event_type, e.actor_type, e.actor_id, e.subject_type, e.subject_id,
               e.action, e.result, e.details, e.request_id, e.occurred_at
        FROM kernel.audit_events e
        WHERE ($1::text IS NULL OR e.subject_type = $1)
          AND ($2::text IS NULL OR e.subject_id = $2)
          AND {VISIBILITY}
        ORDER BY e.occurred_at DESC
        LIMIT $3
        "#
    );
    sqlx::query_as::<_, AuditEventView>(&sql)
        .bind(subject_type)
        .bind(subject_id)
        .bind(limit.clamp(1, 500))
        .bind(scope.user_id)
        .bind(scope.sees_all)
        .fetch_all(db)
        .await
}

// ---------------------------------------------------------------------------
// G12 F (P0-1) · The ledger read is scoped, and these tests are the scope.
//
// The defect they were written from: GET /api/v1/audit answered a viewer with every
// actor's rows on the platform, closure notes included. Each test below drives one of
// the three identities the route has to tell apart, and the last one pins the property
// that makes the fix survive a later tightening of the incident predicate instead of
// undoing it.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::AuthUser;
    use opsweave_contracts::Role;
    use sqlx::postgres::PgConnectOptions;
    use sqlx::PgPool;

    const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";

    /// The note a closure writes into the event's details. The leak this file fixes was
    /// readable business free text, so the assertions look for these words, not only for
    /// row counts: a count of zero is also what a broken query returns.
    const CLOSURE_NOTE_A: &str = "disk pressure on node-7 confirmed by the operator who owns it";
    const CLOSURE_NOTE_B: &str =
        "unrelated tenant failure, nobody outside that tenant may read this";

    fn database_required() -> bool {
        match std::env::var(REQUIRE_DATABASE_ENV) {
            Err(std::env::VarError::NotPresent) => false,
            Err(std::env::VarError::NotUnicode(_)) => {
                panic!("{REQUIRE_DATABASE_ENV} is set but is not valid UTF-8")
            }
            Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
                "" | "0" | "false" | "no" => false,
                "1" | "true" | "yes" => true,
                other => panic!("{REQUIRE_DATABASE_ENV} is set to {other:?}: use 1 to require the DB-backed tests"),
            },
        }
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
        .bind(format!("audit-scope-{id}@example.invalid"))
        .bind(format!("audit scope {role}"))
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn seed_incident(pool: &PgPool, owner: Uuid, title: &str) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.incidents
               (incident_id,title,severity,status,source,started_at,owner)
             VALUES ($1,$2,'MAJOR','OPEN','MANUAL',now(),$3)",
        )
        .bind(id)
        .bind(title)
        .bind(owner)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    /// A job needs a pipeline revision behind it (FK), and the pipeline id is derived
    /// from the submitter so cleanup can find it without a second lookup.
    async fn seed_job(pool: &PgPool, submitted_by: Uuid, key: &str) -> Uuid {
        let id = Uuid::new_v4();
        let pipeline = format!("audit.scope.{submitted_by}");
        sqlx::query(
            "INSERT INTO kernel.pipeline_definitions (pipeline_id,latest_revision) VALUES ($1,1)
             ON CONFLICT (pipeline_id) DO NOTHING",
        )
        .bind(&pipeline)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO kernel.pipeline_revisions
               (pipeline_id,revision,digest,definition,plan,status)
             VALUES ($1,1,$2,'{}'::jsonb,'{}'::jsonb,'PUBLISHED')
             ON CONFLICT DO NOTHING",
        )
        .bind(&pipeline)
        .bind(format!("sha256:{}", "a".repeat(64)))
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO kernel.pipeline_jobs
               (job_id,pipeline_id,pipeline_revision,pipeline_digest,idempotency_key,
                request_digest,status,input,attempts,max_attempts,deadline_at,submitted_by)
             VALUES ($1,$2,1,$3,$4,$5,'QUEUED','{}'::jsonb,0,3,now() + interval '1 hour',$6)",
        )
        .bind(id)
        .bind(&pipeline)
        .bind(format!("sha256:{}", "a".repeat(64)))
        .bind(key)
        .bind(format!("sha256:{}", "b".repeat(64)))
        .bind(submitted_by)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn seed_event(
        pool: &PgPool,
        actor: Uuid,
        event_type: &str,
        subject_type: &str,
        subject_id: &str,
        details: Value,
    ) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.audit_events
               (id,event_type,actor_type,actor_id,subject_type,subject_id,action,result,details)
             VALUES ($1,$2,'USER',$3,$4,$5,'test','CONFIRMED',$6)",
        )
        .bind(id)
        .bind(event_type)
        .bind(actor.to_string())
        .bind(subject_type)
        .bind(subject_id)
        .bind(details)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    fn auth(user_id: Uuid, role: Role) -> AuthUser {
        AuthUser {
            user_id,
            email: format!("audit-scope-{user_id}@example.invalid"),
            display_name: "audit scope caller".to_string(),
            role,
            session_id: Uuid::nil(),
            csrf_token: "csrf-token".to_string(),
            via_cookie: false,
        }
    }

    async fn cleanup(pool: &PgPool, users: &[Uuid]) {
        for user in users {
            sqlx::query("DELETE FROM kernel.audit_events WHERE actor_id=$1")
                .bind(user.to_string())
                .execute(pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM kernel.incidents WHERE owner=$1")
                .bind(user)
                .execute(pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM kernel.pipeline_jobs WHERE submitted_by=$1")
                .bind(user)
                .execute(pool)
                .await
                .unwrap();
            let pipeline = format!("audit.scope.{user}");
            sqlx::query("DELETE FROM kernel.pipeline_revisions WHERE pipeline_id=$1")
                .bind(&pipeline)
                .execute(pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM kernel.pipeline_definitions WHERE pipeline_id=$1")
                .bind(&pipeline)
                .execute(pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM kernel.users WHERE id=$1")
                .bind(user)
                .execute(pool)
                .await
                .unwrap();
        }
    }

    /// The fixture every test below reads: two operators with one incident each, one job
    /// each, and one event of an unclassified subject type, all written by their owners.
    struct Seeded {
        owner_a: Uuid,
        owner_b: Uuid,
        incident_a: Uuid,
        incident_b: Uuid,
        job_a: Uuid,
        future_event: Uuid,
    }

    async fn seeded(pool: &PgPool) -> Seeded {
        let owner_a = seed_user(pool, "operator").await;
        let owner_b = seed_user(pool, "operator").await;
        let incident_a = seed_incident(pool, owner_a, "audit scope incident A").await;
        let incident_b = seed_incident(pool, owner_b, "audit scope incident B").await;
        seed_event(
            pool,
            owner_a,
            "INCIDENT_CLOSED",
            "INCIDENT",
            &incident_a.to_string(),
            serde_json::json!({"closureNote": CLOSURE_NOTE_A}),
        )
        .await;
        seed_event(
            pool,
            owner_b,
            "INCIDENT_CLOSED",
            "INCIDENT",
            &incident_b.to_string(),
            serde_json::json!({"closureNote": CLOSURE_NOTE_B}),
        )
        .await;
        let job_a = seed_job(pool, owner_a, &format!("audit-scope-job-a-{owner_a}")).await;
        seed_event(
            pool,
            owner_a,
            "job.completed",
            "job",
            &job_a.to_string(),
            serde_json::json!({"status": "SUCCEEDED"}),
        )
        .await;
        let future_event = seed_event(
            pool,
            owner_a,
            "future.event",
            "subject_type_nobody_classified_yet",
            "whatever",
            serde_json::json!({"note": CLOSURE_NOTE_A}),
        )
        .await;
        Seeded {
            owner_a,
            owner_b,
            incident_a,
            incident_b,
            job_a,
            future_event,
        }
    }

    async fn ids_of(pool: &PgPool, scope: AuditScope) -> Vec<Uuid> {
        list_scoped(pool, scope, 500, None, None)
            .await
            .unwrap()
            .into_iter()
            .map(|event| event.id)
            .collect()
    }

    fn incident_event_id(events: &[AuditEventView], incident: Uuid) -> Option<&AuditEventView> {
        let subject = incident.to_string();
        events
            .iter()
            .find(|event| event.subject_type == "INCIDENT" && event.subject_id == subject)
    }

    /// The P0 itself: the lowest-privileged role reads no other actor's incident event, and
    /// in particular not the closure note it carries.
    #[tokio::test]
    async fn a_viewer_reads_no_incident_event_of_an_incident_it_cannot_read() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let fixture = seeded(&pool).await;
        let viewer = seed_user(&pool, "viewer").await;
        let scope = AuditScope::from_auth(&auth(viewer, Role::Viewer));

        let events = list_scoped(&pool, scope, 500, None, None).await.unwrap();
        assert!(
            incident_event_id(&events, fixture.incident_a).is_none(),
            "a viewer must not see another operator's incident event"
        );
        assert!(
            incident_event_id(&events, fixture.incident_b).is_none(),
            "a viewer must not see another operator's incident event"
        );
        // Filtering by the subject must not be a way around the scope: the query is the
        // same query whether or not the caller names the incident it wants.
        let filtered = list_scoped(
            &pool,
            scope,
            500,
            Some("INCIDENT"),
            Some(&fixture.incident_b.to_string()),
        )
        .await
        .unwrap();
        assert!(
            filtered.is_empty(),
            "naming the subject is not a way to read outside the scope"
        );
        // The words, not the count: the leak was business free text.
        let serialized = serde_json::to_string(&events).unwrap();
        assert!(!serialized.contains(CLOSURE_NOTE_A));
        assert!(!serialized.contains(CLOSURE_NOTE_B));

        cleanup(&pool, &[fixture.owner_a, fixture.owner_b, viewer]).await;
    }

    /// The middle identity: an operator reads its own incident's events and its own job's
    /// events, and nothing of the other operator's.
    #[tokio::test]
    async fn an_operator_reads_its_own_events_and_the_other_operators_none() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let fixture = seeded(&pool).await;
        let scope = AuditScope::from_auth(&auth(fixture.owner_a, Role::Operator));

        let events = list_scoped(&pool, scope, 500, None, None).await.unwrap();
        let own = incident_event_id(&events, fixture.incident_a)
            .expect("the owner must read its own incident's events");
        assert_eq!(
            own.details["closureNote"],
            serde_json::json!(CLOSURE_NOTE_A)
        );
        assert!(incident_event_id(&events, fixture.incident_b).is_none());
        assert!(
            events.iter().any(|event| event.subject_type == "job"
                && event.subject_id == fixture.job_a.to_string()),
            "the submitter must read its own job's events"
        );
        let serialized = serde_json::to_string(&events).unwrap();
        assert!(!serialized.contains(CLOSURE_NOTE_B));

        cleanup(&pool, &[fixture.owner_a, fixture.owner_b]).await;
    }

    /// The top identity, and the reason the route is still usable: an admin reads
    /// everything, including the events of a subject type nothing has classified yet.
    #[tokio::test]
    async fn an_admin_reads_every_actors_events() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let fixture = seeded(&pool).await;
        let admin = seed_user(&pool, "admin").await;
        let scope = AuditScope::from_auth(&auth(admin, Role::Admin));

        let events = list_scoped(&pool, scope, 500, None, None).await.unwrap();
        assert!(incident_event_id(&events, fixture.incident_a).is_some());
        assert!(incident_event_id(&events, fixture.incident_b).is_some());
        assert!(events.iter().any(|event| event.id == fixture.future_event));

        cleanup(&pool, &[fixture.owner_a, fixture.owner_b, admin]).await;
    }

    /// Default deny: a subject type this file does not classify is invisible to everyone
    /// but an admin. A new resource added by a later phase is therefore refused by
    /// omission rather than leaked by omission.
    #[tokio::test]
    async fn an_unclassified_subject_type_is_invisible_to_a_non_admin() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let fixture = seeded(&pool).await;
        let scope = AuditScope::from_auth(&auth(fixture.owner_a, Role::Operator));

        let events = list_scoped(&pool, scope, 500, None, None).await.unwrap();
        assert!(
            events.iter().all(|event| event.id != fixture.future_event),
            "an event whose subject type is unclassified must not be visible to an operator"
        );

        cleanup(&pool, &[fixture.owner_a, fixture.owner_b]).await;
    }

    /// The property that makes the fix survive D4/D5: for every role, the set of incident
    /// ids visible through the ledger equals the set the incident read predicate lets
    /// through. If a later phase tightens incidents::Caller::sees_all, this test is what
    /// fails when the ledger stops agreeing with it - instead of the ledger quietly
    /// cancelling the tightening.
    #[tokio::test]
    async fn the_ledger_scope_agrees_with_the_incident_read_predicate() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let fixture = seeded(&pool).await;
        let admin = seed_user(&pool, "admin").await;
        let viewer = seed_user(&pool, "viewer").await;
        let incidents = [fixture.incident_a, fixture.incident_b];

        for role in [Role::Admin, Role::Operator, Role::Viewer] {
            for (user, label) in [
                (admin, "admin"),
                (fixture.owner_a, "operator a"),
                (fixture.owner_b, "operator b"),
                (viewer, "viewer"),
            ] {
                let scope = AuditScope::from_auth(&auth(user, role));
                let events = list_scoped(&pool, scope, 500, Some("INCIDENT"), None)
                    .await
                    .unwrap();
                for incident in incidents {
                    let via_ledger = incident_event_id(&events, incident).is_some();
                    let via_incident_read = crate::incidents::incident_status(
                        &pool,
                        crate::incidents::Caller::from_role(user, role),
                        incident,
                    )
                    .await
                    .is_ok();
                    // One direction is the guarantee: everything the ledger shows about an
                    // incident, the incident read shows too. The other direction is not
                    // required - the ledger is allowed to be narrower, never wider.
                    assert!(
                        !via_ledger || via_incident_read,
                        "{label} as {role:?} read an incident event the incident read refuses"
                    );
                }
            }
        }

        cleanup(&pool, &[fixture.owner_a, fixture.owner_b, admin, viewer]).await;
    }

    /// The three identities, in the order the P0-1 acceptance states them, on one call
    /// shape: viewer gets nothing of the others, the owner gets its own, the admin gets all.
    #[tokio::test]
    async fn the_three_identities_see_three_different_ledgers() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let fixture = seeded(&pool).await;
        let admin = seed_user(&pool, "admin").await;
        let viewer = seed_user(&pool, "viewer").await;

        let viewer_ids = ids_of(&pool, AuditScope::from_auth(&auth(viewer, Role::Viewer))).await;
        let operator_ids = ids_of(
            &pool,
            AuditScope::from_auth(&auth(fixture.owner_a, Role::Operator)),
        )
        .await;
        let admin_ids = ids_of(&pool, AuditScope::from_auth(&auth(admin, Role::Admin))).await;

        let incident_b_events = list_scoped(
            &pool,
            AuditScope::from_auth(&auth(admin, Role::Admin)),
            500,
            Some("INCIDENT"),
            Some(&fixture.incident_b.to_string()),
        )
        .await
        .unwrap();
        let incident_b_event = incident_b_events
            .first()
            .expect("the admin reads B's event")
            .id;
        assert!(
            !viewer_ids.contains(&incident_b_event) && !operator_ids.contains(&incident_b_event),
            "another operator's incident event reached a caller that may not read it"
        );
        assert!(admin_ids.contains(&incident_b_event));

        let incident_a_events = list_scoped(
            &pool,
            AuditScope::from_auth(&auth(admin, Role::Admin)),
            500,
            Some("INCIDENT"),
            Some(&fixture.incident_a.to_string()),
        )
        .await
        .unwrap();
        let incident_a_event = incident_a_events
            .first()
            .expect("the admin reads A's event")
            .id;
        assert!(
            operator_ids.contains(&incident_a_event),
            "the owner reads its own event"
        );
        assert!(
            !viewer_ids.contains(&incident_a_event),
            "a viewer read the owner's event"
        );
        assert!(admin_ids.contains(&incident_a_event));

        cleanup(&pool, &[fixture.owner_a, fixture.owner_b, admin, viewer]).await;
    }

    /// The hint the UI renders, for the three identities, with no database in the way: this
    /// is the whole of what the frontend is allowed to know about who may read what.
    #[test]
    fn the_reported_scope_names_the_kinds_each_identity_can_read() {
        let id = Uuid::new_v4();
        let viewer = AuditScope::from_auth(&auth(id, Role::Viewer));
        let operator = AuditScope::from_auth(&auth(id, Role::Operator));
        let admin = AuditScope::from_auth(&auth(id, Role::Admin));
        // The kinds the Activity page's own subject filter offers. Every one of them is a
        // subject with no per-caller read predicate, so every one of them is admin-only and
        // the page must say "refused", not "nothing here".
        let offered = [
            "plugin",
            "node",
            "deployment",
            "publisher",
            "enrollment_token",
        ];

        for scope in [viewer, operator] {
            let view = scope.view(None);
            assert!(!view.sees_all, "a non-admin reads a narrowed ledger");
            assert_eq!(view.readable_subject_types, vec!["INCIDENT", "job"]);
            assert!(view.requested.is_none(), "no subject type was named");
            for subject_type in offered {
                let requested = scope
                    .view(Some(subject_type))
                    .requested
                    .expect("the request named a subject type");
                assert_eq!(requested.subject_type, subject_type);
                assert!(
                    !requested.may_read,
                    "{subject_type} events must be reported as unreadable to a non-admin"
                );
            }
            // The kinds the ledger does scope are not refused as a permission: their empty
            // result is about ownership, which is not something this route can explain.
            for subject_type in ["INCIDENT", "job"] {
                assert!(
                    scope.view(Some(subject_type)).requested.unwrap().may_read,
                    "{subject_type} events are readable where the caller owns the subject"
                );
            }
            // Default deny, spelled out rather than implied by an absent entry.
            assert!(
                !scope
                    .view(Some("subject_type_nobody_classified_yet"))
                    .requested
                    .unwrap()
                    .may_read
            );
        }

        let all = admin.view(Some("plugin"));
        assert!(all.sees_all);
        assert!(all.requested.unwrap().may_read);
        assert!(
            all.readable_subject_types.is_empty(),
            "an admin's readable set is everything, classified here or not, so it is not enumerated"
        );
    }

    /// The classification, held against the predicate that actually runs.
    ///
    /// One probe event per classified type, read by a caller who owns none of them: every
    /// type the view reports as unreadable must be missing from the rows, and the admin must
    /// read all of them. Without this, the two copies - the SQL's `OR` chain and
    /// `SUBJECT_TYPES` - could disagree, and the disagreement would be a UI that explains an
    /// empty list with a permission it does not have, or hides one it does.
    #[tokio::test]
    async fn the_reported_scope_agrees_with_the_predicate_it_describes() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let admin = seed_user(&pool, "admin").await;
        let probes = {
            let mut probes = Vec::new();
            for entry in SUBJECT_TYPES {
                let id = seed_event(
                    &pool,
                    owner,
                    "scope.probe",
                    entry.0,
                    "scope-probe-subject-nobody-owns",
                    serde_json::json!({}),
                )
                .await;
                probes.push((entry.0, entry.1, id));
            }
            probes
        };

        let operator_scope = AuditScope::from_auth(&auth(owner, Role::Operator));
        let operator_events = list_scoped(&pool, operator_scope, 500, None, None)
            .await
            .unwrap();
        let admin_events = list_scoped(
            &pool,
            AuditScope::from_auth(&auth(admin, Role::Admin)),
            500,
            None,
            None,
        )
        .await
        .unwrap();

        for (subject_type, visibility, id) in &probes {
            assert!(
                admin_events.iter().any(|event| event.id == *id),
                "the admin must read every recorded event, including {subject_type}"
            );
            let operator_reads = operator_events.iter().any(|event| event.id == *id);
            let hint = operator_scope
                .view(Some(subject_type))
                .requested
                .expect("the request named a subject type");
            if *visibility == Visibility::AdminOnly {
                assert!(
                    !operator_reads,
                    "{subject_type} is reported as administrator-only and the predicate returned it"
                );
                assert!(!hint.may_read);
            }
            // The `Owned` half cannot be proven by a probe nobody owns: it is proven by
            // `an_operator_reads_its_own_events_and_the_other_operators_none` above, which
            // holds a real incident and a real job. What must hold here is that the hint for
            // a row-bearing type does not depend on whether this probe happened to match.
            assert_eq!(
                hint.may_read,
                *visibility == Visibility::Owned,
                "{subject_type} disagrees between the hint and the classification"
            );
        }

        cleanup(&pool, &[owner, admin]).await;
    }
}
