import type { MessageKey } from '../i18n';

/**
 * The deploy verb, read back the way lib/verify-after-write.ts requires.
 *
 * The incident this file exists for: `InstallWizard.deploy()` took the body of
 * `POST /plugins/{id}/deployments` and rendered it as the result - so the wizard printed whatever
 * the platform echoed on the way in. A create answers "request accepted", not "deployment exists,
 * here is its state"; only a fresh GET does. This verb is not a single re-read either, because a
 * deployment is not settled the moment it is created: it moves through the placement loop, so the
 * read is repeated until the platform reports a settled state, the deadline passes, or the
 * deployment never appears at all.
 *
 * The created id from the write is used as a correlation key and for nothing else: every field
 * that reaches the screen comes from the re-read.
 */
export type DeployReadbackOutcome = 'verified' | 'not-expected' | 'timeout' | 'write-failed' | 'readback-failed';

/** The states a deployment stops moving in; the wizard polls no further once one is seen. */
export const SETTLED_DEPLOYMENT_STATES = ['READY', 'ACTIVE', 'DEGRADED', 'FAILED'];
/** Settled - but not with the outcome the verb promised. */
export const FAILED_DEPLOYMENT_STATES = ['FAILED'];

export interface DeployReadbackResult<T> {
  outcome: DeployReadbackOutcome;
  /** The deployment as a fresh GET reported it; null when no read ever returned it. */
  deployment: T | null;
  /** The status an operator would read off the screen for that deployment, '' when unknown. */
  state: string;
  /** How many GETs the readback spent; 0 when the write itself failed. */
  reads: number;
  error?: unknown;
}

export interface DeployReadbackSpec<T> {
  /** The verb. Its id correlates the readback; its body never supplies a rendered field. */
  write: () => Promise<{ id: string } | null | undefined>;
  /** A fresh read of the collection that must contain the created deployment. */
  read: () => Promise<T[]>;
  idOf: (deployment: T) => string;
  statusOf: (deployment: T) => string;
  /** Optional: decide per-status which ones the verb promised. Defaults to "settled, not FAILED". */
  expected?: (state: string) => boolean;
  /** How long the readback keeps asking before it reports the last state it saw. */
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEPLOY_READBACK_TIMEOUT_MS = 8000;
export const DEPLOY_READBACK_INTERVAL_MS = 500;

export function isSettledDeployment(state: string | null | undefined): boolean {
  return SETTLED_DEPLOYMENT_STATES.includes(String(state ?? '').toUpperCase());
}

/** The verb promised a deployment that lands; FAILED is the one settled state that did not. */
export function deployLanded(state: string | null | undefined): boolean {
  const code = String(state ?? '').toUpperCase();
  return isSettledDeployment(code) && !FAILED_DEPLOYMENT_STATES.includes(code);
}

export async function verifyDeployAfterWrite<T>(spec: DeployReadbackSpec<T>): Promise<DeployReadbackResult<T>> {
  let created: { id: string } | null | undefined;
  try {
    created = await spec.write();
  } catch (error) {
    return { outcome: 'write-failed', deployment: null, state: '', reads: 0, error };
  }

  const wanted = created?.id;
  const now = spec.now ?? (() => Date.now());
  const sleep = spec.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const deadline = now() + (spec.timeoutMs ?? DEPLOY_READBACK_TIMEOUT_MS);
  const interval = spec.intervalMs ?? DEPLOY_READBACK_INTERVAL_MS;
  const expected = spec.expected ?? deployLanded;
  let reads = 0;
  let last: T | null = null;

  for (;;) {
    reads += 1;
    let list: T[];
    try {
      list = await spec.read();
    } catch (error) {
      return { outcome: 'readback-failed', deployment: last, state: last ? spec.statusOf(last) : '', reads, error };
    }
    const found = wanted ? list.find((item) => spec.idOf(item) === wanted) ?? null : null;
    if (found) {
      last = found;
      const state = spec.statusOf(found);
      if (isSettledDeployment(state)) {
        return { outcome: expected(state) ? 'verified' : 'not-expected', deployment: found, state, reads };
      }
    }
    if (now() >= deadline) {
      return { outcome: 'timeout', deployment: last, state: last ? spec.statusOf(last) : '', reads };
    }
    await sleep(interval);
  }
}

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

/** The failure to surface instead of a success, or null when the re-read proved the landing. */
export function deployReadbackFailure<T>(result: DeployReadbackResult<T>, t: Translate): Error | null {
  if (result.outcome === 'verified') return null;
  if (result.outcome === 'not-expected') return new Error(t('install.toast.deployUnsettled', { state: result.state }));
  if (result.outcome === 'timeout') return new Error(t('install.toast.deployUnconfirmed'));
  if (result.outcome === 'readback-failed') return new Error(t('verify.readbackFailed'));
  return result.error instanceof Error ? result.error : new Error(t('install.toast.deployFailed'));
}
