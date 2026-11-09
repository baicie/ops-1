-- B2.1a: workspace attribution for pipeline jobs.
--
-- Authority: docs/adr/ADR-020-plugin-identity-hardening.md section 5, and the
-- same ruling migration 0022 already applied to incidents: a row of business
-- data belongs to exactly one business workspace, and a caller reads it because
-- it is a member of that workspace - not because of its role.
--
-- Why a job needs one. The pipeline worker writes into the Catalog through a
-- workload capability token. A workload has no user session and therefore no
-- membership of its own, so before this column the only workspace a worker
-- could honestly claim was "none" - which is how a worker ended up able to
-- write into any dataset the Catalog would accept. The job is the trustworthy
-- place to remember the decision: it is created by a user, in a transaction the
-- Kernel controls, and the worker can only act on a job it holds a lease for.
--
-- Additive only. `workspace_id` is nullable here and stays nullable: jobs
-- submitted before this migration have no trustworthy owner (0013 left their
-- `submitted_by` NULL for the same reason), and inventing a workspace for them
-- would be exactly the kind of fabricated attribution this phase removes.
-- A job with a NULL workspace is one no worker may write through; see
-- jobs::worker_workspace.

ALTER TABLE kernel.pipeline_jobs ADD COLUMN IF NOT EXISTS workspace_id uuid;

ALTER TABLE kernel.pipeline_jobs
    DROP CONSTRAINT IF EXISTS pipeline_jobs_workspace_fk;
ALTER TABLE kernel.pipeline_jobs
    ADD CONSTRAINT pipeline_jobs_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES kernel.business_workspaces(workspace_id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS pipeline_jobs_workspace_idx
    ON kernel.pipeline_jobs (workspace_id, created_at DESC);

COMMENT ON COLUMN kernel.pipeline_jobs.workspace_id IS
    'B2.1a: the business workspace this job writes into. Null for jobs that predate the column; such a job can be read by an admin but no worker may write through it.';
