import type { AuditEvent } from '../types';
import { identityClock, identityDisambiguator } from '../lib/identity';

/**
 * The language /admin/activity speaks.
 *
 * Everything here is a pure function of the payload, so the one thing this page has to get right
 * - "can a reader tell these two rows apart" - is a unit test over a captured week of real events
 * instead of a claim made next to a screenshot.
 *
 * The measured failure it exists for: at 390px the first page carried 25 cards whose visible text
 * had only 15 distinct values, and the identical ones were identical for a reason that had nothing
 * to do with the event: `capability.service_invoke` against one capability, at one second-level
 * age, with the payload field that differs (the request path) rendered nowhere.
 */

/** §2.4: three identical rows in a row can only be a poller, a fan-out or a retry loop. */
export const RUN_THRESHOLD = 3;

/**
 * Two events with the same name, subject, actor and payload field, less than this apart, are one
 * fact. They are not consecutive - a fan-out interleaves its own requests - so §2.4's "in a row"
 * test cannot see them, and the reader gets two cards that are byte-identical including the clock.
 * 2s is deliberately tight: what it folds is a duplicate request, not "the same thing twice today".
 */
export const BURST_WINDOW_MS = 2000;

export interface DetailFact {
  key: string;
  value: string;
}

/**
 * The payload fields worth a line, in the order that answers "what exactly was it". Grounded in
 * what the Kernel actually writes (measured over the deployment's audit table): path 68, provider
 * 68, version 50, pipelineId 48, imageRef 15, deploymentId 8, draftId 8, pluginId 9.
 */
const DETAIL_PRIORITY = [
  'path',
  'pipelineId',
  'pluginId',
  'draftId',
  'deploymentId',
  'imageRef',
  'provider',
  'consumerPluginId',
  'providerPluginId',
  'status',
  'reason',
  'name',
  'label',
  'email',
];

const isScalar = (value: unknown): value is string | number => typeof value === 'string' || typeof value === 'number';

/**
 * One payload field, chosen so that two rows which are otherwise identical stop being identical.
 * A plugin event carries its version beside its id, and "`dev.opsweave.hello` `0.0.1`" is one
 * answer, not two.
 */
export function detailFact(event: AuditEvent): DetailFact | null {
  const details = event.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const record = details as Record<string, unknown>;
  for (const key of DETAIL_PRIORITY) {
    const value = record[key];
    if (!isScalar(value) || value === '') continue;
    const version = record.version;
    if (key === 'pluginId' && isScalar(version) && version !== '') {
      return { key, value: String(value) + '@' + String(version) };
    }
    return { key, value: String(value) };
  }
  for (const [key, value] of Object.entries(record)) {
    if (isScalar(value) && value !== '') return { key, value: String(value) };
  }
  return null;
}

/** The subject as the product names it, at the width a row has. */
export function subjectName(event: AuditEvent, rowsOnPage = 0): string {
  return identityDisambiguator(event.subjectId, rowsOnPage);
}

/**
 * The actor, at 72px: its kind (three values in this product - USER, WORKLOAD, NODE) and the id
 * that tells one node from another. A UUID is shortened because the whole of it never fits; a
 * workload id is already a name and is kept, because "eaee" is not an actor.
 */
export function actorName(actorId: string | null | undefined, max = 28): string {
  const raw = String(actorId || '');
  if (!raw) return '';
  if (/^[A-Za-z0-9][A-Za-z0-9._]*$/.test(raw) && (/[g-z]/i.test(raw) || raw.includes('.'))) {
    return raw.length > max ? raw.slice(0, max - 1) + '\u2026' : raw;
  }
  return raw.replace(/[^0-9a-f]/gi, '').toLowerCase().slice(0, 8);
}

/** The row as it is read: one fact per line, each of them real. */
export interface PresentedRow {
  event: AuditEvent;
  /** 1 for a row that is its own fact; >= 2 when the same fact repeated. */
  count: number;
  firstAt: string;
  lastAt: string;
  members: AuditEvent[];
  name: string;
  disambiguator: string;
  detail: DetailFact | null;
  actor: { kind: string; name: string };
  /** The machine reading of the row the reader is looking at (§4.1 `data-identity-key`). */
  identityKey: string;
  /** The fold key, without the clock: two rows sharing it are the same fact at two moments. */
  foldKey: string;
}

