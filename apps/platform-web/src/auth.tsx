import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setCsrfToken } from './api';
import { authGeneration } from './auth-generation';
import { adoptSurfaceOwner, clearSurfaceMemory, DENY_ACCESS, readAccess, type AccessInfo, type AccessSource } from './surface';
import type { User } from './types';

/**
 * `/api/v1/auth/me` (and the login response) carry the server-authoritative surface grant.
 * The type stays open about `access` because an older kernel does not send it yet: the
 * normalizer turns "absent" into the documented denial instead of a guess.
 */
interface SessionResponse {
  user: User;
  csrfToken: string;
  access?: unknown;
}

interface AuthState {
  user: User | null;
  /** Server-authoritative surface grant; never derived from `user.role`. */
  access: AccessInfo;
  /** Whether the server declared that grant at all; UX diagnostics only, never authority. */
  accessSource: AccessSource;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [access, setAccess] = useState<AccessInfo>(DENY_ACCESS);
  const [accessSource, setAccessSource] = useState<AccessSource>('missing');
  const [loading, setLoading] = useState(true);

  /** Applies one session body; the single place where `access` reaches React state. */
  const applySession = useCallback((result: SessionResponse) => {
    const grant = readAccess(result.access);
    setUser(result.user);
    setAccess(grant.access);
    setAccessSource(grant.source);
    adoptSurfaceOwner(result.user.id);
  }, []);

  const clearSession = useCallback(() => {
    setUser(null);
    setAccess(DENY_ACCESS);
    setAccessSource('missing');
  }, []);

  /**
   * The mount-time probe. It can still be in flight when a login commits, so its ticket is
   * read before the request goes out and both writes below are gated on it: a response that
   * describes a superseded intent must not touch the session.
   *
   * `setLoading(false)` is deliberately *not* gated. It is a one-way latch (nothing sets it
   * back to true), so a stale response cannot destroy a newer state with it - while gating it
   * would strand a splash over a session that a login established while the probe was out.
   */
  const refresh = useCallback(async () => {
    const ticket = authGeneration.ticket();
    try {
      const result = await api.get<SessionResponse>('/api/v1/auth/me');
      if (!authGeneration.accepts(ticket)) return;
      setCsrfToken(result.csrfToken);
      applySession(result);
    } catch {
      if (!authGeneration.accepts(ticket)) return;
      clearSession();
    } finally {
      setLoading(false);
    }
  }, [applySession, clearSession]);

  useEffect(() => {
    void refresh();
    /**
     * `api.ts` dispatches this for every 401, including one produced by a request that went
     * out *before* the current session existed. A 401 stamped with a superseded generation is
     * not evidence about this session and is dropped; a 401 from the current generation is a
     * real expiry, so it signs the user out and invalidates everything still in flight.
     */
    const unauthorized = (event: Event) => {
      if (!authGeneration.acceptsEvent(event)) return;
      authGeneration.advance();
      clearSession();
    };
    window.addEventListener('opsweave:unauthorized', unauthorized);
    return () => window.removeEventListener('opsweave:unauthorized', unauthorized);
  }, [refresh, clearSession]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.post<SessionResponse>('/api/v1/auth/login', { email, password });
    // /auth/me is the contract's authority for `access`; the login body only mirrors it.
    // Reading it *before* the identity lands keeps the first authenticated render - the one
    // that picks the surface for "/" - from racing ahead of the grant.
    let authoritative = result;
    try {
      const me = await api.get<SessionResponse>('/api/v1/auth/me');
      authoritative = me;
    } catch {
      // Keep the session usable when /auth/me is momentarily unreachable: the login body
      // still yields the identity, and a missing grant normalizes to the deny shape.
    }
    // A committed login *is* the new session intent: advancing here - with no await between
    // the advance and the writes - makes every response issued before this point stale, so
    // the pre-login probe can no longer clear the session it never knew about.
    authGeneration.advance();
    setCsrfToken(authoritative.csrfToken);
    applySession(authoritative);
    setLoading(false);
  }, [applySession]);

  const logout = useCallback(async () => {
    // Signing out is a newer intent than anything already in flight, so nothing older may
    // write session state from here on - including a response that lands during the POST.
    authGeneration.advance();
    try { await api.post('/api/v1/auth/logout'); } catch { /* session may already be gone */ }
    setCsrfToken('');
    clearSurfaceMemory();
    clearSession();
  }, [clearSession]);

  const value = useMemo(
    () => ({ user, access, accessSource, loading, login, logout, refresh }),
    [user, access, accessSource, loading, login, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
