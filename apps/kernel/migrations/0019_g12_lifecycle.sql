-- G12 Phase C: the incident's recorded lifecycle gets the two operations it was
-- missing - a controlled CONCLUDED -> CLOSED, and an ownership handover - plus the
-- version column both of them arbitrate on.
--
-- Defect this closes: since 0016 the CHECK constraint lists CLOSED and no business
-- path produces it. Three defects followed from that:
--
--   * an incident could never end. A concluded record stayed CONCLUDED forever, so
--     "this is over" and "this is still being reviewed" were the same status;
--   * because nothing closed an incident, nothing had ever needed to decide WHO may
--     close it or what a closure must stand on;
--   * ownership was set once at creation (0016 comment: "Accountability, not
--     authorship"), with no way to hand a live incident to the person actually on
--     call. The owner column is also the operator read scope, so a departed
--     owner's incident was readable by admins and nobody else.
--
-- Additive and non-destructive: six columns added to kernel.incidents, two CHECK
-- constraints, one trigger function and one trigger. No row is deleted, no id
-- changes, no evidence or verdict row is touched, and 0018 (and everything before
-- it) is untouched because sqlx checksums it. The two backfills below write a value
-- into a column this migration itself adds, and both are described where they run.
--
-- Rollback: sqlx migrations are forward-only. The reverse DDL is
--    DROP TRIGGER incidents_closure_guard ON kernel.incidents;
--    DROP FUNCTION kernel.incident_closure_guard();
--    ALTER TABLE kernel.incidents
--        DROP CONSTRAINT incidents_closure_consistency_check,
--        DROP CONSTRAINT incidents_closure_note_check,
--        DROP COLUMN revision, DROP COLUMN owner_assigned_at,
--        DROP COLUMN closed_at, DROP COLUMN closed_by,
--        DROP COLUMN closure_note, DROP COLUMN closure_key;
-- and it is NOT free: every closure (who closed it, when, why) and every handover
-- timestamp is destroyed by it, while the status column keeps saying CLOSED - i.e.
-- the row would claim a closure whose authority no longer exists. It may only run
-- as an accepted loss of that record, never implicitly and never inside a release.

-- ---------------------------------------------------------------------------
-- 1. The revision both new operations CAS on.
--
-- One monotonic counter per incident, incremented by every write that changes what
-- a reader would have to re-read: a status transition, a closure, a handover. It is
-- the arbitration token for two operators concluding/closeing/handing over at the
-- same instant, and it is deliberately not a content hash: an evidence append
-- already has its own idempotency key (the unique (incident,kind,source,content_ref)
-- tuple from 0016), so the revision only has to detect "the record you looked at is
-- not the record you are writing to".
-- ---------------------------------------------------------------------------
ALTER TABLE kernel.incidents
    ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1);

-- ---------------------------------------------------------------------------
-- 2. When the current owner got the incident.
--
-- 0016 recorded who owns a row and never when the assignment happened, which made
-- "this has been unowned-triage for six hours" unanswerable. For a row created
-- before this migration the only instant the Kernel knows is its creation, so that
-- is what the backfill stores - it is not filled with now(), which would claim
-- every historical incident was handed over during the migration.
-- ---------------------------------------------------------------------------
ALTER TABLE kernel.incidents ADD COLUMN owner_assigned_at timestamptz;
UPDATE kernel.incidents SET owner_assigned_at = created_at WHERE owner_assigned_at IS NULL;
ALTER TABLE kernel.incidents
    ALTER COLUMN owner_assigned_at SET NOT NULL,
    ALTER COLUMN owner_assigned_at SET DEFAULT now();

