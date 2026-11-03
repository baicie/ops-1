-- 0024 · A CLOSED incident is closed on INSERT too, and its closure is write-once.
--
-- Why this migration exists. 0019 installed `incidents_closure_guard` with
--     CREATE TRIGGER incidents_closure_guard BEFORE UPDATE OF status ON kernel.incidents
-- and a CHECK that the closure columns agree with the status. Both were measured against
-- a real database and both have a hole:
--
--   1. INSERT is not guarded at all. `INSERT INTO kernel.incidents (... status ..., closed_at,
--      closed_by, closure_note) VALUES (..., 'CLOSED', ...)` succeeds with no Human Verdict,
--      no CONCLUDED predecessor and no audit row. The row then claims a closure whose
--      authority no trigger ever asked for. Measured: `INSERT 0 1`.
--
--   2. `BEFORE UPDATE OF status` only fires when the status column is in the SET list. After
--      a legitimate close, `UPDATE ... SET closure_note = 'a different reason entirely',
--      closed_at = '2020-01-01'` and `SET closure_key = 'forged-replay-key'` both succeed,
--      so the sentence a reader trusts ("why this was closed, and when") can be rewritten
--      after the fact by anyone with UPDATE. Measured: `UPDATE 1` twice.
--
-- Neither is reachable through the HTTP API - `close_incident` is the only writer of these
-- columns, it checks the verdict in the same transaction, and it is revision-guarded. That is
-- exactly the argument 0019 rejected for its own rules: "no route does that" is a statement
-- about today's code, a trigger is a statement about the data. A migration, a psql session or
-- a future bug must hit the same wall.
--
-- What this migration changes, and what it deliberately does not:
--
--   * The guard becomes BEFORE INSERT OR UPDATE (not `OF status`), so an INSERT that claims
--     CLOSED is asked the same three questions a transition is: is there a verdict, was the
--     predecessor CONCLUDED (no predecessor exists on INSERT, so an inserted CLOSED row is
--     refused outright), and once CLOSED, are the closure columns unchanged.
--   * A closure becomes write-once: on an UPDATE where OLD.status is already CLOSED, every
--     closure column must equal its old value. A no-op UPDATE stays legal - the handler
--     touches `updated_at` on some paths, and refusing that would be a rule about nothing.
--   * It does NOT retro-fit history. A row already CLOSED without a verdict is a fact 0019
--     chose to keep (see its 3a backfill, which recorded what it knew and invented no
--     operator); this migration neither deletes those rows nor invents verdicts for them. It
--     refuses the NEXT one.
--   * It does NOT touch 0019. That migration is applied and its file is a historical record;
--     editing it would make every existing database disagree with the source without any
--     evidence that it had been re-run.
--
-- Compatibility. A forward-only migration that only ADDS a trigger cannot be silently
-- bypassed by an application that writes correctly: the API path inserts OPEN, transitions to
-- CONCLUDED on the verdict, then closes once. It was verified against the real close endpoint
-- (tests/acceptance/g12_lifecycle.sh) after this migration ran.
--
-- Rollback, spelled out and NOT free: it re-opens the two holes above.
--   DROP TRIGGER incidents_closure_guard ON kernel.incidents;
--   (and then re-create 0019's BEFORE UPDATE OF status trigger if that narrower rule is
--    wanted back: the function itself is unchanged, so no function restore is needed)

-- ---------------------------------------------------------------------------
-- 1. The guard, extended. The function keeps its name and its messages, so an
--    operator reading a refusal sees the same sentences 0019 wrote.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kernel.incident_closure_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- 0024: a row may not be BORN closed. There is no previous status, so there is no
    -- CONCLUDED predecessor and - by the rule below - no way to have signed a verdict
    -- against a primary key that did not exist yet. Refusing here is the honest answer
    -- rather than running the verdict check against an id whose verdict could be added
    -- a millisecond later.
    IF TG_OP = 'INSERT' THEN
        IF NEW.status = 'CLOSED' THEN
            RAISE EXCEPTION
                'incident % cannot be inserted already CLOSED: a closure follows a signed human verdict on an existing record',
                NEW.incident_id
                USING ERRCODE = 'restrict_violation',
                      HINT = 'Insert the incident OPEN, record the verdict, then close it (ADR-G12-003).';
        END IF;
        RETURN NEW;
    END IF;

    -- 4c: no way back out of CLOSED (0019).
    IF OLD.status = 'CLOSED' AND NEW.status <> 'CLOSED' THEN
        RAISE EXCEPTION
            'incident % is CLOSED and cannot return to %: a closure is final',
            NEW.incident_id, NEW.status
            USING ERRCODE = 'restrict_violation',
                  HINT = 'A closed incident is never reopened. Record a new incident instead (ADR-G12-003).';
    END IF;

    -- 0024: once CLOSED, the closure record itself is write-once. The status-not-moving check
    -- above says the ending is final; this says the account of it is. A no-op is allowed on
    -- purpose (the handler bumps updated_at on unrelated paths, and refusing an identical
    -- write would be a rule about punctuation).
    IF OLD.status = 'CLOSED' THEN
        IF NEW.closed_at IS DISTINCT FROM OLD.closed_at
            OR NEW.closed_by IS DISTINCT FROM OLD.closed_by
            OR NEW.closure_note IS DISTINCT FROM OLD.closure_note
            OR NEW.closure_key IS DISTINCT FROM OLD.closure_key
        THEN
            RAISE EXCEPTION
                'incident % is CLOSED and its closure (when, by whom, why, idempotency key) cannot be rewritten',
                NEW.incident_id
                USING ERRCODE = 'restrict_violation',
                      HINT = 'A closure is signed once. A corrected account is a new incident, not an edit to the old one.';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.status = 'CLOSED' THEN
        -- 4b: the only predecessor state (0019).
        IF OLD.status <> 'CONCLUDED' THEN
            RAISE EXCEPTION
                'incident % cannot be closed from status %: CLOSED is reachable only from CONCLUDED',
                NEW.incident_id, OLD.status
                USING ERRCODE = 'restrict_violation',
                      HINT = 'Record the human verdict first; that is what moves an incident to CONCLUDED.';
        END IF;
        -- 4a: a closure stands on a signed verdict (0019).
        IF NOT EXISTS (
            SELECT 1 FROM kernel.incident_verdicts v WHERE v.incident_id = NEW.incident_id
        ) THEN
            RAISE EXCEPTION
                'incident % has no human verdict, so it cannot be closed',
                NEW.incident_id
                USING ERRCODE = 'restrict_violation',
                      HINT = 'A closure without a signed verdict would be a conclusion the system invented (ADR-G12-003 §2).';
        END IF;
        -- 0024: and the closure columns must be filled as the CHECK already requires, so the
        -- refusal names the missing fact instead of a generic constraint name.
        IF NEW.closed_at IS NULL OR NEW.closed_by IS NULL THEN
            RAISE EXCEPTION
                'incident % cannot be closed without recording when and by whom',
                NEW.incident_id
                USING ERRCODE = 'restrict_violation',
                      HINT = 'The CHECK constraint would refuse this row anyway; this message says which fact is missing.';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Replace 0019's narrower trigger with the two events the rule actually
--    covers. `OF status` is gone on purpose: the closure columns must be
--    checked on writes that do not mention the status.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS incidents_closure_guard ON kernel.incidents;

CREATE TRIGGER incidents_closure_guard
    BEFORE INSERT OR UPDATE ON kernel.incidents
    FOR EACH ROW
    EXECUTE FUNCTION kernel.incident_closure_guard();
