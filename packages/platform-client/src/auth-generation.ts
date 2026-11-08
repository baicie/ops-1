/**
 * Request generations for the auth session.
 *
 * `AuthProvider` (auth.tsx) probes `/api/v1/auth/me` on mount, before anyone has logged in.
 * On a slow first paint that probe can answer *after* a successful login, and a bare `401`
 * from it used to clear the freshly established session and bounce the user back to /login.
 * The fix is ordering, not timing: every auth request is stamped with the generation it was
 * issued in, every change of session intent (a login that just committed, a logout, a real
 * sign-out) invalidates all older stamps, and only a result that still carries the current
 * stamp may write session state. A slow response is discarded because it is *older* than the
 * state it would overwrite - never because of how long it took.
 */

/** The generation a request was issued in. Compared for equality; never interpreted as an order. */
export type Generation = number;

export interface AuthGeneration {
  /** The generation in force right now. */
  current(): Generation;
  /**
   * Starts a new generation and invalidates every ticket handed out so far. Called when the
   * session intent genuinely changes, and only then.
   */
  advance(): Generation;
  /** Stamps a request that is about to go out. Read this *before* the first `await`. */
  ticket(): Generation;
  /** Whether a ticket still describes the newest session intent. */
  accepts(ticket: Generation): boolean;
  /**
   * Whether an `opsweave:unauthorized` event still describes the session in force.
   *
   * An event carrying no usable stamp is treated as current. Signing a genuinely expired
   * session out is the security-relevant direction, so the un-stamped case fails *closed*
   * (it signs out) instead of silently ignoring a real revocation.
   */
  acceptsEvent(event: Event): boolean;
}

function stampedGeneration(event: Event): Generation | null {
  const detail = (event as CustomEvent<{ generation?: unknown }>).detail;
  if (!detail || typeof detail !== 'object') return null;
  const value = (detail as { generation?: unknown }).generation;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function createAuthGeneration(initial: Generation = 0): AuthGeneration {
  let value = initial;
  return {
    current: () => value,
    advance: () => {
      value += 1;
      return value;
    },
    ticket: () => value,
    accepts: (ticket) => ticket === value,
    acceptsEvent: (event) => {
      const stamped = stampedGeneration(event);
      return stamped === null ? true : stamped === value;
    },
  };
}

/**
 * The one clock the app shares: `api.ts` stamps outgoing requests with `ticket()` and tags
 * the 401 it dispatches, `auth.tsx` advances it when the session intent changes and checks
 * every write against it.
 */
export const authGeneration = createAuthGeneration();

/** The `detail` `api.ts` attaches to `opsweave:unauthorized`. */
export function unauthorizedDetail(ticket: Generation): { generation: Generation } {
  return { generation: ticket };
}
