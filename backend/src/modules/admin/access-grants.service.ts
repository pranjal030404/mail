import { canApproveGrant, effectiveGrantState, grantAllows, type AccessGrantLike, type AccessGrantScope } from '../../core/index.js';
import type { AppContext } from '../../context.js';
import { exec, one, rows } from '../../db/pool.js';
import { AppError, forbidden, notFound } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { audit } from '../audit/audit.service.js';

export interface GrantRow extends AccessGrantLike {
  id: string;
  tenant_id: string;
  mailbox_id: string;
  support_ticket_id: string | null;
  reason: string;
  requested_at: Date;
  approved_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
  use_count: number;
  mailbox_address?: string;
  tenant_name?: string;
  requester_email?: string;
  approver_email?: string | null;
}

const GRANT_SELECT = `SELECT g.*, m.normalized_address AS mailbox_address, t.name AS tenant_name,
  ra.login_email AS requester_email, aa.login_email AS approver_email
  FROM admin_access_grants g
  JOIN mailboxes m ON m.id = g.mailbox_id
  JOIN tenants t ON t.id = g.tenant_id
  JOIN platform_admins ra ON ra.id = g.requested_by
  LEFT JOIN platform_admins aa ON aa.id = g.approved_by`;

export function presentGrant(g: GrantRow) {
  return {
    id: g.id,
    tenantId: g.tenant_id,
    tenantName: g.tenant_name ?? null,
    mailboxId: g.mailbox_id,
    mailboxAddress: g.mailbox_address ?? null,
    requestedBy: g.requester_email ?? g.requested_by,
    approvedBy: g.approver_email ?? g.approved_by,
    reason: g.reason,
    scope: g.scope,
    status: effectiveGrantState(g),
    supportTicketId: g.support_ticket_id,
    requestedAt: g.requested_at,
    approvedAt: g.approved_at,
    expiresAt: g.expires_at,
    lastUsedAt: g.last_used_at,
    useCount: Number(g.use_count ?? 0),
  };
}

export async function createGrant(ctx: AppContext, adminId: string, input: { mailboxId: string; reason: string; scope: AccessGrantScope; supportTicketId?: string | undefined }, meta: { ip: string; correlationId: string }) {
  const mailbox = await one<{ id: string; tenant_id: string; status: string }>(ctx.db, "SELECT id, tenant_id, status FROM mailboxes WHERE id = ? AND status NOT IN ('deleted','retained')", [input.mailboxId]);
  if (!mailbox) throw notFound('Mailbox');
  if (input.scope !== 'read') throw new AppError(400, 'unsupported_scope', 'Only read access is available in this release.');
  if (input.supportTicketId) {
    const ticket = await one<{ id: string }>(ctx.db, 'SELECT id FROM support_tickets WHERE id = ? AND tenant_id = ?', [input.supportTicketId, mailbox.tenant_id]);
    if (!ticket) throw new AppError(400, 'invalid_ticket', 'That support ticket does not belong to this workspace.');
  }
  const existing = await one<{ id: string }>(ctx.db, "SELECT id FROM admin_access_grants WHERE mailbox_id = ? AND requested_by = ? AND status IN ('pending_approval','active')", [input.mailboxId, adminId]);
  if (existing) throw new AppError(409, 'grant_exists', 'You already have a pending or active grant for this mailbox.');
  const id = newId();
  await exec(
    ctx.db,
    'INSERT INTO admin_access_grants (id, tenant_id, mailbox_id, requested_by, support_ticket_id, reason, scope, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, mailbox.tenant_id, mailbox.id, adminId, input.supportTicketId ?? null, input.reason, input.scope, 'pending_approval'],
  );
  await audit(ctx.db, {
    actorType: 'platform_admin',
    actorAdminId: adminId,
    tenantId: mailbox.tenant_id,
    action: 'admin.access_grant.request',
    targetType: 'mailbox',
    targetId: mailbox.id,
    outcome: 'success',
    reason: input.reason,
    correlationId: meta.correlationId,
    ip: meta.ip,
  });
  return presentGrant((await loadGrant(ctx, id))!);
}

