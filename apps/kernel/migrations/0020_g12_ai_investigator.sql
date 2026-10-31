-- G12 Phase E: a bounded, read-only AI investigator for an incident.
--
-- What this phase adds: an Investigation Run that may READ an incident through five
-- named tools, records every tool invocation, records its hypotheses as hypotheses,
-- and stops at a budget. It adds no write path into the incident record itself.
--
-- The three separations this schema enforces, because a comment would not be enough:
--
--   1. AI HYPOTHESIS IS NOT A HUMAN VERDICT. A hypothesis lives in
--      kernel.investigation_hypotheses with a stance vocabulary
--      (SUPPORTED | CONTRADICTED | UNCERTAIN | CONFLICTED) that is DISJOINT from
--      kernel.incident_verdicts.verdict (CONFIRMED | REFUTED | INCONCLUSIVE). There is
--      no foreign key, no trigger and no sequence between the two tables, so no value
--      of one can become the other. A human review of an investigation is likewise its
--      own table with its own vocabulary (ACCEPTED | REJECTED) and it writes nothing
--      into incident_verdicts - reviewing the investigator is not concluding the
--      incident (ADR-G12-004 §2).
--
--   2. A CITATION MUST BE REAL. investigation_hypothesis_evidence.evidence_id is a
--      foreign key onto kernel.incident_evidence (RESTRICT), and a trigger refuses a
--      citation whose evidence row belongs to a different incident than the run. So "the
--      model cited evidence that does not exist" is not a validation rule the handler
--      could forget: it is a row the database will not store.
--
--   3. A SYNTHETIC RUN CANNOT DRESS AS A MODEL. adapter_kind is a snapshot of the
--      provider row's kind, and a trigger refuses any disagreement between the two, so a
--      run started on the test fixture cannot be relabelled after the fact. The
--      test adapter exists to prove the protocol, and every surface that shows a run also
--      shows which kind produced it.
--
-- Additive and non-destructive: seven CREATE TABLE, two trigger functions and two
-- triggers, one seeded provider row and one seeded source row. No existing table is
-- altered, no row is deleted or rewritten, and migrations 0001-0019 are untouched
-- because sqlx checksums them.
--
-- Rollback: sqlx migrations are forward-only. The reverse DDL is
--    DROP TRIGGER investigation_run_adapter_guard ON kernel.investigation_runs;
--    DROP TRIGGER investigation_citation_guard ON kernel.investigation_hypothesis_evidence;
--    DROP FUNCTION kernel.investigation_run_adapter_guard();
--    DROP FUNCTION kernel.investigation_citation_guard();
--    DROP TABLE kernel.investigation_hypothesis_evidence;
--    DROP TABLE kernel.investigation_hypotheses;
--    DROP TABLE kernel.investigation_tool_invocations;
--    DROP TABLE kernel.investigation_human_reviews;
--    DROP TABLE kernel.investigation_related_sources;
--    DROP TABLE kernel.investigation_runs;
--    DROP TABLE kernel.investigation_model_providers;
-- and it is NOT free: every investigation run, every tool it invoked, every hypothesis
-- it reached and every human review of it is destroyed. It never runs implicitly and
-- never inside a release.

