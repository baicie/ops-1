-- 0032 · G13-B1.5: automation job lease fencing.
--
-- The B1.3 worker claimed with FOR UPDATE SKIP LOCKED and a 60-second lease, but
-- finished with `UPDATE ... WHERE job_id = $1`. A worker whose lease had expired
-- could therefore overwrite the result of the worker that took the job over: a
-- late SUCCEEDED replaced the new evidence id, and a late retryable failure
-- reopened a completed job as RETRY_WAIT.
--
-- Two facts now travel with every claim and must be presented by every terminal
-- write:
--
--   * fencing_token: monotonic per job, advanced by the claim that starts an
--     attempt. A write carrying an older token cannot match the row.
--   * lease_id: a fresh uuid per claim. Two claims for the same job can never
--     share it, even at the same fencing token after a manual repair.
--
-- The CHECK constraints below are the durable half of the state machine: a
-- RUNNING row always carries a lease id, and no terminal write leaves one
-- behind. The writer's WHERE clause is the authority for "is this lease still
-- the current one"; the database refuses a row that contradicts the shape.
--
-- Backfill: a RUNNING row that predates this migration gets a lease id and
-- fencing token 1 so the new CHECK holds. Its owner was the old process, which
-- this deploy replaces; the lease still expires on its own schedule and the next
-- claim advances the token.
--
-- Rollback (destructive only for the fencing evidence; the job state is kept):
--   DROP INDEX kernel.automation_jobs_lease_id_idx;
--   ALTER TABLE kernel.automation_jobs DROP CONSTRAINT automation_jobs_fencing_check;
--   ALTER TABLE kernel.automation_jobs DROP CONSTRAINT automation_jobs_lease_handle_check;
--   ALTER TABLE kernel.automation_jobs DROP COLUMN lease_id, DROP COLUMN fencing_token;

ALTER TABLE kernel.automation_jobs
    ADD COLUMN IF NOT EXISTS fencing_token bigint NOT NULL DEFAULT 0;
ALTER TABLE kernel.automation_jobs
    ADD COLUMN IF NOT EXISTS lease_id uuid;

UPDATE kernel.automation_jobs
   SET lease_id = gen_random_uuid(),
       fencing_token = GREATEST(fencing_token, 1)
 WHERE status = 'RUNNING' AND lease_id IS NULL;

ALTER TABLE kernel.automation_jobs
    DROP CONSTRAINT IF EXISTS automation_jobs_lease_handle_check;
ALTER TABLE kernel.automation_jobs
    ADD CONSTRAINT automation_jobs_lease_handle_check
    CHECK (status <> 'RUNNING' OR lease_id IS NOT NULL);

ALTER TABLE kernel.automation_jobs
    DROP CONSTRAINT IF EXISTS automation_jobs_fencing_check;
ALTER TABLE kernel.automation_jobs
    ADD CONSTRAINT automation_jobs_fencing_check
    CHECK (fencing_token >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS automation_jobs_lease_id_idx
    ON kernel.automation_jobs (lease_id) WHERE lease_id IS NOT NULL;
