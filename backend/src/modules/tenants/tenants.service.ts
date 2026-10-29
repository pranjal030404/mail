import { canAssignRole, effectiveLimits, type Limits, type LimitOverrides, type TenantRole } from '../../core/index.js';
import type { AppContext } from '../../context.js';
import { exec, isDuplicateKey, one, rows, tx } from '../../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { randomToken, sha256Hex } from '../../shared/crypto.js';
import { newId } from '../../shared/ids.js';
import { audit } from '../audit/audit.service.js';
import type { AuthUser, RequestMeta } from '../auth/auth.service.js';
import { templates } from '../notifications/templates.js';
import { getSettings } from '../settings/settings.service.js';

const INVITE_DAYS = 7;

export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'workspace';
}

export async function createTenant(ctx: AppContext, user: AuthUser, name: string, meta: RequestMeta) {
  if (user.kind === 'platform_admin') throw forbidden('admin_customer_actions', 'Platform administrators cannot own customer workspaces.');
  if (!user.email_verified_at) throw forbidden('email_not_verified', 'Verify your email address first.');
  const settings = await getSettings(ctx.db);
  const owned = await one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM tenant_memberships WHERE user_id = ? AND role = 'owner' AND status = 'active'", [user.id]);
  if ((owned?.n ?? 0) >= settings.max_tenants_per_user) throw conflict('tenant_limit', `You can own at most ${settings.max_tenants_per_user} workspaces.`);
  const plan = await one<{ id: string }>(ctx.db, 'SELECT id FROM plans WHERE code = ? AND is_active = 1', [settings.default_plan_code]);
  if (!plan) throw conflict('no_default_plan', 'No default plan is configured. Contact support.');

  const tenantId = newId();
  const slug = `${slugify(name)}-${tenantId.slice(-6).toLowerCase()}`;
  await tx(ctx.db, async (conn) => {
    await exec(conn, 'INSERT INTO tenants (id, name, slug, plan_id, created_by) VALUES (?, ?, ?, ?, ?)', [tenantId, name.trim(), slug, plan.id, user.id]);
    await exec(conn, "INSERT INTO subscriptions (id, tenant_id, plan_id, status) VALUES (?, ?, ?, 'active')", [newId(), tenantId, plan.id]);
    await exec(conn, "INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status) VALUES (?, ?, ?, 'owner', 'active')", [newId(), tenantId, user.id]);
    await audit(conn, { actorType: 'user', actorUserId: user.id, tenantId, action: 'tenant.create', targetType: 'tenant', targetId: tenantId, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip });
  });
  return { id: tenantId, name: name.trim(), slug };
}

interface PlanRow extends Record<string, unknown> {
  max_domains: number;
  max_mailboxes: number;
  max_mailboxes_per_domain: number;
  max_aliases: number;
  mailbox_quota_default_bytes: number;
  mailbox_quota_max_bytes: number;
  tenant_storage_max_bytes: number;
  attachment_max_bytes: number;
  daily_send_limit: number;
  hourly_send_limit: number;
  allow_external_forwarding: number;
  allow_catch_all: number;
  warn_thresholds: number[];
}

/** Plan limits merged with tenant-specific overrides. */
export async function getTenantLimits(ctx: AppContext, tenantId: string): Promise<Limits> {
  const plan = await one<PlanRow>(ctx.db, 'SELECT p.* FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = ?', [tenantId]);
  if (!plan) throw notFound('Workspace');
  const q = await one<Record<string, number | null>>(ctx.db, 'SELECT * FROM tenant_quotas WHERE tenant_id = ?', [tenantId]);
  const camel = (r: PlanRow): Limits => ({
    maxDomains: r.max_domains,
    maxMailboxes: r.max_mailboxes,
    maxMailboxesPerDomain: r.max_mailboxes_per_domain,
    maxAliases: r.max_aliases,
    mailboxQuotaDefaultBytes: Number(r.mailbox_quota_default_bytes),
    mailboxQuotaMaxBytes: Number(r.mailbox_quota_max_bytes),
    tenantStorageMaxBytes: Number(r.tenant_storage_max_bytes),
    attachmentMaxBytes: Number(r.attachment_max_bytes),
    dailySendLimit: r.daily_send_limit,
    hourlySendLimit: r.hourly_send_limit,
    allowExternalForwarding: Boolean(r.allow_external_forwarding),
    allowCatchAll: Boolean(r.allow_catch_all),
    warnThresholds: r.warn_thresholds,
  });
  const overrides: LimitOverrides | null = q
    ? {
        maxDomains: q.max_domains ?? null,
        maxMailboxes: q.max_mailboxes ?? null,
        maxMailboxesPerDomain: q.max_mailboxes_per_domain ?? null,
        maxAliases: q.max_aliases ?? null,
        mailboxQuotaMaxBytes: q.mailbox_quota_max_bytes ?? null,
        tenantStorageMaxBytes: q.tenant_storage_max_bytes ?? null,
        attachmentMaxBytes: q.attachment_max_bytes ?? null,
        dailySendLimit: q.daily_send_limit ?? null,
        hourlySendLimit: q.hourly_send_limit ?? null,
        allowExternalForwarding: q.allow_external_forwarding === null || q.allow_external_forwarding === undefined ? null : Boolean(q.allow_external_forwarding),
        allowCatchAll: q.allow_catch_all === null || q.allow_catch_all === undefined ? null : Boolean(q.allow_catch_all),
      }
    : null;
  return effectiveLimits(camel(plan), overrides);
}