-- ---------------------------------------------------------------------------
-- 1. Who may answer, and what it is.
--
-- A provider row is an identity, not a credential: credential_env_var names the
-- environment variable the kernel reads the secret from, so a row that leaks states
-- where a secret would have been and never what it is. A TEST_FIXTURE row is
-- structurally forbidden from carrying an endpoint or a credential variable, so a
-- fixture cannot be pointed at a real service.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kernel.investigation_model_providers (
    provider_id text PRIMARY KEY
        CHECK (provider_id ~ '^[a-z0-9][a-z0-9_.-]{2,63}$'),
    kind text NOT NULL CHECK (kind IN ('TEST_FIXTURE','HTTP_OPENAI_COMPATIBLE')),
    display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 3 AND 120),
    -- An environment VARIABLE NAME. The value never enters this database.
    credential_env_var text
        CHECK (credential_env_var IS NULL OR credential_env_var ~ '^[A-Z][A-Z0-9_]{2,63}$'),
    base_url text
        CHECK (base_url IS NULL OR base_url ~ '^https?://[^\s]+$'),
    model_id text
        CHECK (model_id IS NULL OR length(btrim(model_id)) BETWEEN 1 AND 120),
    enabled boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- A provider either needs nothing (the fixture) or needs all three (a real one).
    -- A half-configured provider is not a provider, it is a future outage.
    CONSTRAINT investigation_provider_completeness_check CHECK (
        (kind = 'TEST_FIXTURE'
            AND credential_env_var IS NULL AND base_url IS NULL AND model_id IS NULL)
        OR (kind = 'HTTP_OPENAI_COMPATIBLE'
            AND credential_env_var IS NOT NULL AND base_url IS NOT NULL AND model_id IS NOT NULL)
    ),
    -- The fixture is always startable and never needs enabling: it is the protocol
    -- proof, and hiding it behind a flag would only make the contract tests lie.
    CONSTRAINT investigation_fixture_always_enabled_check CHECK (
        kind = 'HTTP_OPENAI_COMPATIBLE' OR enabled
    )
);

INSERT INTO kernel.investigation_model_providers
    (provider_id, kind, display_name, enabled)
VALUES
    ('test-fixture-v1', 'TEST_FIXTURE',
     'Deterministic test fixture (not a model)', true)
