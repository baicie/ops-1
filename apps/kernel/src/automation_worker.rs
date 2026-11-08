//! G13-B1.3/B1.5: durable, lease-fenced automation job worker.
//!
//! The Event handler enqueues a job in the same transaction as the Event and
//! answers `PENDING`. This worker claims a job with a database lease, runs the
//! existing collect/attest/evidence path, and records SUCCEEDED or a bounded
//! retry. A crash leaves the lease to expire; another worker (or the restarted
//! Kernel) reclaims it.
//!
//! A lease is a GENERATION, not a timestamp. Every claim advances the job's
//! `fencing_token` and mints a fresh `lease_id`; every terminal write presents
//! both and a `status='RUNNING'` predicate. Once a takeover has happened, the
//! old worker's token and lease id no longer match any row, so its late success
//! or failure cannot overwrite the new result. The database's CHECK constraints
//! keep the shape (a RUNNING row always has a lease id; a terminal row never
//! does), and this module's writes are the only places the state moves.
//!
//! Evidence dedup is still the writer's unique key. B1.6 adds the job-scoped
//! effect receipt that closes the window between "evidence committed" and "job
//! success committed"; this module only guarantees the terminal state itself.

use crate::audit;
use crate::automation;
use crate::automation_flow;
use crate::error::AppError;
use crate::state::AppState;
use serde_json::json;
use sqlx::FromRow;
use std::time::Duration;
use uuid::Uuid;

const LEASE_SECONDS: i64 = 60;
/// The lease must outlive one attempt's worst case: two outbound calls bounded
/// by `OPSWEAVE_REQUEST_TIMEOUT_SECONDS` plus the attestation write. It is
/// clamped so a misconfigured timeout cannot create a lease that outlives a
/// worker restart by hours. There is no in-flight renewal: the attempt is
/// bounded, so the lease is sized once, and a worker that overruns it has lost
/// the generation by definition.
const MAX_LEASE_SECONDS: i64 = 300;
const MAX_ATTEMPTS: i32 = 3;
/// How many exhausted jobs one tick finalizes. Bounded so a worker never holds
/// an unbounded set of row locks.
const REAP_BATCH: i64 = 32;

#[derive(Debug, Clone, FromRow)]
struct Job {
    job_id: Uuid,
    event_id: Uuid,
    incident_id: Uuid,
    principal_id: Uuid,
    source_id: Uuid,
    attempts: i32,
    max_attempts: i32,
    /// The lease this claim was issued. Every terminal write presents it.
    lease_id: Uuid,
    /// The generation this claim advanced the job to.
    fencing_token: i64,
}

fn retryable(code: &str) -> bool {
    matches!(
        code,
        "AUTOMATION_UPSTREAM_UNAVAILABLE"
            | "AUTOMATION_INSTANCE_UNAVAILABLE"
            | "AUTOMATION_INVALID_RESPONSE"
            | "AUTOMATION_UPSTREAM_FAILED"
            | "AUTOMATION_RESPONSE_TOO_LARGE"
    )
}

fn stale_lease() -> AppError {
    AppError::conflict(
        "AUTOMATION_STALE_LEASE",
        "this worker no longer holds the job lease; the result was not written",
    )
}

/// The lease length for one attempt: two bounded outbound calls plus headroom,
/// never below the base and never above the hard ceiling.
fn lease_seconds(state: &AppState) -> i64 {
    lease_seconds_for(state.config.request_timeout_seconds)
}

fn lease_seconds_for(request_timeout_seconds: u64) -> i64 {
    let per_call = i64::try_from(request_timeout_seconds).unwrap_or(LEASE_SECONDS);
    (2 * per_call + 30).clamp(LEASE_SECONDS, MAX_LEASE_SECONDS)
}

fn lease_is_stale(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<AppError>()
        .is_some_and(|error| error.code == "AUTOMATION_STALE_LEASE")
}

/// Claim one runnable job, advancing its generation.
///
/// `attempts < max_attempts` keeps an exhausted row out of the claim; those
/// rows are finalized by `reap_exhausted` instead, so no job can stay RUNNING
/// or PENDING forever. The row lock and SKIP LOCKED stay exactly as B1.3 wrote
/// them - the change is that the claim also mints the lease handle the terminal
/// write must present.
async fn claim(state: &AppState, worker: &str) -> anyhow::Result<Option<Job>> {
    claim_matching(state, worker, None, None).await
}

