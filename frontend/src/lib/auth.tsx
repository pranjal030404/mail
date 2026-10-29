import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, get, post, setCsrfToken } from './api';
import type { Me } from './types';

interface AuthValue {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<Me | null>;
  login: (email: string, password: string) => Promise<{ mfaRequired: boolean }>;
  logout: () => Promise<void>;
  tenantId: string | null;
  setTenantId: (id: string) => void;
}

const Ctx = createContext<AuthValue | null>(null);
const TENANT_KEY = 'arthvex.tenant';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [tenantId, setTenant] = useState<string | null>(() => {
    try {
      return localStorage.getItem(TENANT_KEY);
    } catch {
      return null;
    }
  });

  const refresh = useCallback(async () => {
    try {
      const m = await get<Me>('/me');
      setCsrfToken(m.csrfToken);
      setMe(m);
      return m;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) console.warn('session check failed');
      setMe(null);
      setCsrfToken('');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await post<{ mfaRequired: boolean; csrfToken: string }>('/auth/login', { email, password });
      setCsrfToken(res.csrfToken);
      await refresh();
      return { mfaRequired: res.mfaRequired };
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    try {
      await post('/auth/logout');
    } finally {
      setMe(null);
      setCsrfToken('');
    }
  }, []);

  const setTenantId = useCallback((id: string) => {
    setTenant(id);
    try {
      localStorage.setItem(TENANT_KEY, id);
    } catch {
      /* storage unavailable: selection just won't persist */
    }
  }, []);

  // Fall back to the first workspace when the remembered one is gone.
  const effectiveTenant = useMemo(() => {
    if (!me) return null;
    return me.memberships.find((m) => m.tenantId === tenantId)?.tenantId ?? me.memberships[0]?.tenantId ?? null;
  }, [me, tenantId]);

  const value = useMemo(() => ({ me, loading, refresh, login, logout, tenantId: effectiveTenant, setTenantId }), [me, loading, refresh, login, logout, effectiveTenant, setTenantId]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('AuthProvider missing');
  return v;
}