export async function loadGrant(ctx: AppContext, grantId: string): Promise<GrantRow | null> {
  return one<GrantRow>(ctx.db, `${GRANT_SELECT} WHERE g.id = ?`, [grantId]);
}

export async function listGrants(ctx: AppContext, opts: { status?: string | undefined; mine?: string | undefined }) {
  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  if (opts.status) {
    where.push('g.status = ?');
    params.push(opts.status);
  }
  if (opts.mine) {
    where.push('g.requested_by = ?');
    params.push(opts.mine);
  }
  const list = await rows<GrantRow>(ctx.db, `${GRANT_SELECT} WHERE ${where.join(' AND ')} ORDER BY g.created_at DESC LIMIT 200`, params);
  return list.map(presentGrant);
}

async function expireIfNeeded(ctx: AppContext, grant: GrantRow, meta: { ip: string; correlationId: string }): Promise<GrantRow> {
  if (grant.status === 'active' && effectiveGrantState(grant) === 'expired') {
    await exec(ctx.db, "UPDATE admin_access_grants SET status = 'expired' WHERE id = ? AND status = 'active'", [grant.id]);
    await audit(ctx.db, {
      actorType: 'system',
      tenantId: grant.tenant_id,
      action: 'admin.access_grant.expired',
      targetType: 'mailbox',
      targetId: grant.mailbox_id,
      outcome: 'success',
      reason: grant.reason,
      correlationId: meta.correlationId,
      ip: meta.ip,
    });
    return { ...grant, status: 'expired' };
  }
  return grant;
}

export async function approveGrant(ctx: AppContext, grantId: string, approverId: string, meta: { ip: string; correlationId: string }) {
  const grant = await loadGrant(ctx, grantId);
  if (!grant) throw notFound('Access grant');
  const check = canApproveGrant(grant, approverId);
  if (!check.ok) throw new AppError(check.code === 'two_person_rule' ? 403 : 409, check.code, check.message);
  const res = await exec(
    ctx.db,
    "UPDATE admin_access_grants SET status = 'active', approved_by = ?, approved_at = NOW(3), expires_at = DATE_ADD(NOW(3), INTERVAL ? MINUTE) WHERE id = ? AND status = 'pending_approval'",
    [approverId, ctx.config.ADMIN_ACCESS_GRANT_TTL_MINUTES, grantId],
  );
  if (res.affectedRows !== 1) throw new AppError(409, 'invalid_state', 'This request is no longer awaiting approval.');
  await audit(ctx.db, {
    actorType: 'platform_admin',
    actorAdminId: approverId,
    tenantId: grant.tenant_id,
    action: 'admin.access_grant.approve',
    targetType: 'mailbox',
    targetId: grant.mailbox_id,
    outcome: 'success',
    reason: grant.reason,
    correlationId: meta.correlationId,
    ip: meta.ip,
    metadata: { grantId, ttlMinutes: ctx.config.ADMIN_ACCESS_GRANT_TTL_MINUTES },
  });
  return presentGrant((await loadGrant(ctx, grantId))!);
}

export async function denyGrant(ctx: AppContext, grantId: string, approverId: string, reason: string, meta: { ip: string; correlationId: string }) {
  const grant = await loadGrant(ctx, grantId);
  if (!grant) throw notFound('Access grant');
  if (grant.status !== 'pending_approval') throw new AppError(409, 'invalid_state', 'This request is no longer awaiting approval.');
  if (grant.requested_by === approverId) throw forbidden('two_person_rule', 'A second super administrator must review this request.');
  await exec(ctx.db, "UPDATE admin_access_grants SET status = 'denied', approved_by = ?, approved_at = NOW(3) WHERE id = ? AND status = 'pending_approval'", [approverId, grantId]);
  await audit(ctx.db, {
    actorType: 'platform_admin',
    actorAdminId: approverId,
    tenantId: grant.tenant_id,
    action: 'admin.access_grant.deny',
    targetType: 'mailbox',
    targetId: grant.mailbox_id,
    outcome: 'success',
    reason,
    correlationId: meta.correlationId,
    ip: meta.ip,
  });
  return presentGrant((await loadGrant(ctx, grantId))!);
}

