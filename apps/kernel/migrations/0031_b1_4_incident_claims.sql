-- 0031 · G13-B1.4: the unclaimed automation-incident queue.
--
-- The Event handler creates automation incidents with owner = the non-login
-- automation service user (0028). An operator's row rule is OwnedRows
-- (owner = caller), so without a queue an operator in the incident's own
-- workspace can never list, read, investigate, append evidence to or conclude an
-- automation incident. Widening OwnedRows would give every operator every
-- workspace row, which is exactly the grant the D5 scope model forbids.
--
-- The queue is a STATE, not a second table: origin='AUTOMATION' AND
-- owner=service-user AND status IN ('OPEN','INVESTIGATING'). A claim moves the
-- owner to the operator under a revision compare-and-set; a release moves it
-- back. Because there is no second table, a queue row cannot disagree with the
-- incident row it describes.
--
-- This migration only adds the partial index the queue read uses. It changes no
-- existing row and no existing constraint.
--
-- Rollback: DROP INDEX kernel.incidents_unclaimed_automation_idx;

CREATE INDEX IF NOT EXISTS incidents_unclaimed_automation_idx
    ON kernel.incidents (workspace_id, started_at DESC, incident_id DESC)
    WHERE owner = '00000000-0000-4000-8000-0000000000a1'::uuid
      AND origin = 'AUTOMATION'
      AND status IN ('OPEN', 'INVESTIGATING');
