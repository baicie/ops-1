ALTER TABLE kernel.pipeline_drafts
    ADD COLUMN IF NOT EXISTS published_revision integer,
    ADD COLUMN IF NOT EXISTS publish_idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_drafts_publish_key_idx
    ON kernel.pipeline_drafts (publish_idempotency_key)
    WHERE publish_idempotency_key IS NOT NULL;
