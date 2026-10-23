-- 0.0.2 Data Foundation: capability grants and plugin storage ownership.
-- Additive only; 0.0.1 tables and endpoints remain unchanged.

CREATE TABLE IF NOT EXISTS kernel.capability_grants (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    major integer NOT NULL CHECK (major > 0),
    consumer_plugin_id text NOT NULL,
    provider_plugin_id text,
    scope jsonb NOT NULL DEFAULT '[]'::jsonb,
    state text NOT NULL CHECK (state IN ('ACTIVE','REVOKED','EXPIRED')),
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    UNIQUE (consumer_plugin_id, name, major)
);
CREATE INDEX IF NOT EXISTS capability_grants_lookup_idx
    ON kernel.capability_grants (name, major, state);

CREATE TABLE IF NOT EXISTS kernel.plugin_storage_bindings (
    plugin_id text PRIMARY KEY,
    schema_name text NOT NULL UNIQUE,
    role_name text NOT NULL UNIQUE,
    credential_ref text NOT NULL,
    state text NOT NULL CHECK (state IN ('UNBOUND','READY','BLOCKED','DISABLED')),
    migration_plan_digest text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE kernel.plugin_migrations
    ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'EXPAND'
        CHECK (phase IN ('EXPAND','MIGRATE','CONTRACT'));
ALTER TABLE kernel.plugin_migrations
    ADD COLUMN IF NOT EXISTS plan_digest text;
ALTER TABLE kernel.plugin_migrations
    ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS plugin_migrations_identity_idx
    ON kernel.plugin_migrations (plugin_id, version, migration_id);
