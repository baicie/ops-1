-- 0033 · G13-B1.6: job-scoped Evidence effect identity.
--
-- ADR: docs/design/g13-b1/b1.6-evidence-exactly-once-adr.md
--
-- Before this migration the only uniqueness on kernel.incident_evidence was
-- (incident_id, kind, source, content_ref). That protects "the same content is
-- not stored twice", not "one job's logical effect commits once": a retry after
-- a crash between Evidence commit and Job success re-collects, produces a new
-- contentRef from a new sampling window, and the tuple no longer conflicts.
--
-- The Evidence row now carries the job that produced it, and that binding is
-- unique. The row IS the effect receipt: the INSERT that writes the evidence
-- also writes the identity, so there is no window in which one exists and the
-- other does not. Recovery looks the job up here before any RPC.
--
-- Uniqueness is deliberately split:
--   * Job-scoped rows are unique by automation_job_id. Two different jobs that
--     produce identical content are two rows - they are two independent
--     effects, and merging them would lose one job's ownership.
--   * Rows without a job (human submissions and historical automation rows)
--     keep the old tuple uniqueness, now as a partial index with the same
--     columns and the same effect on those rows.
--
-- Compatibility: the column is nullable, no row is rewritten, and no Evidence
-- content, digest, trust value, attestation or verdict snapshot is touched.
-- The FK is RESTRICT on purpose: deleting the job must not silently detach the
-- evidence's identity; evidence is business data and outlives the job record.
--
-- Rollback (not free: it re-allows different jobs' identical content to merge):
--   DROP INDEX kernel.incident_evidence_job_key;
--   DROP INDEX kernel.incident_evidence_content_key;
--   ALTER TABLE kernel.incident_evidence DROP COLUMN automation_job_id;
--   ALTER TABLE kernel.incident_evidence
--       ADD CONSTRAINT incident_evidence_incident_id_kind_source_content_ref_key
--       UNIQUE (incident_id, kind, source, content_ref);

ALTER TABLE kernel.incident_evidence
    ADD COLUMN IF NOT EXISTS automation_job_id uuid
        REFERENCES kernel.automation_jobs(job_id) ON DELETE RESTRICT;

ALTER TABLE kernel.incident_evidence
    DROP CONSTRAINT IF EXISTS incident_evidence_incident_id_kind_source_content_ref_key;

CREATE UNIQUE INDEX IF NOT EXISTS incident_evidence_content_key
    ON kernel.incident_evidence (incident_id, kind, source, content_ref)
    WHERE automation_job_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS incident_evidence_job_key
    ON kernel.incident_evidence (automation_job_id)
    WHERE automation_job_id IS NOT NULL;
