import type { MessageKey } from './i18n';
import type { StatusTone } from './components/status-tone';
import type { IncidentEvidence, IncidentList, IncidentTimelineEvent, IncidentVerdict, IncidentView, Role } from './types';

/**
 * The incident slice's client-side facts, kept out of the two page components.
 *
 * Everything here is a pure function over wire payloads, so the rules the pages rely on - which
 * filters exist, which failure codes have copy, when an empty evidence list is 'missing' rather
 * than 'unavailable', what a timeline entry may be made of - are testable without a browser and
 * cannot drift between the list and the detail page.
 *
 * Two deliberate omissions, both of them stated on the page rather than papered over:
 *   * there is no free-text search: the list endpoint has no `q` parameter, and filtering the
 *     loaded page would silently ignore rows the cursor has not fetched yet;
 *   * there is no AI conclusion anywhere: the payload has no field for one (ADR-G11-001 §7).
 *
 * G12 C removed the third one: the kernel now has a close endpoint, so CLOSED is a value this
 * client can reach and the status filter is not carrying a code nothing produces.
 */

/** The status closed set from the contract. Since G12 C every value has a reachable path. */
export const INCIDENT_STATUS_CODES = ['OPEN', 'INVESTIGATING', 'CONCLUDED', 'CLOSED'] as const;
export const INCIDENT_SEVERITY_CODES = ['CRITICAL', 'MAJOR', 'MINOR', 'WARNING'] as const;
export const EVIDENCE_KIND_CODES = ['METRIC_SNAPSHOT', 'LOG_EXCERPT', 'QUERY_RESULT', 'OPERATOR_NOTE'] as const;
/**
 * The read-side closed set: what a stored row may carry in verifiedTrust.
 * The write side is narrower (CLAIMABLE_TRUST_CODES); the difference is the fix.
 */
export const EVIDENCE_TRUST_CODES = ['SOURCE_ATTESTED', 'OPERATOR_ASSERTED', 'UNVERIFIED'] as const;
/** What this form offers. The API also accepts REFUTED; that value is not exposed here. */
export const VERDICT_CHOICES = ['CONFIRMED', 'INCONCLUSIVE'] as const;

/** A verdict rationale shorter than this is a 400 from the kernel; the form says so up front. */
export const RATIONALE_MIN_CHARS = 10;
/** Kernel bounds on the create form (apps/kernel/src/incidents.rs, insert_incident). */
export const TITLE_MIN_CHARS = 4;
export const TITLE_MAX_CHARS = 200;

export const OWNER_ANY = 'ALL';
export const OWNER_SELF = 'ME';
export const FILTER_ANY = 'ALL';

export interface IncidentQuery {
  status?: string | null;
  severity?: string | null;
  /** A resolved user id, or null for "every owner my role can see". */
  owner?: string | null;
  limit?: number;
  cursor?: string | null;
}

/**
 * The list URL's query string. Empty filters are omitted instead of sent as "ALL": the kernel
 * validates status/severity against a closed set and would answer 400 for the word ALL.
 */
export function incidentListQuery(query: IncidentQuery): string {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit ?? 20));
  for (const [key, value] of [
    ['status', query.status],
    ['severity', query.severity],
    ['owner', query.owner],
  ] as const) {
    const trimmed = (value ?? '').trim();
    if (!trimmed || trimmed === FILTER_ANY) continue;
    params.set(key, trimmed);
  }
  if (query.cursor) params.set('cursor', query.cursor);
  return params.toString();
}

/**
 * What the owner select actually sends.
 *
 * "Only mine" is resolved to the signed-in user's id here rather than in the component, so the
 * filter cannot be a label that sends nothing. A viewer or admin may also pick a named owner
 * when the user directory is readable; an operator asking for someone else's rows gets an empty
 * page, because the server applies its own scope before this filter.
 */
export function ownerFilterValue(ownerFilter: string, selfId: string | null): string | null {
  if (!ownerFilter || ownerFilter === OWNER_ANY) return null;
  if (ownerFilter === OWNER_SELF) return selfId;
  return ownerFilter;
}

/**
 * What the kernel says the incident list will show this caller, sent beside the rows.
 * Mirrors `incidents::IncidentScopeView` in apps/kernel/src/incidents.rs.
 *
 * It lives here rather than in types.ts for the reason `AuditScope` lives in lib/audit-scope.ts:
 * a scope only means something next to the helper that reads it, and the empty-list decision is
 * that helper. A type declared in both places would be a second copy of the contract.
 */
export interface IncidentScope {
  /**
   * The field this read was narrowed on; `null` when it applied no owner narrowing.
   *
   * `null` is the absence of a restriction this field can name. It is NOT the claim that the
   * page holds every incident that exists - that would be a sentence about the world, and this
   * payload only knows what this read did (ADR-G11-001 4.6,
   * docs/design/g12-scope/narrowed-reads.md 3.4). The `seesAll` boolean this type used to carry
   * was read as exactly that claim, which is why it is gone rather than renamed.
   */
  narrowedTo: 'owner' | null;
  /**
   * How many business workspaces bounded this read. Zero is the one value that explains an
   * empty list completely and that no role explains: since D5 a caller reads a business row
   * because it is a MEMBER of the workspace the row lives in, so a caller in no workspace
   * cannot be shown a row by any read in the kernel. A count of the bound applied - never a
   * count of what exists.
   */
  workspaceCount: number;
}

/**
 * GET /api/v1/incidents: the rows and the read they were produced under.
 *
 * `scope` is null when the body carried none (an older kernel, or a test fixture). Never
 * assumed to be unnarrowed: an unknown scope is not an empty permission slice, and it is not
 * an empty ledger either.
 */
export interface IncidentListPayload extends IncidentList {
  scope: IncidentScope | null;
}

/** Why the incident list is empty: three different facts a reader must never see mixed up. */
export type IncidentEmptyKind =
  /** The page's own filters hid every row the kernel sent. Clearing them can show rows. */
  | 'filtered'
  /**
   * The kernel sent no row because this read was narrowed to what the caller owns. Not a
   * filter, and not evidence that the platform has recorded nothing - an operator owns none of
   * it.
   */
  | 'scoped'
  /**
   * The caller is a member of no business workspace, so no read can return a row. This
   * outranks both filters and the owner narrowing: clearing a filter cannot conjure a row
   * that a zero-membership scope can never return, and telling a viewer "you own nothing"
   * when the truth is "you were never granted anything" sends it to the wrong remedy.
   */
  | 'workspace'
  /**
   * The kernel named no narrowing and sent no row: this read applied no owner restriction and
   * still returned nothing. That is a fact about the read. It is not a count of the platform,
   * and the copy for this state is not allowed to phrase it as one.
   */
  | 'none';

