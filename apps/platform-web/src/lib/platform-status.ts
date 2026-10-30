import * as React from 'react';
import type { Overview } from '../types';
import type { MessageKey } from '../i18n';

/**
 * One verdict, three readers.
 *
 * V5 shipped three independent claims about the same platform: the topbar pill read
 * `health === 'READY'` from its own copy of `/api/v1/overview`, the sidebar printed the
 * `/readyz` HTTP status as `Status READY`, and the page body derived its own verdict
 * (`unconfigured` from `health === 'READY' && nodesTotal === 0 && pluginsInstalled === 0`).
 * On the state-empty page that produced "Not configured" in the body, "Platform ready" in the
 * pill and "Status READY" in the rail - three instruments disagreeing about one machine.
 *
 * This module is the single derivation. The body, the pill and the rail all read it, so a
 * state can only be described one way at a time. It is a tiny subscribe/store rather than a
 * React context because the writers (the shell's poll and the page body's AsyncBoundary) and
 * the readers (rail, topbar) sit in different subtrees of the same shell.
 */

/** The verdicts the chrome is allowed to print. No member is a claim about one subsystem. */
export type PlatformVerdict = 'unknown' | 'ready' | 'attention' | 'degraded' | 'not-configured' | 'unavailable' | 'forbidden';

/** Why a read of `/api/v1/overview` produced nothing; `null` means it answered. */
export type ReadFailure = 'unavailable' | 'forbidden';

/** What the page body last put on screen. A body verdict outranks the shell's own poll. */
export type BodyState = 'ready' | 'empty' | 'attention' | 'unavailable' | 'forbidden';

export interface PlatformSnapshot {
  overview: Overview | null;
  overviewFailure: ReadFailure | null;
  body: BodyState;
  /** True once any source has settled; before that the verdict is UNKNOWN, never READY. */
  loaded: boolean;
}

const INITIAL: PlatformSnapshot = { overview: null, overviewFailure: null, body: 'ready', loaded: false };

let snapshot: PlatformSnapshot = INITIAL;
const listeners = new Set<() => void>();

function publish(next: PlatformSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/**
 * The single rule for "this platform has proven nothing yet".
 *
 * A READY health code with zero nodes and zero plugins is not health: nothing exists to be
 * healthy. Both the body (which prints the setup steps) and the chrome (which must then stop
 * saying "ready") read this one function, so they cannot disagree.
 */
export function isUnconfigured(overview: Overview | null): boolean {
  return Boolean(overview && overview.health === 'READY' && overview.nodesTotal === 0 && overview.pluginsInstalled === 0);
}

/** Derivation, pure and exported so a unit test can pin every branch without a browser. */
export function deriveVerdict(state: PlatformSnapshot): PlatformVerdict {
  // A 403 on any surface is a permission wall: it outranks every health code, because the
  // client did not observe the platform at all.
  if (state.body === 'forbidden' || state.overviewFailure === 'forbidden') return 'forbidden';
  if (state.body === 'unavailable' || state.overviewFailure === 'unavailable') return 'unavailable';
  if (state.body === 'attention') return 'attention';
  if (!state.overview) return state.body === 'empty' ? 'not-configured' : 'unknown';
  if (isUnconfigured(state.overview)) return 'not-configured';
  if (state.overview.health === 'READY') return 'ready';
  if (state.overview.health === 'DEGRADED') return 'degraded';
  return 'attention';
}

/** Called by the shell's poll: an answer, or the reason there is none. */
export function reportOverview(overview: Overview | null, failure: ReadFailure | null = null): void {
  publish({ ...snapshot, overview, overviewFailure: overview ? null : failure, loaded: true });
}

/**
 * Called by `AsyncBoundary` so a panel the reader can see ("this source did not answer",
 * "a 403 wall") is also what the rail and the topbar say. Without this the rail kept
 * advertising READY on 3 of the 4 pages whose body said otherwise.
 */
export function reportBodyState(body: BodyState): void {
  if (snapshot.body === body) return;
  publish({ ...snapshot, body });
}

/** A route change starts a body that has not reported yet. */
export function resetBodyState(): void {
  reportBodyState('ready');
}

export function readPlatformSnapshot(): PlatformSnapshot {
  return snapshot;
}

/** Test seam: the store is module state, so a test must be able to start from zero. */
export function resetPlatformStatus(): void {
  snapshot = INITIAL;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function usePlatformVerdict(): PlatformVerdict {
  const state = React.useSyncExternalStore(subscribe, readPlatformSnapshot, readPlatformSnapshot);
  return deriveVerdict(state);
}

export function usePlatformSnapshot(): PlatformSnapshot {
  return React.useSyncExternalStore(subscribe, readPlatformSnapshot, readPlatformSnapshot);
}

/**
 * Copy for each verdict, in one table so the pill and the rail cannot drift either.
 * `short` is the rail's one-word field; `pill` is the topbar sentence.
 */
export const VERDICT_COPY: Record<PlatformVerdict, { pill: MessageKey; short: MessageKey; tone: 'ok' | 'warn' | 'danger' | 'neutral' }> = {
  unknown: { pill: 'topbar.health.unknown', short: 'badge.value.unknown', tone: 'neutral' },
  ready: { pill: 'topbar.health.ready', short: 'badge.value.ready', tone: 'ok' },
  attention: { pill: 'topbar.health.attention', short: 'badge.value.attention', tone: 'warn' },
  degraded: { pill: 'topbar.health.critical', short: 'badge.value.degraded', tone: 'danger' },
  'not-configured': { pill: 'topbar.health.notConfigured', short: 'badge.value.notConfigured', tone: 'neutral' },
  unavailable: { pill: 'topbar.health.unavailable', short: 'badge.value.unavailable', tone: 'danger' },
  forbidden: { pill: 'topbar.health.forbidden', short: 'badge.value.noAccess', tone: 'danger' },
};

/** The rail's dot, keyed by verdict; the CSS colours these, so no colour lives in JS. */
export function verdictDotState(verdict: PlatformVerdict): 'READY' | 'ATTENTION' | 'NOT_READY' | 'NOT_CONFIGURED' | 'UNKNOWN' {
  switch (verdict) {
    case 'ready': return 'READY';
    case 'attention': return 'ATTENTION';
    case 'degraded':
    case 'unavailable':
    case 'forbidden': return 'NOT_READY';
    case 'not-configured': return 'NOT_CONFIGURED';
    default: return 'UNKNOWN';
  }
}

/**
 * The pill sentence. Only `degraded` carries a number (how many attention rows are critical),
 * and it is the count the same payload already carries - not a second reading of it.
 */
export function pillText(
  verdict: PlatformVerdict,
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
  criticalCount: number,
): string {
  const copy = VERDICT_COPY[verdict];
  return verdict === 'degraded' ? t(copy.pill, { count: criticalCount }) : t(copy.pill);
}
