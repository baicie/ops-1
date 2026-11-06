-- 0026 · G13-B0 slices 0–1: the Kernel-owned source registry and the future
-- automation identity/event tables.
--
-- This migration does not enable automation. It creates the authoritative
-- records the later slices need, and it changes one legacy uniqueness rule so
-- that a workspace-scoped source can use `nativeId` values that another
-- workspace also uses.
--
-- Authority: ADR-018 (Automation Principal) and ADR-019 (Event identity and
-- dedup). The source registry is configuration the Kernel reads, never data a
-- plugin may declare: a plugin can only ask for a sourceId that is already in
-- kernel.telemetry_sources with a READY state.
--
-- Legacy incident identity is preserved, not migrated:
--   * rows created before this migration have source_id NULL;
--   * incidents_source_native_idx is rebuilt with `source_id IS NULL`, so those
--     rows keep exactly the old global (source, native_id) uniqueness;
--   * new source-scoped rows use incidents_workspace_source_native_idx and can
--     repeat a nativeId in another workspace;
--   * no row is backfilled, merged or rewritten.
--
-- Rollback (destructive only for the new tables; the index rebuild is
-- reversible because legacy rows keep source_id NULL):
--   DROP TABLE kernel.automation_principals;
--   DROP TABLE kernel.telemetry_events;
--   -- Drop both indexes BEFORE the columns: dropping source_id would drop the
--   -- partial index implicitly, and the explicit DROP would then fail.
--   DROP INDEX kernel.incidents_workspace_source_native_idx;
--   DROP INDEX kernel.incidents_source_native_idx;
--   ALTER TABLE kernel.incidents DROP COLUMN recurrence_of, DROP COLUMN origin,
--     DROP COLUMN source_id;
--   CREATE UNIQUE INDEX incidents_source_native_idx
--     ON kernel.incidents (source, native_id) WHERE native_id IS NOT NULL;
--   DROP TABLE kernel.telemetry_sources;
--   ALTER TABLE kernel.audit_events DROP CONSTRAINT audit_events_actor_type_check;
--   ALTER TABLE kernel.audit_events ADD CONSTRAINT audit_events_actor_type_check
--     CHECK (actor_type IN ('USER','NODE','KERNEL','WORKLOAD'));

-- 1. The Kernel-owned source registry -----------------------------------------

