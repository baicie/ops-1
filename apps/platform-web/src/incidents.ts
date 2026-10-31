import type { MessageKey } from './i18n';
import type { StatusTone } from './components/status-tone';
import type { IncidentEvidence, IncidentVerdict, IncidentView } from './types';

/**
 * The incident slice's client-side facts, kept out of the two page components.
 *
 * Everything here is a pure function over wire payloads, so the rules the pages rely on - which
 * filters exist, which failure codes have copy, when an empty evidence list is 'missing' rather
 * than 'unavailable', what a timeline entry may be made of - are testable without a browser and
 * cannot drift between the list and the detail page.
 *
 * Three deliberate omissions, all of them stated on the page rather than papered over:
 *   * there is no free-text search: the list endpoint has no `q` parameter, and filtering the
 *     loaded page would silently ignore rows the cursor has not fetched yet;
 *   * there is no CLOSED transition: the kernel has no close endpoint in this slice, so the
 *     status filter carries the code for a value nothing can currently reach;
 *   * there is no AI conclusion anywhere: the payload has no field for one (ADR-G11-001 §7).
 */

/** The status closed set from the contract. CLOSED is reachable in the database, not in this slice. */
export const INCIDENT_STATUS_CODES = ['OPEN', 'INVESTIGATING', 'CONCLUDED', 'CLOSED'] as const;
export const INCIDENT_SEVERITY_CODES = ['CRITICAL', 'MAJOR', 'MINOR', 'WARNING'] as const;
export const EVIDENCE_KIND_CODES = ['METRIC_SNAPSHOT', 'LOG_EXCERPT', 'QUERY_RESULT', 'OPERATOR_NOTE'] as const;
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
};

export function incidentFailureKey(code?: string | null): MessageKey | null {
  if (!code) return null;
  return FAILURE_KEYS[code] ?? null;
}

export type EvidencePanelState = 'loading' | 'present' | 'missing' | 'unavailable';

/**
 * Which evidence panel to draw.
 *
 * Three answers, kept apart on purpose: `missing` is a fact the kernel asserted (it answered and
 * the list is empty), `unavailable` is the absence of an answer, and `loading` is neither - a
 * panel that says "no evidence" before the request returns is the same lie as an empty list
 * standing in for a failure.
 */
export function evidencePanelState(rows: IncidentEvidence[] | null, failed: boolean): EvidencePanelState {
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