-- ---------------------------------------------------------------------------
-- 3. The closure record.
--
-- closed_at/closed_by are the fact 0016 could not express: a CLOSED row that does
-- not say who closed it or when is a status, not an ending. closure_note is the
-- operator's sentence; closure_key is the client's idempotency key, so a retried
-- close is answered with the closure that already happened instead of being mistaken
-- for a second closure (or for someone else's).
-- ---------------------------------------------------------------------------
ALTER TABLE kernel.incidents
    ADD COLUMN closed_at timestamptz,
    -- RESTRICT: a closure names a real account, and that account cannot be deleted
    -- while a closure of record points at it.
    ADD COLUMN closed_by uuid REFERENCES kernel.users(id),
    ADD COLUMN closure_note text,
    ADD COLUMN closure_key text;

-- 3a. Rows that are already CLOSED.
--
-- How these can exist: 0016 allowed the value and no endpoint produced it, so every
-- CLOSED row in a pre-0019 database was written by hand (a data fix, a test, an
-- operator with psql). The closure they describe is real - the row says so - but
-- its authority was never recorded. The backfill names the only facts it has
-- (updated_at, and the owner as the accountable party), writes a note saying exactly
-- what happened, and does NOT invent an operator or a reason. Without this step the
-- consistency constraint in 3b could not be added to a non-empty database.
UPDATE kernel.incidents
SET closed_at = updated_at,
    closed_by = owner,
    closure_note = 'MIGRATION_0019_BACKFILL: this row was already CLOSED before migration 0019, when no endpoint could produce that status. The closure time here is the row''s last update and the closer is its owner at that moment; no closure reason was ever recorded, so none is claimed.',
    closure_key = NULL
WHERE status = 'CLOSED' AND closed_at IS NULL;

-- 3b. The closure columns and the status cannot disagree.
--
-- Four separate claims, each a way to lie about an ending:
--   * CLOSED without closed_at is an ending with no time;
--   * closed_at without CLOSED is a closure of something still open;
--   * closed_by without closed_at names a closer of nothing;
--   * a closure_key without a closure is a retry key for a closure that never
--     happened, which would let a later close be answered as a replay of it.
ALTER TABLE kernel.incidents
    ADD CONSTRAINT incidents_closure_consistency_check CHECK (
        ((status = 'CLOSED') = (closed_at IS NOT NULL))
        AND ((closed_at IS NULL) = (closed_by IS NULL))
        AND (closure_key IS NULL OR closed_at IS NOT NULL)
    ),
    ADD CONSTRAINT incidents_closure_note_check CHECK (
        closure_note IS NULL
        OR length(btrim(closure_note)) BETWEEN 4 AND 1000
    );

-- ---------------------------------------------------------------------------
-- 4. The two lifecycle rules that cannot be expressed as a CHECK constraint,
--    because both need to read another table or the previous row version.
--
-- Enforced in the database and not only in the handlers for the same reason 0017
-- and 0018 enforce their rules here: "no route does that" is a statement about
-- today's code, this trigger is a statement about the data. A hand-written UPDATE
-- from psql, a future bug or a migration must hit the same wall as the endpoint.
--
--   4a. A closure stands on a Human Verdict. Nothing in this system may declare an
--       incident finished-without-review, and the verdict is write-once (0016), so
--       the row checked here is the signature, not a summary of one.
--   4b. There is no shortcut into CLOSED. The only predecessor state of CLOSED is
--       CONCLUDED, so OPEN -> CLOSED (and INVESTIGATING -> CLOSED) is refused by
--       the schema and not only by the SQL that the handler happens to run.
--   4c. A closure is final. Once status is CLOSED it cannot leave CLOSED, which is
--       what makes "reopening" impossible by deleting or resetting anything: a
--       verdict cannot be re-signed (0016 write-once, no delete route) and the
--       status cannot move even if one were removed by hand.
--
-- It is deliberately possible for a table owner to drop this trigger
-- (DROP TRIGGER / ALTER TABLE ... DISABLE TRIGGER), because an acceptance test has
-- to demonstrate that a reopened incident is REFUSED - and dropping a guard is a
-- much louder action than a forgotten WHERE clause.
-- ---------------------------------------------------------------------------
CREATE FUNCTION kernel.incident_closure_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- 4c: no way back out of CLOSED.
    IF OLD.status = 'CLOSED' AND NEW.status <> 'CLOSED' THEN
        RAISE EXCEPTION
            'incident % is CLOSED and cannot return to %: a closure is final',
            NEW.incident_id, NEW.status
            USING ERRCODE = 'restrict_violation',
                  HINT = 'A closed incident is never reopened. Record a new incident instead (ADR-G12-003).';
    END IF;

    IF NEW.status = 'CLOSED' THEN
        -- 4b: the only predecessor state.
        IF OLD.status <> 'CONCLUDED' THEN
            RAISE EXCEPTION
                'incident % cannot be closed from status %: CLOSED is reachable only from CONCLUDED',
                NEW.incident_id, OLD.status
                USING ERRCODE = 'restrict_violation',
                      HINT = 'Record the human verdict first; that is what moves an incident to CONCLUDED.';
        END IF;
        -- 4a: a closure stands on a signed verdict.
        IF NOT EXISTS (
            SELECT 1 FROM kernel.incident_verdicts v WHERE v.incident_id = NEW.incident_id
        ) THEN
            RAISE EXCEPTION
                'incident % has no human verdict, so it cannot be closed',
                NEW.incident_id
                USING ERRCODE = 'restrict_violation',
                      HINT = 'A closure without a signed verdict would be a conclusion the system invented (ADR-G12-003 §2).';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER incidents_closure_guard
    BEFORE UPDATE OF status ON kernel.incidents
    FOR EACH ROW
    EXECUTE FUNCTION kernel.incident_closure_guard();
