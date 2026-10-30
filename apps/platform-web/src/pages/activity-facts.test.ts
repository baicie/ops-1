import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../types';
import { CAPTURED_EVENTS } from './activity-fixtures';
import { BURST_WINDOW_MS, actorName, detailFact, presentEvents, subjectName } from './activity-facts';
import { ageMessage, clockMessage } from '../lib/age';

/**
 * The measurement the review made by hand, as an assertion.
 *
 * Review #7: at 390px, scrolling from card 8 to card 24 of /admin/activity, "the four lines repeat
 * ten times" - 25 cards whose visible text held 15 distinct values, with the one fact that
 * separated them (who did it) rendered nowhere on the page. Every test here reads the captured
 * payload, not a screenshot, so the number survives a CSS change.
 */

const now = Date.now();

/** The text a card is made of, in the order the card paints it. */
function readerText(row: ReturnType<typeof presentEvents>[number], locale: 'en' | 'zh-CN' = 'en'): string {
  return [
    row.name + (row.disambiguator ? ' · ' + row.disambiguator : ''),
    row.count > 1 ? 'x' + row.count : '',
    row.actor.kind + ' ' + row.actor.name,
    row.detail ? row.detail.key + ' ' + row.detail.value : '',
    ageMessage(locale, row.firstAt),
    clockMessage(locale, row.firstAt),
  ].filter(Boolean).join(' | ');
}

const PAGE = () => presentEvents(CAPTURED_EVENTS).slice(0, 25);

describe('one page of the real audit table', () => {
  it('renders 25 cards with 25 different texts, at both widths', () => {
    const rows = PAGE();
    expect(rows).toHaveLength(25);
    for (const locale of ['en', 'zh-CN'] as const) {
      const texts = rows.map((row) => readerText(row, locale));
      expect(new Set(texts).size, 'distinct card texts: ' + JSON.stringify(texts.slice(0, 3))).toBe(25);
    }
  });

  it('the identity key the audit harness reads is unique too', () => {
    const keys = PAGE().map((row) => row.identityKey);
    expect(new Set(keys).size).toBe(25);
    // §2.1: the key must not carry the age, which ticks under the reader. A clock is stable.
    // Both dialects: the long form AND the catalog form the product actually prints now ("3h
    // ago"). Matching only the long form made this assertion vacuous the moment the two surfaces
    // were unified, and a vacuous green is the one failure a test like this must not have.
    expect(keys.filter((key) => /\b\d+\s*(?:s|m|h|d)\s+ago\b|\b\d+\s+(?:second|minute|hour|day)s?\s+ago\b|just now/i.test(key))).toEqual([]);
  });

  it('has a red side: the previous renderer of the same rows was not distinguishable', () => {
    const rows = PAGE();
    // name · subject is what the row said before this round; the payload field, the actor and the
    // clock were elsewhere or absent, which is exactly the 15 of 25 the review counted.
    const before = rows.map((row) => row.name + (row.disambiguator ? ' · ' + row.disambiguator : ''));
    expect(new Set(before).size).toBeLessThan(25);
    // And the actor is not what saved it either - three values, on its own, separate nothing.
    const byActor = rows.map((row) => row.actor.kind + ' ' + row.actor.name);
    expect(new Set(byActor).size).toBeLessThan(25);
  });

  it('names the subject instead of hex-stripping it', () => {
    const capability = CAPTURED_EVENTS.find((event) => event.eventType === 'capability.service_invoke');
    expect(capability).toBeTruthy();
    // 'data.catalog' is a name. The old formatter answered 'daac', which is also what it answered
    // for every other id sharing that prefix.
    expect(subjectName(capability!)).toBe(capability!.subjectId);
    // A UUID is still shortened: its whole text never fits a row.
    const uuid = CAPTURED_EVENTS.find((event) => /^[0-9a-f]{8}-/.test(event.subjectId));
    expect(subjectName(uuid!).length).toBe(4);
  });

  it('puts the payload field that differs on the row', () => {
    const reads = CAPTURED_EVENTS.filter((event) => event.eventType === 'capability.service_invoke');
    const facts = reads.map(detailFact);
    expect(facts[0]?.key).toBe('path');
    expect(new Set(facts.map((fact) => fact?.value)).size).toBe(new Set(reads.map((event) => (event.details as Record<string, unknown>).path)).size);
    // A plugin event names the deployment it acted on, not the plugin (the plugin is the subject).
    const plugin = CAPTURED_EVENTS.find((event) => event.eventType === 'plugin.activated');
    expect(detailFact(plugin!)).toEqual({ key: 'deploymentId', value: '7ab1de1c-8d47-4bb4-b6b3-d0c1cf7e40fc' });
    // ...and when a payload does carry the plugin id, its version rides with it: one answer.
    expect(detailFact({ ...plugin!, details: { pluginId: 'dev.opsweave.hello', version: 3 } })).toEqual({
      key: 'pluginId',
      value: 'dev.opsweave.hello@3',
    });
  });
});