/**
 * Which of the three an empty incident list is, from the kernel's scope and the page's filters.
 *
 * The precedence is the opposite of the audit ledger's, and deliberately so. There a refused
 * kind outranks a filter, because clearing a filter cannot conjure a row of a kind the kernel
 * never sends. Here narrowing does not refuse the rows the reader owns: it limits the list to
 * them, so a filter that matches none of them is still the cause, and blaming the scope would
 * send the reader to a boundary they cannot cross instead of to the button that helps.
 *
 * A missing scope ranks last: it licenses only the claim that needs no evidence - this read
 * returned nothing. An unreadable body is not an unnarrowed one (lib/audit-scope.ts makes the
 * same choice for the same reason), but it is also no longer able to make the page say anything
 * about the platform, because 'none' no longer says anything about it either.
 */
export function incidentsEmptyKind(input: { scope: IncidentScope | null; filtering: boolean }): IncidentEmptyKind {
  const { scope, filtering } = input;
  if (scope?.workspaceCount === 0) return 'workspace';
  if (filtering) return 'filtered';
  if (scope?.narrowedTo === 'owner') return 'scoped';
  return 'none';
}

/**
 * Failure copy, by the stable error code the kernel sends. The code decides; the server's
 * English sentence is never rendered as copy (rules/06). A code with no entry is reported with
 * the code itself in a <code> element and a generic sentence around it.
 */
const FAILURE_KEYS: Record<string, MessageKey> = {
  FORBIDDEN: 'incidents.error.forbidden',
  INVALID_REQUEST: 'incidents.error.invalidRequest',
  CSRF_FAILED: 'incidents.error.csrf',
  INCIDENT_NOT_FOUND: 'incidents.error.notFound',
  INCIDENT_EVIDENCE_REQUIRED: 'incidents.error.evidenceRequired',
  INCIDENT_ALREADY_CONCLUDED: 'incidents.error.alreadyConcluded',
  INCIDENT_CLOSED: 'incidents.error.closed',
  INCIDENT_STATE_CONFLICT: 'incidents.error.stateConflict',
  INCIDENT_VERDICT_NOT_FOUND: 'incidents.error.verdictMissing',
  INCIDENT_WRITE_CONFLICT: 'incidents.error.writeConflict',
  // D5: an account that is a member of no business workspace has nowhere to file a record,
  // and one that is a member of several must say which. Two codes, because one of them is
  // fixable by the caller and the other needs an administrator.
  INCIDENT_WORKSPACE_FORBIDDEN: 'incidents.error.workspaceForbidden',
  INCIDENT_WORKSPACE_REQUIRED: 'incidents.error.workspaceRequired',
  BUSINESS_WORKSPACE_NOT_FOUND: 'incidents.error.workspaceNotFound',
  // G12 A1. Four codes, because "the server said no" is not one situation: an
  // unverifiable attestation and a stale one are different mistakes with different
  // remedies, and collapsing them into one sentence would hide which happened.
  EVIDENCE_TRUST_NOT_SELF_ASSERTABLE: 'incidents.error.notSelfAssertable',
  EVIDENCE_ATTESTATION_INVALID: 'incidents.error.attestationInvalid',
  EVIDENCE_ATTESTATION_STALE: 'incidents.error.attestationStale',
  EVIDENCE_ADAPTER_UNKNOWN: 'incidents.error.adapterUnknown',
  // G12 C. Five refusals that a closure can produce, each a different obstacle and
  // therefore a different sentence: 'not concludable', 'no verdict', 'someone else
  // closed it', 'it already is closed', 'your version is stale'.
  INCIDENT_CLOSE_REQUIRES_CONCLUDED: 'incidents.error.closeRequiresConcluded',
  INCIDENT_CLOSE_REQUIRES_VERDICT: 'incidents.error.closeRequiresVerdict',
  INCIDENT_ALREADY_CLOSED: 'incidents.error.alreadyClosed',
  INCIDENT_VERSION_CONFLICT: 'incidents.error.versionConflict',
  AUDIT_WRITE_FAILED: 'incidents.error.auditFailed',
  // And four for a handover: the target is unknown, disabled, cannot operate, or is
  // already the owner.
  INCIDENT_OWNER_UNKNOWN: 'incidents.error.ownerUnknown',
  INCIDENT_OWNER_DISABLED: 'incidents.error.ownerDisabled',
  INCIDENT_OWNER_ROLE_INELIGIBLE: 'incidents.error.ownerRoleIneligible',
  INCIDENT_OWNER_UNCHANGED: 'incidents.error.ownerUnchanged',
};

export function incidentFailureKey(code?: string | null): MessageKey | null {
  if (!code) return null;
  return FAILURE_KEYS[code] ?? null;
}

export type EvidencePanelState = 'loading' | 'present' | 'missing' | 'unavailable' | 'forbidden';

/**
 * Which evidence panel to draw.
 *
 * Four answers, kept apart on purpose: `missing` is a fact the kernel asserted (it answered and
 * the list is empty), `unavailable` is the absence of an answer, `forbidden` is an answer that
 * says a grant is what fixes it and a retry is not, and `loading` is none of those - a panel
 * that says "no evidence" before the request returns is the same lie as an empty list standing
 * in for a failure.
 */
export function evidencePanelState(
  rows: IncidentEvidence[] | null,
  failed: boolean,
  status?: number | null,
): EvidencePanelState {
  if (status === 403) return 'forbidden';
  if (failed && !rows) return 'unavailable';
  if (!rows) return 'loading';
  if (rows.length === 0) return 'missing';
  return 'present';
}

export type VerdictPanelState = 'recorded' | 'open' | 'sealed';

/**
 * A verdict is write-once (ADR-G11-001 §5.1): once recorded the form is replaced by the record.
 * CLOSED is 'sealed' - no write endpoint in this slice reaches it, but the state is honoured
 * rather than rendered as a form that would 409.
 */
export function verdictPanelState(incident: Pick<IncidentView, 'humanVerdict' | 'status'>): VerdictPanelState {
  if (incident.humanVerdict) return 'recorded';
  if (incident.status === 'CLOSED') return 'sealed';
  return 'open';
}
// ---------------------------------------------------------------------------
// G12 C · the lifecycle: closure, handover, and what this account may do
//
// Everything below is presentation. The kernel is the authority for every one of
// these answers - it re-checks the role, the data scope, the verdict and the
// revision on every write (apps/kernel/src/incidents.rs close_incident_record /
// transfer_incident_owner) - and the server-side 403/404/409 tests are the proof
// that the UI is not what enforces them. What these functions buy is that a viewer
// reads a sentence instead of submitting a form that is guaranteed to fail.
// ---------------------------------------------------------------------------

/** Kernel bounds from migration 0019 / incidents.rs; the forms validate against them. */
export const CLOSURE_NOTE_MIN_CHARS = 4;
export const CLOSURE_NOTE_MAX_CHARS = 1000;
export const TRANSFER_REASON_MIN_CHARS = 10;
export const TRANSFER_REASON_MAX_CHARS = 1000;

/** Which operations can still act on an incident, and why not when they cannot. */
export type ClosurePanelState = 'closed' | 'ready' | 'not-concludable';

