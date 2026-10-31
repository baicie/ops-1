-- 0023 · The closed vocabulary for an invocation's authorization gate (G12 H, P2).
--
-- Why this migration exists. 0020 required an OK invocation to record
-- authorization_predicate, so "the investigator read something" always answered "under
-- which authority" - and then wrote NULL for every refusal, so the one row an auditor
-- actually wants ("this run asked for something it could not have") answered nothing.
-- The column is now filled for refusals too, which raises a new risk: a caller could put
-- an arbitrary sentence there and the panel would render it as an authorization decision.
--
-- So the vocabulary is closed in the database. The values are the places in
-- apps/kernel/src/investigations.rs that actually decide a call:
--
--   INCIDENT_READ_PREDICATE           the share read predicate (role rule + workspace
--                                     boundary + row rule, one predicate by design) passed,
--                                     or refused
--   EVIDENCE_CONTENT_FIXITY_CHECK     the content read: fixity, retention, UTF-8
--   RUN_INCIDENT_SCOPE_PREDICATE      the run's own incident; a foreign incidentId stops here
--   PRE_PREDICATE_TOOL_ALLOWLIST      refused before any predicate: not one of the five
--   PRE_PREDICATE_ARGUMENT            refused before any predicate: unreadable arguments
--   PRE_PREDICATE_SCOPE_IDENTITY      refused before any predicate: the account is not
--                                     resolvable, so nothing can be authorized for it
--   DEPLOYMENT_SOURCE_CONFIGURATION   decided by configuration, not by the caller
--   UNREACHED_TOOL_INTERRUPTED        cut off inside the tool; no layer answered
--
-- Non-destructive: a CHECK that admits every value already stored (the two predicates) and
-- every NULL written before this migration. Nothing is backfilled, because inventing a
-- gate for a historical refusal would be inventing the fact this column exists to state.
-- Rollback: ALTER TABLE ... DROP CONSTRAINT investigation_invocation_predicate_vocabulary_check;
-- the column, its type and its NULLs are untouched, so dropping it widens nothing and
-- loses nothing.

ALTER TABLE kernel.investigation_tool_invocations
    ADD CONSTRAINT investigation_invocation_predicate_vocabulary_check
    CHECK (authorization_predicate IS NULL OR authorization_predicate IN (
        'INCIDENT_READ_PREDICATE',
        'EVIDENCE_CONTENT_FIXITY_CHECK',
        'RUN_INCIDENT_SCOPE_PREDICATE',
        'PRE_PREDICATE_TOOL_ALLOWLIST',
        'PRE_PREDICATE_ARGUMENT',
        'PRE_PREDICATE_SCOPE_IDENTITY',
        'DEPLOYMENT_SOURCE_CONFIGURATION',
        'UNREACHED_TOOL_INTERRUPTED'
    ));
