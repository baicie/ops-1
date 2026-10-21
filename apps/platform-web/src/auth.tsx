import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setCsrfToken } from './api';
import type { User } from './types';

interface AuthState {
  user: User | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await api.get<{ user: User; csrfToken: string }>('/api/v1/auth/me');
      setCsrfToken(result.csrfToken);
      setUser(result.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unauthorized = () => setUser(null);
    window.addEventListener('opsweave:unauthorized', unauthorized);
    return () => window.removeEventListener('opsweave:unauthorized', unauthorized);
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.post<{ user: User; csrfToken: string }>('/api/v1/auth/login', { email, password });
    setCsrfToken(result.csrfToken);
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    try { await api.post('/api/v1/auth/logout'); } catch { /* session may already be gone */ }
    setCsrfToken('');
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, loading, login, logout, refresh }), [user, loading, login, logout, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
