-- G11 business slice: Incident -> Evidence -> Human Verdict.
-- Additive only. Existing tables and endpoints are unchanged.
--
-- Authority: the Kernel is the single writer of the incident record (ADR
-- docs/design/g11-incident/incident-adr.md). No plugin reads these tables.
--
-- Rollback: sqlx migrations are forward-only. The reverse DDL is documented in
-- the ADR (section "Rollback") and is destructive: it drops real business
-- records, so it is never executed implicitly and never inside a release.

CREATE TABLE IF NOT EXISTS kernel.incidents (
    incident_id uuid PRIMARY KEY,
    title text NOT NULL CHECK (length(btrim(title)) BETWEEN 4 AND 200),
    severity text NOT NULL CHECK (severity IN ('CRITICAL','MAJOR','MINOR','WARNING')),
    status text NOT NULL CHECK (status IN ('OPEN','INVESTIGATING','CONCLUDED','CLOSED')),
    -- Closed value set: only sources the kernel can attest today. A connector
    -- (Zabbix/Nebula) must widen this with its own migration + ADR, because a
    -- client must never be able to claim provenance the system cannot verify.
    source text NOT NULL CHECK (source IN ('MANUAL','API')),
    native_id text,
    related_entity text CHECK (
        related_entity IS NULL OR length(btrim(related_entity)) BETWEEN 3 AND 200
    ),
    started_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- Accountability, not authorship: who created the row is already recorded
    -- as actor_id in kernel.audit_events. This column is what the operator data
    -- scope filters on, mirroring pipeline_jobs.submitted_by.
    owner uuid NOT NULL REFERENCES kernel.users(id),
    CHECK (native_id IS NULL OR length(btrim(native_id)) BETWEEN 1 AND 200)
);

-- Natural identity of a reported failure. Two rows for the same source-native
-- failure are a data defect, so the uniqueness is enforced by the database
-- rather than by a read-then-insert in the handler.
CREATE UNIQUE INDEX IF NOT EXISTS incidents_source_native_idx
    ON kernel.incidents (source, native_id)
    WHERE native_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS incidents_owner_time_idx
    ON kernel.incidents (owner, started_at DESC, incident_id DESC);
CREATE INDEX IF NOT EXISTS incidents_time_idx
    ON kernel.incidents (started_at DESC, incident_id DESC);
CREATE INDEX IF NOT EXISTS incidents_status_idx
    ON kernel.incidents (status, started_at DESC);

CREATE TABLE IF NOT EXISTS kernel.incident_evidence (
    evidence_id uuid PRIMARY KEY,
    incident_id uuid NOT NULL
        REFERENCES kernel.incidents(incident_id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (
        kind IN ('METRIC_SNAPSHOT','LOG_EXCERPT','QUERY_RESULT','OPERATOR_NOTE')
    ),
    -- Which system or act produced this content. Free text because provenance
    -- is evidence, not configuration; it is bounded and never dereferenced.
    source text NOT NULL CHECK (length(btrim(source)) BETWEEN 2 AND 200),
    collected_at timestamptz NOT NULL,
    -- Opaque locator (content digest or store key). The payload itself never
    -- enters the kernel database, so evidence cannot silently grow unbounded
    -- and the kernel never fetches a URL a caller supplied.
    content_ref text NOT NULL CHECK (length(btrim(content_ref)) BETWEEN 2 AND 1000),
    trust text NOT NULL CHECK (trust IN ('SOURCE_ATTESTED','OPERATOR_ASSERTED','UNVERIFIED')),
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Replaying the same collection produces the same evidence row, not a
    -- second copy of the same fact.
    UNIQUE (incident_id, kind, source, content_ref)
);
CREATE INDEX IF NOT EXISTS incident_evidence_time_idx
    ON kernel.incident_evidence (incident_id, collected_at DESC, evidence_id DESC);

CREATE TABLE IF NOT EXISTS kernel.incident_verdicts (
    -- One human conclusion per incident. A second conclusion is a new review
    -- round (out of scope for D1), never an in-place overwrite of history.
    incident_id uuid PRIMARY KEY
        REFERENCES kernel.incidents(incident_id) ON DELETE RESTRICT,
    verdict text NOT NULL CHECK (verdict IN ('CONFIRMED','REFUTED','INCONCLUSIVE')),
    rationale text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 10 AND 4000),
    decided_by uuid NOT NULL REFERENCES kernel.users(id),
    decided_at timestamptz NOT NULL DEFAULT now()
);
