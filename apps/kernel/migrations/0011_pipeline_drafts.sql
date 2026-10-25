-- Drafts are mutable, versioned and separate from immutable published revisions.
CREATE TABLE IF NOT EXISTS kernel.pipeline_drafts (
    draft_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_id text NOT NULL REFERENCES kernel.pipeline_definitions(pipeline_id) ON DELETE CASCADE,
    base_revision integer NOT NULL CHECK (base_revision > 0),
    definition jsonb NOT NULL,
    definition_digest text NOT NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED')),
    created_by uuid NOT NULL REFERENCES kernel.users(id),
    updated_by uuid NOT NULL REFERENCES kernel.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pipeline_drafts_pipeline_owner_idx
    ON kernel.pipeline_drafts (pipeline_id, created_by, updated_at DESC);
