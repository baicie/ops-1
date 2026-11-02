-- G12 Phase F: two schema claims that were shapes pretending to be guarantees.
--
-- The independent review of Phase F exhibited two hand-written statements that the
-- comments in 0017 and 0020 said were impossible:
--
--   * 0017 §2 said "Attestation is the only route to SOURCE_ATTESTED, in the schema and
--     not only in the handler: a hand-written INSERT cannot mint it either."
--     INSERT ... verification_method='SOURCE_ADAPTER', verifier_identity='made-up-adapter'
--     succeeded. Every CHECK held, because a CHECK can see the SHAPE of a row and never
--     whether its writer held an adapter secret.
--   * 0020 §6 said of kernel.investigation_human_reviews: "One row per run (PK on run_id)
--     and no UPDATE path: a review is a review, and a second opinion is a second run."
--     UPDATE ... SET decision='REJECTED' succeeded.
--
-- This migration does the two DIFFERENT things the two claims need, because they are not
-- the same kind of claim.
--
-- 1. The review claim is enforceable, so it is enforced. A trigger refuses the UPDATE
--    itself; "no UPDATE path" stops meaning "we did not write a handler for it" and starts
--    meaning "the database will not accept one". DELETE is deliberately NOT blocked: a
--    review disappears with the run it reviews (ON DELETE CASCADE in 0020), and a delete
--    of a run is already the operator's own destructive act on their own record.
--
-- 2. The attestation claim is NOT enforceable here, so it is corrected where it lives -
--    on the constraint, in the database, where the next reader of the schema will see it
--    instead of the migration file. A foreign key to a table of adapter identities was
--    considered and rejected:
--      a) the adapter set is deployment configuration (OPSWEAVE_EVIDENCE_ADAPTERS), and a
--         table listing adapter ids would be a second copy of that set which can disagree
--         with the first - the same reason 0020 refuses to duplicate related-source
--         enablement in investigation_related_sources;
--      b) it would be a FALSE guarantee. A hand-written INSERT naming a REAL adapter id
--         would pass it while proving nothing about possession of that adapter's secret,
--         so the forged row would look attested and be trusted. A constraint that makes a
--         forgery cheaper to believe is worse than an honest comment.
--    What the schema guarantees is the shape; possession of a secret is proven by the
--    handler's signature check (attestation_payload, ADR-G12-003 §5) and by nothing else.
--    There is no way to express "this row was written by code that held the secret" in a
--    CHECK, a trigger or an FK without the writer cooperating, and a writer that is
--    cooperating is not the threat.
--
-- 3. result_digest: 0020 recorded a digest of the payload a tool returned and then threw
--    the payload away, so nobody could recompute it - a claim no later reader can check,
--    which is worse than no digest at all. The payload is now kept (result_body), and kept
--    as TEXT of exactly the bytes that were hashed: jsonb would normalize key order and
--    whitespace, so a digest over the stored value would be a digest over something else.
--    Three things bound the copy, because a forensic record that breaks the retention model
--    is not worth having:
--      a) 64 KiB per invocation (RESULT_BODY_MAX_BYTES). A larger payload is recorded by
--         length and digest only, and the row says nothing it cannot support.
--      b) result_retention_expires_at carries the same horizon as the content row the
--         payload quotes, so the copy expires with its source instead of outliving it.
--         It is NULL for payloads that quote no retained bytes (ids, statuses, timestamps).
--      c) it is removed with the run (ON DELETE CASCADE), like every other row in the
--         ledger.
--    Known residual, stated rather than hidden: deleting an evidence row deletes its
--    content (0018) but not a run's record of having read it. That record is what an
--    auditor needs, it is bounded by (a), and it is reachable only by whoever holds the
--    database - no endpoint serves it.
--
-- No earlier migration is modified: sqlx checksums are a promise that an applied migration
-- never changes underneath a database that has already run it.
--
-- Reverting (manual, never automatic):
--    DROP TRIGGER investigation_review_immutable ON kernel.investigation_human_reviews;
--    DROP FUNCTION kernel.investigation_review_immutable();
--    ALTER TABLE kernel.investigation_tool_invocations
--        DROP CONSTRAINT investigation_invocation_result_pair_check;
--    COMMENT ON ... IS NULL (the three comments below).