export async function revokeGrant(ctx: AppContext, grantId: string, adminId: string, reason: string, meta: { ip: string; correlationId: string }) {
  const grant = await loadGrant(ctx, grantId);
  if (!grant) throw notFound('Access grant');
  const res = await exec(ctx.db, "UPDATE admin_access_grants SET status = 'revoked', revoked_at = NOW(3) WHERE id = ? AND status IN ('pending_approval','active')", [grantId]);
  if (res.affectedRows !== 1) throw new AppError(409, 'invalid_state', 'Only a pending or active grant can be revoked.');
  await audit(ctx.db, {
    actorType: 'platform_admin',
    actorAdminId: adminId,
    tenantId: grant.tenant_id,
    action: 'admin.access_grant.revoke',
    targetType: 'mailbox',
    targetId: grant.mailbox_id,
    outcome: 'success',
    reason,
    correlationId: meta.correlationId,
    ip: meta.ip,
  });
  return presentGrant((await loadGrant(ctx, grantId))!);
}

/**
 * Verifies that `adminId` may read this mailbox through this grant right now, records the use and
 * audits it. Every content request calls this; there is no cached entitlement.
 */
export async function authorizeGrantUse(ctx: AppContext, grantId: string, adminId: string, meta: { ip: string; correlationId: string }): Promise<GrantRow> {
  const loaded = await loadGrant(ctx, grantId);
  if (!loaded) throw notFound('Access grant');
  const grant = await expireIfNeeded(ctx, loaded, meta);
  if (grant.requested_by !== adminId) throw forbidden('grant_not_yours', 'This access grant was issued to another operator.');
  if (!grantAllows(grant, 'read')) {
    await audit(ctx.db, {
      actorType: 'platform_admin',
      actorAdminId: adminId,
      tenantId: grant.tenant_id,
      action: 'admin.access_grant.denied',
      targetType: 'mailbox',
      targetId: grant.mailbox_id,
      outcome: 'denied',
      reason: grant.reason,
      correlationId: meta.correlationId,
      ip: meta.ip,
      metadata: { grantId, state: effectiveGrantState(grant) },
    });
    throw forbidden('grant_inactive', 'This access grant is not active. Request a new one.');
  }
  await exec(ctx.db, 'UPDATE admin_access_grants SET use_count = use_count + 1, last_used_at = NOW(3) WHERE id = ?', [grantId]);
  await audit(ctx.db, {
    actorType: 'platform_admin',
    actorAdminId: adminId,
    tenantId: grant.tenant_id,
    action: 'admin.access_grant.use',
    targetType: 'mailbox',
    targetId: grant.mailbox_id,
    outcome: 'success',
    reason: grant.reason,
    correlationId: meta.correlationId,
    ip: meta.ip,
    metadata: { grantId },
  });
  return grant;
}

/** Worker sweep: active grants become expired without operator action. */
export async function expireGrants(ctx: AppContext): Promise<number> {
  const due = await rows<{ id: string; tenant_id: string; mailbox_id: string; reason: string }>(
    ctx.db,
    "SELECT id, tenant_id, mailbox_id, reason FROM admin_access_grants WHERE status = 'active' AND expires_at <= NOW(3) LIMIT 200",
  );
  let n = 0;
  for (const g of due) {
    const res = await exec(ctx.db, "UPDATE admin_access_grants SET status = 'expired' WHERE id = ? AND status = 'active'", [g.id]);
    if (res.affectedRows === 1) {
      n++;
      await audit(ctx.db, { actorType: 'worker', tenantId: g.tenant_id, action: 'admin.access_grant.expired', targetType: 'mailbox', targetId: g.mailbox_id, outcome: 'success', reason: g.reason });
    }
  }
  return n;
}
