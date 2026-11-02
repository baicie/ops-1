-- G12 D5 Phase 1: the minimal business permission model (方案 C).
--
-- Authority: docs/design/g12-scope/d5-business-workspace-adr.md. Read that file
-- before changing a predicate here; the migration and the handler disagreeing
-- about who may read a row is the failure this phase exists to remove.
--
-- The decision this migration implements, in one sentence: a row of business
-- data is visible to a caller because the caller is a MEMBER OF THE BUSINESS
-- WORKSPACE the row belongs to, and for no other reason. The role still decides
-- which verbs a caller may use (require_operator / require_admin) and, inside an
-- authorized workspace, whether it sees every row or only its own. The role no
-- longer decides WHICH workspaces - that is membership, and membership is data
-- an administrator grants, not an attribute a role carries.
--
-- Why this is not "add a column and move on": before this migration a viewer read
-- every incident on the platform through incidents::Caller's `!can_operate()`
-- half (ADR-G11-001 section 4.6, narrowed-reads.md section 3.4, decision D5).
-- That half was an accident of how the predicate was written, not a decision
-- about viewers, and it also contradicted the audit ledger, which told the same
-- viewer that INCIDENT events are visible only where the caller OWNS the subject.
-- Membership replaces the accident with a decision.
--
-- Additive only. No column is dropped, no type is changed, no business value is
-- overwritten: the only UPDATE fills the new column on rows that predate it.
-- Rollback DDL is in the ADR (section 6) and was executed against a scratch
-- database; it is destructive in exactly one sense - dropping workspace_id loses
-- the workspace decision a row was filed under - so it is never run implicitly.

-- ---------------------------------------------------------------------------
-- 1. The business workspace: the unit of data visibility.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kernel.business_workspaces (
    workspace_id uuid PRIMARY KEY,
    -- Stable, human-readable handle: what an administrator names in a grant and
    -- what an operator reads in a 404 explanation. It is not a routing key and
    -- nothing dereferences it.
    key text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Platform administration of workspace METADATA (who created the container),
    -- never a data grant: creating a workspace does not put its creator inside
    -- it. That separation is the whole point of the ruling that a Platform Admin
    -- does not thereby own every future business domain.
    created_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE kernel.business_workspaces IS
    'G12 D5: the unit of business data visibility. A row of business data is visible to a caller iff the caller is a member of the workspace the row belongs to (and, for an operator, owns the row).';

-- ---------------------------------------------------------------------------
-- 2. Membership: the grant, and the only route into a workspace.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kernel.business_workspace_members (
    workspace_id uuid NOT NULL
        REFERENCES kernel.business_workspaces(workspace_id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
    granted_at timestamptz NOT NULL DEFAULT now(),
    -- Who granted it. NULL for the rows this migration writes, which is honest:
    -- nobody granted those, the migration carried an existing decision forward.
    granted_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
    PRIMARY KEY (workspace_id, user_id)
);

-- The read every request performs: "which workspaces may this caller read".
CREATE INDEX IF NOT EXISTS business_workspace_members_user_idx
    ON kernel.business_workspace_members (user_id, workspace_id);

COMMENT ON TABLE kernel.business_workspace_members IS
    'G12 D5: business workspace membership. Read at the instant of every request and every AI tool call - never copied into a session or a run, so a revoked member loses the scope on its next call.';

-- ---------------------------------------------------------------------------
-- 3. Resource ownership: every incident belongs to exactly one workspace.
-- ---------------------------------------------------------------------------
-- No DEFAULT on purpose. A default would let a forgotten INSERT land business
-- data in the legacy workspace silently; without one, an INSERT that does not
-- name its workspace fails at the database, which is the behaviour we want from
-- a column that decides who can read the row.
ALTER TABLE kernel.incidents ADD COLUMN IF NOT EXISTS workspace_id uuid;

-- ---------------------------------------------------------------------------
-- 4. The legacy workspace, and the one-time grant that keeps history readable.
-- ---------------------------------------------------------------------------
-- Fixed UUID so that an operator, a rollback script and a test can all name the
-- same row without a lookup.
INSERT INTO kernel.business_workspaces (workspace_id, key, name, created_by)
VALUES ('00000000-0000-4000-8000-000000000001', 'legacy', 'Legacy (pre-D5 incidents)', NULL)
ON CONFLICT (workspace_id) DO NOTHING;

UPDATE kernel.incidents
   SET workspace_id = '00000000-0000-4000-8000-000000000001'
 WHERE workspace_id IS NULL;

ALTER TABLE kernel.incidents ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE kernel.incidents
    ADD CONSTRAINT incidents_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES kernel.business_workspaces(workspace_id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS incidents_workspace_time_idx
    ON kernel.incidents (workspace_id, started_at DESC, incident_id DESC);

-- The one-time grant. Every account that exists at migration time is made a
-- member of the legacy workspace, because that is the set of accounts the OLD
-- predicate let read legacy rows (admin: all rows; viewer: all rows, read-only;
-- operator: its own rows, which it still only sees through the row rule). Doing
-- this in data rather than in a role check is the difference between a snapshot
-- and a rule: an account created AFTER this migration gets nothing until an
-- administrator grants it, which is the tightening D5 asked for.
--
-- It expands nobody: admin and viewer keep exactly the rows they could read a
-- moment earlier, and an operator's visible set is unchanged because the row
-- rule still limits it to rows it owns.
INSERT INTO kernel.business_workspace_members (workspace_id, user_id, granted_by)
SELECT '00000000-0000-4000-8000-000000000001', u.id, NULL
  FROM kernel.users u
ON CONFLICT (workspace_id, user_id) DO NOTHING;

COMMENT ON COLUMN kernel.incidents.workspace_id IS
    'G12 D5: the business workspace this record lives in. Decides who may read it; the owner column decides which rows an operator sees inside it.';