/**
 * The closure panel's three answers.
 *
 * 'not-concludable' is not an error state: OPEN and INVESTIGATING simply have no way
 * into CLOSED (the kernel refuses it with INCIDENT_CLOSE_REQUIRES_CONCLUDED), so the
 * panel says what has to happen first instead of offering a disabled button.
 */
export function closurePanelState(incident: Pick<IncidentView, 'status'>): ClosurePanelState {
  if (incident.status === 'CLOSED') return 'closed';
  if (incident.status === 'CONCLUDED') return 'ready';
  return 'not-concludable';
}

export interface IncidentCapabilities {
  canAddEvidence: boolean;
  canRecordVerdict: boolean;
  canClose: boolean;
  canTransferOwner: boolean;
  /** Why writing is unavailable at all (a viewer), or null when the account may write. */
  readOnlyReason: MessageKey | null;
  /** Why the closure is not offered, or null when it is. */
  closeBlockedReason: MessageKey | null;
  /** Why the handover is not offered, or null when it is. */
  transferBlockedReason: MessageKey | null;
}

export interface CapabilityInput {
  incident: Pick<IncidentView, 'status' | 'owner' | 'humanVerdict'>;
  userId: string | null;
  role: Role | null;
}

/**
 * What the page may offer this account for this incident.
 *
 * It mirrors, and does not replace, the kernel's rules: the operator data scope is
 * `owner = caller` (admin and viewer see every incident), the write gate is the
 * operator/admin role, and CLOSED accepts no write at all.
 */
export function incidentCapabilities({ incident, userId, role }: CapabilityInput): IncidentCapabilities {
  const canOperate = role === 'operator' || role === 'admin';
  // D5 RESIDUE, recorded rather than hidden: this line still infers "can read it" from the
  // role, and since D5 the readable set is membership, which the page does not have here.
  // It only picks WHICH refusal sentence to show - the server already answered 404 for an
  // incident this account may not read, so the component never receives one - and the two
  // sentences are both refusals. Closing this properly means passing the scope into this
  // function, which is a page-shape change and belongs with the workspace selector, not
  // with the security model. docs/design/g12-scope/d5-business-workspace-adr.md section 10.
  const seesAll = role === 'admin' || role === 'viewer';
  const visible = Boolean(userId) && (seesAll || incident.owner === userId);
  const closed = incident.status === 'CLOSED';
  const concludable = incident.status === 'CONCLUDED' && Boolean(incident.humanVerdict);

  const mayWrite = canOperate && visible;
  const readOnlyReason: MessageKey | null = visible && !canOperate ? 'incidents.permission.viewerReadOnly' : null;

  const closeBlockedReason: MessageKey | null = !visible
    ? 'incidents.permission.outOfScope'
    : !canOperate
      ? 'incidents.permission.viewerClose'
      : closed
        ? null
        : incident.status !== 'CONCLUDED'
          ? 'incidents.close.blocked.notConcluded'
          : !incident.humanVerdict
            ? 'incidents.close.blocked.noVerdict'
            : null;

  const transferBlockedReason: MessageKey | null = !visible
    ? 'incidents.permission.outOfScope'
    : !canOperate
      ? 'incidents.permission.viewerTransfer'
      : closed
        ? 'incidents.close.blocked.closedTransfer'
        : null;

  return {
    canAddEvidence: mayWrite && !closed,
    canRecordVerdict: mayWrite && !closed && !incident.humanVerdict,
    canClose: mayWrite && concludable,
    canTransferOwner: mayWrite && !closed,
    readOnlyReason,
    closeBlockedReason,
    transferBlockedReason,
  };
}

/**
 * Whether handing an incident over ends this account's access to it.
 *
 * The kernel's operator read scope IS the owner column, so an operator who transfers an
 * incident away can no longer read it, while the roles that see every incident keep it. The
 * answer is derived from the role and not from the write's response on purpose: a write's own
 * echo is not evidence of what happened (docs/design/ui-visual-v3/code-rules.md A5), and the page
 * must not need it to tell the operator the truth.
 */
export function losesAccessAfterHandover(role: Role | null): boolean {
  return role === 'operator';
}

/** The body POST /incidents/{id}/close expects, built from the record on screen. */
export interface CloseIncidentPayload {
  expectedRevision: number;
  note: string;
  idempotencyKey: string;
}

export function closeIncidentPayload(revision: number, note: string, idempotencyKey: string): CloseIncidentPayload {
  return { expectedRevision: revision, note: note.trim(), idempotencyKey };
}

/** The body POST /incidents/{id}/owner expects. */
export interface TransferIncidentPayload {
  expectedRevision: number;
  toOwner: string;
  reason: string;
}

export function transferIncidentPayload(revision: number, toOwner: string, reason: string): TransferIncidentPayload {
  return { expectedRevision: revision, toOwner, reason: reason.trim() };
}

/**
 * One key per close attempt, generated before the request leaves.
 *
 * The kernel answers a retry carrying the same key with the closure that happened, and a
 * second close with no key as 409 - so the key must be created once per submission attempt
 * and reused by its retries, never regenerated on a click that follows a timeout.
 */