ON CONFLICT (provider_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The run: its budget, fixed before it starts, and its consumption.
--
-- Every limit is a column and not a constant so the bound a run was actually held to
-- is readable afterwards, together with what it used. A limit that only existed in
-- the code would be unprovable the moment the code changed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kernel.investigation_runs (
    run_id uuid PRIMARY KEY,
    incident_id uuid NOT NULL
        REFERENCES kernel.incidents(incident_id) ON DELETE CASCADE,
    -- The client's own key for this investigation. With it, a retried start answers
    -- with the run that already exists instead of spending a second budget.
    idempotency_key text NOT NULL
        CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 200),
    -- A run is INSERTed already RUNNING: it executes inside the request that starts
    -- it, so a PENDING value would describe a queue this system does not have. An
    -- abandoned row stays RUNNING and is detectable by deadline_at having passed
    -- (the read side derives `stale`), which is a fact rather than a guess.
    status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN (
        'RUNNING','SUCCEEDED','PARTIAL','FAILED','CANCELLED',
        'EXPIRED','BUDGET_EXHAUSTED'
    )),
    provider_id text NOT NULL
        REFERENCES kernel.investigation_model_providers(provider_id) ON DELETE RESTRICT,
    -- Snapshot of the provider's kind, guarded below by a trigger.
    adapter_kind text NOT NULL CHECK (adapter_kind IN ('TEST_FIXTURE','HTTP_OPENAI_COMPATIBLE')),
    -- Whose authority the five read tools ran under. This is NOT the model and NOT
    -- the requester's token: it is the operator account, resolved at the run's scope,
    -- and every tool invocation re-reads that account's role before it reads anything.
    scope_user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE RESTRICT,
    requested_by uuid NOT NULL REFERENCES kernel.users(id) ON DELETE RESTRICT,

    -- ---- budget, fixed at start -------------------------------------------
    max_steps bigint NOT NULL CHECK (max_steps BETWEEN 1 AND 200),
    max_tool_calls bigint NOT NULL CHECK (max_tool_calls BETWEEN 1 AND 500),
    tool_timeout_ms bigint NOT NULL CHECK (tool_timeout_ms BETWEEN 100 AND 60000),
    -- Per tool call, not per run: a run retries a timed-out call at most this many
    -- times, so the run-wide ceiling is max_retries * max_tool_calls (checked below).
    max_retries bigint NOT NULL CHECK (max_retries BETWEEN 0 AND 5),
    token_budget bigint NOT NULL CHECK (token_budget BETWEEN 1 AND 4000000),
    deadline_at timestamptz NOT NULL,

    -- ---- consumption ------------------------------------------------------
    steps_used bigint NOT NULL DEFAULT 0 CHECK (steps_used >= 0),
    tool_calls_used bigint NOT NULL DEFAULT 0 CHECK (tool_calls_used >= 0),
    retries_used bigint NOT NULL DEFAULT 0 CHECK (retries_used >= 0),
    prompt_tokens bigint NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
    completion_tokens bigint NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
    tokens_used bigint NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
    -- Cost in millionths of the account currency, and the basis it was derived from.
    -- The fixture reports 0 with basis TEST_FIXTURE_NO_COST, because a fixture that
    -- claimed a price would be inventing money.
    cost_micros bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
    -- NO_COST: nothing was billed and nothing is claimed.
    -- TEST_FIXTURE_NO_COST: the fixture runs on the kernel's own CPU; a fixture that
    --   reported a price would be inventing money.
    -- CONFIGURED_PRICE: tokens times the price the deployment declared, which is the
    --   only way this kernel can state a cost without making one up.
    cost_basis text NOT NULL DEFAULT 'NO_COST'
        CHECK (cost_basis IN (
            'NO_COST','TEST_FIXTURE_NO_COST','CONFIGURED_PRICE','PROVIDER_REPORTED'
        )),
    hypotheses_used bigint NOT NULL DEFAULT 0 CHECK (hypotheses_used >= 0),

    -- ---- how it ended -----------------------------------------------------
    stop_reason text CHECK (stop_reason IS NULL OR stop_reason IN (
        'FINAL_ANSWER','STEP_BUDGET','TOOL_CALL_BUDGET','TOKEN_BUDGET',
        'DEADLINE','CANCELLED','PROVIDER_ERROR','INTERNAL_ERROR','REFUSED'
    )),
    -- The sentence a reader gets when the run did not simply answer. Bounded, and
    -- required for every non-success so a PARTIAL run cannot be silently partial.
    detail text CHECK (detail IS NULL OR length(btrim(detail)) BETWEEN 4 AND 2000),

    cancel_requested_at timestamptz,
    cancel_requested_by uuid REFERENCES kernel.users(id) ON DELETE RESTRICT,

    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,

    UNIQUE (incident_id, idempotency_key),

    -- No budget column can be overrun even by a hand-written UPDATE: the consumption
    -- cannot exceed the ceiling it was started under.
    CONSTRAINT investigation_step_budget_check CHECK (steps_used <= max_steps),
    CONSTRAINT investigation_call_budget_check CHECK (tool_calls_used <= max_tool_calls),
    CONSTRAINT investigation_retry_budget_check CHECK (
        retries_used <= max_retries * max_tool_calls
    ),
    -- No CHECK on token_budget, on purpose. Steps and tool calls are refused BEFORE
    -- the operation that would exceed them, so their ceilings are exact and enforced
    -- here. A token budget cannot be: a turn's usage is only known once the provider
    -- has answered, and it cannot be un-spent. The run therefore stops at the first
    -- turn boundary past the budget, and tokens_used is a measurement that may exceed
    -- token_budget by at most one turn. Writing a CHECK that pretended otherwise
    -- would force the kernel to clamp a measured number, which is a lie about cost.
    CONSTRAINT investigation_token_breakdown_check CHECK (
        tokens_used = prompt_tokens + completion_tokens
    ),
    -- A terminal status has an end and a reason; a live one has neither. This is what
    -- makes "the run stopped" and "the run is still going" distinguishable at rest.
    CONSTRAINT investigation_terminal_state_check CHECK (
        (status <> 'RUNNING') = (finished_at IS NOT NULL)
        AND (finished_at IS NULL OR finished_at >= started_at)
    ),
    CONSTRAINT investigation_stop_reason_check CHECK (
        (status <> 'RUNNING') = (stop_reason IS NOT NULL)
    ),
    CONSTRAINT investigation_partial_detail_check CHECK (
        status <> 'PARTIAL' OR detail IS NOT NULL
    ),
    CONSTRAINT investigation_cancel_pair_check CHECK (
        (cancel_requested_at IS NULL) = (cancel_requested_by IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS investigation_runs_incident_idx
    ON kernel.investigation_runs (incident_id, started_at DESC, run_id DESC);

-- The adapter kind cannot drift from the provider it names.
CREATE FUNCTION kernel.investigation_run_adapter_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    declared text;
BEGIN
    SELECT kind INTO declared
      FROM kernel.investigation_model_providers
     WHERE provider_id = NEW.provider_id;
    IF declared IS NULL OR declared <> NEW.adapter_kind THEN
        RAISE EXCEPTION
            'investigation run names provider % as %, which is not what that provider is',
            NEW.provider_id, NEW.adapter_kind
            USING ERRCODE = 'restrict_violation',
                  HINT = 'A run cannot claim to be answered by something other than the provider it names (ADR-G12-004 §7).';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER investigation_run_adapter_guard
    BEFORE INSERT OR UPDATE OF provider_id, adapter_kind ON kernel.investigation_runs
    FOR EACH ROW
    EXECUTE FUNCTION kernel.investigation_run_adapter_guard();

-- ---------------------------------------------------------------------------
-- 3. One tool invocation, including the refusals.
--
-- The refusals are the interesting rows: a run that asked for something outside its
-- scope and was told so is exactly what an auditor needs, and a table that only
-- recorded successes would delete the evidence of the control working.
--
-- authorization_predicate is the name of the backend predicate that allowed the call.
-- A successful invocation cannot be stored without one, so "the tool read something"
-- always answers "under which authority".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kernel.investigation_tool_invocations (
    invocation_id uuid PRIMARY KEY,
    run_id uuid NOT NULL
        REFERENCES kernel.investigation_runs(run_id) ON DELETE CASCADE,
    sequence integer NOT NULL CHECK (sequence >= 1),
    attempt integer NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 6),
    tool_name text NOT NULL CHECK (tool_name IN (
        'get_incident','list_evidence','read_evidence',
        'get_incident_timeline','get_related_context'
    )),
    -- The arguments the MODEL produced, kept verbatim. Auditing only what was allowed
    -- would hide what was asked for.
    arguments jsonb NOT NULL,
    outcome text NOT NULL CHECK (outcome IN (
        'OK','REFUSED','ERROR','TIMEOUT','BUDGET_EXHAUSTED'
    )),
    error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
    -- Why it failed, in the kernel's words. Kept apart from error_code because the UI
    -- localizes the code and an auditor needs the sentence. Bounded so a provider that
    -- echoes a whole response cannot grow this table.
    error_detail text
        CHECK (error_detail IS NULL OR length(btrim(error_detail)) BETWEEN 1 AND 1000),
    authorization_predicate text,
    -- The identity the predicate re-read at call time. NULL when authorization never
    -- ran, which is itself the audit fact for a refused call.
    scope_actor uuid,
    result_bytes integer CHECK (result_bytes IS NULL OR result_bytes >= 0),
    -- sha256 over the result body, so a later reader can tell whether it changed.
    result_digest text CHECK (result_digest IS NULL OR result_digest ~ '^[0-9a-f]{64}$'),
    -- Evidence rows this invocation actually returned. Citations may only name rows
    -- that appear here, which is what makes a citation traceable to a read.
    evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
    started_at timestamptz NOT NULL,
    finished_at timestamptz NOT NULL,
    duration_ms integer NOT NULL CHECK (duration_ms >= 0),
    UNIQUE (run_id, sequence, attempt),
    CONSTRAINT investigation_invocation_success_check CHECK (
        outcome <> 'OK' OR (error_code IS NULL AND authorization_predicate IS NOT NULL)
    ),
    CONSTRAINT investigation_invocation_failure_check CHECK (
        outcome = 'OK' OR error_code IS NOT NULL
    ),
    CONSTRAINT investigation_invocation_clock_check CHECK (finished_at >= started_at)
);
CREATE INDEX IF NOT EXISTS investigation_invocations_run_idx
    ON kernel.investigation_tool_invocations (run_id, sequence, attempt);

-- ---------------------------------------------------------------------------
-- 4. A hypothesis: what the investigator THINKS, which is not a conclusion.
--
-- The stance vocabulary is deliberately disjoint from the verdict vocabulary:
--   stance  SUPPORTED | CONTRADICTED | UNCERTAIN | CONFLICTED   (what the AI says)
--   verdict CONFIRMED | REFUTED | INCONCLUSIVE                  (what a human signs)
-- There is no mapping between them anywhere in this schema, and none is intended: a
-- SUPPORTED hypothesis is a claim that the evidence it cites points somewhere, not a
-- decision that the incident is confirmed.
--
-- UNCERTAIN and CONFLICTED are first-class stances rather than an empty hypothesis
-- list, so "the evidence is not enough" is a result the protocol can state instead of
-- a result it fails to state. Both must carry their gap codes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kernel.investigation_hypotheses (
    hypothesis_id uuid PRIMARY KEY,
    run_id uuid NOT NULL
        REFERENCES kernel.investigation_runs(run_id) ON DELETE CASCADE,
    ordinal integer NOT NULL CHECK (ordinal >= 1),
    statement text NOT NULL CHECK (length(btrim(statement)) BETWEEN 12 AND 1000),
    stance text NOT NULL CHECK (stance IN (
        'SUPPORTED','CONTRADICTED','UNCERTAIN','CONFLICTED'
    )),
    confidence text NOT NULL CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
    -- Why, in the investigator's words, including why it stopped where it did.
    reasoning text NOT NULL CHECK (length(btrim(reasoning)) BETWEEN 10 AND 4000),
    -- What is NOT established. Required whenever the stance says something is missing.
    uncertainty text CHECK (uncertainty IS NULL OR length(btrim(uncertainty)) BETWEEN 10 AND 2000),
    -- Closed codes for what is missing, so the UI renders a cause instead of prose:
    --   NO_EVIDENCE_ROWS            nothing to reason from
    --   EVIDENCE_PREDATES_INCIDENT  the record disagrees about when this began
    --   EVIDENCE_UNVERIFIED         the cited rows carry no provenance the Kernel
    --                               established
    --   TOOL_REFUSED / TOOL_FAILED / TOOL_TIMED_OUT  a read this run asked for and did
    --                               not get
    --   SOURCE_UNAVAILABLE          the related-context source is not authorised on
    --                               this deployment
    --   BUDGET_EXHAUSTED            the run stopped at a limit before finishing
    gap_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
    adapter_kind text NOT NULL CHECK (adapter_kind IN ('TEST_FIXTURE','HTTP_OPENAI_COMPATIBLE')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, ordinal),
    CONSTRAINT investigation_uncertain_has_gap_check CHECK (
        stance NOT IN ('UNCERTAIN','CONFLICTED')
        OR (uncertainty IS NOT NULL AND jsonb_array_length(gap_codes) >= 1)
    ),
    CONSTRAINT investigation_gap_codes_are_an_array_check CHECK (jsonb_typeof(gap_codes) = 'array')
);

-- ---------------------------------------------------------------------------
-- 5. The citations: supporting and contradicting, both pointing at real rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kernel.investigation_hypothesis_evidence (
    hypothesis_id uuid NOT NULL
        REFERENCES kernel.investigation_hypotheses(hypothesis_id) ON DELETE CASCADE,
    -- RESTRICT, for the reason 0017 gives for the verdict snapshot: the citation is
    -- the signed-ish fact. Evidence cannot be deleted through any endpoint today, and
    -- if that changes this constraint has to be reasoned about, not silently cascade.
    evidence_id uuid NOT NULL
        REFERENCES kernel.incident_evidence(evidence_id) ON DELETE RESTRICT,
    role text NOT NULL CHECK (role IN ('SUPPORTING','CONTRADICTING')),
    -- Which read produced it. SET NULL rather than CASCADE: losing the pointer to the
    -- invocation must not delete the citation.
    invocation_id uuid
        REFERENCES kernel.investigation_tool_invocations(invocation_id) ON DELETE SET NULL,
    PRIMARY KEY (hypothesis_id, evidence_id, role)
);

-- A citation of evidence from another incident is refused by the database, not by a
-- handler check that a future caller could skip.
CREATE FUNCTION kernel.investigation_citation_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM kernel.investigation_hypotheses h
          JOIN kernel.investigation_runs r ON r.run_id = h.run_id
          JOIN kernel.incident_evidence e ON e.evidence_id = NEW.evidence_id
         WHERE h.hypothesis_id = NEW.hypothesis_id
           AND e.incident_id = r.incident_id
    ) THEN
        RAISE EXCEPTION
            'hypothesis % cannot cite evidence %: that evidence does not belong to the incident this investigation is about',
            NEW.hypothesis_id, NEW.evidence_id
            USING ERRCODE = 'restrict_violation',
                  HINT = 'A conclusion cites the evidence of its own incident or it cites nothing (ADR-G12-004 §2).';
    END IF;
    IF NEW.invocation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
          FROM kernel.investigation_tool_invocations i
          JOIN kernel.investigation_hypotheses h ON h.run_id = i.run_id
         WHERE i.invocation_id = NEW.invocation_id
           AND h.hypothesis_id = NEW.hypothesis_id
    ) THEN
        RAISE EXCEPTION
            'invocation % did not run inside the investigation that cites it',
            NEW.invocation_id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER investigation_citation_guard
    BEFORE INSERT OR UPDATE ON kernel.investigation_hypothesis_evidence
    FOR EACH ROW
    EXECUTE FUNCTION kernel.investigation_citation_guard();

