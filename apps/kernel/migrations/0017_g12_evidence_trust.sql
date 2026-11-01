-- G12 Phase A (A1): separate what a submitter CLAIMS about evidence trust
-- from what the Kernel can VERIFY about it.
--
-- Defect this closes: before 0017 a client could POST
-- {"trust":"SOURCE_ATTESTED"} and the row was stored as attested. The column
-- was named `trust`, it was populated from the request body, and the Kernel had
-- no way to distinguish "a connector vouched for this" from "the caller typed the
-- word". The two are different facts and now live in different columns:
--
--   claimed_trust  - what the submitter said about its own row (never authority)
--   verified_trust - the outcome the Kernel reached on its own (the only field
--                    any reader or any later verdict may rely on)
--
-- Additive and non-destructive: one column rename (PostgreSQL preserves the
-- data, the primary key, both foreign keys, all indexes and every timestamp) and
-- six added columns. No row is deleted, no id changes, no verdict history is
-- touched.
--
-- Rollback: sqlx migrations are forward-only. The reverse DDL is documented in
-- docs/design/g11-incident/incident-adr.md (§11.7) and is NOT run automatically.
-- It is not free: reverting restores the CLAIM to a column called trust, so every
-- row downgraded here would look attested again unless the archive is kept.

-- ---------------------------------------------------------------------------
-- 1. The old column was always a claim, so give it the name of one.
--    RENAME keeps the 0016 CHECK constraint attached (it becomes
--    incident_evidence_trust_check over claimed_trust) and every existing value.
-- ---------------------------------------------------------------------------
ALTER TABLE kernel.incident_evidence RENAME COLUMN trust TO claimed_trust;

-- ---------------------------------------------------------------------------
-- 2. The Kernel's own conclusion, plus the five facts that justify it.
-- ---------------------------------------------------------------------------
ALTER TABLE kernel.incident_evidence
    -- Server verdict. Defaults to UNVERIFIED so a write path that forgets to set
    -- it can never accidentally claim attestation: the column fails safe.
    ADD COLUMN verified_trust text NOT NULL DEFAULT 'UNVERIFIED'
        CHECK (verified_trust IN ('SOURCE_ATTESTED','OPERATOR_ASSERTED','UNVERIFIED')),
    -- How the Kernel reached it: NONE (nothing verified), OPERATOR_IDENTITY (an
    -- authenticated operator with the write permission submitted the row) or
    -- SOURCE_ADAPTER (an adapter proved possession of its configured secret).
    ADD COLUMN verification_method text NOT NULL DEFAULT 'NONE'
        CHECK (verification_method IN ('NONE','OPERATOR_IDENTITY','SOURCE_ADAPTER')),
    -- When the verification ran. NULL when nothing was verified.
    ADD COLUMN verified_at timestamptz,
    -- Which authenticated identity vouched: the adapter id for SOURCE_ADAPTER,
    -- NULL otherwise (the vouching identity there is submitted_by).
    ADD COLUMN verifier_identity text,
    -- Who submitted the row. Recoverable for historical rows from the audit
    -- trail (see step 3); NULL when no audit row exists and the Kernel therefore
    -- does not know - it is not filled with a guess.
    ADD COLUMN submitted_by uuid REFERENCES kernel.users(id),
    -- Why a row carries the verification it carries, when that needs saying.
    ADD COLUMN verification_note text,
    ADD CONSTRAINT incident_evidence_verification_check CHECK (
        (verification_method = 'NONE'
            AND verified_at IS NULL AND verifier_identity IS NULL)
        OR (verification_method = 'OPERATOR_IDENTITY'
            AND verified_at IS NOT NULL AND verified_trust = 'OPERATOR_ASSERTED')
        OR (verification_method = 'SOURCE_ADAPTER'
            AND verified_at IS NOT NULL AND verifier_identity IS NOT NULL
            AND verified_trust = 'SOURCE_ATTESTED')
    );

-- Attestation is the only route to SOURCE_ATTESTED, in the schema and not only
-- in the handler: a hand-written INSERT cannot mint it either.
ALTER TABLE kernel.incident_evidence
    ADD CONSTRAINT incident_evidence_attestation_requires_adapter CHECK (
        verified_trust <> 'SOURCE_ATTESTED'
        OR (verification_method = 'SOURCE_ADAPTER' AND verifier_identity IS NOT NULL)
    );

-- ---------------------------------------------------------------------------
-- 3. Historical rows: state what they really are.
--
-- Why these rows exist at all: every SOURCE_ATTESTED row in a pre-0017 database
-- came from the request body of POST /incidents/{id}/evidence. No adapter
-- identity, no signature and no server check ever stood behind one. They cannot
-- keep claiming attestation, so they are downgraded and the claim is preserved
-- separately with a note that says what happened. Not a silent rewrite: the id,
-- incident_id, kind, source, collected_at, content_ref and created_at of every
-- row are untouched, and claimed_trust still holds the original word.
-- ---------------------------------------------------------------------------

