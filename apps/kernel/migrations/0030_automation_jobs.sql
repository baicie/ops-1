-- 0030 · Durable automation jobs.
--
-- Event ingest used to run collect+attestation inside the HTTP request. A
-- Kernel crash after the Event commit lost the work, and a slow plugin held the
-- request open. The Event now enqueues one job in the same transaction; a
-- Kernel worker claims it with a lease, so a crash is recoverable and retries
-- are explicit.
--
-- One job per Event (event_id unique). A retry never creates a second job or a
-- second Incident; Evidence dedup remains the writer's unique key. A job that
-- cannot be retried (binding/config/incident lifecycle) goes straight to
-- FAILED_FINAL. Lease takeover uses SKIP LOCKED and an expired lease predicate.
--
-- Rollback: DROP TABLE kernel.automation_jobs;

CREATE TABLE IF NOT EXISTS kernel.automation_jobs (
    job_id uuid PRIMARY KEY,
    event_id uuid NOT NULL UNIQUE
        REFERENCES kernel.telemetry_events(event_id) ON DELETE CASCADE,
    incident_id uuid NOT NULL REFERENCES kernel.incidents(incident_id) ON DELETE CASCADE,
    principal_id uuid NOT NULL REFERENCES kernel.automation_principals(principal_id) ON DELETE CASCADE,
    source_id uuid NOT NULL REFERENCES kernel.telemetry_sources(source_id) ON DELETE RESTRICT,
    status text NOT NULL CHECK (status IN ('PENDING','RUNNING','RETRY_WAIT','SUCCEEDED','FAILED_FINAL','CANCELLED')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    available_at timestamptz NOT NULL DEFAULT now(),
    lease_owner text,
    lease_until timestamptz,
    last_error_code text,
    evidence_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((status = 'RUNNING') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS automation_jobs_claim_idx
    ON kernel.automation_jobs (status, available_at, job_id);
CREATE INDEX IF NOT EXISTS automation_jobs_lease_idx
    ON kernel.automation_jobs (lease_until) WHERE status = 'RUNNING';
