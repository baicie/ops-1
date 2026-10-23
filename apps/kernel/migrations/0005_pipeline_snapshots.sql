CREATE TABLE IF NOT EXISTS kernel.pipeline_job_snapshots (
    job_id uuid PRIMARY KEY REFERENCES kernel.pipeline_jobs(job_id),
    source_digest text NOT NULL,
    source_length bigint NOT NULL CHECK (source_length >= 0 AND source_length <= 4194304),
    source jsonb NOT NULL,
    etag text,
    fetched_at timestamptz NOT NULL DEFAULT now()
);
