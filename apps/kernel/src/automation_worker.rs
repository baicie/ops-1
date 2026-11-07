//! G13-B1.3: durable automation job worker.
//!
//! The Event handler enqueues a job in the same transaction as the Event and
//! answers `PENDING`. This worker claims a job with a database lease, runs the
//! existing collect/attest/evidence path, and records SUCCEEDED or a bounded
//! retry. A crash leaves the lease to expire; another worker (or the restarted
//! Kernel) reclaims it. Evidence dedup is still the writer's unique key, so a
//! retry cannot silently double-store the same fact.

use crate::automation;
use crate::automation_flow;
use crate::error::AppError;
use crate::state::AppState;
use serde_json::json;
use sqlx::FromRow;
use std::time::Duration;
use uuid::Uuid;

const LEASE_SECONDS: i64 = 60;
const MAX_ATTEMPTS: i32 = 3;

#[derive(Debug, Clone, FromRow)]
struct Job {
    job_id: Uuid,
    event_id: Uuid,
    incident_id: Uuid,
    principal_id: Uuid,
    source_id: Uuid,
    attempts: i32,
    max_attempts: i32,
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

async fn claim(state: &AppState, worker: &str) -> anyhow::Result<Option<Job>> {
    let job = sqlx::query_as::<_, Job>(
        r#"
        UPDATE kernel.automation_jobs j
           SET status='RUNNING',
               attempts=j.attempts + 1,
               lease_owner=$1,
               lease_until=now() + ($2 || ' seconds')::interval,
               updated_at=now()
         WHERE j.job_id = (
             SELECT job_id FROM kernel.automation_jobs
              WHERE (status IN ('PENDING','RETRY_WAIT') AND available_at <= now())
                 OR (status='RUNNING' AND lease_until < now())
              ORDER BY available_at, job_id
              LIMIT 1
              FOR UPDATE SKIP LOCKED
         )
         RETURNING job_id,event_id,incident_id,principal_id,source_id,attempts,max_attempts
        "#,
    )
    .bind(worker)
    .bind(LEASE_SECONDS)
    .fetch_optional(&state.db)
    .await?;
    Ok(job)
}

async fn finish_success(state: &AppState, job: &Job, evidence_id: Uuid) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE kernel.automation_jobs
            SET status='SUCCEEDED', evidence_id=$2, lease_owner=NULL, lease_until=NULL,
                last_error_code=NULL, updated_at=now()
          WHERE job_id=$1",
    )
    .bind(job.job_id)
    .bind(evidence_id)
    .execute(&state.db)
    .await?;
    let _ = crate::audit::record(
        &state.db,
        "telemetry.automation.succeeded",
        "AUTOMATION",
        &job.principal_id.to_string(),
        "INCIDENT",
        &job.incident_id.to_string(),
        "AUTOMATION_COLLECT",
        "ACCEPTED",
        json!({"jobId": job.job_id, "evidenceId": evidence_id, "attempts": job.attempts}),
        None,
    )
    .await;
    Ok(())
}

async fn finish_error(state: &AppState, job: &Job, error: &AppError) -> anyhow::Result<()> {
    let retry = retryable(error.code) && job.attempts < job.max_attempts;
    if retry {
        let backoff = i64::from(job.attempts.max(1)) * 15;
        sqlx::query(
            "UPDATE kernel.automation_jobs
                SET status='RETRY_WAIT', available_at=now() + ($2 || ' seconds')::interval,
                    lease_owner=NULL, lease_until=NULL, last_error_code=$3, updated_at=now()
              WHERE job_id=$1",
        )
        .bind(job.job_id)
        .bind(backoff)
        .bind(error.code)
        .execute(&state.db)
        .await?;
    } else {
        sqlx::query(
            "UPDATE kernel.automation_jobs
                SET status='FAILED_FINAL', lease_owner=NULL, lease_until=NULL,
                    last_error_code=$2, updated_at=now()
              WHERE job_id=$1",
        )
        .bind(job.job_id)
        .bind(error.code)
        .execute(&state.db)
        .await?;
    }
    let _ = crate::audit::record(
        &state.db,
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
        }),
        None,
    )
    .await;
    Ok(())
}

/// Claim and run at most one job. Returns true when a job was handled.
pub async fn run_once(state: &AppState, worker: &str) -> anyhow::Result<bool> {
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
    )
    .await
    {
        Ok(run) => {
            if let Some(evidence_id) = run.evidence_id {
                finish_success(state, &job, evidence_id).await?;
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
        Err(error) => finish_error(state, &job, &error).await?,
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
