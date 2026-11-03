-- 0025 · The human verdict is write-once at the table, as 0016 said it was.
--
-- Why this migration exists. 0019's comment states "the verdict is write-once (0016), so the row
-- checked here is the signature" and 0024 leans on the same sentence when it refuses a closure
-- that nobody signed. Measured on a real database with 0024 applied, both halves of that sentence
-- were false:
--
--   UPDATE kernel.incident_verdicts SET verdict='INCONCLUSIVE' WHERE ...   -> UPDATE 1
--   DELETE FROM kernel.incident_verdicts WHERE ...                          -> DELETE 1
--
-- 0016 declared the rule in a comment and gave the table a primary key; nothing enforced it. The
-- API is careful - `record_verdict` refuses a second verdict with INCIDENT_ALREADY_CONCLUDED - but
-- "no route does that" is the argument 0019 rejected for its own rules, and it is rejected here
-- for the same reason: a migration, a psql session or a future bug must meet the same wall as the
-- endpoint. A closure that can have its signature swapped after the fact is a closure whose
-- authority is a claim rather than a record.
--
-- What this refuses:
--   * UPDATE of any column on a verdict row. A verdict has no editable field: who decided, what
--     they decided, why, and when.
--   * DELETE of a verdict row, EXCEPT in the one context that exists to prove the surrounding
--     rules still hold - see the escape hatch below.
--
-- The escape hatch, and why it is not a hole. Several tests must act as "a table owner did this"
-- to prove what happens when the signature disappears (for example: delete the verdict, then show
-- the incident still cannot leave CLOSED). Those tests set
--     SET LOCAL kernel.allow_verdict_removal = 'on'
-- inside their transaction. The setting is transaction-local, it is not read anywhere in
-- production code, and no HTTP route can set it - a client cannot reach it, and an operator
-- cannot either. It is a statement a developer makes about a throwaway database, written in the
-- test that needs it, in the same way `DROP TRIGGER` was the old way of proving a guard works.
--
-- Compatibility: the API never updates or deletes a verdict row. `record_verdict` INSERTs once per
-- incident (the primary key refuses the second), and the delete paths are test cleanup. Both test
-- sites were updated to state their intent explicitly rather than relying on the absence of a
-- guard; a real deployment sees no behaviour change on any route.
--
-- Rollback, spelled out and NOT free (it re-opens both holes):
--   DROP TRIGGER incident_verdicts_write_once ON kernel.incident_verdicts;
--   DROP FUNCTION kernel.incident_verdict_write_once();

CREATE FUNCTION kernel.incident_verdict_write_once()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    migrating text := coalesce(current_setting('kernel.allow_verdict_backfill', true), '');
BEGIN
    -- A forward migration may reshape rows it is backfilling; a running system may not.
    -- This flag is set by MIGRATION SQL only (SET LOCAL inside the migration's transaction)
    -- and never by the kernel. It is checked first because a migration that is rewriting a
    -- verdict is doing so as one declared act, not as an edit to a live record.
    IF migrating = 'on' THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION
            'incident % already has a human verdict, and a verdict cannot be revised',
            OLD.incident_id
            USING ERRCODE = 'restrict_violation',
                  HINT = 'A second conclusion is a new review, never an in-place overwrite (ADR-G11-001 section 2).';
    END IF;

    -- TG_OP = 'DELETE'
    IF coalesce(current_setting('kernel.allow_verdict_removal', true), '') = 'on' THEN
        -- Transaction-local, set only by a test that is demonstrating the consequence of a
        -- vanished signature. Nothing in the kernel sets it.
        RETURN OLD;
    END IF;
    RAISE EXCEPTION
        'the human verdict on incident % cannot be deleted: a closure stands on it',
        OLD.incident_id
        USING ERRCODE = 'restrict_violation',
              HINT = 'Deleting a signature does not reopen an incident and does not unmake the closure (ADR-G12-003).';
END;
$$;

CREATE TRIGGER incident_verdicts_write_once
    BEFORE UPDATE OR DELETE ON kernel.incident_verdicts
    FOR EACH ROW
    EXECUTE FUNCTION kernel.incident_verdict_write_once();
