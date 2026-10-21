-- OpsWeave 0.0.1 control-plane schema (Kernel-owned).
-- The Kernel is the only writer. Business plugins never read these tables.
CREATE SCHEMA IF NOT EXISTS kernel;

CREATE TABLE IF NOT EXISTS kernel.users (
    id uuid PRIMARY KEY,
    email text NOT NULL,
    display_name text NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL CHECK (role IN ('admin','operator','viewer')),
    disabled boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON kernel.users (lower(email));

CREATE TABLE IF NOT EXISTS kernel.sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    csrf_token text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_token_idx ON kernel.sessions (token_hash);

CREATE TABLE IF NOT EXISTS kernel.trusted_publishers (
    publisher_id text PRIMARY KEY,
    public_key_hex text NOT NULL,
    fingerprint text NOT NULL,
    trust_state text NOT NULL CHECK (trust_state IN ('TRUSTED','REVOKED')),
    note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS kernel.plugin_packages (
    package_id uuid PRIMARY KEY,
    plugin_id text NOT NULL,
    version text NOT NULL,
    schema_version text NOT NULL,
    publisher text NOT NULL,
    manifest jsonb NOT NULL,
    artifact_digest text NOT NULL,
    bundle_digest text NOT NULL UNIQUE,
    payload_digest text NOT NULL,
    frontend_index jsonb,
    backend_image_ref text,
    status text NOT NULL CHECK (status IN ('UPLOADED','VERIFIED','STAGED','INSTALLED','REJECTED')),
    signature_state text NOT NULL,
    rejection_reason text,
    uploaded_by uuid REFERENCES kernel.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (plugin_id, version)
);
CREATE INDEX IF NOT EXISTS packages_plugin_idx ON kernel.plugin_packages (plugin_id, created_at DESC);

CREATE TABLE IF NOT EXISTS kernel.plugin_installations (
    plugin_id text PRIMARY KEY,
    state text NOT NULL CHECK (state IN ('STAGED','INSTALLED','DISABLED','UNINSTALLED')),
    active_revision_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kernel.plugin_deployments (
    id uuid PRIMARY KEY,
    plugin_id text NOT NULL,
    package_id uuid NOT NULL REFERENCES kernel.plugin_packages(package_id),
    version text NOT NULL,
    desired_replicas integer NOT NULL CHECK (desired_replicas BETWEEN 0 AND 20),
    generation bigint NOT NULL CHECK (generation > 0),
    placement jsonb NOT NULL,
    resources jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('PENDING','PREPARING','READY','ACTIVE','DRAINING','DISABLED','DEGRADED','FAILED')),
    status_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    activated_at timestamptz,
    drain_until timestamptz,
    UNIQUE (plugin_id, version)
);
CREATE INDEX IF NOT EXISTS deployments_status_idx ON kernel.plugin_deployments (status);

CREATE TABLE IF NOT EXISTS kernel.nodes (
    id uuid PRIMARY KEY,
    name text NOT NULL UNIQUE,
    control_token_hash text NOT NULL,
    data_token text NOT NULL,
    generation bigint NOT NULL DEFAULT 1,
    os text NOT NULL,
    arch text NOT NULL,
    labels jsonb NOT NULL DEFAULT '{}'::jsonb,
    capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
    status text NOT NULL CHECK (status IN ('READY','DEGRADED','UNREACHABLE','UNKNOWN')),
    last_seen_at timestamptz,
    data_endpoint text,
    runtime_adapter_version text,
    resource_snapshot jsonb,
    enrolled_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    cert_expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS nodes_status_idx ON kernel.nodes (status);

CREATE TABLE IF NOT EXISTS kernel.node_enrollment_tokens (
    id uuid PRIMARY KEY,
    token_hash text NOT NULL UNIQUE,
    label text,
    created_by uuid REFERENCES kernel.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    used_by_node uuid REFERENCES kernel.nodes(id)
);

CREATE TABLE IF NOT EXISTS kernel.plugin_instances (
    id uuid PRIMARY KEY,
    deployment_id uuid NOT NULL REFERENCES kernel.plugin_deployments(id) ON DELETE CASCADE,
    node_id uuid NOT NULL REFERENCES kernel.nodes(id),
    slot integer NOT NULL,
    deployment_generation bigint NOT NULL,
    desired_action text NOT NULL CHECK (desired_action IN ('START','STOP')),
    state text NOT NULL CHECK (state IN ('STARTING','READY','UNHEALTHY','UNREACHABLE','STOPPED','UNKNOWN')),
    observed_at timestamptz,
    container_id text,
    image_digest text,
    host_port integer,
    restart_count integer NOT NULL DEFAULT 0,
    last_error text,
    runtime_adapter_version text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (deployment_id, slot)
);
CREATE INDEX IF NOT EXISTS instances_node_idx ON kernel.plugin_instances (node_id, state);

CREATE TABLE IF NOT EXISTS kernel.activation_revisions (
    id uuid PRIMARY KEY,
    plugin_id text NOT NULL,
    package_id uuid NOT NULL REFERENCES kernel.plugin_packages(package_id),
    version text NOT NULL,
    deployment_id uuid NOT NULL REFERENCES kernel.plugin_deployments(id),
    generation bigint NOT NULL CHECK (generation > 0),
    status text NOT NULL CHECK (status IN ('ACTIVE','SUPERSEDED','DISABLED')),
    policy_digest text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    activated_at timestamptz,
    superseded_at timestamptz,
    UNIQUE (plugin_id, generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS activation_one_active_idx
    ON kernel.activation_revisions (plugin_id) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS kernel.capability_registrations (
    id uuid PRIMARY KEY,
    plugin_id text NOT NULL,
    version text NOT NULL,
    revision_id uuid NOT NULL REFERENCES kernel.activation_revisions(id) ON DELETE CASCADE,
    direction text NOT NULL CHECK (direction IN ('PROVIDES','REQUIRES')),
    name text NOT NULL,
    major integer NOT NULL,
    api_digest text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (plugin_id, revision_id, direction, name)
);
CREATE INDEX IF NOT EXISTS capability_name_idx ON kernel.capability_registrations (name, major);

CREATE TABLE IF NOT EXISTS kernel.operation_receipts (
    id uuid PRIMARY KEY,
    idempotency_key text NOT NULL,
    action text NOT NULL,
    request_digest text NOT NULL,
    status text NOT NULL CHECK (status IN ('ACCEPTED','CONFIRMED','REJECTED','UNKNOWN')),
    response_code integer,
    response_body jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (idempotency_key, action)
);

CREATE TABLE IF NOT EXISTS kernel.audit_events (
    id uuid PRIMARY KEY,
    event_type text NOT NULL,
    actor_type text NOT NULL CHECK (actor_type IN ('USER','NODE','KERNEL','WORKLOAD')),
    actor_id text NOT NULL,
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    action text NOT NULL,
    result text NOT NULL CHECK (result IN ('ACCEPTED','CONFIRMED','REJECTED','UNKNOWN')),
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    request_id text,
    trace_id text,
    occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_time_idx ON kernel.audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_subject_idx ON kernel.audit_events (subject_type, subject_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS kernel.platform_settings (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kernel.plugin_migrations (
    id uuid PRIMARY KEY,
    plugin_id text NOT NULL,
    version text NOT NULL,
    migration_id text NOT NULL,
    checksum text NOT NULL,
    status text NOT NULL CHECK (status IN ('PENDING','APPLIED','FAILED','BLOCKED')),
    applied_at timestamptz
);

CREATE TABLE IF NOT EXISTS kernel.system_plugins (
    plugin_id text PRIMARY KEY,
    name text NOT NULL,
    version text NOT NULL,
    description text NOT NULL,
    ui_route text,
    installed_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO kernel.system_plugins (plugin_id, name, version, description, ui_route)
VALUES (
    'dev.opsweave.ops-center',
    'Ops Center',
    '0.0.1',
    'Official system plugin for node, instance, log and recovery operations. Its screens are host-owned so Bootstrap Diagnostics remain available when business plugins fail.',
    '/ops-center'
)
ON CONFLICT (plugin_id) DO NOTHING;
