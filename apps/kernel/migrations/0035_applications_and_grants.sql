-- G14.3: applications, and authorization that is scoped to them.
--
-- Authority: docs/adr/ADR-022-platform-core-and-applications.md §2.4 and §2.2.
--
-- The rule this migration creates the data for: a platform administrator is NOT
-- thereby an operator of every business application, and being allowed into an
-- application is NOT being allowed into every workspace inside it. Three
-- independent answers, and today only one of them exists:
--
--   may this caller use the PLATFORM (users, nodes, plugins)?  -> role, already enforced
--   may this caller use THIS APPLICATION at all?                -> this migration
--   may this caller read THIS WORKSPACE's rows?                 -> business_workspace_members (0022)
--
-- Without the middle one, "installing the ops application" and "being allowed to
-- use the ops application" are the same statement, and the first thing a
-- deployment does - install it for everyone - silently grants it to everyone.

-- ---------------------------------------------------------------------------
-- 1. The application registry.
-- ---------------------------------------------------------------------------
-- Registration is DATA, not code (ADR-022 §2.4): the Kernel must serve a new
-- application without a rebuild. `key` is the stable identifier the API path and
-- the grants use; `surface_prefix` is the path this application is mounted at.
CREATE TABLE IF NOT EXISTS kernel.applications (
    application_id text PRIMARY KEY CHECK (application_id ~ '^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$'),
    display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 2 AND 120),
    -- Where the application's own build is mounted ("/app", "/console"). Not a
    -- routing table: the Kernel's static site still owns serving, this is the
    -- declaration a grant and an operator read.
    surface_prefix text NOT NULL CHECK (surface_prefix ~ '^/[a-z0-9-]+$'),
    -- Which Core surfaces this application's users need. Kept as an array so a
    -- future application can require platform access without a schema change.
    requires_surfaces text[] NOT NULL DEFAULT '{}',
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (surface_prefix)
);

COMMENT ON TABLE kernel.applications IS
    'G14.3: registered business applications. Data, not code: adding one is an INSERT, never a Kernel rebuild (ADR-022 section 2.4).';

-- ---------------------------------------------------------------------------
-- 2. The grant: who may use which application.
-- ---------------------------------------------------------------------------
-- Deliberately a separate table from business_workspace_members. They answer
-- different questions and a caller can hold one without the other:
--   * application access  = "may this account open the ops product at all"
--   * workspace membership = "inside it, whose rows may it read"
-- An administrator may grant the first and withhold the second (an account that
-- can open the product and see nothing until it is added to a workspace), and a
-- workspace member may exist in an account that cannot open any application.
CREATE TABLE IF NOT EXISTS kernel.application_grants (
    application_id text NOT NULL REFERENCES kernel.applications(application_id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
    -- Which application-level verbs this grant carries. Empty is meaningful and
    -- is the default: it means "may open the application", nothing more. A
    -- handler that needs a verb asks for it by name.
    permissions text[] NOT NULL DEFAULT '{}',
    granted_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
    granted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (application_id, user_id)
);

CREATE INDEX IF NOT EXISTS application_grants_user_idx
    ON kernel.application_grants (user_id, application_id);

COMMENT ON TABLE kernel.application_grants IS
    'G14.3: application-scoped authorization. A platform admin role does not imply a row here, which is the ruling ADR-022 section 2.2 states.';

-- ---------------------------------------------------------------------------
-- 3. The built-in applications, and the grants that keep history working.
-- ---------------------------------------------------------------------------
-- Same shape as migration 0022's legacy grant: every account that exists at
-- migration time keeps exactly the access it had a moment earlier, and an
-- account created afterwards gets nothing until an administrator grants it.
-- That direction is the tightening this phase asks for, and it is why the grant
-- is in data rather than in a role check.
INSERT INTO kernel.applications (application_id, display_name, surface_prefix, requires_surfaces)
VALUES
    ('opsweave.ops', 'OpsWeave Operations', '/app', ARRAY['workspace']),
    ('opsweave.console', 'OpsWeave Platform Console', '/console', ARRAY['admin'])
ON CONFLICT (application_id) DO NOTHING;

-- The console application is granted by the SAME predicate that already decides
-- the admin surface, so this migration cannot change who sees the console.
INSERT INTO kernel.application_grants (application_id, user_id, permissions, granted_by)
SELECT 'opsweave.console', u.id, ARRAY[]::text[], NULL::uuid
  FROM kernel.users u
ON CONFLICT (application_id, user_id) DO NOTHING;

-- The ops application is granted to every account that is a member of at least
-- one business workspace. That is exactly the set that could already file and
-- read incidents before this migration, so nobody gains a capability and nobody
-- loses one.
INSERT INTO kernel.application_grants (application_id, user_id, permissions, granted_by)
SELECT DISTINCT 'opsweave.ops', m.user_id, ARRAY[]::text[], NULL::uuid
  FROM kernel.business_workspace_members m
ON CONFLICT (application_id, user_id) DO NOTHING;

-- An administrator that existed before this migration but is a member of no
-- workspace could still reach /app and read nothing. Keep that behaviour rather
-- than locking it out: being able to open an empty product is not a data grant.
INSERT INTO kernel.application_grants (application_id, user_id, permissions, granted_by)
SELECT 'opsweave.ops', u.id, ARRAY[]::text[], NULL::uuid
  FROM kernel.users u
 WHERE u.role = 'admin'
ON CONFLICT (application_id, user_id) DO NOTHING;
