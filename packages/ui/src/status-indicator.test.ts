import { describe, expect, it } from 'vitest';
import { indicatorStateForCode } from './status-indicator';

/**
 * The wire code alone decides the observational state, so this mapping is the one place
 * where "stopped on purpose" and "never configured" can be folded together by accident.
 * They are different facts about a node and must stay different chips.
 */
describe('indicatorStateForCode', () => {
  it('keeps a stopped process out of the never-configured bucket', () => {
    expect(indicatorStateForCode('STOPPED')).toBe('stopped');
    expect(indicatorStateForCode('DISABLED')).toBe('notConfigured');
    expect(indicatorStateForCode('UNINSTALLED')).toBe('notConfigured');
  });

  it('accepts the code in any case, because the wire is not the presentation', () => {
    expect(indicatorStateForCode('stopped')).toBe('stopped');
    expect(indicatorStateForCode(' Stopped ')).toBe('unknown');
  });

  it('still lets revocation and staleness win over the stored code', () => {
    expect(indicatorStateForCode('STOPPED', { revoked: true })).toBe('revoked');
    expect(indicatorStateForCode('STOPPED', { stale: true })).toBe('stale');
  });

  it('degrades a code it does not know to unknown instead of guessing', () => {
    expect(indicatorStateForCode('HALTED')).toBe('unknown');
    expect(indicatorStateForCode(null)).toBe('unknown');
  });
});
