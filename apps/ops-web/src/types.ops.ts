// Ops-domain contract types (Incident, Evidence, Verdict, Timeline).
//
// G14.1/ADR-022: these belong to the Ops Application, not to Platform Core. They
// live in their own module so the shared contract package cannot accidentally
// export an Incident to the platform console - the dependency direction the ADR
// fixes is one-way, and a type that leaks across it is the cheapest way to
// violate it.

/* ── G11 incident slice (contracts/openapi/incident-v1.yaml) ─────────────────────────── */

/**
 * One incident as the kernel derives it. `evidenceRefs` is capped at the newest 100 by the
 * shared projection, so it is a reference list and never a total: the evidence endpoint is the
 * complete set, and the UI must not print a count derived from this field as if it were all.
 */
export interface IncidentView {
  id: string;
  title: string;
  severity: string;
  status: string;
  source: string;
  nativeId: string | null;
  relatedEntity: string | null;
  startedAt: string;
  updatedAt: string;
  owner: string;
  /** When the current owner was assigned; equal to createdAt for a row never handed over. */
  ownerAssignedAt: string;
  /**
   * G13-B1.4: USER, AUTOMATION, or null for a row that predates migration 0026. It says who
   * filed the record; a source adapter's provenance is in `source`.
   */
  origin: string | null;
  /**
   * G13-B1.4: true exactly when the row is waiting in the workspace automation queue (origin
   * AUTOMATION, the non-login service owner, status OPEN or INVESTIGATING). The kernel derives
   * it from the same fields the claim route checks, so a button built from it cannot appear for
   * a row the claim would refuse.
   */
  claimable: boolean;
  /**
   * G12 C: the version the lifecycle writes arbitrate on. Every close and handover sends it as
   * `expectedRevision`, so a decision taken against a record that has since changed is refused
   * (409 INCIDENT_VERSION_CONFLICT) instead of overwriting what the caller never saw.
   */
  revision: number;
  /**
   * The closure of record. Non-null if and only if status is CLOSED - the database enforces it
   * (migration 0019), so a UI can decide whether to render a closure from these three fields.
   */
  closedAt: string | null;
  closedBy: string | null;
  closureNote: string | null;
  evidenceRefs: string[];
  humanVerdict: IncidentVerdict | null;
}

export interface IncidentVerdict {
  incidentId: string;
  verdict: string;
  rationale: string;
  decidedBy: string;
  decidedAt: string;
  /**
   * G12 A3: how many evidence rows the signing transaction actually read. This is the number the
   * verdict stands on. It is not, and must never be recomputed as, the number the incident holds
   * now - evidence is still accepted after CONCLUDED.
   */
  consideredEvidenceCount: number;
  /** sha256 (hex) over that set, or null when the kernel recorded no set. */
  consideredEvidenceDigest: string | null;
  /**
   * RECORDED means the set above is a record. PRE_MIGRATION_UNRECORDED means the verdict was
   * signed before the snapshot existed: the set was never stored, so it is unknown and the UI
   * must say so rather than reconstruct it from timestamps.
   */
  snapshotKind: 'RECORDED' | 'PRE_MIGRATION_UNRECORDED' | string;
}

/**
 * G12 A1: two fields, two questions.
 *
 * claimedTrust is what the submitter said about its own row. verifiedTrust is what the kernel
 * established, and it is the only field that may be rendered as provenance. They can disagree,
 * and when they do the disagreement is the interesting fact.
 */
export interface IncidentEvidence {
  id: string;
  incidentId: string;
  kind: string;
  source: string;
  collectedAt: string;
  /**
   * For a STORED row this is the kernel's own sha256:<hex> over the bytes it stored; for a
   * LEGACY_REFERENCE row it is whatever the submitter typed. The kernel never fetches it, so
   * neither may the UI - it is a string to display, never a link.
   */
  contentRef: string;
  /** G12 B: STORED when the kernel holds the bytes; LEGACY_REFERENCE when it holds only a locator. */
  contentStatus: string;
  /** text/plain or application/json; null for a legacy reference. */
  contentType: string | null;
  contentBytes: number | null;
  /** sha256 the kernel computed over the bytes it stored - never a value that came from a client. */
  contentSha256: string | null;
  /** When the kernel accepted the bytes (server clock); the fact half of the capture window. */
  contentCapturedAt: string | null;
  /** capturedAt + 365 days. After this the content endpoint answers 410. */
  contentRetentionExpiresAt: string | null;
  claimedTrust: string;
  verifiedTrust: string;
  /** NONE | OPERATOR_IDENTITY | SOURCE_ADAPTER. */
  verificationMethod: string;
  verifiedAt: string | null;
  /** The authenticated adapter that vouched, for SOURCE_ADAPTER rows. */
  verifierIdentity: string | null;
  submittedBy: string | null;
  verificationNote: string | null;
  createdAt: string;
  /** G12 A3: true when the row was appended after the verdict was signed. */
  afterVerdict: boolean;
}

export interface IncidentList {
  items: IncidentView[];
  nextCursor: string | null;
}

export interface IncidentEvidenceList {
  items: IncidentEvidence[];
}

/**
 * G12 C: one row of an incident's own audit trail (GET /incidents/{id}/timeline).
 *
 * The endpoint is scoped by the incident read predicate, so a trail exists exactly where its
 * record does. `details` is the write's own facts and its shape depends on `eventType` - it is
 * rendered field by field, never dumped.
 */
export interface IncidentTimelineEvent {
  id: string;
  eventType: string;
  actorType: string;
  actorId: string;
  subjectType: string;
  subjectId: string;
  action: string;
  result: string;
  details: Record<string, unknown>;
  requestId: string | null;
  occurredAt: string;
}

export interface IncidentTimeline {
  items: IncidentTimelineEvent[];
  /** True when the incident holds more audit rows than this page: the OLDEST were dropped. */
  truncated: boolean;
}

/**
 * What a completed handover answers with. Deliberately not the incident: after a handover the
 * transferring operator may no longer read it, so this is the handover itself.
 */
export interface IncidentOwnerTransfer {
  incidentId: string;
  previousOwner: string;
  owner: string;
  ownerAssignedAt: string;
  reason: string;
  transferredBy: string;
  transferredAt: string;
  revision: number;
}
