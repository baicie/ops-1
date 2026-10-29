import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from './api';
import { authGeneration, createAuthGeneration, type AuthGeneration } from './auth-generation';

/**
 * Regression: a login committing before the mount-time `/api/v1/auth/me` probe answered used
 * to be wiped by the probe's late 401 (trace: probe 200 @135.167 before login, late 401
 * @136.085 after the workspace had already rendered), bouncing a real user back to /login on
 * a slow first paint.
 *
 * These tests carry no browser: the deciding rule lives in auth-generation.ts, and the 401
 * signal itself is exercised through the real `api.ts`.
 */

/**
 * Replays the *call order* of `AuthProvider` (auth.tsx) over a plain state object, so the
 * assertions are about the guard those call sites use - not about a second implementation of
 * the provider. No await sits between `advance()` and the writes it authorizes, exactly as in
 * auth.tsx.
 */
function provider(clock: AuthGeneration) {
  const state = { user: null as string | null };

  /** auth.tsx:62-75 `refresh()` - ticket before the request, writes gated on it. */
  async function refresh(response: Promise<{ user: string }>) {
    const ticket = clock.ticket();
    try {
      const body = await response;
      if (!clock.accepts(ticket)) return 'discarded';
      state.user = body.user;
      return 'applied';
    } catch {
      if (!clock.accepts(ticket)) return 'discarded';
      state.user = null;
      return 'signed-out';
    }
  }

  /** auth.tsx:94-114 `login()` - the commit is the new session intent. */
  function login(user: string) {
    clock.advance();
    state.user = user;
  }

  /** auth.tsx:116-124 `logout()` - newer intent than anything already in flight. */
  function logout() {
    clock.advance();
    state.user = null;
  }

  /** auth.tsx:85-89 the `opsweave:unauthorized` listener. */
  function unauthorized(event: Event) {
    if (!clock.acceptsEvent(event)) return 'ignored';
    clock.advance();
    state.user = null;
    return 'signed-out';
  }

  return { state, refresh, login, logout, unauthorized };
}

function unauthorizedAt(generation: number): Event {
  return new CustomEvent('opsweave:unauthorized', { detail: { generation } });
}

function deferredRejection() {
  let reject!: (reason: unknown) => void;
  const promise = new Promise<{ user: string }>((_resolve, fail) => { reject = fail; });
  return { promise, reject };
}

describe('auth request generations', () => {
  it('keeps the session when a probe issued before the login answers 401 afterwards', async () => {
    const clock = createAuthGeneration();
    const session = provider(clock);

    // The probe goes out on mount, before anyone is logged in.
    const probeTicket = clock.ticket();
    const probe = deferredRejection();
    const inflight = session.refresh(probe.promise);

    // The user logs in while it is still out.
    session.login('u-1');
    expect(session.state.user).toBe('u-1');

    // The probe's 401 lands now: stale, so neither write path may touch the session.
    probe.reject(Object.assign(new Error('401'), { status: 401 }));
    expect(await inflight).toBe('discarded');
    expect(session.state.user).toBe('u-1');

    // The same late 401 through the global signal must not log the user out either.
    expect(session.unauthorized(unauthorizedAt(probeTicket))).toBe('ignored');
    expect(session.state.user).toBe('u-1');
  });

  it('still signs out a genuinely expired session', async () => {
    const clock = createAuthGeneration();
    const session = provider(clock);
    session.login('u-1');

    // A 401 that belongs to the generation in force *is* a revocation.
    expect(session.unauthorized(unauthorizedAt(clock.ticket()))).toBe('signed-out');
    expect(session.state.user).toBeNull();

    // Same for the probe path: no newer intent has superseded it.
    session.login('u-2');
    const expired = deferredRejection();
    const inflight = session.refresh(expired.promise);
    expired.reject(Object.assign(new Error('401'), { status: 401 }));
    expect(await inflight).toBe('signed-out');
    expect(session.state.user).toBeNull();
  });

  it('discards a late 200 that would resurrect a session the user signed out of', async () => {
    const clock = createAuthGeneration();
    const session = provider(clock);
    session.login('u-1');

    let resolveProbe!: (value: { user: string }) => void;
    const probe = new Promise<{ user: string }>((resolve) => { resolveProbe = resolve; });
    const inflight = session.refresh(probe);

    session.logout();
    resolveProbe({ user: 'u-1' });

    expect(await inflight).toBe('discarded');
    expect(session.state.user).toBeNull();
  });

  it('treats a 401 with no stamp as current, so an unknown emitter still signs out', () => {
    const clock = createAuthGeneration();
    const session = provider(clock);
    session.login('u-1');

    expect(clock.acceptsEvent(new Event('opsweave:unauthorized'))).toBe(true);
    expect(session.unauthorized(new Event('opsweave:unauthorized'))).toBe('signed-out');
    expect(session.state.user).toBeNull();
  });

  it('never lets a ticket survive a change of intent, in either direction', () => {
    const clock = createAuthGeneration(7);
    const first = clock.ticket();
    expect(clock.accepts(first)).toBe(true);

    const second = clock.advance();
    expect(second).not.toBe(first);
    expect(clock.accepts(first)).toBe(false);
    expect(clock.accepts(second)).toBe(true);
    expect(clock.acceptsEvent(unauthorizedAt(first))).toBe(false);
    expect(clock.acceptsEvent(unauthorizedAt(second))).toBe(true);
  });
});

describe('the opsweave:unauthorized signal api.ts dispatches', () => {
  const events: Event[] = [];
  const previous = { window: (globalThis as any).window, fetch: (globalThis as any).fetch };

  beforeEach(() => {
    events.length = 0;
    (globalThis as any).window = {
      dispatchEvent: (event: Event) => { events.push(event); return true; },
    };
  });

  afterEach(() => {
    (globalThis as any).window = previous.window;
    (globalThis as any).fetch = previous.fetch;
  });

  it('is stamped with the generation the request went out in, not the one it landed in', async () => {
    let settle!: (value: unknown) => void;
    (globalThis as any).fetch = () => new Promise((resolve) => { settle = resolve; });

    const issuedAt = authGeneration.ticket();
    const inFlight = api.get('/api/v1/auth/me').catch((error: unknown) => error);

    // The login commits while the probe is still out (auth.tsx:110).
    const atLogin = authGeneration.advance();
    expect(atLogin).not.toBe(issuedAt);

    settle({ status: 401, ok: false, text: async () => '{"code":"UNAUTHORIZED","message":"no session"}' });
    const error = await inFlight as { status: number };

    expect(error.status).toBe(401);
    expect(events).toHaveLength(1);
    expect((events[0] as CustomEvent).detail).toEqual({ generation: issuedAt });
    // The listener in auth.tsx drops it instead of clearing the session.
    expect(authGeneration.acceptsEvent(events[0])).toBe(false);
  });

  it('is still accepted for a 401 that belongs to the session in force', async () => {
    let settle!: (value: unknown) => void;
    (globalThis as any).fetch = () => new Promise((resolve) => { settle = resolve; });

    const issuedAt = authGeneration.ticket();
    const inFlight = api.get('/api/v1/nodes').catch((error: unknown) => error);
    settle({ status: 401, ok: false, text: async () => '{"code":"UNAUTHORIZED","message":"no session"}' });
    await inFlight;

    expect(events).toHaveLength(1);
    expect((events[0] as CustomEvent).detail).toEqual({ generation: issuedAt });
    expect(authGeneration.acceptsEvent(events[0])).toBe(true);
  });
});