/// The one claim statement. `only` exists so a test can claim ITS fixture
/// instead of whichever job happens to be oldest in a shared test database; the
/// production path passes `None`. The SQL is otherwise identical, so the tests
/// exercise the statement that ships.
async fn claim_matching(
    state: &AppState,
    worker: &str,
    only: Option<Uuid>,
    only_source: Option<Uuid>,
) -> anyhow::Result<Option<Job>> {
    let job = sqlx::query_as::<_, Job>(
        r#"
        UPDATE kernel.automation_jobs j
           SET status='RUNNING',
               attempts=j.attempts + 1,
               lease_owner=$1,
               lease_until=now() + ($2 || ' seconds')::interval,
               lease_id=gen_random_uuid(),
               fencing_token=j.fencing_token + 1,
               updated_at=now()
         WHERE j.job_id = (
             SELECT job_id FROM kernel.automation_jobs
              WHERE ((status IN ('PENDING','RETRY_WAIT') AND available_at <= now())
                 OR (status='RUNNING' AND lease_until < now()))
                AND attempts < max_attempts
                AND ($3::uuid IS NULL OR job_id = $3)
                AND ($4::uuid IS NULL OR source_id = $4)
              ORDER BY available_at, job_id
              LIMIT 1
              FOR UPDATE SKIP LOCKED
         )
         RETURNING job_id,event_id,incident_id,principal_id,source_id,attempts,max_attempts,
                   lease_id,fencing_token
        "#,
    )
    .bind(worker)
    .bind(lease_seconds(state))
    .bind(only)
    .bind(only_source)
    .fetch_optional(&state.db)
    .await?;
    Ok(job)
}

