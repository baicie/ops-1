import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setCsrfToken } from './api';
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

  const refresh = useCallback(async () => {
    try {
      const result = await api.get<SessionResponse>('/api/v1/auth/me');
      setCsrfToken(result.csrfToken);
      applySession(result);
    } catch {
      setUser(null);
      setAccess(DENY_ACCESS);
      setAccessSource('missing');
    } finally {
      setLoading(false);
    }
  }, [applySession]);

  useEffect(() => {
    void refresh();
    const unauthorized = () => {
      setUser(null);
      setAccess(DENY_ACCESS);
      setAccessSource('missing');
    };
    window.addEventListener('opsweave:unauthorized', unauthorized);
    return () => window.removeEventListener('opsweave:unauthorized', unauthorized);
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.post<SessionResponse>('/api/v1/auth/login', { email, password });
    setCsrfToken(result.csrfToken);
    // /auth/me is the contract's authority for `access`; the login body only mirrors it.
    // Reading it *before* the identity lands keeps the first authenticated render - the one
    // that picks the surface for "/" - from racing ahead of the grant.
    let authoritative = result;
    try {
      const me = await api.get<SessionResponse>('/api/v1/auth/me');
      setCsrfToken(me.csrfToken);
      authoritative = me;
    } catch {
      // Keep the session usable when /auth/me is momentarily unreachable: the login body
      // still yields the identity, and a missing grant normalizes to the deny shape.
    }
    applySession(authoritative);
  }, [applySession]);

  const logout = useCallback(async () => {
    try { await api.post('/api/v1/auth/logout'); } catch { /* session may already be gone */ }
    setCsrfToken('');
    clearSurfaceMemory();
    setAccess(DENY_ACCESS);
    setAccessSource('missing');
    setUser(null);
  }, []);

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
