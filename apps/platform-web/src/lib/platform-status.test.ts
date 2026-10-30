import { describe, expect, it } from 'vitest';
import { deriveVerdict, isUnconfigured, verdictDotState, type PlatformSnapshot } from './platform-status';
import type { Overview } from '../types';

/**
 * P0-2 was three instruments disagreeing about one machine: the body said "not configured",
 * the pill said "platform ready", the rail said "status READY". These cases pin the single
 * derivation that replaced them, including the four non-normal states the rail used to lie in.
 */
function overview(patch: Partial<Overview> = {}): Overview {
  return {
    health: 'READY',
    nodesTotal: 1,
    nodesReady: 1,
    pluginsInstalled: 1,
    pluginsAvailable: 1,
    instancesReady: 1,
    instancesTotal: 1,
    activeDeployments: 1,
    attention: [],
    recentEvents: [],
    ...patch,
  };
}

function state(patch: Partial<PlatformSnapshot> = {}): PlatformSnapshot {
  return { overview: null, overviewFailure: null, body: 'ready', loaded: false, ...patch };
}

describe('platform verdict', () => {
  it('never calls an empty platform ready', () => {
    const empty = overview({ nodesTotal: 0, pluginsInstalled: 0 });
    expect(isUnconfigured(empty)).toBe(true);
    expect(deriveVerdict(state({ overview: empty, loaded: true }))).toBe('not-configured');
  });

  it('does not read "READY with nothing on it" as configured', () => {
    expect(isUnconfigured(overview({ pluginsInstalled: 0 }))).toBe(false);
    expect(isUnconfigured(null)).toBe(false);
  });

  it('maps every health code', () => {
    expect(deriveVerdict(state({ overview: overview() }))).toBe('ready');
    expect(deriveVerdict(state({ overview: overview({ health: 'DEGRADED' }) }))).toBe('degraded');
    expect(deriveVerdict(state({ overview: overview({ health: 'ATTENTION' }) }))).toBe('attention');
  });

  it('reports a failed or forbidden read instead of the last health code', () => {
    expect(deriveVerdict(state({ overviewFailure: 'forbidden', overview: null }))).toBe('forbidden');
    expect(deriveVerdict(state({ overviewFailure: 'unavailable', overview: null }))).toBe('unavailable');
  });

  it('lets the body outrank the shell poll', () => {
    // The shell may hold a healthy payload while the page in front of the reader says 403.
    expect(deriveVerdict(state({ overview: overview(), body: 'forbidden' }))).toBe('forbidden');
    expect(deriveVerdict(state({ overview: overview(), body: 'unavailable' }))).toBe('unavailable');
    expect(deriveVerdict(state({ overview: overview(), body: 'attention' }))).toBe('attention');
  });

  it('says UNKNOWN before any source settled, not READY', () => {
    expect(deriveVerdict(state())).toBe('unknown');
  });

  it('only paints a green dot for the ready verdict', () => {
    expect(verdictDotState('ready')).toBe('READY');
    for (const verdict of ['unknown', 'attention', 'degraded', 'not-configured', 'unavailable', 'forbidden'] as const) {
      expect(verdictDotState(verdict)).not.toBe('READY');
    }
  });
});