const coarseKey = (event: AuditEvent) => [event.eventType, event.action, event.subjectType, event.subjectId].join('\u0000');

function foldKeyOf(event: AuditEvent, rowsOnPage: number): string {
  const detail = detailFact(event);
  return [
    coarseKey(event),
    event.result,
    event.actorType,
    event.actorId,
    subjectName(event, rowsOnPage),
    detail ? detail.key + '=' + detail.value : '',
  ].join('\u0000');
}

/** Epoch ms, or +Infinity for a timestamp a clock cannot read (never folds). */
const ms = (at: string): number => {
  const value = Date.parse(at);
  return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
};

function finalize(row: PresentedRow, rowsOnPage: number): PresentedRow {
  row.foldKey = foldKeyOf(row.event, rowsOnPage);
  // The key is the row's own facts, not a hash of them: name, subject, who did it, the payload
  // field that differs, and the moment. The AGE is deliberately absent - it ticks, and a key that
  // changes while the reader is on the page is not an identity (the audit measured the version of
  // this key that carried the age: two rows a minute apart counted as two identities).
  row.identityKey = [
    row.name,
    row.disambiguator,
    row.actor.kind + ' ' + row.actor.name,
    row.detail ? row.detail.key + '=' + row.detail.value : '',
    identityClock(row.firstAt),
    row.count > 1 ? '+' + (row.count - 1) + '@' + identityClock(row.lastAt) : '',
  ].filter(Boolean).join(' \u00b7 ');
  return row;
}

function makeRow(event: AuditEvent, rowsOnPage: number): PresentedRow {
  return finalize({
    event,
    count: 1,
    firstAt: event.occurredAt,
    lastAt: event.occurredAt,
    members: [event],
    name: event.eventType,
    disambiguator: subjectName(event, rowsOnPage),
    detail: detailFact(event),
    actor: { kind: event.actorType, name: actorName(event.actorId) },
    identityKey: '',
    foldKey: '',
  }, rowsOnPage);
}

/**
 * Fold a newest-first list of events into the rows a reader sees.
 *
 * Two folds, both of them §2.4's rule and neither of them cosmetic:
 *   1. a consecutive run of >= 3 rows that share name, action and subject is one fact (the burst
 *      the spec was written for);
 *   2. the same row repeated within BURST_WINDOW_MS, even with other rows interleaved, is one
 *      fact too - which is what the requests of a fan-out actually look like on the wire.
 */
export function presentEvents(events: AuditEvent[]): PresentedRow[] {
  const rowsOnPage = events.length;
  const rows: PresentedRow[] = [];
  const open = new Map<string, PresentedRow>();
  let index = 0;
  while (index < events.length) {
    let end = index;
    const coarse = coarseKey(events[index]);
    while (end + 1 < events.length && coarseKey(events[end + 1]) === coarse) end += 1;
    if (end - index + 1 >= RUN_THRESHOLD) {
      const members = events.slice(index, end + 1);
      const row = makeRow(events[index], rowsOnPage);
      row.count = members.length;
      row.members = members;
      row.lastAt = events[end].occurredAt;
      rows.push(finalize(row, rowsOnPage));
      open.set(row.foldKey, row);
      index = end + 1;
      continue;
    }
    const event = events[index];
    const foldKey = foldKeyOf(event, rowsOnPage);
    const row = open.get(foldKey);
    const within = row ? Math.abs(ms(row.lastAt) - ms(event.occurredAt)) : Number.POSITIVE_INFINITY;
    if (row && within <= BURST_WINDOW_MS) {
      row.count += 1;
      row.members = [...row.members, event];
      row.lastAt = event.occurredAt;
      finalize(row, rowsOnPage);
    } else {
      const fresh = makeRow(event, rowsOnPage);
      rows.push(fresh);
      open.set(fresh.foldKey, fresh);
    }
    index += 1;
  }
  return rows;
}
