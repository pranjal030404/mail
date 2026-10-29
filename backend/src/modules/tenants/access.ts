import { tenantCan, type TenantAction, type TenantRole } from '../../core/index.js';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { one } from '../../db/pool.js';
import { requireUser, type AuthState } from '../../plugins/session.js';
import { AppError, forbidden, notFound } from '../../shared/errors.js';

export interface TenantAccess {
  auth: AuthState;
  tenantId: string;
  role: TenantRole;
  membershipId: string;
  tenantStatus: 'active' | 'suspended' | 'closed';
}

/**
 * The single entry point for tenant authorization. Non-members get 404 (existence is not revealed);
 * members lacking the permission get 403; writes to a suspended tenant are refused.
 * Knowing an object ID is never sufficient: every query that follows must also filter by access.tenantId.
 */
export async function authorizeTenant(
  ctx: AppContext,
  req: FastifyRequest,
  tenantId: string,
  action: TenantAction,
  opts: { write?: boolean } = {},
): Promise<TenantAccess> {
  const auth = requireUser(req);
  const m = await one<{ id: string; role: TenantRole; tenant_status: TenantAccess['tenantStatus'] }>(
    ctx.db,
    `SELECT m.id, m.role, t.status AS tenant_status FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
      WHERE m.tenant_id = ? AND m.user_id = ? AND m.status = 'active'`,
    [tenantId, auth.user.id],
  );
  if (!m) throw notFound('Workspace');
  if (!tenantCan(m.role, action)) throw forbidden();
  if (opts.write && m.tenant_status !== 'active') throw new AppError(403, 'tenant_suspended', 'This workspace is suspended. Contact support.');
  return { auth, tenantId, role: m.role, membershipId: m.id, tenantStatus: m.tenant_status };
}
