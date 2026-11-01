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
/**
 * The closed set of values `verifiedTrust` may carry. This is a SERVER verdict (G12 A1): a
 * reader may treat it as provenance, and no request can set it.
 */
export const EVIDENCE_TRUST_CODES = ['SOURCE_ATTESTED', 'OPERATOR_ASSERTED', 'UNVERIFIED'] as const;
/**
 * What a submitter is allowed to say about its own row (`claimedTrust`). Deliberately smaller
 * than the set above: SOURCE_ATTESTED means "the Kernel checked", and a caller cannot perform
 * that check on the Kernel's behalf by typing it. A request naming it is refused with
 * EVIDENCE_TRUST_NOT_SELF_ASSERTABLE rather than quietly lowered, so this form does not offer
 * it at all.
 */
export const EVIDENCE_TRUST_CLAIM_CODES = ['OPERATOR_ASSERTED', 'UNVERIFIED'] as const;
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

export type EvidencePanelState = 'loading' | 'present' | 'missing' | 'unavailable' | 'forbidden';

/**
 * Which evidence panel to draw.
 *
 * Four answers, kept apart on purpose: `missing` is a fact the kernel asserted (it answered and
 * the list is empty), `unavailable` is the absence of an answer, `forbidden` is a refusal (the
 * request was answered, and the answer was "not for you"), and `loading` is none of them - a
 * panel that says "no evidence" before the request returns is the same lie as an empty list
 * standing in for a failure.
 *
 * A refusal is split out from `unavailable` because the two have different remedies: a refused
 * read is fixed by a grant, a failed one by a retry. Drawing both as "could not be read" sends
 * the reader to the wrong place.
 */
export function evidencePanelState(
  rows: IncidentEvidence[] | null,
  failed: boolean,
  status?: number | null,
): EvidencePanelState {
  if (rows) {
    if (rows.length === 0) return 'missing';
    return 'present';
  }
  if (failed && status === 403) return 'forbidden';
  if (failed) return 'unavailable';
  return 'loading';
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

/** How `verifiedTrust` was reached. A method, not a level: it never re-ranks the row. */
const VERIFICATION_METHOD_KEYS: Record<string, MessageKey> = {
  NONE: 'incidents.verification.none',
  OPERATOR_IDENTITY: 'incidents.verification.operatorIdentity',
  SOURCE_ADAPTER: 'incidents.verification.sourceAdapter',
};

export function verificationMethodKey(code?: string | null): MessageKey {
  if (!code) return 'incidents.verification.unknown';
  return VERIFICATION_METHOD_KEYS[code.toUpperCase()] ?? 'incidents.verification.unknown';
}

/** A catalog key for every trust code the contract allows, and one for a code it does not. */
export function evidenceTrustKey(code?: string | null): MessageKey {
  if (!code) return 'incidents.trust.unknown';
  return EVIDENCE_TRUST_KEYS[code.toUpperCase()] ?? 'incidents.trust.unknown';
}

/**
 * Trust is the anti-forgery field (ADR-G11-001 §2.2, ADR-015): a hand-written note and a
 * source-attested metric snapshot must not look alike, which is a tone, not a sentence.
 *
 * Since G12 this column is the Kernel's verdict, not the writer's claim, so SOURCE_ATTESTED
 * earns `ok` — the green this product reserves for a fact the server established. Before the
 * attestation path existed the same value meant "the caller typed this", and painting it green
 * would have been the UI asserting something nobody checked; that is no longer the case.
 */
export function evidenceTrustTone(code?: string | null): StatusTone {
  switch ((code ?? '').toUpperCase()) {
    // The Kernel verified a signature over this exact tuple against a configured adapter.
    case 'SOURCE_ATTESTED': return 'ok';
    // An authenticated operator submitted it in their own name. A real, narrower provenance.
    case 'OPERATOR_ASSERTED': return 'neutral';
    // Nothing was verified: the default for a row whose claim the Kernel could not check.
    case 'UNVERIFIED': return 'warn';
    default: return 'unknown';
  }
}

/**
 * A glyph per trust level, so the three are distinguishable without colour.
 *
 * The audit's requirement is shape before colour: a reader with a colour deficiency, a
 * greyscale print and a dark-theme washout all have to resolve these three. Tone carries the
 * same information a second time; neither is load-bearing alone.
 */
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
