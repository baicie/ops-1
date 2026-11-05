import { describe, expect, it } from 'vitest';
import { canSave, collectState, type CollectionResult, type CollectStateInput } from './incident-collect';

const NOW = Date.parse('2026-11-06T10:00:00Z');

function collection(overrides: Partial<CollectionResult> = {}): CollectionResult {
  return {
    collectionId: '3c7b1a90-5d42-4e18-8f6a-1d9e0b2c4f55',
    sourceId: '9f1c4d2e-6b70-4a1f-9c33-2b8de4a51c07',
    outcome: 'OK',
    requestedItems: 1,
    answeredItems: 1,
    clamped: [],
    series: [{ itemId: '10401', outcome: 'OK', samples: [{ occurredAt: '2026-11-06T09:30:00Z', value: 17.5 }] }],
    observedAt: '2026-11-06T09:59:00Z',
    contentRef: 'sha256:' + 'a'.repeat(64),
    ...overrides,
  };
}

function input(overrides: Partial<CollectStateInput> = {}): CollectStateInput {
  return {
    sourceStatus: 'ready',
    collection: null,
    submit: 'idle',
    cancelled: false,
    now: NOW,
    ...overrides,
  };
}

describe('collectState', () => {
  it('is initial after sources load and before a collection runs', () => {
    expect(collectState(input())).toBe('initial');
  });

  it('reports loading while the source list is being read', () => {
    expect(collectState(input({ sourceStatus: 'loading' }))).toBe('loading');
  });

  it('reports empty when no source is registered', () => {
    expect(collectState(input({ sourceStatus: 'empty' }))).toBe('empty');
  });

  it('reports forbidden separately from unavailable', () => {
    expect(collectState(input({ sourceStatus: 'forbidden' }))).toBe('forbidden');
    expect(collectState(input({ sourceStatus: 'unavailable' }))).toBe('unavailable');
  });

  it('keeps a successful answer ready', () => {
    expect(collectState(input({ collection: collection() }))).toBe('ready');
  });

  it('reports an authoritative empty window as empty, not ready', () => {
    expect(collectState(input({ collection: collection({ outcome: 'EMPTY', series: [] }) }))).toBe('empty');
  });

  it('does not collapse NO_DATA, TIMEOUT or UNAVAILABLE into empty', () => {
    expect(collectState(input({ collection: collection({ outcome: 'NO_DATA' }) }))).toBe('noData');
    expect(collectState(input({ collection: collection({ outcome: 'TIMEOUT' }) }))).toBe('timeout');
    expect(collectState(input({ collection: collection({ outcome: 'UNAVAILABLE' }) }))).toBe('unavailable');
    expect(collectState(input({ collection: collection({ outcome: 'UNKNOWN' }) }))).toBe('unavailable');
  });

  it('marks a partial collection partial even when samples exist', () => {
    expect(collectState(input({ collection: collection({ outcome: 'PARTIAL' }) }))).toBe('partial');
  });

  it('marks a successful observation older than the freshness window stale', () => {
    expect(collectState(input({ collection: collection({ observedAt: '2026-11-06T09:00:00Z' }) }))).toBe('stale');
  });

  it('submission states win over the collection state', () => {
    expect(collectState(input({ submit: 'pending' }))).toBe('submitPending');
    expect(collectState(input({ submit: 'conflict' }))).toBe('submitConflict');
    expect(collectState(input({ submit: 'saved' }))).toBe('saved');
  });

  it('a cancelled dialog is cancelled, never saved', () => {
    expect(collectState(input({ cancelled: true, submit: 'saved' }))).toBe('cancelled');
  });
});

describe('canSave', () => {
  it('accepts observations that carry an answer or an established absence', () => {
    for (const outcome of ['OK', 'EMPTY', 'NO_DATA', 'PARTIAL'] as const) {
      expect(canSave(collection({ outcome }))).toBe(true);
    }
  });

  it('refuses collections that obtained no answer', () => {
    for (const outcome of ['TIMEOUT', 'UNAVAILABLE', 'UNKNOWN'] as const) {
      expect(canSave(collection({ outcome }))).toBe(false);
    }
    expect(canSave(null)).toBe(false);
  });
});
