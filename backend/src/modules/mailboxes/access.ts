import { tenantCan } from '../../core/index.js';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { one } from '../../db/pool.js';
import { notFound } from '../../shared/errors.js';
import { authorizeTenant, type TenantAccess } from '../tenants/access.js';

/**
 * Admins/owners may act on any mailbox in their workspace; a mailbox_user may act only on the
 * mailbox linked to their membership. Reading another mailbox is always denied, and the response
 * is 404 so mailbox existence is not revealed.
 */
export async function authorizeMailboxAccess(
  ctx: AppContext,
  req: FastifyRequest,
  tenantId: string,
  mailboxId: string,
  mode: 'read' | 'manage' | 'self-write',
): Promise<TenantAccess> {
  const access = await authorizeTenant(ctx, req, tenantId, 'tenant.read', { write: mode !== 'read' });
  if (mode === 'manage') {
    if (!tenantCan(access.role, 'mailboxes.manage')) throw notFound('Mailbox');
    return access;
  }
  if (tenantCan(access.role, 'mailboxes.read')) return access;
  const link = await one<{ mailbox_id: string | null }>(ctx.db, 'SELECT mailbox_id FROM tenant_memberships WHERE id = ?', [access.membershipId]);
  if (tenantCan(access.role, 'mailbox.self') && link?.mailbox_id === mailboxId) return access;
  throw notFound('Mailbox');
}