-- ---------------------------------------------------------------------------
-- 6. A human review OF THE INVESTIGATION, which concludes nothing about the incident.
--
-- decision is ACCEPTED | REJECTED - the words for "I find this reasoning usable" and
-- "I do not", which are different questions from CONFIRMED | REFUTED | INCONCLUSIVE.
-- One row per run (PK on run_id) and no UPDATE path: a review is a review, and a
-- second opinion is a second run.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kernel.investigation_human_reviews (
    run_id uuid PRIMARY KEY
        REFERENCES kernel.investigation_runs(run_id) ON DELETE CASCADE,
    decision text NOT NULL CHECK (decision IN ('ACCEPTED','REJECTED')),
    note text NOT NULL CHECK (length(btrim(note)) BETWEEN 10 AND 2000),
    reviewed_by uuid NOT NULL REFERENCES kernel.users(id) ON DELETE RESTRICT,
    reviewed_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 7. What get_related_context may read.
--
-- A closed set of source kinds the kernel actually has, each naming the predicate that
-- authorises it. This table declares WHAT EXISTS and HOW IT IS AUTHORISED; it does not
-- declare what is enabled, because enablement is deployment configuration and a second
-- copy of it here could disagree with the first. With nothing configured the tool
-- answers SOURCE_UNAVAILABLE - no data, and no fabricated data either.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kernel.investigation_related_sources (
    source_id text PRIMARY KEY CHECK (source_id IN ('incident_index')),
    display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 3 AND 120),
    -- The name of the predicate the tool must apply. Recorded so the invocation row
    -- and this row can be compared, and so the tool has nothing to invent.
    authorization_predicate text NOT NULL CHECK (length(btrim(authorization_predicate)) BETWEEN 3 AND 120),
    description text NOT NULL CHECK (length(btrim(description)) BETWEEN 10 AND 2000)
);

INSERT INTO kernel.investigation_related_sources
    (source_id, display_name, authorization_predicate, description)
VALUES
    ('incident_index',
     'Incident index by related entity',
     'INCIDENT_READ_PREDICATE',
     'Other incidents of the same tenant that share this incident''s relatedEntity and that the investigating operator may read. Scoped by the same predicate as GET /api/v1/incidents, so it can never widen what the operator sees; enablement is OPSWEAVE_INVESTIGATION_RELATED_SOURCES.')
ON CONFLICT (source_id) DO NOTHING;
