import { Navigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import type { TenantRole } from '../../lib/types';

export function useTenant() {
  const { me, tenantId } = useAuth();
  const m = me?.memberships.find((x) => x.tenantId === tenantId) ?? null;
  return { tenantId, tenant: m, role: (m?.role ?? null) as TenantRole | null, canManage: m?.role === 'owner' || m?.role === 'admin', suspended: m?.tenantStatus === 'suspended' };
}

export function NeedsWorkspace({ children }: { children: React.ReactNode }) {
  const { tenantId } = useTenant();
  if (!tenantId) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