-- ---------------------------------------------------------------------------
-- 1. A review is written once, and the database is what refuses the rewrite.
-- ---------------------------------------------------------------------------
CREATE FUNCTION kernel.investigation_review_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'investigation review of run % is write-once and cannot be rewritten in place',
        OLD.run_id
        USING ERRCODE = 'restrict_violation',
              HINT = 'A second opinion is a second run (ADR-G12-004 §6), not an edit of the first review.';
END;
$$;

CREATE TRIGGER investigation_review_immutable
    BEFORE UPDATE ON kernel.investigation_human_reviews
    FOR EACH ROW
    EXECUTE FUNCTION kernel.investigation_review_immutable();

COMMENT ON TABLE kernel.investigation_human_reviews IS
    'One review per investigation run, written once. UPDATE is refused by the investigation_review_immutable trigger, not only by the absence of a handler. A review says whether a human found the reasoning usable; it concludes nothing about the incident.';

-- ---------------------------------------------------------------------------
-- 2. What the attestation constraint actually guarantees, stated on the constraint.
-- ---------------------------------------------------------------------------
COMMENT ON CONSTRAINT incident_evidence_attestation_requires_adapter ON kernel.incident_evidence IS
    'SHAPE ONLY. A row claiming SOURCE_ATTESTED must also say it was verified SOURCE_ADAPTER and name a verifier identity. This constraint cannot and does not prove that the writer possessed that adapter''s secret: a hand-written INSERT naming a real adapter satisfies it. Possession is proven by the signature check in the write handler (attestation_payload, ADR-G12-003 §5) and by nothing in the schema. The paragraph in migration 0017 that said the schema forbids minting an attestation was wrong and is corrected by migration 0021.';

COMMENT ON COLUMN kernel.incident_evidence.verifier_identity IS
    'The adapter id the handler verified a signature for. Not a foreign key: the adapter set is deployment configuration (OPSWEAVE_EVIDENCE_ADAPTERS), and a database copy of it would be a second source of truth that can disagree with the first while proving nothing about possession.';

-- ---------------------------------------------------------------------------
-- 3. result_digest is a change detector, and it always travels with its byte count.
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN kernel.investigation_tool_invocations.result_digest IS
    'sha256 over the exact JSON bytes the Kernel handed the model at this invocation. The payload itself is NOT retained (a copy of an evidence body here would outlive the retention horizon of kernel.incident_evidence_content), so this digest cannot be recomputed by a later reader: it records THAT a read happened and over which bytes, not a commitment anyone can re-verify offline. What is verifiable later is the source the read came from - for content, kernel.incident_evidence_content.sha256.';

COMMENT ON COLUMN kernel.investigation_tool_invocations.result_bytes IS
    'Length of the payload the digest covers. Always present with result_digest or absent with it, enforced by investigation_invocation_result_pair_check.';

ALTER TABLE kernel.investigation_tool_invocations
    -- The payload, verbatim, exactly as it was hashed. text and not jsonb: jsonb
    -- normalizes key order and whitespace, and then result_digest is a digest over
    -- something the stored value can never reproduce.
    ADD COLUMN result_body text
        CHECK (result_body IS NULL OR octet_length(result_body) <= 65536),
    -- The horizon of the bytes this payload quotes, copied from the content row. NULL when
    -- the payload quotes no retained bytes.
    ADD COLUMN result_retention_expires_at timestamptz;

ALTER TABLE kernel.investigation_tool_invocations
    ADD CONSTRAINT investigation_invocation_result_pair_check CHECK (
        (result_digest IS NULL) = (result_bytes IS NULL)
    ),
    -- A payload always travels with the digest and length that describe it: a retained
    -- body with nothing saying what it digests to would be a copy, not a record.
    ADD CONSTRAINT investigation_invocation_result_body_check CHECK (
        result_body IS NULL
        OR (result_digest IS NOT NULL AND result_bytes IS NOT NULL)
    );