export async function getTenantDetail(ctx: AppContext, tenantId: string) {
  const t = await one<{ id: string; name: string; slug: string; status: string; plan_code: string; plan_name: string; created_at: Date; suspended_reason: string | null }>(
    ctx.db,
    'SELECT t.id, t.name, t.slug, t.status, t.suspended_reason, t.created_at, p.code AS plan_code, p.name AS plan_name FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = ?',
    [tenantId],
  );
  if (!t) throw notFound('Workspace');
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    status: t.status,
    plan: { code: t.plan_code, name: t.plan_name },
    createdAt: t.created_at,
    limits: await getTenantLimits(ctx, tenantId),
  };
}

export async function renameTenant(ctx: AppContext, tenantId: string, name: string, actor: AuthUser, meta: RequestMeta) {
  await exec(ctx.db, 'UPDATE tenants SET name = ? WHERE id = ?', [name.trim(), tenantId]);
  await audit(ctx.db, { actorType: 'user', actorUserId: actor.id, tenantId, action: 'tenant.update', targetType: 'tenant', targetId: tenantId, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip });
}

// ---------------------------------------------------------------- members

export async function listMembers(ctx: AppContext, tenantId: string) {
  return rows<{ id: string; user_id: string | null; email: string | null; display_name: string | null; role: TenantRole; status: string; invitation_expires_at: Date | null; created_at: Date }>(
    ctx.db,
    `SELECT m.id, m.user_id, COALESCE(u.login_email, m.invited_email) AS email, u.display_name, m.role, m.status, m.invitation_expires_at, m.created_at
       FROM tenant_memberships m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = ? AND m.status IN ('active','invited') ORDER BY m.created_at`,
    [tenantId],
  );
}

export async function inviteMember(ctx: AppContext, tenantId: string, actor: AuthUser, actorRole: TenantRole, emailRaw: string, role: TenantRole, meta: RequestMeta, mailboxId?: string) {
  if (!canAssignRole(actorRole, role)) throw forbidden('cannot_assign_role', 'You cannot assign that role.');
  const email = emailRaw.trim().toLowerCase();
  if (mailboxId) {
    if (role !== 'mailbox_user') throw badRequest('invalid_mailbox_link', 'Only the mailbox user role can be linked to a mailbox.');
    if (!(await one(ctx.db, "SELECT id FROM mailboxes WHERE id = ? AND tenant_id = ? AND status NOT IN ('deleted','retained')", [mailboxId, tenantId]))) throw notFound('Mailbox');
  }
  const existing = await one<{ id: string }>(
    ctx.db,
    `SELECT m.id FROM tenant_memberships m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = ? AND m.status IN ('active','invited') AND (u.login_email = ? OR m.invited_email = ?)`,
    [tenantId, email, email],
  );
  if (existing) throw conflict('already_member', 'That person is already a member or has a pending invitation.');
  const tenant = await one<{ name: string }>(ctx.db, 'SELECT name FROM tenants WHERE id = ?', [tenantId]);
  const token = randomToken();
  const id = newId();
  await exec(
    ctx.db,
    `INSERT INTO tenant_memberships (id, tenant_id, invited_email, role, status, invitation_token_hash, invitation_expires_at, invited_by, mailbox_id)
     VALUES (?, ?, ?, ?, 'invited', ?, DATE_ADD(NOW(3), INTERVAL ? DAY), ?, ?)`,
    [id, tenantId, email, role, sha256Hex(token), INVITE_DAYS, actor.id, mailboxId ?? null],
  );
  const m = templates.tenantInvitation(ctx.config.APP_BASE_URL, tenant?.name ?? 'a workspace', role, token);
  await ctx.mailer.send({ to: email, subject: m.subject, text: m.text, category: 'tenant_invitation' });
  await audit(ctx.db, { actorType: 'user', actorUserId: actor.id, tenantId, action: 'member.invite', targetType: 'membership', targetId: id, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip, metadata: { role } });
  return { id };
}