export function newIdempotencyKey(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();
  // Fallback for a context without WebCrypto. Uniqueness per client is all this key needs.
  return 'close-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

/** Field-level validation the kernel would answer 400 for; the form says it first. */
export function closureNoteError(note: string): MessageKey | null {
  const length = note.trim().length;
  if (length < CLOSURE_NOTE_MIN_CHARS || length > CLOSURE_NOTE_MAX_CHARS) return 'incidents.close.noteHint';
  return null;
}

export function transferReasonError(reason: string): MessageKey | null {
  const length = reason.trim().length;
  if (length < TRANSFER_REASON_MIN_CHARS || length > TRANSFER_REASON_MAX_CHARS) return 'incidents.transfer.reasonHint';
  return null;
}

/**
 * A row the Kernel vouched for itself, as opposed to one an operator merely asserted.
 *
 * SOURCE_ATTESTED is the only trust value an adapter's signature can produce (G12 A1), so
 * it is the only one this page is allowed to call 'verified'.
 */
export function isKernelVerified(row: Pick<IncidentEvidence, 'verifiedTrust'>): boolean {
  return row.verifiedTrust === 'SOURCE_ATTESTED';
}

export function kernelVerifiedCount(rows: IncidentEvidence[]): number {
  return rows.filter(isKernelVerified).length;
}

// -- the audit trail -------------------------------------------------------

const TIMELINE_EVENT_KEYS: Record<string, MessageKey> = {
  INCIDENT_CREATED: 'incidents.timeline.event.created',
  INCIDENT_EVIDENCE_ADDED: 'incidents.timeline.event.evidence',
  INCIDENT_VERDICT_RECORDED: 'incidents.timeline.event.verdict',
  INCIDENT_OWNER_TRANSFERRED: 'incidents.timeline.event.transferred',
  INCIDENT_CLOSED: 'incidents.timeline.event.closed',
};

/**
 * The copy for one audit event type.
 *
 * The set is open by contract, so an event type this build has never heard of renders as
 * 'other' next to its raw code - a trail that hides rows it does not recognise would be a
 * shorter history than the one the kernel holds.
 */
export function timelineEventKey(eventType?: string | null): MessageKey {
  if (eventType && TIMELINE_EVENT_KEYS[eventType]) return TIMELINE_EVENT_KEYS[eventType];
  return 'incidents.timeline.event.other';
}

export function timelineEventTone(eventType?: string | null): StatusTone {
  if (eventType === 'INCIDENT_CLOSED') return 'neutral';
  if (eventType === 'INCIDENT_OWNER_TRANSFERRED') return 'info';
  if (eventType === 'INCIDENT_VERDICT_RECORDED') return 'ok';
  if (eventType === 'INCIDENT_EVIDENCE_ADDED') return 'info';
  return 'neutral';
}

/** The typed projection of one event's `details`, which the contract leaves free-form. */
export interface TimelineEventFacts {
  evidenceKind: string | null;
  verifiedTrust: string | null;
  verdict: string | null;
  consideredEvidenceCount: number | null;
  fromOwner: string | null;
  toOwner: string | null;
  reason: string | null;
  closureNote: string | null;
}

function textField(details: Record<string, unknown>, key: string): string | null {
  const value = details[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function timelineEventFacts(event: Pick<IncidentTimelineEvent, 'details'>): TimelineEventFacts {
  const details = event.details ?? {};
  const count = details.consideredEvidenceCount;
  return {
    evidenceKind: textField(details, 'kind'),
    verifiedTrust: textField(details, 'verifiedTrust'),
    verdict: textField(details, 'verdict'),
    consideredEvidenceCount: typeof count === 'number' && Number.isFinite(count) ? count : null,
    fromOwner: textField(details, 'fromOwner'),
    toOwner: textField(details, 'toOwner'),
    reason: textField(details, 'reason'),
    closureNote: textField(details, 'closureNote'),
  };
}

export type IncidentFactKind = 'started' | 'evidence' | 'verdict';

/**
 * One row of the detail timeline, built only from timestamps the kernel returned.
 *
 * There is no "status changed" event here: the slice records no status history table, so a
 * timeline point for one would be invented. What exists is the start, each evidence row's own
 * `collectedAt` (which is deliberately separable from its insert time), and the verdict.
 */
export interface IncidentFact {
  id: string;
  kind: IncidentFactKind;
  at: string;
  /** False when `at` is not a parseable timestamp; the UI prints the raw value instead of a lie. */
  atValid: boolean;
  evidence: IncidentEvidence | null;
  verdict: IncidentVerdict | null;
}

export function incidentFacts(incident: IncidentView, evidence: IncidentEvidence[]): IncidentFact[] {
  const facts: IncidentFact[] = [
    { id: 'started', kind: 'started', at: incident.startedAt, atValid: Number.isFinite(Date.parse(incident.startedAt)), evidence: null, verdict: null },
  ];
  for (const row of evidence) {
    facts.push({ id: 'evidence:' + row.id, kind: 'evidence', at: row.collectedAt, atValid: Number.isFinite(Date.parse(row.collectedAt)), evidence: row, verdict: null });
  }
  if (incident.humanVerdict) {
    const decidedAt = incident.humanVerdict.decidedAt;
    facts.push({ id: 'verdict', kind: 'verdict', at: decidedAt, atValid: Number.isFinite(Date.parse(decidedAt)), evidence: null, verdict: incident.humanVerdict });
  }
  // Newest first; a row whose timestamp cannot be read sorts last and says so.
  return facts
    .map((fact, order) => ({ fact, order }))
    .sort((left, right) => {
      const leftAt = left.fact.atValid ? Date.parse(left.fact.at) : Number.NEGATIVE_INFINITY;
      const rightAt = right.fact.atValid ? Date.parse(right.fact.at) : Number.NEGATIVE_INFINITY;
      if (leftAt !== rightAt) return rightAt - leftAt;
      return left.order - right.order;
    })
    .map((entry) => entry.fact);
}

/**
 * The first characters of an owner id.
 *
 * The user directory is admin-only (`GET /api/v1/users` requires the admin role), so an operator
 * or viewer has no name to print. A truncated id is a fact; inventing "Unknown user" would be a
 * claim about the account rather than about what this page could read.
 */
export function shortOwner(owner?: string | null): string {
  if (!owner) return '';
  return owner.slice(0, 8);
}

/** A create form's local datetime-local value, in the shape the kernel parses (ISO 8601 UTC). */
export function toIsoInstant(localValue: string): string | null {
  if (!localValue) return null;
  const parsed = new Date(localValue);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/** `datetime-local` needs "YYYY-MM-DDTHH:mm"; the incident's own start seeds the form. */
export function toLocalInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/* ── the two remaining closed sets: evidence kind, and how much a row can carry ──────── */

const EVIDENCE_KIND_KEYS: Record<string, MessageKey> = {
  METRIC_SNAPSHOT: 'incidents.evidenceKind.metricSnapshot',
  LOG_EXCERPT: 'incidents.evidenceKind.logExcerpt',
  QUERY_RESULT: 'incidents.evidenceKind.queryResult',
  OPERATOR_NOTE: 'incidents.evidenceKind.operatorNote',
};

/** A catalog key for every code the contract allows, and one for a code it does not. */
export function evidenceKindKey(code?: string | null): MessageKey {
  if (!code) return 'incidents.evidenceKind.unknown';
  return EVIDENCE_KIND_KEYS[code.toUpperCase()] ?? 'incidents.evidenceKind.unknown';
}

const EVIDENCE_TRUST_KEYS: Record<string, MessageKey> = {
  SOURCE_ATTESTED: 'incidents.trust.sourceAttested',
  OPERATOR_ASSERTED: 'incidents.trust.operatorAsserted',
  UNVERIFIED: 'incidents.trust.unverified',
};

/**
 * Trust is the anti-forgery field (ADR-G11-001 §2.2): a hand-written note and a source-attested
 * metric snapshot must not look alike, which is a tone, not a sentence.
 */
export function evidenceTrustKey(code?: string | null): MessageKey {
  if (!code) return 'incidents.trust.unknown';
  return EVIDENCE_TRUST_KEYS[code.toUpperCase()] ?? 'incidents.trust.unknown';
}

export function evidenceTrustTone(code?: string | null): StatusTone {
  switch ((code ?? '').toUpperCase()) {
    case 'SOURCE_ATTESTED': return 'ok';
    case 'OPERATOR_ASSERTED': return 'info';
    case 'UNVERIFIED': return 'warn';
    default: return 'unknown';
  }
}

/**
 * Where the record came from. The slice's source set is exactly {MANUAL, API}; the page states
 * that Zabbix and Nebula are not connected, so this label is the whole provenance story.
 */
export function incidentSourceKey(code?: string | null): MessageKey {
  switch ((code ?? '').toUpperCase()) {
    case 'MANUAL': return 'incidents.source.manual';
    case 'API': return 'incidents.source.api';
    default: return 'incidents.source.unknown';
  }
}
/* ── G12 A1: the claim and the verdict are two different fields ─────────────────────── */

/**
 * What a submitter may say about its own row.
 *
 * SOURCE_ATTESTED is absent on purpose, and its absence is not the defence: the kernel refuses
 * the value in claimedTrust as well, and refuses a body "trust" field outright. Removing the
 * option here only stops the form from offering something that would be a 400.
 */
export const CLAIMABLE_TRUST_CODES = ['OPERATOR_ASSERTED', 'UNVERIFIED'] as const;

const VERIFICATION_METHOD_KEYS: Record<string, MessageKey> = {
  NONE: 'incidents.verificationMethod.none',
  OPERATOR_IDENTITY: 'incidents.verificationMethod.operatorIdentity',
  SOURCE_ADAPTER: 'incidents.verificationMethod.sourceAdapter',
};

/** How the kernel reached its conclusion. A method with no entry prints the raw code. */
export function verificationMethodKey(code?: string | null): MessageKey {
  if (!code) return 'incidents.verificationMethod.none';
  return VERIFICATION_METHOD_KEYS[code.toUpperCase()] ?? 'incidents.verificationMethod.unknown';
}

/**
 * True when what the submitter claimed and what the kernel established differ.
 *
 * This is the honest way to render the split: not by hiding the claim, but by showing when the
 * claim was not upheld. A row that claimed UNVERIFIED and was verified as OPERATOR_ASSERTED is
 * also a mismatch, in the harmless direction - the kernel found more than the submitter claimed.
 */
export function trustMismatch(row: Pick<IncidentEvidence, 'claimedTrust' | 'verifiedTrust'>): boolean {
  return (row.claimedTrust ?? '').toUpperCase() !== (row.verifiedTrust ?? '').toUpperCase();
}

/* ── G12 A2: route identity, refresh, and out-of-order answers ───────────────────────── */

/** A failure reduced to the two facts that decide what the page may keep showing. */
export interface IncidentFailure {
  status: number | null;
  code: string | null;
}

/**
 * Reads status and code off whatever was thrown.
 *
 * Duck-typed instead of narrowing on ApiError so this module stays a pure function of wire
 * payloads: the whole routing rule below is then testable without a browser, a router or a fetch.
 */
export function classifyFailure(cause: unknown): IncidentFailure {
  const error = cause as { status?: unknown; code?: unknown } | null | undefined;
  return {
    status: typeof error?.status === 'number' ? error.status : null,
    code: typeof error?.code === 'string' ? error.code : null,
  };
}

/**
 * The failures that take away the right to keep showing what is on screen.
 *
 * 401/403/404 are answers: the caller is not allowed, or the thing is not there for them. A 5xx
 * or a network error is the absence of an answer, and an absence is not a reason to erase a record
 * the user was already reading - that is the stale case, handled by keeping the data.
 */
export function clearsSensitiveView(failure: IncidentFailure | null | undefined): boolean {
  if (!failure) return false;
  return failure.status === 401 || failure.status === 403 || failure.status === 404;
}

export type DetailPhase = 'loading' | 'ready' | 'not-found' | 'denied' | 'failed';

/**
 * Everything the detail page knows, tagged with the route id it describes.
 *
 * The tag is the whole point: a snapshot answers "what do I know about incident X", and it is
 * only ever rendered for X. Nothing here is keyed on a timer.
 */
export interface IncidentDetailSnapshot {
  routeId: string;
  incident: IncidentView | null;
  evidence: IncidentEvidence[] | null;
  /**
   * The failure itself, not a summary of it: the notice prints the kernel's code and request id,
   * so reducing it to {status, code} here would lose the half of it the user can quote.
   */
  incidentError: unknown;
  evidenceError: unknown;
  /** When the incident was last read successfully. The stale banner prints this, not "just now". */
  observedAt: string | null;
  /** A same-id refresh is in flight. Never used to hide data that is already known. */
  refreshing: boolean;
}

export function emptyDetail(routeId: string): IncidentDetailSnapshot {
  return {
    routeId,
    incident: null,
    evidence: null,
    incidentError: null,
    evidenceError: null,
    observedAt: null,
    refreshing: true,
  };
}

export type DetailAction =
  | { type: 'route'; routeId: string }
  | { type: 'refresh' }
  | { type: 'incident'; routeId: string; incident: IncidentView; observedAt: string }
  | { type: 'incident-failed'; routeId: string; cause: unknown }
  | { type: 'evidence'; routeId: string; evidence: IncidentEvidence[] }
  | { type: 'evidence-failed'; routeId: string; cause: unknown };

/**
 * The detail page's state machine.
 *
 * Two rules, and both are about what must NOT happen:
 *
 *   1. A route change clears. Arriving at /incidents/B must never render /incidents/A's title,
 *      evidence or verdict for even one frame, so the reset happens here rather than after the
 *      new request returns.
 *   2. A response for another route is dropped. This is the out-of-order guard, and it is a
 *      comparison - not a delay. A slow answer for A cannot land on B's snapshot because the
 *      snapshot is tagged and the tag is compared.
 *
 * A same-id refresh (the Refresh button, or a write) keeps the data it has: the id did not change,
 * so what is on screen still describes the right incident.
 */
export function detailReducer(
  state: IncidentDetailSnapshot,
  action: DetailAction,
): IncidentDetailSnapshot {
  switch (action.type) {
    case 'route':
      if (action.routeId === state.routeId) return state;
      return emptyDetail(action.routeId);
    case 'refresh':
      return { ...state, refreshing: true };
    case 'incident':
      if (action.routeId !== state.routeId) return state;
      return {
        ...state,
        incident: action.incident,
        incidentError: null,
        observedAt: action.observedAt,
        refreshing: false,
      };
    case 'evidence':
      if (action.routeId !== state.routeId) return state;
      return { ...state, evidence: action.evidence, evidenceError: null };
    case 'incident-failed': {
      if (action.routeId !== state.routeId) return state;
      if (clearsSensitiveView(classifyFailure(action.cause))) {
        return { ...state, incident: null, evidence: null, incidentError: action.cause, evidenceError: null, observedAt: null, refreshing: false };
      }
      // A failed refresh on the same id: keep the record, say it is stale.
      return { ...state, incidentError: action.cause, refreshing: false };
    }
    case 'evidence-failed': {
      if (action.routeId !== state.routeId) return state;
      if (clearsSensitiveView(classifyFailure(action.cause))) {
        return { ...state, evidence: null, evidenceError: action.cause };
      }
      return { ...state, evidenceError: action.cause };
    }
    default:
      return state;
  }
}

/**
 * What the page is allowed to render for the route it is currently on.
 *
 * The last line of defence, and the cheapest: if the snapshot describes a different id than the
 * URL, the page gets an empty snapshot for the URL's id. A state update that slipped past the
 * reducer cannot leak the previous incident through here.
 */
export function projectDetail(
  state: IncidentDetailSnapshot,
  routeId: string,
): IncidentDetailSnapshot {
  if (state.routeId === routeId) return state;
  return emptyDetail(routeId);
}

export function detailPhase(state: IncidentDetailSnapshot): DetailPhase {
  if (state.incident) return 'ready';
  if (!state.incidentError) return 'loading';
  const failure = classifyFailure(state.incidentError);
  if (failure.status === 404) return 'not-found';
  if (clearsSensitiveView(failure)) return 'denied';
  return 'failed';
}

/* ── G12 A3: what the verdict considered, and what came after ───────────────────────── */

export interface EvidencePartition {
  /** Rows that existed when the verdict was signed. */
  considered: IncidentEvidence[];
  /** Rows appended after signing. They are evidence, but they are not what was signed. */
  afterVerdict: IncidentEvidence[];
}

/**
 * Splits the evidence list by the verdict, using the kernel's afterVerdict flag and nothing else.
 *
 * With no verdict every row is simply evidence; there is nothing it could have been considered
 * against. With a verdict, the split is the difference between "the signer weighed this" and "a
 * later addition", and the page must not render them as the same thing.
 */
export function partitionEvidence(
  evidence: IncidentEvidence[],
  verdict: IncidentVerdict | null,
): EvidencePartition {
  if (!verdict) return { considered: evidence, afterVerdict: [] };
  const considered: IncidentEvidence[] = [];
  const afterVerdict: IncidentEvidence[] = [];
  for (const row of evidence) {
    if (row.afterVerdict) afterVerdict.push(row);
    else considered.push(row);
  }
  return { considered, afterVerdict };
}

export type VerdictSnapshotState = 'recorded' | 'unknown';

/**
 * Whether the verdict's considered set is a record or an unknown.
 *
 * PRE_MIGRATION_UNRECORDED is not an edge case to smooth over: those verdicts were signed before
 * the set was stored, so the only truthful rendering is "the set is unknown". Deriving it from
 * timestamps and presenting that as the record is exactly the silent rewrite this phase is about.
 */
export function verdictSnapshotState(verdict: Pick<IncidentVerdict, 'snapshotKind'>): VerdictSnapshotState {
  return verdict.snapshotKind === 'RECORDED' ? 'recorded' : 'unknown';
}

/* ── G12 B: the bytes behind an evidence row ────────────────────────────────────────── */

/**
 * The read-side closed set for where a row's content is.
 *
 * STORED means the kernel holds bytes for this row and a separate request can serve them.
 * LEGACY_REFERENCE means it holds a locator and nothing else - the row is not weaker evidence,
 * it is evidence whose bytes this kernel cannot show, and the page must say that instead of
 * printing the locator as if it were the payload (ADR-G12-002 §1.2).
 */
export const EVIDENCE_CONTENT_STATUS_CODES = ['STORED', 'LEGACY_REFERENCE'] as const;

const CONTENT_STATUS_KEYS: Record<string, MessageKey> = {
  STORED: 'incidents.content.status.stored',
  LEGACY_REFERENCE: 'incidents.content.status.legacy',
};

export function evidenceContentStatusKey(code?: string | null): MessageKey {
  if (!code) return 'incidents.content.status.legacy';
  return CONTENT_STATUS_KEYS[code.toUpperCase()] ?? 'incidents.content.status.legacy';
}

/**
 * A tone, not a verdict about the evidence.
 *
 * STORED is deliberately 'info' and never 'ok': holding the bytes proves the content did not
 * change, it does not prove the source told the truth. Painting it green would merge the two
 * axes this whole phase exists to separate (ADR-G12-002 §1.6).
 */
export function evidenceContentStatusTone(code?: string | null): StatusTone {
  switch ((code ?? '').toUpperCase()) {
    case 'STORED': return 'info';
    case 'LEGACY_REFERENCE': return 'warn';
    default: return 'unknown';
  }
}

/** Whether the viewer should fetch bytes at all. A legacy row has none to fetch. */
export function contentPanelMode(status?: string | null): 'stored' | 'legacy' {
  return (status ?? '').toUpperCase() === 'STORED' ? 'stored' : 'legacy';
}

/**
 * What the content request returned, as one state.
 *
 * Four failures stay four states because they are four different facts: the kernel holds no
 * bytes (unavailable), it holds bytes it will not serve any more (expired), it holds bytes that
 * no longer match their digest (integrity), and it will not answer this caller at all (denied).
 * Collapsing them into "failed" would tell the reader to retry a tamper.
 */
export type ContentReadPhase = 'loading' | 'ready' | 'expired' | 'unavailable' | 'integrity' | 'denied' | 'failed';

export function contentFailurePhase(failure: unknown): ContentReadPhase | null {
  if (!failure) return null;
  const { status, code } = classifyFailure(failure);
  switch (code) {
    case 'EVIDENCE_CONTENT_EXPIRED': return 'expired';
    case 'EVIDENCE_CONTENT_NOT_STORED': return 'unavailable';
    case 'EVIDENCE_NOT_FOUND': return 'unavailable';
    case 'EVIDENCE_CONTENT_INTEGRITY_FAILED': return 'integrity';
    default: break;
  }
  if (status === 401 || status === 403) return 'denied';
  // INCIDENT_NOT_FOUND covers both "absent" and "outside the caller scope", and for content the
  // honest reading of either is the same: this caller does not get these bytes.
  if (code === 'INCIDENT_NOT_FOUND') return 'denied';
  return 'failed';
}

/** Copy for every terminal phase. loading/ready draw their own thing. */
const CONTENT_PHASE_KEYS: Record<string, { title: MessageKey; description: MessageKey }> = {
  expired: { title: 'incidents.content.phase.expired.title', description: 'incidents.content.phase.expired.description' },
  unavailable: { title: 'incidents.content.phase.unavailable.title', description: 'incidents.content.phase.unavailable.description' },
  integrity: { title: 'incidents.content.phase.integrity.title', description: 'incidents.content.phase.integrity.description' },
  denied: { title: 'incidents.content.phase.denied.title', description: 'incidents.content.phase.denied.description' },
  failed: { title: 'incidents.content.phase.failed.title', description: 'incidents.content.phase.failed.description' },
};

export function contentPhaseKeys(phase: ContentReadPhase): { title: MessageKey; description: MessageKey } | null {
  return CONTENT_PHASE_KEYS[phase] ?? null;
}

/** A digest in lowercase hex. Null when the platform offers no WebCrypto (the state says so). */
export async function sha256Hex(text: string): Promise<string | null> {
  const subtle = typeof globalThis.crypto === 'undefined' ? undefined : globalThis.crypto.subtle;
  if (!subtle) return null;
  const bytes = new TextEncoder().encode(text);
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * The browser's own verdict on the bytes it received.
 *
 * This is the whole point of the viewer: the page does not take the kernel's digest header on
 * faith, it recomputes sha256 over the text it is about to display and compares. 'unknown' is
 * not a pass - it says this browser could not compute a digest, and it is rendered as such.
 */
export type DigestVerdict = 'match' | 'mismatch' | 'unknown';

export function digestVerdict(computed: string | null, expected: string | null): DigestVerdict {
  if (!computed || !expected) return 'unknown';
  return computed.toLowerCase() === expected.toLowerCase() ? 'match' : 'mismatch';
}

const DIGEST_KEYS: Record<DigestVerdict, MessageKey> = {
  match: 'incidents.content.digest.match',
  mismatch: 'incidents.content.digest.mismatch',
  unknown: 'incidents.content.digest.unknown',
};

export function digestVerdictKey(verdict: DigestVerdict): MessageKey {
  return DIGEST_KEYS[verdict];
}

export function digestVerdictTone(verdict: DigestVerdict): StatusTone {
  if (verdict === 'match') return 'ok';
  if (verdict === 'mismatch') return 'danger';
  return 'warn';
}

/**
 * The name an export writes.
 *
 * The export is the bytes the server just served, saved by the browser - there is no export
 * endpoint, so a file can never contain content the read did not return.
 */
export function evidenceExportFileName(row: Pick<IncidentEvidence, 'id' | 'contentType'>): string {
  const extension = (row.contentType ?? '') === 'application/json' ? 'json' : 'txt';
  return 'evidence-' + row.id.slice(0, 8) + '.' + extension;
}


/* ---- Incident list model restored from main (#22) ----
 * The G12 branch predates PR #22's incident-list rewrite, so these exports exist only
 * on main. They are appended here rather than re-implemented: pages/incident-trust.tsx,
 * Incidents.tsx and incidents.test.ts import them, and dropping them is a product
 * regression (columning, run collapse, counted-list states and the assurance summary).
 */
export const EVIDENCE_TRUST_CLAIM_CODES = CLAIMABLE_TRUST_CODES;
export function evidenceTrustGlyph(code?: string | null): string {
  switch ((code ?? '').toUpperCase()) {
    case 'SOURCE_ATTESTED': return 'shield';
    case 'OPERATOR_ASSERTED': return 'users';
    case 'UNVERIFIED': return 'circleDashed';
    default: return 'unknown';
  }
}

/**
 * How much the writer claimed, as an order. Higher is a larger claim, never a larger proof.
 *
 * `-1` is reserved for a code outside the contract's closed set, which must never sort as if it
 * were one of the three: an unknown trust word is the one case where the page knows nothing at
 * all, and folding it into the weakest known level would be the same defect the audit found in
 * the job list (seven codes collapsed onto one branch, so a success and a never-observed run
 * drew identically).
 */
export function evidenceTrustRank(code?: string | null): number {
  switch ((code ?? '').toUpperCase()) {
    case 'SOURCE_ATTESTED': return 3;
    case 'OPERATOR_ASSERTED': return 2;
    case 'UNVERIFIED': return 1;
    default: return -1;
  }
}

/** Is this one of the three words the contract allows? Used to mark a row, never to recode it. */
export function isKnownEvidenceTrust(code?: string | null): boolean {
  return evidenceTrustRank(code) > 0;
}

export interface EvidenceAssurance {
  /** How many rows the set holds. */
  total: number;
  /** Rows per trust code, including codes the contract does not define. */
  byCode: Record<string, number>;
  /** The weakest claim present, or null for an empty set. An unknown code is its own answer. */
  weakest: string | null;
  /** True when at least one row carries a code outside the closed set. */
  hasUnknown: boolean;
}

/**
 * What an evidence set is worth, as the set's weakest link rather than its best row.
 *
 * A verdict rests on the whole set, so the summary a reader needs before signing one is the
 * floor, not the ceiling. An unknown code is the floor by definition: the page cannot rank
 * something it cannot read.
 */
export function evidenceAssurance(rows: IncidentEvidence[]): EvidenceAssurance {
  const byCode: Record<string, number> = {};
  let weakest: string | null = null;
  let hasUnknown = false;
  for (const row of rows) {
    const code = (row.verifiedTrust ?? '').toUpperCase() || 'UNSET';
    byCode[code] = (byCode[code] ?? 0) + 1;
    if (!isKnownEvidenceTrust(code)) hasUnknown = true;
    if (weakest === null) { weakest = code; continue; }
    const rank = evidenceTrustRank(code);
    const floor = evidenceTrustRank(weakest);
    // An unrankable code (-1) is already the floor, so it wins any comparison it takes part in.
    if (rank < floor) weakest = code;
  }
  return { total: rows.length, byCode, weakest, hasUnknown };
}


/* ── the list page's own rules: which body to draw, which columns earn width ─────────── */

/**
 * The one state machine behind the list body.
 *
 * `empty`, `forbidden` and `failed` are three different facts and the audit found them drawn
 * as one empty list. They are separated here, by HTTP status rather than by message text, so
 * neither page can regress to "no rows" for a refusal:
 *
 *   * `loading`    - no answer yet, and nothing older on screen;
 *   * `forbidden`  - the kernel refused the read (403). There are no rows to speak of;
 *   * `conflict`   - a 409 the read path can still answer with (cursor raced a write);
 *   * `failed`     - the request did not answer, for any other reason;
 *   * `empty`      - it answered, and the answer is no rows, with no filter narrowing it;
 *   * `filtered`   - it answered zero *for these filters*, which is a different remedy;
 *   * `stale`      - rows are on screen and a later read failed; the old rows stay, labelled;
 *   * `ready`      - rows, fresh.
 */
export type IncidentListState =
  | 'loading' | 'forbidden' | 'conflict' | 'failed' | 'empty' | 'filtered' | 'stale' | 'ready';

/** The HTTP status decides a refusal; the message never does (rules/06). */
function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

export function incidentListState(input: {
  rows: IncidentView[] | null;
  error: unknown;
  loading: boolean;
  filtering: boolean;
}): IncidentListState {
  const { rows, error, loading, filtering } = input;
  // Rows already on screen survive a failed refresh: dropping them would turn a stale read
  // into an empty page, which is the more alarming of the two lies.
  if (rows && rows.length > 0) return error ? 'stale' : 'ready';
  if (error && !rows) {
    const status = statusOf(error);
    if (status === 403) return 'forbidden';
    if (status === 409) return 'conflict';
    return 'failed';
  }
  if (!rows) return loading ? 'loading' : 'failed';
  return filtering ? 'filtered' : 'empty';
}

/* ── the count the toolbar may print ──────────────────────────────────────────────── */

/**
 * Whether the list has actually answered yet, so a row count is a fact.
 *
 * `loading`, `forbidden`, `conflict` and `failed` all reach the renderer with zero rows in hand.
 * Printing "0 on this page" beside them states something the kernel never said - and a reader
 * cannot tell a refused read from a genuinely empty one, which is the confusion the eight states
 * exist to prevent. The toolbar count therefore speaks only in the four answered states.
 */
export const COUNTED_LIST_STATES: readonly IncidentListState[] = ['ready', 'stale', 'empty', 'filtered'];

export function incidentCountKnown(state: IncidentListState): boolean {
  return COUNTED_LIST_STATES.includes(state);
}

/**
 * §2.4: three consecutive rows that say the same thing are one fact.
 *
 * The run key is what a reader would call "the same incident again": same title, same severity,
 * same status, same related entity. The id is deliberately not in the key - every row has a
 * unique one, so including it would make the rule unreachable - and neither is the timestamp,
 * for the reason table-kit's `Identity` records: a key containing a clock stops matching the
 * moment the clock ticks.
 *
 * Only **consecutive** rows collapse. The list arrives newest-first from the kernel, so a run
 * is a burst in time; two bursts a day apart stay two rows, because collapsing them would
 * claim a span the data does not have.
 */
export interface IncidentRun {
  /** The newest row of the run; its id keys the React element and opens the detail page. */
  head: IncidentView;
  /** Rows in the run, newest first. Length 1 is an ordinary row. */
  rows: IncidentView[];
  /** The run's own key, for the §4.1 `data-row-key` the metrics harness counts. */
  key: string;
  /** Oldest `startedAt` in the run - the far end of the span. */
  firstAt: string;
  /** Newest `startedAt` in the run. */
  lastAt: string;
}

/** §2.4's threshold: a run of 1 or 2 renders as rows; 3 or more collapses. */
export const RUN_COLLAPSE_THRESHOLD = 3;

export function incidentRunKey(incident: IncidentView): string {
  return [incident.title, incident.severity, incident.status, incident.relatedEntity ?? ''].join('\u0001');
}

export function collapseIncidentRuns(
  rows: IncidentView[],
  threshold = RUN_COLLAPSE_THRESHOLD,
): IncidentRun[] {
  const runs: IncidentRun[] = [];
  let group: IncidentView[] = [];

  const flush = () => {
    if (group.length === 0) return;
    const key = incidentRunKey(group[0]);
    if (group.length >= threshold) {
      const times = group.map((row) => row.startedAt).filter((at) => Number.isFinite(Date.parse(at)));
      runs.push({
        head: group[0],
        rows: group,
        key,
        // With no readable timestamp in the whole run there is no span to print; the head's own
        // value travels unchanged so the cell can say "unreadable" instead of inventing a date.
        firstAt: times.length ? times[times.length - 1] : group[group.length - 1].startedAt,
        lastAt: times.length ? times[0] : group[0].startedAt,
      });
    } else {
      for (const row of group) {
        runs.push({ head: row, rows: [row], key, firstAt: row.startedAt, lastAt: row.startedAt });
      }
    }
    group = [];
  };

  for (const row of rows) {
    if (group.length > 0 && incidentRunKey(group[0]) !== incidentRunKey(row)) flush();
    group.push(row);
  }
  flush();
  return runs;
}

/**
 * §2.2: a column earns its width, or it is demoted into the identity cell.
 *
 * The ratio is distinct values over rows on screen. Below 0.2 a column is read once rather than
 * scanned, so it costs a column's width to carry one line of information; at 0 it carries none.
 * The rule only applies with at least 10 rows on screen - under that, a ratio is noise, and
 * `null` says "not measurable" rather than guessing.
 *
 * `visible` is what the page should render as a column. The caller moves everything else into
 * the identity cell's second line, where it keeps its value and loses only its column.
 */
export type IncidentColumnId = 'severity' | 'status' | 'evidence' | 'started' | 'owner';

export const INCIDENT_OPTIONAL_COLUMNS: readonly IncidentColumnId[] =
  ['severity', 'status', 'evidence', 'started', 'owner'] as const;

/**
 * The catalog key each column's heading reads from.
 *
 * It lives beside the plan rather than in the page so that a demoted column and a rendered
 * column cannot be named by two different strings: the footnote that states "this column held
 * one value" has to use the same word the heading would have used.
 */
export const INCIDENT_COLUMN_LABEL_KEYS: Record<IncidentColumnId, MessageKey> = {
  severity: 'table.severity',
  status: 'table.status',
  evidence: 'table.evidence',
  started: 'table.started',
  owner: 'table.owner',
};

/** §2.2's floor, and the row count below which a ratio is not evidence. */
export const COLUMN_KEEP_RATIO = 0.2;
export const COLUMN_RATIO_MIN_ROWS = 10;

/** ≥1024 keeps 5 columns, 768–1023 keeps 4, below that §2.5's card rules take over. */
export function columnCapForWidth(width: number): number {
  if (width >= 1024) return 5;
  if (width >= 768) return 4;
  return 3;
}

export interface IncidentColumnPlan {
  visible: IncidentColumnId[];
  demoted: IncidentColumnId[];
  /** Per column, distinct/rows, or null when fewer than {@link COLUMN_RATIO_MIN_ROWS} rows. */
  ratios: Record<IncidentColumnId, number | null>;
}

/** The value a column shows for one row, as the string the reader would compare. */
function columnValue(column: IncidentColumnId, incident: IncidentView): string {
  switch (column) {
    case 'severity': return incident.severity;
    case 'status': return incident.status;
    // The count, not the ids: two rows with different evidence but the same count look alike to
    // a reader scanning the column, and the ratio has to measure what the eye can use.
    case 'evidence': return String(incident.evidenceRefs.length);
    case 'started': return incident.startedAt;
    case 'owner': return incident.owner;
  }
}

export function incidentColumnPlan(rows: IncidentView[], viewportWidth: number): IncidentColumnPlan {
  const ratios = {} as Record<IncidentColumnId, number | null>;
  const measurable = rows.length >= COLUMN_RATIO_MIN_ROWS;
  for (const column of INCIDENT_OPTIONAL_COLUMNS) {
    if (!measurable) { ratios[column] = null; continue; }
    const distinct = new Set(rows.map((row) => columnValue(column, row))).size;
    ratios[column] = Math.round((distinct / rows.length) * 1000) / 1000;
  }

  // The identity column is never optional, so the cap spends one of its slots before ranking.
  const slots = Math.max(0, columnCapForWidth(viewportWidth) - 1);
  const ranked = [...INCIDENT_OPTIONAL_COLUMNS].sort((left, right) => {
    const a = ratios[left];
    const b = ratios[right];
    // An unmeasured column keeps its declared order rather than sorting as if it scored 0.
    if (a === null || b === null) return 0;
    return b - a;
  });

  const visible: IncidentColumnId[] = [];
  const demoted: IncidentColumnId[] = [];
  for (const column of ranked) {
    const ratio = ratios[column];
    const earns = ratio === null || ratio >= COLUMN_KEEP_RATIO;
    if (earns && visible.length < slots) visible.push(column);
    else demoted.push(column);
  }
  // Rendering order is the declared one; the ranking above only decides *which* survive, because
  // a table whose columns reorder as data changes cannot be learned.
  return {
    visible: INCIDENT_OPTIONAL_COLUMNS.filter((column) => visible.includes(column)),
    demoted: INCIDENT_OPTIONAL_COLUMNS.filter((column) => demoted.includes(column)),
    ratios,
  };
}
