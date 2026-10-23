ALTER TABLE kernel.pipeline_jobs
    ADD COLUMN IF NOT EXISTS deadline_at timestamptz;
UPDATE kernel.pipeline_jobs
SET deadline_at = created_at + make_interval(secs => timeout_seconds)
WHERE deadline_at IS NULL;
