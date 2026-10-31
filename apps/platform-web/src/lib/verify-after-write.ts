import type { MessageKey } from '../i18n';

/**
 * A write is a request, not a result.
 *
 * The incident this file exists for: the Plugins row menu offered "Stop", the Kernel answered
 * 200 for `POST /plugins/{id}/disable`, the page printed "stopped" - and the plugin was never
 * returned to INSTALLED, because no route in this build can do that. The question "did the write
 * actually happen" is answered by the platform, not by the HTTP status, so every write verb on
 * the shell now runs through one shape:
 *
 *   1. send the verb;
 *   2. re-read the same resource with a fresh GET (never the write's own response body);
 *   3. report success only when the re-read shows the state the verb promised;
 *   4. otherwise report failure with the state that is actually there.
 *
 * A 200 whose re-read is unchanged is `unchanged`, not success, and a re-read that itself fails
 * is `readback-failed`: an unconfirmed write must not be printed as a confirmed one.
 */
export type VerifiedWriteOutcome = 'verified' | 'unchanged' | 'write-failed' | 'readback-failed';

/** The state printed when the resource is gone on purpose (a 404 that proves an uninstall). */
export const ABSENT_STATE = 'NOT_FOUND';

export interface VerifiedWriteResult<T> {
  outcome: VerifiedWriteOutcome;
  /** The resource as the platform reported it on re-read; null when nothing could be read. */
  resource: T | null;
  /** What an operator would read off the screen for that resource, e.g. "DISABLED". */
  state: string;
  /** The rejection behind `write-failed` / `readback-failed`. */
  error?: unknown;
}

export interface VerifiedWriteSpec<T> {
  /** The verb: it resolves when the platform accepted the request. */
  write: () => Promise<unknown>;
  /** A fresh read of the same resource, used as the only proof the verb landed. */
  read: () => Promise<T>;
  /** True only when the re-read resource shows what the verb promised. */
  expected: (resource: T) => boolean;
  /** How that resource renders its state to an operator. */
  describe: (resource: T) => string;
  /** For a verb whose success is the resource disappearing: a 404 on re-read verifies it. */
  absentIsExpected?: boolean;
}

function isNotFound(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 404;
}

export async function verifyAfterWrite<T>(spec: VerifiedWriteSpec<T>): Promise<VerifiedWriteResult<T>> {
  try {
    await spec.write();
  } catch (error) {
    return { outcome: 'write-failed', resource: null, state: '', error };
  }

  let resource: T;
  try {
    resource = await spec.read();
  } catch (error) {
    if (spec.absentIsExpected && isNotFound(error)) {
      return { outcome: 'verified', resource: null, state: ABSENT_STATE };
    }
    return { outcome: 'readback-failed', resource: null, state: '', error };
  }

  const state = spec.describe(resource);
  return { outcome: spec.expected(resource) ? 'verified' : 'unchanged', resource, state };
}

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

/**
 * The failure a caller must surface instead of a success toast, or null when the verb landed.
 * The re-read failure of a plain rejection is re-thrown untouched so the existing per-page
 * handling still prints the platform's error code.
 */
export function verifiedWriteFailure<T>(result: VerifiedWriteResult<T>, t: Translate): Error | null {
  if (result.outcome === 'verified') return null;
  if (result.outcome === 'unchanged') return new Error(t('verify.unchanged', { state: result.state }));
  if (result.outcome === 'readback-failed') return new Error(t('verify.readbackFailed'));
  return result.error instanceof Error ? result.error : new Error(t('verify.writeFailed'));
}

/** The sentence that keeps a success honest: the state the re-read actually showed. */
export function verifiedWriteDetail<T>(result: VerifiedWriteResult<T>, t: Translate): string {
  return t('verify.state', { state: result.state });
}