CREATE TABLE IF NOT EXISTS kernel.telemetry_sources (
    source_id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL
        REFERENCES kernel.business_workspaces(workspace_id) ON DELETE RESTRICT,
    plugin_id text NOT NULL CHECK (length(btrim(plugin_id)) BETWEEN 1 AND 200),
    -- The handle, never the secret. The endpoint/TLS columns are copied from
    -- the A.2 credential binding at sync time; a binding change is reflected on
    -- the next Kernel start and the source becomes non-READY until then.
    secret_ref text NOT NULL CHECK (secret_ref LIKE 'secretref:%'),
    endpoint text,
    tls_policy text CHECK (tls_policy IS NULL OR tls_policy IN ('VERIFY','TEST_PLAINTEXT')),
    state text NOT NULL CHECK (state IN ('READY','DISABLED','INVALID')),
    invalid_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- A READY source must have an approved endpoint and TLS policy. INVALID is
    -- how a configuration error stays visible instead of silently disappearing.
    CHECK (state <> 'READY' OR (endpoint IS NOT NULL AND tls_policy IS NOT NULL)),
    CHECK ((state = 'INVALID') = (invalid_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS telemetry_sources_workspace_idx
    ON kernel.telemetry_sources (workspace_id, state, source_id);

-- 2. Incident source identity for automation ----------------------------------

ALTER TABLE kernel.incidents ADD COLUMN IF NOT EXISTS source_id uuid
    REFERENCES kernel.telemetry_sources(source_id) ON DELETE RESTRICT;
ALTER TABLE kernel.incidents ADD COLUMN IF NOT EXISTS origin text;
ALTER TABLE kernel.incidents ADD COLUMN IF NOT EXISTS recurrence_of uuid
    REFERENCES kernel.incidents(incident_id) ON DELETE SET NULL;

ALTER TABLE kernel.incidents DROP CONSTRAINT IF EXISTS incidents_origin_check;
ALTER TABLE kernel.incidents ADD CONSTRAINT incidents_origin_check
    CHECK (origin IS NULL OR origin IN ('USER','AUTOMATION'));

-- ADR-019: the closed source set widens with the connector this schema can
-- attest; the value is still not caller-controlled (the Kernel sets it).
ALTER TABLE kernel.incidents DROP CONSTRAINT IF EXISTS incidents_source_check;
ALTER TABLE kernel.incidents ADD CONSTRAINT incidents_source_check
    CHECK (source IN ('MANUAL','API','ZABBIX'));

-- Legacy rows keep their old global key. New source-scoped rows are unique per
-- workspace+source+nativeId, which is the dedup key ADR-019 freezes.
DROP INDEX IF EXISTS kernel.incidents_source_native_idx;
CREATE UNIQUE INDEX IF NOT EXISTS incidents_source_native_idx
    ON kernel.incidents (source, native_id)
    WHERE native_id IS NOT NULL AND source_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS incidents_workspace_source_native_idx
    ON kernel.incidents (workspace_id, source_id, native_id)
    WHERE source_id IS NOT NULL AND native_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS incidents_recurrence_idx
    ON kernel.incidents (recurrence_of) WHERE recurrence_of IS NOT NULL;

-- 3. Event store (B1 slice 3 writes it; the contract is frozen now) ------------

CREATE TABLE IF NOT EXISTS kernel.telemetry_events (
    event_id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL
        REFERENCES kernel.business_workspaces(workspace_id) ON DELETE RESTRICT,
    source_id uuid NOT NULL
        REFERENCES kernel.telemetry_sources(source_id) ON DELETE RESTRICT,
    native_id text NOT NULL CHECK (length(btrim(native_id)) BETWEEN 1 AND 200),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
    trigger_state text NOT NULL CHECK (trigger_state IN ('PROBLEM','RESOLVED')),
    severity text NOT NULL CHECK (severity IN ('CRITICAL','MAJOR','MINOR','WARNING','INFO')),
    occurred_at timestamptz NOT NULL,
    observed_at timestamptz NOT NULL,
    payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    late boolean NOT NULL DEFAULT false,
    incident_id uuid REFERENCES kernel.incidents(incident_id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, source_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS telemetry_events_native_idx
    ON kernel.telemetry_events (workspace_id, source_id, native_id, occurred_at DESC);

-- 4. Automation principals (B1 slice 2 issues them; table frozen now) ----------

CREATE TABLE IF NOT EXISTS kernel.automation_principals (
    principal_id uuid PRIMARY KEY,
    plugin_id text NOT NULL CHECK (length(btrim(plugin_id)) BETWEEN 1 AND 200),
    instance_id uuid NOT NULL,
    node_id uuid NOT NULL,
    node_generation bigint NOT NULL CHECK (node_generation >= 0),
    workspace_id uuid NOT NULL
        REFERENCES kernel.business_workspaces(workspace_id) ON DELETE RESTRICT,
    source_id uuid NOT NULL
        REFERENCES kernel.telemetry_sources(source_id) ON DELETE RESTRICT,
    allowed_ops text[] NOT NULL CHECK (cardinality(allowed_ops) BETWEEN 1 AND 8),
    event_id uuid REFERENCES kernel.telemetry_events(event_id) ON DELETE SET NULL,
    incident_id uuid REFERENCES kernel.incidents(incident_id) ON DELETE SET NULL,
    budget jsonb NOT NULL DEFAULT '{}'::jsonb,
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    jti uuid NOT NULL UNIQUE,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at > issued_at)
);
CREATE INDEX IF NOT EXISTS automation_principals_live_idx
    ON kernel.automation_principals (source_id, expires_at DESC)
    WHERE revoked_at IS NULL;

-- 5. Audit actor type ---------------------------------------------------------

ALTER TABLE kernel.audit_events DROP CONSTRAINT IF EXISTS audit_events_actor_type_check;
ALTER TABLE kernel.audit_events ADD CONSTRAINT audit_events_actor_type_check
    CHECK (actor_type IN ('USER','NODE','KERNEL','WORKLOAD','AUTOMATION'));
