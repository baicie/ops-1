-- 0028 · The service identity and the recurrence rule for automation incidents.
--
-- 1. `opsweave-automation` is a NON-LOGIN user row. Incidents need an owner
--    (0016 owner uuid NOT NULL REFERENCES kernel.users), and using a real
--    operator would attribute automated work to a person. The password hash is
--    an inert value; no route can authenticate this account, and its role is
--    viewer so even a hypothetical session could not operate.
--
-- 2. The workspace+source+native unique index from 0026 covered every row, so a
--    new PROBLEM after a CLOSED incident could never create a recurrence. The
--    index now guards only the states that must have at most one row
--    (OPEN/INVESTIGATING/CONCLUDED). A CLOSED incident is history; a recurrence
--    is a new row with recurrence_of pointing at it. Concurrent writers during
--    the active states still lose to the unique index.
--
-- Rollback:
--   DROP INDEX kernel.incidents_workspace_source_native_idx;
--   CREATE UNIQUE INDEX incidents_workspace_source_native_idx
--     ON kernel.incidents (workspace_id, source_id, native_id)
--     WHERE source_id IS NOT NULL AND native_id IS NOT NULL;
--   DELETE FROM kernel.users WHERE id='00000000-0000-4000-8000-0000000000a1';

INSERT INTO kernel.users (id, email, display_name, password_hash, role)
VALUES (
    '00000000-0000-4000-8000-0000000000a1',
    'automation@opsweave.invalid',
    'OpsWeave Automation',
    '!',
    'viewer'
)
ON CONFLICT DO NOTHING;

DROP INDEX IF EXISTS kernel.incidents_workspace_source_native_idx;
CREATE UNIQUE INDEX IF NOT EXISTS incidents_workspace_source_native_idx
    ON kernel.incidents (workspace_id, source_id, native_id)
    WHERE source_id IS NOT NULL
      AND native_id IS NOT NULL
      AND status IN ('OPEN','INVESTIGATING','CONCLUDED');
