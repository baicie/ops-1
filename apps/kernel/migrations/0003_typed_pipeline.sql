-- 0.0.3 typed pipeline and durable job store. Additive.
CREATE TABLE IF NOT EXISTS kernel.pipeline_definitions (
    pipeline_id text PRIMARY KEY,
    latest_revision integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kernel.pipeline_revisions (
    pipeline_id text NOT NULL REFERENCES kernel.pipeline_definitions(pipeline_id),
    revision integer NOT NULL CHECK (revision > 0),
    digest text NOT NULL,
    definition jsonb NOT NULL,
    plan jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('PUBLISHED')),
    published_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (pipeline_id, revision),
    UNIQUE (pipeline_id, digest)
);
CREATE TABLE IF NOT EXISTS kernel.pipeline_jobs (
    job_id uuid PRIMARY KEY,
    pipeline_id text NOT NULL,
    pipeline_revision integer NOT NULL,
    pipeline_digest text NOT NULL,
    idempotency_key text NOT NULL UNIQUE,
    request_digest text NOT NULL,
    status text NOT NULL CHECK (status IN ('QUEUED','CLAIMED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
    input jsonb NOT NULL DEFAULT '{}'::jsonb,
    current_fence bigint NOT NULL DEFAULT 0 CHECK (current_fence >= 0),
    current_lease_id uuid,
    attempts integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 8),
    timeout_seconds integer NOT NULL DEFAULT 300 CHECK (timeout_seconds BETWEEN 1 AND 3600),
    last_error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (pipeline_id, pipeline_revision) REFERENCES kernel.pipeline_revisions(pipeline_id, revision)
);
CREATE INDEX IF NOT EXISTS pipeline_jobs_status_idx ON kernel.pipeline_jobs (status, updated_at);
CREATE TABLE IF NOT EXISTS kernel.pipeline_job_attempts (
    job_id uuid NOT NULL REFERENCES kernel.pipeline_jobs(job_id),
    attempt_number integer NOT NULL,
    worker_id text NOT NULL,
    node_id uuid NOT NULL,
    instance_id uuid NOT NULL,
    boot_id uuid NOT NULL,
    lease_id uuid NOT NULL,
    fencing_sequence bigint NOT NULL,
    status text NOT NULL CHECK (status IN ('CLAIMED','RUNNING','SUCCEEDED','FAILED','CANCELLED','LOST')),
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    error_code text,
    PRIMARY KEY (job_id, attempt_number)
);
CREATE TABLE IF NOT EXISTS kernel.pipeline_job_leases (
    lease_id uuid PRIMARY KEY,
    job_id uuid NOT NULL REFERENCES kernel.pipeline_jobs(job_id),
    attempt_number integer NOT NULL,
    worker_id text NOT NULL,
    node_id uuid NOT NULL,
    instance_id uuid NOT NULL,
    boot_id uuid NOT NULL,
    fencing_sequence bigint NOT NULL,
    status text NOT NULL CHECK (status IN ('ACTIVE','EXPIRED','REVOKED','RELEASED')),
    acquired_at timestamptz NOT NULL DEFAULT now(),
    heartbeat_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    UNIQUE (job_id, fencing_sequence)
);
CREATE INDEX IF NOT EXISTS pipeline_job_leases_active_idx ON kernel.pipeline_job_leases (job_id, status, expires_at);
CREATE TABLE IF NOT EXISTS kernel.pipeline_job_checkpoints (
    checkpoint_id uuid PRIMARY KEY,
    job_id uuid NOT NULL REFERENCES kernel.pipeline_jobs(job_id),
    attempt_number integer NOT NULL,
    sequence bigint NOT NULL,
    fencing_sequence bigint NOT NULL,
    input_cursor text,
    state_digest text NOT NULL,
    state jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (job_id, attempt_number, sequence)
);
CREATE TABLE IF NOT EXISTS kernel.pipeline_job_results (
    job_id uuid PRIMARY KEY REFERENCES kernel.pipeline_jobs(job_id),
    fencing_sequence bigint NOT NULL,
    status text NOT NULL CHECK (status IN ('SUCCEEDED','FAILED','CANCELLED')),
    output jsonb NOT NULL DEFAULT '{}'::jsonb,
    error_code text,
    error_message text,
    result_digest text,
    receipt jsonb,
    completed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kernel.pipeline_job_events (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id uuid NOT NULL REFERENCES kernel.pipeline_jobs(job_id),
    event_type text NOT NULL,
    from_status text,
    to_status text,
    fencing_sequence bigint,
    worker_id text,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pipeline_job_events_job_idx ON kernel.pipeline_job_events (job_id, occurred_at);

-- Catalog calls this function inside its own transaction. It acquires the same
-- job row lock used by Claim, so a fenced Catalog commit and a new Claim cannot
-- interleave between authorization and receipt/records commit.
CREATE OR REPLACE FUNCTION kernel.fence_authorize(
    p_job_id uuid,
    p_lease_id uuid,
    p_fencing_sequence bigint
) RETURNS TABLE(authorized boolean, reason text, pipeline_id text, pipeline_revision integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, kernel
AS $function$
DECLARE
    v_status text;
    v_lease_status text;
    v_expires timestamptz;
    v_fence bigint;
    v_pipeline text;
    v_revision integer;
BEGIN
    SELECT j.status, j.current_fence, j.pipeline_id, j.pipeline_revision
      INTO v_status, v_fence, v_pipeline, v_revision
      FROM kernel.pipeline_jobs j
     WHERE j.job_id = p_job_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'JOB_NOT_FOUND', NULL::text, NULL::integer;
        RETURN;
    END IF;
    IF v_status NOT IN ('CLAIMED','RUNNING') THEN
        RETURN QUERY SELECT false, 'JOB_NOT_RUNNING', v_pipeline, v_revision;
        RETURN;
    END IF;
    IF p_fencing_sequence <> v_fence THEN
        RETURN QUERY SELECT false, 'STALE_FENCE', v_pipeline, v_revision;
        RETURN;
    END IF;
    SELECT l.status, l.expires_at
      INTO v_lease_status, v_expires
      FROM kernel.pipeline_job_leases l
     WHERE l.lease_id = p_lease_id AND l.job_id = p_job_id AND l.fencing_sequence = v_fence;
    IF NOT FOUND OR v_lease_status <> 'ACTIVE' OR v_expires <= now() THEN
        RETURN QUERY SELECT false, 'LEASE_NOT_ACTIVE', v_pipeline, v_revision;
        RETURN;
    END IF;
    RETURN QUERY SELECT true, 'OK', v_pipeline, v_revision;
END;
$function$;
REVOKE ALL ON FUNCTION kernel.fence_authorize(uuid, uuid, bigint) FROM PUBLIC;