describe('folding', () => {
  const base = (overrides: Partial<AuditEvent>): AuditEvent => ({
    id: 'e',
    eventType: 'capability.service_invoke',
    actorType: 'WORKLOAD',
    actorId: 'opsweave.kernel.catalog',
    subjectType: 'capability',
    subjectId: 'data.catalog',
    action: 'catalog.metadata.read',
    result: 'ACCEPTED',
    details: { path: '/api/data-catalog/datasets/a' },
    requestId: null,
    occurredAt: '2026-10-30T11:00:00.000Z',
    ...overrides,
  });

  it('folds the same request repeated 165ms apart, even with another row between them', () => {
    const rows = presentEvents([
      base({ id: 'a', occurredAt: '2026-10-30T11:00:00.544Z' }),
      // The interleaved row is a different fact (another subject), which is what a fan-out looks
      // like on the wire: it is why §2.4's "in a row" test cannot see this repetition at all.
      base({ id: 'b', subjectId: 'other.capability', occurredAt: '2026-10-30T11:00:00.532Z' }),
      base({ id: 'c', occurredAt: '2026-10-30T11:00:00.379Z' }),
    ]);
    expect(rows.map((row) => row.count)).toEqual([2, 1]);
    expect(rows[0].members.map((member) => member.id)).toEqual(['a', 'c']);
    expect(rows[0].lastAt).toBe('2026-10-30T11:00:00.379Z');
  });

  it('does not fold the same request twice an hour apart', () => {
    const rows = presentEvents([
      base({ id: 'a', occurredAt: '2026-10-30T11:00:00.000Z' }),
      base({ id: 'b', occurredAt: '2026-10-30T10:00:00.000Z' }),
    ]);
    expect(rows.map((row) => row.count)).toEqual([1, 1]);
    // ...but they are still two different rows to the reader, because the clock is on the row.
    expect(rows[0].identityKey).not.toBe(rows[1].identityKey);
    expect(BURST_WINDOW_MS).toBe(2000);
  });

  it('folds a consecutive run of three or more whatever the payload says (§2.4)', () => {
    const rows = presentEvents([
      base({ id: 'a', occurredAt: '2026-10-30T11:00:00.000Z' }),
      base({ id: 'b', details: { path: '/api/other' }, occurredAt: '2026-10-30T10:40:00.000Z' }),
      base({ id: 'c', occurredAt: '2026-10-30T10:20:00.000Z' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(3);
    expect(rows[0].firstAt).toBe('2026-10-30T11:00:00.000Z');
    expect(rows[0].lastAt).toBe('2026-10-30T10:20:00.000Z');
  });

  it('keeps two rows apart when only the payload field differs', () => {
    const rows = presentEvents([
      base({ id: 'a', occurredAt: '2026-10-30T11:00:00.000Z' }),
      base({ id: 'b', details: { path: '/api/data-catalog/datasets/b' }, occurredAt: '2026-10-30T11:00:00.100Z' }),
    ]);
    expect(rows.map((row) => row.detail?.value)).toEqual(['/api/data-catalog/datasets/a', '/api/data-catalog/datasets/b']);
    expect(rows[0].identityKey).not.toBe(rows[1].identityKey);
  });
});

describe('actorName', () => {
  it('keeps a workload name and shortens an id', () => {
    expect(actorName('opsweave.kernel.catalog')).toBe('opsweave.kernel.catalog');
    expect(actorName('3233782f-0cea-46f0-a71f-b1e549fcd9be')).toBe('3233782f');
    expect(actorName('n:9b426dab-27c4-45ce-9773-b51a3db4f246:i:01bf9675')).toHaveLength(8);
    expect(actorName('')).toBe('');
  });
});

describe('one age grammar', () => {
  it('reads the same in an age cell and in a run span', () => {
    // The page printed "24m ago" in one column and "3 hours ago" in the span of the run in the
    // same row: two formatters for one fact. Both now come from this one function.
    expect(ageMessage('en', new Date(now - 24 * 60_000).toISOString())).toBe('24m ago');
    expect(ageMessage('en', new Date(now - 3 * 3600_000).toISOString())).toBe('3h ago');
    expect(ageMessage('zh-CN', new Date(now - 3 * 3600_000).toISOString())).toBe('3小时前');
    expect(clockMessage('en', '2026-10-30T16:07:46.379Z').length).toBeGreaterThan(4);
  });
});
