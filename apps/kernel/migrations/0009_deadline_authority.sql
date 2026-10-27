-- Deadline is part of every execution authorization. The check is made with
-- clock_timestamp() after the job row lock is acquired, so a lock wait cannot
-- authorize work using the transaction-start timestamp.
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
    v_deadline timestamptz;
    v_fence bigint;
    v_pipeline text;
    v_revision integer;
BEGIN
    SELECT j.status, j.current_fence, j.pipeline_id, j.pipeline_revision, j.deadline_at
      INTO v_status, v_fence, v_pipeline, v_revision, v_deadline
      FROM kernel.pipeline_jobs j
     WHERE j.job_id = p_job_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'JOB_NOT_FOUND', NULL::text, NULL::integer;
        RETURN;
    END IF;
    IF v_deadline IS NOT NULL AND clock_timestamp() >= v_deadline THEN
        RETURN QUERY SELECT false, 'JOB_DEADLINE_EXCEEDED', v_pipeline, v_revision;
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
    IF NOT FOUND OR v_lease_status <> 'ACTIVE' OR v_expires <= clock_timestamp() THEN
        RETURN QUERY SELECT false, 'LEASE_NOT_ACTIVE', v_pipeline, v_revision;
        RETURN;
    END IF;
    RETURN QUERY SELECT true, 'OK', v_pipeline, v_revision;
END;
$function$;
REVOKE ALL ON FUNCTION kernel.fence_authorize(uuid, uuid, bigint) FROM PUBLIC;

CREATE OR REPLACE FUNCTION kernel.fence_authorize_effect(
    p_job_id uuid,
    p_lease_id uuid,
    p_fencing_sequence bigint,
    p_sink_node_id text,
    p_dataset_id uuid,
    p_schema_revision integer
) RETURNS TABLE(authorized boolean, reason text, pipeline_id text, pipeline_revision integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, kernel
AS $function$
DECLARE
    v_status text;
    v_lease_status text;
    v_expires timestamptz;
    v_deadline timestamptz;
    v_fence bigint;
    v_pipeline text;
    v_revision integer;
    v_sink_id text;
    v_dataset uuid;
    v_schema integer;
BEGIN
    SELECT j.status, j.current_fence, j.pipeline_id, j.pipeline_revision, j.deadline_at
      INTO v_status, v_fence, v_pipeline, v_revision, v_deadline
      FROM kernel.pipeline_jobs j
     WHERE j.job_id = p_job_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'JOB_NOT_FOUND', NULL::text, NULL::integer;
        RETURN;
    END IF;
    IF v_deadline IS NOT NULL AND clock_timestamp() >= v_deadline THEN
        RETURN QUERY SELECT false, 'JOB_DEADLINE_EXCEEDED', v_pipeline, v_revision;
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
    IF NOT FOUND OR v_lease_status <> 'ACTIVE' OR v_expires <= clock_timestamp() THEN
        RETURN QUERY SELECT false, 'LEASE_NOT_ACTIVE', v_pipeline, v_revision;
        RETURN;
    END IF;
    SELECT node->>'nodeId',
           (node->'config'->>'datasetId')::uuid,
           (node->'config'->>'schemaRevision')::integer
      INTO v_sink_id, v_dataset, v_schema
      FROM kernel.pipeline_revisions r,
           LATERAL jsonb_array_elements(r.definition->'nodes') node
     WHERE r.pipeline_id = v_pipeline
       AND r.revision = v_revision
       AND node->>'type' = 'builtin.sink.dataset'
     LIMIT 1;
    IF v_sink_id IS NULL OR v_sink_id <> p_sink_node_id OR v_dataset <> p_dataset_id OR v_schema <> p_schema_revision THEN
        RETURN QUERY SELECT false, 'SINK_SCOPE_MISMATCH', v_pipeline, v_revision;
        RETURN;
    END IF;
    RETURN QUERY SELECT true, 'OK', v_pipeline, v_revision;
END;
$function$;
REVOKE ALL ON FUNCTION kernel.fence_authorize_effect(uuid, uuid, bigint, text, uuid, integer) FROM PUBLIC;