export async function acceptInvitation(ctx: AppContext, user: AuthUser, token: string, meta: RequestMeta) {
  if (user.kind === 'platform_admin') throw forbidden('admin_customer_actions', 'Platform administrators cannot join customer workspaces.');
  const inv = await one<{ id: string; tenant_id: string; invited_email: string; role: TenantRole }>(
    ctx.db,
    "SELECT id, tenant_id, invited_email, role FROM tenant_memberships WHERE invitation_token_hash = ? AND status = 'invited' AND invitation_expires_at > NOW(3)",
    [sha256Hex(token)],
  );
  // Same response whether the token is bad or belongs to a different address.
  if (!inv || inv.invited_email !== user.login_email) throw badRequest('invalid_invitation', 'This invitation is invalid, expired or addressed to a different account.');
  try {
    const res = await exec(
      ctx.db,
      "UPDATE tenant_memberships SET user_id = ?, status = 'active', invitation_token_hash = NULL, invited_email = NULL WHERE id = ? AND status = 'invited'",
      [user.id, inv.id],
    );
    if (res.affectedRows !== 1) throw badRequest('invalid_invitation', 'This invitation is invalid or has already been used.');
  } catch (err) {
    if (isDuplicateKey(err)) throw conflict('already_member', 'You are already a member of this workspace.');
    throw err;
  }
  await audit(ctx.db, { actorType: 'user', actorUserId: user.id, tenantId: inv.tenant_id, action: 'member.accept', targetType: 'membership', targetId: inv.id, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip });
  return { tenantId: inv.tenant_id, role: inv.role };
}

async function activeOwnerCount(ctx: AppContext, conn: Parameters<typeof one>[0], tenantId: string): Promise<number> {
  return (await one<{ n: number }>(conn, "SELECT COUNT(*) AS n FROM tenant_memberships WHERE tenant_id = ? AND role = 'owner' AND status = 'active' FOR UPDATE", [tenantId]))?.n ?? 0;
}

export async function changeMemberRole(ctx: AppContext, tenantId: string, actor: AuthUser, actorRole: TenantRole, membershipId: string, newRole: TenantRole, meta: RequestMeta) {
  await tx(ctx.db, async (conn) => {
    const target = await one<{ id: string; role: TenantRole; status: string }>(conn, 'SELECT id, role, status FROM tenant_memberships WHERE id = ? AND tenant_id = ? FOR UPDATE', [membershipId, tenantId]);
    if (!target || target.status === 'revoked') throw notFound('Member');
    if (!canAssignRole(actorRole, newRole) || !canAssignRole(actorRole, target.role)) throw forbidden('cannot_assign_role', 'You cannot change that role.');
    if (target.role === 'owner' && newRole !== 'owner' && (await activeOwnerCount(ctx, conn, tenantId)) <= 1) throw conflict('last_owner', 'A workspace must keep at least one owner.');
    await exec(conn, 'UPDATE tenant_memberships SET role = ? WHERE id = ?', [newRole, membershipId]);
    await audit(conn, { actorType: 'user', actorUserId: actor.id, tenantId, action: 'member.role_change', targetType: 'membership', targetId: membershipId, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip, metadata: { from: target.role, to: newRole } });
  });
}

export async function removeMember(ctx: AppContext, tenantId: string, actor: AuthUser, actorRole: TenantRole, membershipId: string, meta: RequestMeta) {
  await tx(ctx.db, async (conn) => {
    const target = await one<{ id: string; role: TenantRole; status: string; user_id: string | null }>(conn, 'SELECT id, role, status, user_id FROM tenant_memberships WHERE id = ? AND tenant_id = ? FOR UPDATE', [membershipId, tenantId]);
    if (!target || target.status === 'revoked') throw notFound('Member');
    const self = target.user_id === actor.id;
    if (!self && !canAssignRole(actorRole, target.role)) throw forbidden('cannot_assign_role', 'You cannot remove that member.');
    if (target.role === 'owner' && target.status === 'active' && (await activeOwnerCount(ctx, conn, tenantId)) <= 1) throw conflict('last_owner', 'A workspace must keep at least one owner.');
    await exec(conn, "UPDATE tenant_memberships SET status = 'revoked', invitation_token_hash = NULL WHERE id = ?", [membershipId]);
    await audit(conn, { actorType: 'user', actorUserId: actor.id, tenantId, action: 'member.remove', targetType: 'membership', targetId: membershipId, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip });
  });
}
