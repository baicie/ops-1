ALTER TABLE kernel.pipeline_job_results
    ADD COLUMN IF NOT EXISTS lease_id uuid,
    ADD COLUMN IF NOT EXISTS worker_id text;
