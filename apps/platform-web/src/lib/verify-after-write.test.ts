import { describe, expect, it, vi } from 'vitest';
import { translate } from '../i18n';
import {
  ABSENT_STATE,
  verifiedWriteDetail,
  verifiedWriteFailure,
  verifyAfterWrite,
  type VerifiedWriteSpec,
} from './verify-after-write';

/**
 * The four branches the incident needs pinned: the state really changed, the Kernel answered but
 * the state did not change, the request itself failed, and the re-read failed. A fifth case pins
 * the one verb whose success is the resource disappearing.
 *
 * The copy is asserted through the real catalogs (`translate`), so a missing message key fails
 * here instead of printing an untranslated key to an operator.
 */
const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate('en', key, params);

interface PluginRow {
  id: string;
  state: string;
}

function spec(patch: Partial<VerifiedWriteSpec<PluginRow>> = {}): VerifiedWriteSpec<PluginRow> {
  return {
    write: () => Promise.resolve({ ok: true }),
    read: () => Promise.resolve({ id: 'dev.opsweave.hello', state: 'DISABLED' }),
    expected: (plugin) => plugin.state === 'DISABLED',
    describe: (plugin) => plugin.state,
    ...patch,
  };
}

describe('verifyAfterWrite', () => {
  it('reports success when the re-read shows the promised state', async () => {
    const result = await verifyAfterWrite(spec());

    expect(result.outcome).toBe('verified');
    expect(result.state).toBe('DISABLED');
    expect(verifiedWriteFailure(result, t)).toBeNull();
    expect(verifiedWriteDetail(result, t)).toBe('State now: DISABLED');
  });

  // The incident: POST /disable is 200, the screen says stopped, the state is not what was promised.
  it('reports failure with the actual state when the write is accepted but nothing changed', async () => {
    const result = await verifyAfterWrite(spec({ read: () => Promise.resolve({ id: 'dev.opsweave.hello', state: 'STAGED' }) }));

    expect(result.outcome).toBe('unchanged');
    expect(result.state).toBe('STAGED');
    const failure = verifiedWriteFailure(result, t);
    expect(failure).not.toBeNull();
    expect(failure?.message).toBe('Submitted, but the state did not change (current: STAGED)');
    // The lie this replaces: a success sentence for a write that never landed.
    expect(failure?.message).not.toMatch(/stopped|succeeded|enabled/i);
  });

  it('reports a failed request as a failure and keeps the platform error', async () => {
    const rejection = Object.assign(new Error('plugin has no active revision'), { status: 409, code: 'PLUGIN_NOT_ACTIVE' });
    const result = await verifyAfterWrite(spec({ write: () => Promise.reject(rejection) }));

    expect(result.outcome).toBe('write-failed');
    expect(result.error).toBe(rejection);
    expect(verifiedWriteFailure(result, t)).toBe(rejection);
    // A failure never carries a "state now" detail: nothing was proven.
    expect(result.state).toBe('');
  });

  it('reports an unconfirmed write when the re-read itself fails', async () => {
    const readback = Object.assign(new Error('gateway timeout'), { status: 504 });
    const result = await verifyAfterWrite(spec({ read: () => Promise.reject(readback) }));

    expect(result.outcome).toBe('readback-failed');
    expect(result.error).toBe(readback);
    const failure = verifiedWriteFailure(result, t);
    expect(failure?.message).toBe('The write was submitted, but the state could not be re-read, so the result is unconfirmed');
    expect(failure?.message).not.toContain('gateway timeout');
  });

  it('treats a 404 as success only for a verb whose success is the resource being gone', async () => {
    const gone = Object.assign(new Error('not found'), { status: 404 });

    const uninstall = await verifyAfterWrite(spec({ read: () => Promise.reject(gone), absentIsExpected: true }));
    expect(uninstall.outcome).toBe('verified');
    expect(uninstall.state).toBe(ABSENT_STATE);

    const disable = await verifyAfterWrite(spec({ read: () => Promise.reject(gone) }));
    expect(disable.outcome).toBe('readback-failed');
  });

  it('re-reads once, after the write, and never trusts the write response', async () => {
    const calls: string[] = [];
    const result = await verifyAfterWrite(spec({
      write: () => { calls.push('write'); return Promise.resolve({ state: 'DISABLED' }); },
      read: async () => { calls.push('read'); return { id: 'dev.opsweave.hello', state: 'STAGED' }; },
    }));

    expect(calls).toEqual(['write', 'read']);
    // The write body claimed DISABLED; the re-read says STAGED and that is what gets reported.
    expect(result.state).toBe('STAGED');
    expect(result.outcome).toBe('unchanged');
  });

  it('does not re-read when the write was rejected', async () => {
    const read = vi.fn(async () => ({ id: 'dev.opsweave.hello', state: 'DISABLED' }));
    await verifyAfterWrite(spec({ write: () => Promise.reject(new Error('refused')), read }));
    expect(read).not.toHaveBeenCalled();
  });
});