/// Finalize jobs that have used every attempt and can never run again.
///
/// Without this, a worker that crashes on its last attempt leaves a RUNNING row
/// whose lease expires but which `claim` refuses (attempts == max_attempts):
/// permanently RUNNING, silently. Each row moves to FAILED_FINAL with its audit
/// in the same transaction.
async fn reap_exhausted(state: &AppState) -> anyhow::Result<usize> {
    let mut tx = state.db.begin().await?;
    let rows: Vec<(Uuid, Uuid, i32, i32)> = sqlx::query_as(
        "SELECT job_id, incident_id, attempts, max_attempts
           FROM kernel.automation_jobs
          WHERE attempts >= max_attempts
            AND (status IN ('PENDING','RETRY_WAIT')
                 OR (status='RUNNING' AND lease_until < now()))
          ORDER BY job_id
          LIMIT $1
          FOR UPDATE SKIP LOCKED",
    )
    .bind(REAP_BATCH)
    .fetch_all(&mut *tx)
    .await?;
    for (job_id, incident_id, attempts, max_attempts) in &rows {
        sqlx::query(
            "UPDATE kernel.automation_jobs
                SET status='FAILED_FINAL', last_error_code='AUTOMATION_ATTEMPTS_EXHAUSTED',
                    lease_owner=NULL, lease_until=NULL, lease_id=NULL, updated_at=now()
              WHERE job_id=$1",
        )
        .bind(job_id)
        .execute(&mut *tx)
        .await?;
        audit::record_in_tx(
            &mut tx,
            "telemetry.automation.attempt_failed",
            "AUTOMATION",
            "kernel",
            "INCIDENT",
            &incident_id.to_string(),
            "AUTOMATION_COLLECT",
            "REJECTED",
            json!({
                "jobId": job_id,
                "attempt": attempts,
                "maxAttempts": max_attempts,
                "code": "AUTOMATION_ATTEMPTS_EXHAUSTED",
                "retry": false,
            }),
            None,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(rows.len())
}

/// Write SUCCEEDED under the claimed generation.
///
/// The compare-and-set is `(job_id, lease_id, fencing_token, status='RUNNING')`.
/// A stale worker matches no row and is answered STALE_LEASE without a write.
/// The audit row commits with the state; a failed audit rolls the terminal state
/// back, so a success is never reported without its trail.
async fn finish_success(state: &AppState, job: &Job, evidence_id: Uuid) -> anyhow::Result<()> {
    let mut tx = state.db.begin().await?;
    let updated: Option<Uuid> = sqlx::query_scalar(
        "UPDATE kernel.automation_jobs
            SET status='SUCCEEDED', evidence_id=$4, lease_owner=NULL, lease_until=NULL,
                lease_id=NULL, last_error_code=NULL, updated_at=now()
          WHERE job_id=$1 AND lease_id=$2 AND fencing_token=$3 AND status='RUNNING'
          RETURNING job_id",
    )
    .bind(job.job_id)
    .bind(job.lease_id)
    .bind(job.fencing_token)
    .bind(evidence_id)
    .fetch_optional(&mut *tx)
    .await?;
    if updated.is_none() {
        // A retry of this very success (the commit landed, the response did not)
        // is idempotent. Anything else is a lost generation.
        let current: Option<(String, Option<Uuid>)> = sqlx::query_as(
            "SELECT status, evidence_id FROM kernel.automation_jobs WHERE job_id=$1",
        )
        .bind(job.job_id)
        .fetch_optional(&mut *tx)
        .await?;
        tx.rollback().await?;
        if current
            .as_ref()
            .is_some_and(|(status, stored)| status == "SUCCEEDED" && *stored == Some(evidence_id))
        {
            return Ok(());
        }
        return Err(stale_lease().into());
    }
    audit::record_in_tx(
        &mut tx,
        "telemetry.automation.succeeded",
        "AUTOMATION",
        &job.principal_id.to_string(),
        "INCIDENT",
        &job.incident_id.to_string(),
        "AUTOMATION_COLLECT",
        "ACCEPTED",
        json!({
            "jobId": job.job_id,
            "evidenceId": evidence_id,
            "attempts": job.attempts,
            "fencingToken": job.fencing_token,
        }),
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Write RETRY_WAIT or FAILED_FINAL under the claimed generation.
async fn finish_error(state: &AppState, job: &Job, error: &AppError) -> anyhow::Result<()> {
    let retry = retryable(error.code) && job.attempts < job.max_attempts;
    let mut tx = state.db.begin().await?;
    let updated: Option<Uuid> = if retry {
        let backoff = i64::from(job.attempts.max(1)) * 15;
        sqlx::query_scalar(
            "UPDATE kernel.automation_jobs
                SET status='RETRY_WAIT', available_at=now() + ($5 || ' seconds')::interval,
                    lease_owner=NULL, lease_until=NULL, lease_id=NULL,
                    last_error_code=$4, updated_at=now()
              WHERE job_id=$1 AND lease_id=$2 AND fencing_token=$3 AND status='RUNNING'
              RETURNING job_id",
        )
        .bind(job.job_id)
        .bind(job.lease_id)
        .bind(job.fencing_token)
        .bind(error.code)
        .bind(backoff)
        .fetch_optional(&mut *tx)
        .await?
    } else {
        sqlx::query_scalar(
            "UPDATE kernel.automation_jobs
                SET status='FAILED_FINAL', lease_owner=NULL, lease_until=NULL, lease_id=NULL,
                    last_error_code=$4, updated_at=now()
              WHERE job_id=$1 AND lease_id=$2 AND fencing_token=$3 AND status='RUNNING'
              RETURNING job_id",
        )
        .bind(job.job_id)
        .bind(job.lease_id)
        .bind(job.fencing_token)
        .bind(error.code)
        .fetch_optional(&mut *tx)
        .await?
    };
    if updated.is_none() {
        tx.rollback().await?;
        return Err(stale_lease().into());
    }
    audit::record_in_tx(
        &mut tx,
        "telemetry.automation.attempt_failed",
        "AUTOMATION",
        &job.principal_id.to_string(),
        "INCIDENT",
        &job.incident_id.to_string(),
        "AUTOMATION_COLLECT",
        "REJECTED",
        json!({
            "jobId": job.job_id,
            "attempt": job.attempts,
            "maxAttempts": job.max_attempts,
            "code": error.code,
            "retry": retry,
            "fencingToken": job.fencing_token,
        }),
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Claim and run at most one job. Returns true when a job was handled.
pub async fn run_once(state: &AppState, worker: &str) -> anyhow::Result<bool> {
    // Exhausted rows are finalized before a claim so they can never be skipped
    // forever. A failure here is retried on the next tick with the rest.
    reap_exhausted(state).await?;
    let Some(job) = claim(state, worker).await? else {
        return Ok(false);
    };
    let occurred_at: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT occurred_at FROM kernel.telemetry_events WHERE event_id=$1")
            .bind(job.event_id)
            .fetch_optional(&state.db)
            .await?;
    let Some(occurred_at) = occurred_at else {
        finish_error(
            state,
            &job,
            &AppError::conflict(
                "AUTOMATION_EVENT_MISSING",
                "the job's event no longer exists",
            ),
        )
        .await?;
        return Ok(true);
    };
    let principal = match automation::load_principal(state, job.principal_id).await {
        Ok(principal) => principal,
        Err(error) => {
            finish_error(state, &job, &error).await?;
            return Ok(true);
        }
    };
    match automation_flow::collect_and_append(
        state,
        &principal,
        job.incident_id,
        job.source_id,
        occurred_at,
        job.job_id,
    )
    .await
    {
        Ok(run) => {
            if let Some(evidence_id) = run.evidence_id {
                match finish_success(state, &job, evidence_id).await {
                    Ok(()) => {}
                    Err(error) if lease_is_stale(&error) => {
                        // A takeover happened while this attempt ran. The new
                        // generation owns the terminal state; this worker stops.
                        tracing::warn!(
                            job_id = %job.job_id,
                            fencing_token = job.fencing_token,
                            "automation job lease was taken over before this attempt finished; result discarded"
                        );
                    }
                    Err(error) => return Err(error),
                }
            } else {
                finish_error(
                    state,
                    &job,
                    &AppError::unavailable(
                        "AUTOMATION_INVALID_RESPONSE",
                        "collection returned no evidence",
                    ),
                )
                .await?;
            }
        }
        Err(error) => match finish_error(state, &job, &error).await {
            Ok(()) => {}
            Err(error) if lease_is_stale(&error) => {
                tracing::warn!(
                    job_id = %job.job_id,
                    fencing_token = job.fencing_token,
                    "automation job lease was taken over before this attempt failed; result discarded"
                );
            }
            Err(error) => return Err(error),
        },
    }
    Ok(true)
}

/// Run the worker until the process exits. A failed claim is retried on the
/// next tick rather than killing the worker.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let worker = format!("kernel-{}", Uuid::new_v4());
        loop {
            match run_once(&state, &worker).await {
                Ok(true) => {}
                Ok(false) => tokio::time::sleep(Duration::from_secs(2)).await,
                Err(error) => {
                    tracing::warn!(error = %error, "automation job worker failed; retrying");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        }
    });
}

pub fn default_max_attempts() -> i32 {
    MAX_ATTEMPTS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retryable_codes_are_the_transient_ones_only() {
        for code in [
            "AUTOMATION_UPSTREAM_UNAVAILABLE",
            "AUTOMATION_INSTANCE_UNAVAILABLE",
            "AUTOMATION_INVALID_RESPONSE",
        ] {
            assert!(retryable(code), "{code}");
        }
        for code in [
            "AUTOMATION_CONFIGURATION_REQUIRED",
            "AUTOMATION_SOURCE_NOT_READY",
            "INCIDENT_CLOSED",
            "INCIDENT_ALREADY_CONCLUDED",
            "AUTOMATION_BUDGET_EXHAUSTED",
            "AUTOMATION_PRINCIPAL_EXPIRED",
        ] {
            assert!(!retryable(code), "{code}");
        }
    }
}

#[cfg(test)]
mod fencing_tests {
    use super::*;
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
            b"automation-fencing-test".to_vec(),
        )
        .unwrap()
    }

    struct Fixture {
        source: Uuid,
        incident: Uuid,
        principal: Uuid,
        job: Uuid,
    }

    async fn seed(pool: &PgPool) -> Fixture {
        let workspace = crate::scope::legacy_workspace();
        let source = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.telemetry_sources
                 (source_id,workspace_id,plugin_id,secret_ref,endpoint,tls_policy,state)
             VALUES ($1,$2,'zabbix-source','secretref:zabbix/main','https://zabbix.example/api_jsonrpc.php','VERIFY','READY')",
        )
        .bind(source)
        .bind(workspace)
        .execute(pool)
        .await
        .unwrap();
        let incident = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.incidents
               (incident_id,title,severity,status,source,native_id,started_at,owner,workspace_id,origin)
             VALUES ($1,$2,'MAJOR','OPEN','ZABBIX',$3,now(),$4,$5,'AUTOMATION')",
        )
        .bind(incident)
        .bind(format!("fencing incident {incident}"))
        .bind(format!("fencing-native-{incident}"))
        .bind(Uuid::parse_str(crate::automation::AUTOMATION_USER_ID).unwrap())
        .bind(workspace)
        .execute(pool)
        .await
        .unwrap();
        let principal = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.automation_principals
                 (principal_id,plugin_id,instance_id,node_id,node_generation,workspace_id,source_id,
                  allowed_ops,event_id,incident_id,budget,issued_at,expires_at,jti)
             VALUES ($1,'zabbix-source',$2,$3,1,$4,$5,$6,NULL,NULL,'{}'::jsonb,now(),now()+interval '300 seconds',$7)",
        )
        .bind(principal)
        .bind(Uuid::new_v4())
        .bind(Uuid::new_v4())
        .bind(workspace)
        .bind(source)
        .bind(vec!["SOURCE_COLLECT".to_string()])
        .bind(Uuid::new_v4())
        .execute(pool)
        .await
        .unwrap();
        let event = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.telemetry_events
                 (event_id,workspace_id,source_id,native_id,idempotency_key,trigger_state,severity,
                  occurred_at,observed_at,payload_digest,payload,late,incident_id)
             VALUES ($1,$2,$3,$4,$5,'PROBLEM','MAJOR',now(),now(),$6,'{}'::jsonb,false,$7)",
        )
        .bind(event)
        .bind(workspace)
        .bind(source)
        .bind(format!("fencing-native-{incident}"))
        .bind(format!("fencing-key-{event}"))
        .bind(format!("sha256:{}", "0".repeat(64)))
        .bind(incident)
        .execute(pool)
        .await
        .unwrap();
        let job = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.automation_jobs
                 (job_id,event_id,incident_id,principal_id,source_id,status,max_attempts)
             VALUES ($1,$2,$3,$4,$5,'PENDING',3)",
        )
        .bind(job)
        .bind(event)
        .bind(incident)
        .bind(principal)
        .bind(source)
        .execute(pool)
        .await
        .unwrap();
        Fixture {
            source,
            incident,
            principal,
            job,
        }
    }

    async fn cleanup(pool: &PgPool, fixture: &Fixture) {
        let _ = sqlx::query(
            "DELETE FROM kernel.audit_events
              WHERE subject_type='INCIDENT' AND subject_id=$1",
        )
        .bind(fixture.incident.to_string())
        .execute(pool)
        .await;
        let _ = sqlx::query("DELETE FROM kernel.automation_jobs WHERE source_id=$1")
            .bind(fixture.source)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM kernel.telemetry_events WHERE source_id=$1")
            .bind(fixture.source)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM kernel.automation_principals WHERE principal_id=$1")
            .bind(fixture.principal)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM kernel.incidents WHERE incident_id=$1")
            .bind(fixture.incident)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM kernel.telemetry_sources WHERE source_id=$1")
            .bind(fixture.source)
            .execute(pool)
            .await;
    }

    async fn terminal(pool: &PgPool, job: Uuid) -> (String, Option<Uuid>) {
        sqlx::query_as("SELECT status, evidence_id FROM kernel.automation_jobs WHERE job_id=$1")
            .bind(job)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    async fn job_audit(pool: &PgPool, job: Uuid, event_type: &str) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM kernel.audit_events
              WHERE event_type=$2 AND details->>'jobId'=$1",
        )
        .bind(job.to_string())
        .bind(event_type)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    fn stale_code(error: &anyhow::Error) -> Option<&str> {
        error.downcast_ref::<AppError>().map(|error| error.code)
    }

    /// B1.5 regression: worker A claims, its lease expires, worker B takes over
    /// and succeeds. A wakes up and tries to write both a success and a failure
    /// with its old handle. Neither may touch the row B owns.
    #[tokio::test]
    async fn a_stale_worker_cannot_overwrite_the_new_workers_result() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let fixture = seed(&pool).await;
        let state = state(pool.clone());

        let a = claim_matching(&state, "worker-a", Some(fixture.job), None)
            .await
            .unwrap()
            .expect("A claims");
        assert_eq!(a.fencing_token, 1);
        sqlx::query(
            "UPDATE kernel.automation_jobs SET lease_until=now()-interval '1 second' WHERE job_id=$1",
        )
        .bind(fixture.job)
        .execute(&pool)
        .await
        .unwrap();
        let b = claim_matching(&state, "worker-b", Some(fixture.job), None)
            .await
            .unwrap()
            .expect("B takes over");
        assert_eq!(b.fencing_token, 2, "a takeover advances the generation");

        let evidence_b = Uuid::new_v4();
        finish_success(&state, &b, evidence_b).await.unwrap();
        assert_eq!(
            terminal(&pool, fixture.job).await,
            ("SUCCEEDED".into(), Some(evidence_b))
        );
        assert_eq!(
            job_audit(&pool, fixture.job, "telemetry.automation.succeeded").await,
            1
        );

        let evidence_a = Uuid::new_v4();
        let late = finish_success(&state, &a, evidence_a).await.unwrap_err();
        assert_eq!(
            stale_code(&late),
            Some("AUTOMATION_STALE_LEASE"),
            "{late:?}"
        );
        assert_eq!(
            terminal(&pool, fixture.job).await,
            ("SUCCEEDED".into(), Some(evidence_b)),
            "the stale worker's evidence id must not replace the new result"
        );

        let late_failure = finish_error(
            &state,
            &a,
            &AppError::unavailable("AUTOMATION_UPSTREAM_UNAVAILABLE", "late failure"),
        )
        .await
        .unwrap_err();
        assert_eq!(
            stale_code(&late_failure),
            Some("AUTOMATION_STALE_LEASE"),
            "{late_failure:?}"
        );
        assert_eq!(
            terminal(&pool, fixture.job).await.0,
            "SUCCEEDED",
            "a stale failure must not reopen a completed job"
        );
        assert_eq!(
            job_audit(&pool, fixture.job, "telemetry.automation.succeeded").await,
            1,
            "a stale worker writes no success audit"
        );

        cleanup(&pool, &fixture).await;
    }

    #[tokio::test]
    async fn one_worker_completes_and_a_replay_of_its_own_success_is_idempotent() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let fixture = seed(&pool).await;
        let state = state(pool.clone());

        let job = claim_matching(&state, "worker-solo", Some(fixture.job), None)
            .await
            .unwrap()
            .unwrap();
        let evidence = Uuid::new_v4();
        finish_success(&state, &job, evidence).await.unwrap();
        let (status, stored) = terminal(&pool, fixture.job).await;
        assert_eq!(status, "SUCCEEDED");
        assert_eq!(stored, Some(evidence));
        let lease: Option<Uuid> =
            sqlx::query_scalar("SELECT lease_id FROM kernel.automation_jobs WHERE job_id=$1")
                .bind(fixture.job)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(lease.is_none(), "a terminal row carries no lease");

        // The commit landed but the worker never saw the answer: a replay with
        // the same generation and evidence is success, not a conflict.
        finish_success(&state, &job, evidence).await.unwrap();
        assert_eq!(
            job_audit(&pool, fixture.job, "telemetry.automation.succeeded").await,
            1,
            "the replay writes no second audit row"
        );

        cleanup(&pool, &fixture).await;
    }

    #[tokio::test]
    async fn a_live_lease_cannot_be_claimed_by_a_second_worker() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let fixture = seed(&pool).await;
        let state = state(pool.clone());
        let first = claim_matching(&state, "worker-a", Some(fixture.job), None)
            .await
            .unwrap()
            .expect("A claims");
        assert!(claim_matching(&state, "worker-b", Some(fixture.job), None)
            .await
            .unwrap()
            .is_none());
        let (owner, fence): (Option<String>, i64) = sqlx::query_as(
            "SELECT lease_owner, fencing_token FROM kernel.automation_jobs WHERE job_id=$1",
        )
        .bind(fixture.job)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(owner.as_deref(), Some("worker-a"));
        assert_eq!(fence, 1);
        finish_error(
            &state,
            &first,
            &AppError::conflict("AUTOMATION_CONFIGURATION_REQUIRED", "no items"),
        )
        .await
        .unwrap();
        cleanup(&pool, &fixture).await;
    }

    #[tokio::test]
    async fn a_retry_clears_the_lease_and_the_next_claim_advances_the_fence() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let fixture = seed(&pool).await;
        let state = state(pool.clone());

        let first = claim_matching(&state, "worker-a", Some(fixture.job), None)
            .await
            .unwrap()
            .unwrap();
        finish_error(
            &state,
            &first,
            &AppError::unavailable("AUTOMATION_UPSTREAM_UNAVAILABLE", "plugin down"),
        )
        .await
        .unwrap();
        let (status, lease): (String, Option<Uuid>) =
            sqlx::query_as("SELECT status, lease_id FROM kernel.automation_jobs WHERE job_id=$1")
                .bind(fixture.job)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "RETRY_WAIT");
        assert!(lease.is_none());
        assert_eq!(
            job_audit(&pool, fixture.job, "telemetry.automation.attempt_failed").await,
            1
        );

        sqlx::query("UPDATE kernel.automation_jobs SET available_at=now() WHERE job_id=$1")
            .bind(fixture.job)
            .execute(&pool)
            .await
            .unwrap();
        let second = claim_matching(&state, "worker-b", Some(fixture.job), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(second.attempts, 2);
        assert_eq!(second.fencing_token, 2);
        let evidence = Uuid::new_v4();
        finish_success(&state, &second, evidence).await.unwrap();
        assert_eq!(
            terminal(&pool, fixture.job).await,
            ("SUCCEEDED".into(), Some(evidence))
        );

        // The first attempt's failure arrives after the retry already won.
        let late = finish_error(
            &state,
            &first,
            &AppError::unavailable("AUTOMATION_UPSTREAM_UNAVAILABLE", "late"),
        )
        .await
        .unwrap_err();
        assert_eq!(stale_code(&late), Some("AUTOMATION_STALE_LEASE"));
        assert_eq!(terminal(&pool, fixture.job).await.0, "SUCCEEDED");

        cleanup(&pool, &fixture).await;
    }

    #[tokio::test]
    async fn exhausted_jobs_are_reaped_instead_of_staying_running_forever() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let fixture = seed(&pool).await;
        let state = state(pool.clone());
        // The shape a worker crash on its final attempt leaves behind.
        sqlx::query(
            "UPDATE kernel.automation_jobs
                SET status='RUNNING', attempts=3, max_attempts=3,
                    lease_owner='dead-worker', lease_until=now()-interval '1 minute',
                    lease_id=gen_random_uuid(), fencing_token=3
              WHERE job_id=$1",
        )
        .bind(fixture.job)
        .execute(&pool)
        .await
        .unwrap();

        let reaped = reap_exhausted(&state).await.unwrap();
        assert!(
            reaped >= 1,
            "the reaper must finalize this exhausted row, not leave it RUNNING"
        );
        let (status, code, lease): (String, Option<String>, Option<Uuid>) = sqlx::query_as(
            "SELECT status, last_error_code, lease_id FROM kernel.automation_jobs WHERE job_id=$1",
        )
        .bind(fixture.job)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(status, "FAILED_FINAL");
        assert_eq!(code.as_deref(), Some("AUTOMATION_ATTEMPTS_EXHAUSTED"));
        assert!(lease.is_none());
        assert_eq!(
            job_audit(&pool, fixture.job, "telemetry.automation.attempt_failed").await,
            1
        );

        cleanup(&pool, &fixture).await;
    }

    /// A terminal state is never committed without its audit row. The trigger
    /// fails only for THIS job, so other tests running in parallel are unaffected.
    #[tokio::test]
    async fn a_failed_audit_rolls_the_terminal_state_back() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let fixture = seed(&pool).await;
        let state = state(pool.clone());
        let job = claim_matching(&state, "worker-audit", Some(fixture.job), None)
            .await
            .unwrap()
            .unwrap();

        let suffix = fixture.job.simple();
        let function = format!("fencing_fail_audit_{suffix}");
        let trigger = format!("fencing_fail_audit_{suffix}");
        sqlx::query(&format!(
            "CREATE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN
               IF NEW.details->>'jobId' = '{}' THEN
                 RAISE EXCEPTION 'injected audit failure';
               END IF;
               RETURN NEW;
             END $$",
            fixture.job
        ))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(&format!(
            "CREATE TRIGGER {trigger} BEFORE INSERT ON kernel.audit_events
             FOR EACH ROW EXECUTE FUNCTION {function}()"
        ))
        .execute(&pool)
        .await
        .unwrap();

        let evidence = Uuid::new_v4();
        let error = finish_success(&state, &job, evidence).await.unwrap_err();
        assert!(
            error.to_string().contains("injected audit failure"),
            "{error:?}"
        );
        assert_eq!(
            terminal(&pool, fixture.job).await,
            ("RUNNING".into(), None),
            "the terminal state must not survive a failed audit"
        );

        sqlx::query(&format!("DROP TRIGGER {trigger} ON kernel.audit_events"))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(&format!("DROP FUNCTION {function}()"))
            .execute(&pool)
            .await
            .unwrap();

        // The same handle still holds the lease, so the retry can complete.
        finish_success(&state, &job, evidence).await.unwrap();
        assert_eq!(
            terminal(&pool, fixture.job).await,
            ("SUCCEEDED".into(), Some(evidence))
        );

        cleanup(&pool, &fixture).await;
    }

    #[tokio::test]
    async fn two_workers_claiming_the_same_instant_have_one_winner() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let fixture = seed(&pool).await;
        let state = state(pool.clone());
        let left = claim_matching(&state, "worker-left", Some(fixture.job), None);
        let right = claim_matching(&state, "worker-right", Some(fixture.job), None);
        let (left, right) = tokio::join!(left, right);
        let left = left.unwrap();
        let right = right.unwrap();
        assert_eq!(
            usize::from(left.is_some()) + usize::from(right.is_some()),
            1,
            "exactly one claim wins: {left:?} / {right:?}"
        );
        let winner = left.or(right).unwrap();
        let (owner, fence): (Option<String>, i64) = sqlx::query_as(
            "SELECT lease_owner, fencing_token FROM kernel.automation_jobs WHERE job_id=$1",
        )
        .bind(fixture.job)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(fence, 1);
        assert!(matches!(
            owner.as_deref(),
            Some("worker-left") | Some("worker-right")
        ));
        finish_success(&state, &winner, Uuid::new_v4())
            .await
            .unwrap();
        cleanup(&pool, &fixture).await;
    }

    /// Many workers, many jobs: every job is claimed exactly once per generation,
    /// every claim advances its fence exactly once, and no row is left RUNNING.
    #[tokio::test]
    async fn many_workers_leave_no_job_unclaimed_or_permanently_running() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let fixture = seed(&pool).await;
        let state = state(pool.clone());
        let total = 16;
        let mut expected = vec![fixture.job];
        for _ in 1..total {
            let event = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO kernel.telemetry_events
                     (event_id,workspace_id,source_id,native_id,idempotency_key,trigger_state,severity,
                      occurred_at,observed_at,payload_digest,payload,late,incident_id)
                 VALUES ($1,$2,$3,$4,$5,'PROBLEM','MAJOR',now(),now(),$6,'{}'::jsonb,false,$7)",
            )
            .bind(event)
            .bind(crate::scope::legacy_workspace())
            .bind(fixture.source)
            .bind(format!("bulk-native-{event}"))
            .bind(format!("bulk-key-{event}"))
            .bind(format!("sha256:{}", "1".repeat(64)))
            .bind(fixture.incident)
            .execute(&pool)
            .await
            .unwrap();
            let job = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO kernel.automation_jobs
                     (job_id,event_id,incident_id,principal_id,source_id,status,max_attempts)
                 VALUES ($1,$2,$3,$4,$5,'PENDING',3)",
            )
            .bind(job)
            .bind(event)
            .bind(fixture.incident)
            .bind(fixture.principal)
            .bind(fixture.source)
            .execute(&pool)
            .await
            .unwrap();
            expected.push(job);
        }

        let claimed = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<Uuid>::new()));
        let mut tasks = Vec::new();
        for index in 0..4 {
            let state = state.clone();
            let claimed = claimed.clone();
            tasks.push(tokio::spawn(async move {
                let mut empty_rounds = 0;
                for _ in 0..40 {
                    match claim_matching(
                        &state,
                        &format!("worker-{index}"),
                        None,
                        Some(fixture.source),
                    )
                    .await
                    {
                        Ok(Some(job)) => {
                            empty_rounds = 0;
                            claimed.lock().await.push(job.job_id);
                            finish_success(&state, &job, Uuid::new_v4())
                                .await
                                .expect("the claim's own generation writes its success");
                        }
                        Ok(None) => {
                            empty_rounds += 1;
                            if empty_rounds >= 3 {
                                break;
                            }
                            tokio::time::sleep(Duration::from_millis(10)).await;
                        }
                        Err(error) => panic!("claim failed: {error:?}"),
                    }
                }
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }

        let claimed = claimed.lock().await.clone();
        expected.sort();
        let mut unique = claimed.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(
            unique,
            expected,
            "every job is claimed exactly once ({} claims for {} jobs)",
            claimed.len(),
            total
        );

        let rows: Vec<(String, i64, Option<Uuid>)> = sqlx::query_as(
            "SELECT status, fencing_token, lease_id FROM kernel.automation_jobs
              WHERE source_id=$1 ORDER BY job_id",
        )
        .bind(fixture.source)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(rows.len(), total as usize);
        for (status, fence, lease) in rows {
            assert_eq!(status, "SUCCEEDED");
            assert_eq!(fence, 1);
            assert!(lease.is_none());
        }

        cleanup(&pool, &fixture).await;
    }

    /// A PostgreSQL failure must be reported as a failure. The worker's own
    /// pool is closed after the claim; the terminal write cannot reach the
    /// database, so the job must still be RUNNING with its lease intact, and
    /// the independent verifier pool must see exactly that.
    #[tokio::test]
    async fn a_database_failure_does_not_report_a_terminal_state() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let fixture = seed(&pool).await;
        let url = std::env::var("OPSWEAVE_TEST_DATABASE_URL").unwrap();
        let options: PgConnectOptions = url.parse().unwrap();
        let worker_pool = PgPool::connect_with(options).await.unwrap();
        let state = AppState::new(
            crate::config::Config::from_env(),
            worker_pool.clone(),
            b"automation-fencing-test".to_vec(),
        )
        .unwrap();
        let job = claim_matching(&state, "worker-db", Some(fixture.job), None)
            .await
            .unwrap()
            .expect("claim before the failure");
        worker_pool.close().await;

        let error = finish_success(&state, &job, Uuid::new_v4())
            .await
            .unwrap_err();
        assert!(
            error.to_string().to_lowercase().contains("pool")
                || error.to_string().to_lowercase().contains("closed"),
            "{error:?}"
        );
        let (status, evidence, lease): (String, Option<Uuid>, Option<Uuid>) = sqlx::query_as(
            "SELECT status, evidence_id, lease_id FROM kernel.automation_jobs WHERE job_id=$1",
        )
        .bind(fixture.job)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(status, "RUNNING");
        assert!(evidence.is_none());
        assert_eq!(lease, Some(job.lease_id), "the lease was not released");

        cleanup(&pool, &fixture).await;
    }

    /// Fault injection: the Evidence committed, the Job success did not (a crash
    /// in that window). The restarted worker must find the receipt, skip the
    /// plugin entirely (there is no route in this fixture), and confirm success.
    #[tokio::test]
    async fn a_restarted_worker_recovers_a_committed_effect_without_collecting_again() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let fixture = seed(&pool).await;
        let state = state(pool.clone());
        let evidence = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.incident_evidence
               (evidence_id,incident_id,kind,source,collected_at,content_ref,claimed_trust,
                verified_trust,verification_method,verified_at,submitted_by,automation_job_id)
             VALUES ($1,$2,'METRIC_SNAPSHOT','zabbix:effect',now(),$3,'OPERATOR_ASSERTED',
                     'OPERATOR_ASSERTED','OPERATOR_IDENTITY',now(),$4,$5)",
        )
        .bind(evidence)
        .bind(fixture.incident)
        .bind(format!("sha256:{}", "b".repeat(64)))
        .bind(Uuid::parse_str(crate::automation::AUTOMATION_USER_ID).unwrap())
        .bind(fixture.job)
        .execute(&pool)
        .await
        .unwrap();

        let job = claim_matching(&state, "restarted-worker", Some(fixture.job), None)
            .await
            .unwrap()
            .expect("the expired attempt is claimable");
        let principal = automation::load_principal(&state, fixture.principal)
            .await
            .unwrap();
        let run = automation_flow::collect_and_append(
            &state,
            &principal,
            fixture.incident,
            fixture.source,
            chrono::Utc::now(),
            job.job_id,
        )
        .await
        .expect("recovery must not need an upstream");
        assert!(run.recovered);
        assert_eq!(run.evidence_id, Some(evidence));
        finish_success(&state, &job, run.evidence_id.unwrap())
            .await
            .unwrap();
        assert_eq!(
            terminal(&pool, fixture.job).await,
            ("SUCCEEDED".into(), Some(evidence))
        );
        assert_eq!(
            job_audit(&pool, fixture.job, "telemetry.automation.succeeded").await,
            1
        );
        let rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id=$1",
        )
        .bind(fixture.incident)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(rows, 1, "recovery adds no second evidence row");

        // The evidence FK is RESTRICT: clean it before the job it names.
        let _ = sqlx::query("DELETE FROM kernel.incident_evidence WHERE incident_id=$1")
            .bind(fixture.incident)
            .execute(&pool)
            .await;
        cleanup(&pool, &fixture).await;
    }

    #[test]
    fn the_lease_outlives_one_bounded_attempt_and_is_clamped() {
        assert_eq!(
            lease_seconds_for(10),
            60,
            "default: two 10s calls + headroom"
        );
        assert_eq!(lease_seconds_for(30), 90);
        assert_eq!(lease_seconds_for(0), 60);
        assert_eq!(
            lease_seconds_for(600),
            MAX_LEASE_SECONDS,
            "a misconfigured timeout cannot create an unbounded lease"
        );
    }
}
