-- 0027 · Each automation operation is consumed once.
--
-- A valid `owa1` signature is not a licence to repeat a state change. The
-- principal row bounds the workspace/source/instance/budget, and this table
-- bounds replay: `(principal_id, operation)` is unique, so the second ingest or
-- evidence append for the same principal is refused with AUTOMATION_REPLAY even
-- if the token was captured and is still unexpired.
--
-- Different operations may share one principal (for example EVENT_INGEST then
-- SOURCE_COLLECT), because each is consumed under its own key. Cleanup cascades
-- with the principal row; revocation does not erase the use record.
--
-- Rollback: DROP TABLE kernel.automation_principal_uses;

CREATE TABLE IF NOT EXISTS kernel.automation_principal_uses (
    principal_id uuid NOT NULL
        REFERENCES kernel.automation_principals(principal_id) ON DELETE CASCADE,
    operation text NOT NULL CHECK (operation IN ('EVENT_INGEST','SOURCE_COLLECT','EVIDENCE_APPEND')),
    used_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (principal_id, operation)
);
