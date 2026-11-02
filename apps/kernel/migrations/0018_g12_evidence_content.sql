-- G12 Phase B (B1/B2): the BYTES behind an evidence row, not only a reference to
-- somewhere the content might be.
--
-- Defect this closes: since 0016 an evidence row has carried content_ref, a
-- 2..1000 character opaque string the client chose. The Kernel never read it,
-- never checked it, and never could tell "the bytes are here and unchanged"
-- from "a placeholder someone typed". After 0018 a row either has content in
-- this table - bounded, write-once, digested by the server over the bytes it
-- actually stored - or it does not, and the read path says LEGACY_REFERENCE
-- rather than implying the content exists.
--
-- Why PostgreSQL bytea and not object storage: the per-item bound is 64 KiB and
-- the release requirement is a verifiable read path, not a storage platform
-- (docs/design/g12-evidence/evidence-content-adr.md §2). A second authority for
-- the same bytes would need its own backup, restore and authorization story.
--
-- Additive and non-destructive: one NEW table plus one trigger function. No
-- existing column is added, renamed or dropped, no row of any existing table is
-- updated, and 0017 (and everything before it) is untouched because sqlx
-- checksums it. Every pre-0018 evidence row simply has no content row, which is
-- the truth about it.
--
-- Rollback: sqlx migrations are forward-only. The reverse DDL is
--    DROP TRIGGER incident_evidence_content_write_once ON kernel.incident_evidence_content;
--    DROP FUNCTION kernel.incident_evidence_content_is_immutable();
--    DROP TABLE kernel.incident_evidence_content;
-- and it is NOT free: DROP TABLE destroys every stored content byte, which is
-- the one thing this table exists to hold. It may only run when the loss of all
-- evidence content is an accepted outcome; the evidence rows themselves and
-- every signed verdict's considered-set snapshot survive it.

-- ---------------------------------------------------------------------------
-- 1. One content row per evidence row.
--
-- The primary key IS the foreign key: an evidence id can hold at most one
-- content, and a second submission of the same evidence cannot create a second
-- version of it. There is no version column on purpose (ADR §1.2): content is
-- write-once, so "change the content" is expressed as a new evidence row.
-- ---------------------------------------------------------------------------
CREATE TABLE kernel.incident_evidence_content (
    evidence_id uuid PRIMARY KEY
        -- CASCADE, and the trigger in section 2 is what makes the cascade safe:
        -- content may only disappear together with the evidence row it belongs
        -- to, in one statement, never on its own. The alternative - RESTRICT,
        -- as incident_verdict_evidence uses - would make every evidence row
        -- undeletable forever, which buys nothing: a signed verdict already
        -- refuses to let its evidence rows go (that same RESTRICT), so content
        -- behind a signature is protected twice over.
        REFERENCES kernel.incident_evidence(evidence_id) ON DELETE CASCADE,
    -- Exactly two values. No charset parameter, no text/html, no
    -- application/octet-stream: the Kernel serves this type back verbatim, and a
    -- value it cannot serve safely is a value it must not accept.
    content_type text NOT NULL
        CHECK (content_type IN ('text/plain', 'application/json')),
    -- The bytes as submitted. No normalisation, no trimming, no escaping: the
    -- digest below is over exactly these bytes, so that recomputing it at read
    -- time is a meaningful test.
    body bytea NOT NULL
        CHECK (octet_length(body) BETWEEN 1 AND 65536),
    -- Cached length of body, CHECKed against body so the two can never disagree.
    -- Counting bytes rather than characters is what makes the 64 KiB bound real
    -- for multi-byte text.
    content_bytes integer NOT NULL
        CHECK (content_bytes BETWEEN 1 AND 65536 AND content_bytes = octet_length(body)),
    -- sha256 (lowercase hex) computed by the Kernel over the bytes it stored, in
    -- the transaction that stored them. A digest that arrived in the request body
    -- is never written here (ADR §1.5).
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    -- When the Kernel accepted these bytes (server clock), which is the fact half
    -- of the capture window [collectedAt (claim), captured_at (fact)].
    captured_at timestamptz NOT NULL DEFAULT now(),
    -- captured_at + 365 days, so the retention horizon is stored rather than
    -- recomputed by each reader from a constant that could drift.
    retention_expires_at timestamptz NOT NULL DEFAULT (now() + interval '365 days'),
    CONSTRAINT incident_evidence_content_retention_check
        CHECK (retention_expires_at > captured_at)
);

-- Reading is always by evidence_id (the primary key) from the evidence list
-- join; no additional index is needed and none is created.

-- ---------------------------------------------------------------------------
-- 2. Write-once, enforced by the database and not only by the handlers.
--
-- The handlers expose no update or delete route, but "no route" is a statement
-- about today's code. This trigger is a statement about the data: an UPDATE or a
-- DELETE from psql, a migration, a future bug is refused with restrict_violation
-- rather than quietly rewriting the bytes a signed verdict stands on.
--
-- DELETE is refused too, with one exception that is checked rather than trusted:
-- a cascade from the evidence row is allowed, and it is recognised by the parent
-- row already being gone inside this statement. So content cannot be stripped
-- from a live evidence row ("the row is still there, the bytes are not"), and it
-- cannot be deleted out from under one by hand. The only way to lose the bytes is
-- to delete the evidence row itself - which a signed verdict refuses
-- (incident_verdict_evidence.evidence_id is ON DELETE RESTRICT).
--
-- It is deliberately possible for a table owner to disable it
-- (ALTER TABLE ... DISABLE TRIGGER), because the acceptance test has to break
-- the content to prove corruption is DETECTED - and disabling a lock is a much
-- louder action than a forgotten WHERE clause.
-- ---------------------------------------------------------------------------
CREATE FUNCTION kernel.incident_evidence_content_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE'
       AND NOT EXISTS (
           SELECT 1 FROM kernel.incident_evidence WHERE evidence_id = OLD.evidence_id
       )
    THEN
        -- The evidence row is already gone in this statement: this delete is the
        -- cascade that belongs to it, and letting it through is what keeps the
        -- two rows bound together instead of leaving an orphan behind.
        RETURN OLD;
    END IF;
    RAISE EXCEPTION
        'kernel.incident_evidence_content is write-once: % on evidence_id=% is refused',
        TG_OP, OLD.evidence_id
        USING ERRCODE = 'restrict_violation',
              HINT = 'Evidence content cannot be rewritten or stripped from its row; record a new evidence row instead (ADR-G12-002 §1.8).';
END;
$$;

CREATE TRIGGER incident_evidence_content_write_once
    BEFORE UPDATE OR DELETE ON kernel.incident_evidence_content
    FOR EACH ROW
    EXECUTE FUNCTION kernel.incident_evidence_content_is_immutable();
