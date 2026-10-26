-- Jobs submitted before this migration have no trustworthy owner. They are
-- intentionally left NULL and remain accessible only to Admins for sensitive reads.
ALTER TABLE kernel.pipeline_jobs
    ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES kernel.users(id);
CREATE INDEX IF NOT EXISTS pipeline_jobs_submitted_by_idx
    ON kernel.pipeline_jobs (submitted_by, created_at DESC);