-- 3a. Every SOURCE_ATTESTED row: unverifiable, so unverified.
UPDATE kernel.incident_evidence
SET verified_trust = 'UNVERIFIED',
    verification_method = 'NONE',
    verified_at = NULL,
    verifier_identity = NULL,
    verification_note = 'MIGRATION_0017_DOWNGRADE: claimed SOURCE_ATTESTED before migration 0017, when the column was client-supplied. No adapter identity, signature or server check backs this row, so the attestation cannot be upheld and the Kernel reports it as UNVERIFIED.'
WHERE claimed_trust = 'SOURCE_ATTESTED';

-- 3b. OPERATOR_ASSERTED rows: the claim the Kernel can still uphold, because the
--     endpoint has required the operator role since 0016. Verified as of the
--     moment the row was recorded, which is the only instant the server knows.
UPDATE kernel.incident_evidence
SET verified_trust = 'OPERATOR_ASSERTED',
    verification_method = 'OPERATOR_IDENTITY',
    verified_at = created_at
WHERE claimed_trust = 'OPERATOR_ASSERTED';

-- 3c. UNVERIFIED rows stay UNVERIFIED; they are already the fail-safe value.

-- 3d. Recover the submitter from the audit trail written in the same
--     transaction as the evidence row. Where that trail is missing the column
--     stays NULL rather than naming a plausible account.
UPDATE kernel.incident_evidence e
SET submitted_by = m.actor_id::uuid
FROM (
    SELECT DISTINCT ON (details->>'evidenceId')
           details->>'evidenceId' AS evidence_id,
           actor_id
    FROM kernel.audit_events
    WHERE event_type = 'INCIDENT_EVIDENCE_ADDED'
      AND subject_type = 'INCIDENT'
      AND action = 'ADD_EVIDENCE'
      AND details ? 'evidenceId'
      AND actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ORDER BY details->>'evidenceId', occurred_at ASC
) m
WHERE e.evidence_id::text = m.evidence_id
  AND e.submitted_by IS NULL
  AND EXISTS (SELECT 1 FROM kernel.users u WHERE u.id = m.actor_id::uuid);

-- ---------------------------------------------------------------------------
-- 4. A3: what a signed verdict actually considered.
--
-- A verdict used to be reconstructible only by guessing from timestamps, so
-- evidence appended after signing could be read as if the signer had weighed it.
-- The considered set is now recorded once, at signing time, and is immutable:
-- rows are only ever inserted by the verdict transaction.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kernel.incident_verdict_evidence (
    incident_id uuid NOT NULL
        REFERENCES kernel.incident_verdicts(incident_id) ON DELETE CASCADE,
    -- RESTRICT, not CASCADE: the snapshot is the signed fact. Evidence cannot be
    -- deleted through any endpoint, and if that ever changes the constraint has
    -- to be reasoned about rather than silently taking the snapshot with it.
    evidence_id uuid NOT NULL
        REFERENCES kernel.incident_evidence(evidence_id) ON DELETE RESTRICT,
    -- sha256 (hex) of this row's identity and content at signing time, so a
    -- later edit to a content_ref is detectable even though the id is unchanged.
    evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
    PRIMARY KEY (incident_id, evidence_id)
);

ALTER TABLE kernel.incident_verdicts
    -- The exact number of evidence rows in the considered set (0 for an
    -- INCONCLUSIVE verdict signed with none).
    ADD COLUMN considered_evidence_count integer NOT NULL DEFAULT 0
        CHECK (considered_evidence_count >= 0),
    -- sha256 (hex) over the considered set; NULL when nothing was recorded.
    ADD COLUMN considered_evidence_digest text
        CHECK (considered_evidence_digest IS NULL
               OR considered_evidence_digest ~ '^[0-9a-f]{64}$'),
    -- RECORDED: the considered set is in this snapshot. PRE_MIGRATION_UNRECORDED:
    -- the verdict was signed before 0017 and its considered set was never stored,
    -- so it stays unknown instead of being reconstructed from timestamps and
    -- presented as if it had been.
    ADD COLUMN snapshot_kind text NOT NULL DEFAULT 'PRE_MIGRATION_UNRECORDED'
        CHECK (snapshot_kind IN ('RECORDED','PRE_MIGRATION_UNRECORDED'));

-- Every pre-0017 verdict is honestly marked as unrecorded. No backfill can
-- invent the set the signer looked at.
UPDATE kernel.incident_verdicts
SET snapshot_kind = 'PRE_MIGRATION_UNRECORDED',
    considered_evidence_count = 0,
    considered_evidence_digest = NULL
WHERE snapshot_kind = 'PRE_MIGRATION_UNRECORDED';
