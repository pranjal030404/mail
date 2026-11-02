import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { TENANT_ROLES, SYSTEM_ROLES } from '../../core/index.js';
import type { AppContext } from '../../context.js';
import { exec, one, rows } from '../../db/pool.js';
import { AppError, forbidden, notFound, parse } from '../../shared/errors.js';
import { requirePermission, type AuthState } from '../../plugins/session.js';
import { audit } from '../audit/audit.service.js';
import { revokeAllSessions } from '../auth/auth.service.js';
import { activateAccount, invitationInfo, listInvitations, resendInvitation, revokeInvitation, issueInvitation, kickOutbox, type InvitationRow } from '../invitations/invitations.service.js';
import { clientSettings, cancelDeletion, createMailbox, present, resetCredentials, scheduleDeletion, loadMailbox, updateMailbox } from '../mailboxes/mailboxes.service.js';
import { enqueueEmail, outboxStats, retryEmail, testEmailConfiguration } from '../notifications/outbox.service.js';
import { assignAdminRole, createRole, deleteRole, getRole, listPermissions, listRoles, roleMembers, updateRole } from '../rbac/rbac.service.js';
import { getTenantLimits } from '../tenants/tenants.service.js';
import * as users from './users.service.js';
import { tx } from '../../db/pool.js';
import { newId } from '../../shared/ids.js';

const id = z.string().length(26);
const reason = z.string().trim().min(5).max(500);
const Sensitive = z.object({ reason, confirm: z.literal(true, { error: 'Explicit confirmation is required.' }) });
const page = { page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) };
const like = (s: string) => `%${s.replace(/[%_\\]/g, '\\$&')}%`;

const limit = (ctx: AppContext, max: number, windowMs = 60_000) => ({ rateLimit: { max: ctx.config.RATE_LIMIT_ENABLED ? max : 1_000_000, timeWindow: windowMs } });

export async function consoleRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const actorOf = (a: AuthState): users.AdminActor => ({ id: a.user.id, display_name: a.user.display_name, permissions: a.user.permissions ?? new Set() });
  const adminAudit = (req: FastifyRequest, a: AuthState, action: string, targetType: string, targetId: string | null, extra: { tenantId?: string | null; reason?: string; metadata?: Record<string, unknown> } = {}) =>
    audit(ctx.db, { actorType: 'platform_admin', actorAdminId: a.user.id, tenantId: extra.tenantId ?? null, action, targetType, targetId, outcome: 'success', ...(extra.reason ? { reason: extra.reason } : {}), correlationId: req.meta.correlationId, ip: req.meta.ip, ...(extra.metadata ? { metadata: extra.metadata } : {}) });

  // ================= public activation (token-authenticated, no session) =================
  app.post('/auth/invitation-info', { config: limit(ctx, 30, 3600_000) }, async (req) => {
    const { token } = parse(z.object({ token: z.string().min(20).max(200) }), req.body);
    return invitationInfo(ctx, token);
  });

  app.post('/auth/activate', { config: limit(ctx, 10, 3600_000) }, async (req) => {
    const body = parse(z.object({ token: z.string().min(20).max(200), email: z.string().trim().max(254), password: z.string().min(1).max(256), acceptTerms: z.boolean() }), req.body);
    await activateAccount(ctx, body, req.meta);
    return { ok: true };
  });

  // ================= dashboard =================
  app.get('/admin/dashboard', async (req) => {
    requirePermission(ctx, req, 'dashboard.read');
    const { days } = parse(z.object({ days: z.coerce.number().int().refine((d) => [1, 7, 30, 90].includes(d), 'days must be 1, 7, 30 or 90').default(7) }), req.query);
    const c = (await one<Record<string, number | string>>(
      ctx.db,
      `SELECT
        (SELECT COUNT(*) FROM users) AS users_total,
        (SELECT COUNT(*) FROM users WHERE status = 'active') AS users_active,
        (SELECT COUNT(*) FROM users WHERE status = 'suspended') AS users_suspended,
        (SELECT COUNT(*) FROM users WHERE created_at > DATE_SUB(NOW(3), INTERVAL ? DAY)) AS users_new,
        (SELECT COUNT(*) FROM account_invitations WHERE status = 'pending' AND expires_at > NOW(3)) AS invites_pending,
        (SELECT COUNT(*) FROM account_invitations WHERE status = 'pending' AND expires_at <= NOW(3)) AS invites_expired,
        (SELECT COUNT(*) FROM account_invitations WHERE delivery = 'failed' AND status = 'pending') AS invites_failed,
        (SELECT COUNT(*) FROM tenants) AS tenants_total,
        (SELECT COUNT(*) FROM tenants WHERE status = 'suspended') AS tenants_suspended,
        (SELECT COUNT(*) FROM domains WHERE status <> 'removed') AS domains_total,
        (SELECT COUNT(*) FROM domains WHERE ownership_status = 'verified' AND status <> 'removed') AS domains_verified,
        (SELECT COUNT(*) FROM mailboxes WHERE status = 'active') AS mb_active,
        (SELECT COUNT(*) FROM mailboxes WHERE status = 'suspended') AS mb_suspended,
        (SELECT COUNT(*) FROM mailboxes WHERE status IN ('draft','provisioning')) AS mb_pending,
        (SELECT COUNT(*) FROM mailboxes WHERE status = 'provisioning_failed') AS mb_failed,
        (SELECT COALESCE(SUM(used_bytes),0) FROM mailboxes WHERE status NOT IN ('deleted','retained')) AS storage_used,
        (SELECT COALESCE(SUM(quota_bytes),0) FROM mailboxes WHERE status NOT IN ('deleted','retained')) AS storage_allocated,
        (SELECT COUNT(*) FROM provisioning_jobs WHERE status = 'succeeded' AND completed_at > DATE_SUB(NOW(3), INTERVAL ? DAY)) AS jobs_ok,
        (SELECT COUNT(*) FROM provisioning_jobs WHERE status IN ('failed','needs_manual_review') AND updated_at > DATE_SUB(NOW(3), INTERVAL ? DAY)) AS jobs_failed,
        (SELECT COUNT(*) FROM provisioning_jobs WHERE status IN ('queued','retrying','running')) AS jobs_pending`,
      [days, days, days],
    ))!;
    const emails = await outboxStats(ctx.db);
    const recentFailures = await rows(ctx.db, "SELECT id, kind, to_email, attempts, last_error, updated_at FROM email_outbox WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 5");
    const canAudit = req.auth!.user.permissions?.has('audit.read');
    const activity = canAudit ? await rows(ctx.db, "SELECT occurred_at, action, outcome, target_type, target_id FROM audit_logs WHERE actor_type = 'platform_admin' ORDER BY id DESC LIMIT 10") : null;
    const engine = await ctx.mail.healthCheck().then((h) => ({ ...h, available: true })).catch(() => ({ ok: false, detail: 'Health check failed', available: true }));
    return {
      rangeDays: days,
      counts: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Number(v)])),
      emails,
      recentEmailFailures: recentFailures,
      activity,
      mailEngine: { ...engine, kind: ctx.mail.kind },
      unavailable: { mailQueue: 'Mail-queue depth is reported by the mail server and is not collected by the control plane.', lastActivity: 'Per-mailbox last activity is not collected.' },
    };
  });

  // ================= permissions & roles =================
  app.get('/admin/permissions', async (req) => {
    requirePermission(ctx, req, 'permissions.read');
    return { permissions: (await listPermissions(ctx.db)).map(({ is_sensitive, ...p }) => ({ ...p, sensitive: Boolean(is_sensitive) })), systemRoles: SYSTEM_ROLES.map((r) => r.key) };
  });

  app.get('/admin/roles', async (req) => {
    requirePermission(ctx, req, 'roles.read');
    return { roles: await listRoles(ctx.db) };
  });

  app.get('/admin/roles/:roleId', async (req) => {
    requirePermission(ctx, req, 'roles.read');
    const { roleId } = parse(z.object({ roleId: id }), req.params);
    return { role: await getRole(ctx.db, roleId), members: await roleMembers(ctx.db, roleId) };
  });

  const RoleBody = z.object({ name: z.string().trim().min(3).max(80), description: z.string().trim().max(300).default(''), permissions: z.array(z.string().max(64)).max(200) });

  app.post('/admin/roles', { config: limit(ctx, 30) }, async (req, reply) => {
    const a = requirePermission(ctx, req, 'roles.create');
    const body = parse(RoleBody, req.body);
    const role = await createRole(ctx.db, a.user.permissions!, body, a.user.id);
    await adminAudit(req, a, 'role.create', 'role', role.id, { metadata: { name: role.name, permissions: role.permissions.length } });
    return reply.code(201).send({ role });
  });

  app.patch('/admin/roles/:roleId', { config: limit(ctx, 30) }, async (req) => {
    const a = requirePermission(ctx, req, 'roles.update');
    const { roleId } = parse(z.object({ roleId: id }), req.params);
    const body = parse(RoleBody.partial(), req.body);
    const { before, after } = await updateRole(ctx.db, a.user.permissions!, roleId, body);
    const added = after.permissions.filter((p) => !before.permissions.includes(p));
    const removed = before.permissions.filter((p) => !after.permissions.includes(p));
    await adminAudit(req, a, 'role.update', 'role', roleId, { metadata: { added, removed } });
    // Holders of this role are re-evaluated on their next request (permissions are never cached in sessions).
    return { role: after };
  });

  app.post('/admin/roles/:roleId/duplicate', { config: limit(ctx, 30) }, async (req, reply) => {
    const a = requirePermission(ctx, req, 'roles.create');
    const { roleId } = parse(z.object({ roleId: id }), req.params);
    const { name } = parse(z.object({ name: z.string().trim().min(3).max(80) }), req.body);
    const source = await getRole(ctx.db, roleId);
    const role = await createRole(ctx.db, a.user.permissions!, { name, description: source.description, permissions: source.permissions }, a.user.id);
    await adminAudit(req, a, 'role.duplicate', 'role', role.id, { metadata: { from: roleId } });
    return reply.code(201).send({ role });
  });

  app.delete('/admin/roles/:roleId', async (req) => {
    const a = requirePermission(ctx, req, 'roles.delete');
    const { roleId } = parse(z.object({ roleId: id }), req.params);
    const role = await deleteRole(ctx.db, roleId);
    await adminAudit(req, a, 'role.delete', 'role', roleId, { metadata: { name: role.name } });
    return { ok: true };
  });

  app.put('/admin/admins/:adminId/role', { config: limit(ctx, 20) }, async (req) => {
    const a = requirePermission(ctx, req, 'admins.manage');
    const { adminId } = parse(z.object({ adminId: id }), req.params);
    const body = parse(Sensitive.extend({ roleId: id }), req.body);
    const res = await assignAdminRole(ctx.db, a.user.permissions!, adminId, body.roleId);
    // A privilege change ends the target's existing sessions so nothing stale survives.
    const revoked = await revokeAllSessions(ctx, adminId, 'role_changed', adminId === a.user.id ? a.session.id : undefined, 'platform_admin');
    await adminAudit(req, a, 'admin.role.assign', 'platform_admin', adminId, { reason: body.reason, metadata: { from: res.before, to: res.after.key, sessionsRevoked: revoked } });
    return { ok: true, role: res.after.key };
  });

  // ================= users =================
  const UserList = z.object({
    q: z.string().max(100).optional(), status: z.enum(['pending_verification', 'active', 'suspended', 'closed']).optional(), tenantId: id.optional(),
    role: z.enum(TENANT_ROLES).optional(), verified: z.enum(['yes', 'no']).optional(), mfa: z.enum(['yes', 'no']).optional(),
    createdFrom: z.string().max(30).optional(), createdTo: z.string().max(30).optional(),
    sort: z.enum(['created', 'name', 'email', 'last_login']).default('created'), dir: z.enum(['asc', 'desc']).default('desc'), ...page,
  });

  app.get('/admin/users', async (req) => {
    requirePermission(ctx, req, 'users.read');
    return users.listUsers(ctx, parse(UserList, req.query));
  });

  app.get('/admin/users/:userId', async (req) => {
    const a = requirePermission(ctx, req, 'users.read');
    const { userId } = parse(z.object({ userId: id }), req.params);
    return users.getUserDetail(ctx, userId, Boolean(a.user.permissions?.has('audit.read')));
  });

  const CreateUser = z.object({
    fullName: z.string().trim().min(1).max(120),
    email: z.string().trim().max(254).pipe(z.email()),
    displayName: z.string().trim().max(120).optional(),
    workspace: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('none') }), z.object({ mode: z.literal('personal') }),
      z.object({ mode: z.literal('company'), name: z.string().trim().min(2).max(120) }), z.object({ mode: z.literal('existing'), tenantId: id }),
    ]),
    membershipRole: z.enum(TENANT_ROLES).default('mailbox_user'),
    mailbox: z.object({ domainId: id, localPart: z.string().trim().min(1).max(64), displayName: z.string().trim().max(120).optional(), quotaBytes: z.number().int().positive().optional() }).optional(),
    invitation: z.enum(['send_now', 'send_later', 'none']).default('send_now'),
    sendMailboxInstructions: z.boolean().default(true),
  });

  app.post('/admin/users', { config: limit(ctx, 20) }, async (req, reply) => {
    const a = requirePermission(ctx, req, 'users.create');
    const body = parse(CreateUser, req.body);
    // Handing out ownership of an existing workspace is a tenant-level privilege of its own.
    if (body.workspace.mode === 'existing' && body.membershipRole === 'owner' && !a.user.permissions?.has('tenants.update')) throw forbidden('forbidden', 'Assigning workspace ownership requires tenants.update.');
    const result = await users.createUser(ctx, actorOf(a), body, req.meta);
    return reply.code(201).send(result);
  });

  app.patch('/admin/users/:userId', async (req) => {
    const a = requirePermission(ctx, req, 'users.update');
    const { userId } = parse(z.object({ userId: id }), req.params);
    const body = parse(z.object({ displayName: z.string().trim().min(1).max(120).optional(), timezone: z.string().max(64).optional(), locale: z.string().max(16).optional() }), req.body);
    await users.updateProfile(ctx, actorOf(a), userId, body, req.meta);
    return { ok: true };
  });

  const ownerGuard = (a: AuthState, role: string) => {
    if (role === 'owner' && !a.user.permissions?.has('tenants.update')) throw forbidden('forbidden', 'Assigning workspace ownership requires tenants.update.');
  };

  app.post('/admin/users/:userId/memberships', async (req, reply) => {
    const a = requirePermission(ctx, req, 'users.update');
    const { userId } = parse(z.object({ userId: id }), req.params);
    const body = parse(z.object({ tenantId: id, role: z.enum(TENANT_ROLES) }), req.body);
    ownerGuard(a, body.role);
    return reply.code(201).send(await users.addMembership(ctx, actorOf(a), userId, body.tenantId, body.role, req.meta));
  });

  app.patch('/admin/users/:userId/memberships/:membershipId', async (req) => {
    const a = requirePermission(ctx, req, 'users.update');
    const { userId, membershipId } = parse(z.object({ userId: id, membershipId: id }), req.params);
    const { role } = parse(z.object({ role: z.enum(TENANT_ROLES) }), req.body);
    ownerGuard(a, role);
    await users.changeMembershipRole(ctx, actorOf(a), userId, membershipId, role, req.meta);
    return { ok: true };
  });

  app.delete('/admin/users/:userId/memberships/:membershipId', async (req) => {
    const a = requirePermission(ctx, req, 'users.update');
    const { userId, membershipId } = parse(z.object({ userId: id, membershipId: id }), req.params);
    await users.removeMembership(ctx, actorOf(a), userId, membershipId, req.meta);
    return { ok: true };
  });

  app.post('/admin/users/:userId/suspend', { config: limit(ctx, 30) }, async (req) => {
    const a = requirePermission(ctx, req, 'users.suspend');
    const { userId } = parse(z.object({ userId: id }), req.params);
    const body = parse(Sensitive, req.body);
    await users.setUserStatus(ctx, actorOf(a), userId, 'suspended', body.reason, req.meta);
    return { ok: true };
  });

  app.post('/admin/users/:userId/reactivate', { config: limit(ctx, 30) }, async (req) => {
    const a = requirePermission(ctx, req, 'users.suspend');
    const { userId } = parse(z.object({ userId: id }), req.params);
    const body = parse(Sensitive, req.body);
    await users.setUserStatus(ctx, actorOf(a), userId, 'active', body.reason, req.meta);
    return { ok: true };
  });

  app.post('/admin/users/:userId/revoke-sessions', { config: limit(ctx, 30) }, async (req) => {
    const a = requirePermission(ctx, req, 'users.sessions.revoke');
    const { userId } = parse(z.object({ userId: id }), req.params);
    const body = parse(Sensitive, req.body);
    if (!(await one(ctx.db, 'SELECT id FROM users WHERE id = ?', [userId]))) throw notFound('User');
    const n = await revokeAllSessions(ctx, userId, 'admin_revoked');
    await adminAudit(req, a, 'user.revoke_sessions', 'user', userId, { reason: body.reason, metadata: { revoked: n } });
    return { revoked: n };
  });

  app.post('/admin/users/:userId/password-reset', { config: limit(ctx, 10) }, async (req) => {
    const a = requirePermission(ctx, req, 'users.password_reset');
    const { userId } = parse(z.object({ userId: id }), req.params);
    await users.initiatePasswordReset(ctx, actorOf(a), userId, req.meta);
    return { ok: true };
  });

  app.post('/admin/users/:userId/reset-mfa', { config: limit(ctx, 10) }, async (req) => {
    const a = requirePermission(ctx, req, 'users.password_reset');
    const { userId } = parse(z.object({ userId: id }), req.params);
    const body = parse(Sensitive, req.body);
    await users.resetMfa(ctx, actorOf(a), userId, body.reason, req.meta);
    return { ok: true };
  });

  app.get('/admin/users/:userId/deletion-preview', async (req) => {
    requirePermission(ctx, req, 'users.delete');
    const { userId } = parse(z.object({ userId: id }), req.params);
    return users.deletionPreview(ctx, userId);
  });

  app.post('/admin/users/:userId/close', { config: limit(ctx, 10) }, async (req) => {
    const a = requirePermission(ctx, req, 'users.delete');
    const { userId } = parse(z.object({ userId: id }), req.params);
    const body = parse(Sensitive.extend({ confirmEmail: z.string().trim().max(254) }), req.body);
    await users.closeAccount(ctx, actorOf(a), userId, body.confirmEmail, body.reason, req.meta);
    return { ok: true };
  });

  // Create an invitation for an existing account that has none (e.g. created with "send later").
  app.post('/admin/users/:userId/invitations', { config: limit(ctx, 20) }, async (req, reply) => {
    const a = requirePermission(ctx, req, 'users.create');
    const { userId } = parse(z.object({ userId: id }), req.params);
    const u = await one<{ login_email: string; display_name: string; status: string }>(ctx.db, 'SELECT login_email, display_name, status FROM users WHERE id = ?', [userId]);
    if (!u) throw notFound('User');
    if (u.status !== 'pending_verification') throw new AppError(409, 'invalid_state', 'The account is already activated or unavailable.');
    const existing = await one<{ id: string }>(ctx.db, "SELECT id FROM account_invitations WHERE user_id = ? AND status = 'pending' AND expires_at > NOW(3)", [userId]);
    if (existing) throw new AppError(409, 'invitation_exists', 'An outstanding invitation exists. Resend it instead.');
    const invId = newId();
    const m = await one<{ tenant_id: string; role: string; mailbox_id: string | null }>(ctx.db, "SELECT tenant_id, role, mailbox_id FROM tenant_memberships WHERE user_id = ? AND status = 'active' ORDER BY created_at LIMIT 1", [userId]);
    await tx(ctx.db, async (conn) => {
      await exec(conn, 'INSERT INTO account_invitations (id, user_id, email, tenant_id, membership_role, mailbox_id, send_mailbox_info, expires_at, created_by_admin_id) VALUES (?, ?, ?, ?, ?, ?, 1, NOW(3), ?)', [invId, userId, u.login_email, m?.tenant_id ?? null, m?.role ?? null, m?.mailbox_id ?? null, a.user.id]);
      const inv = (await one<InvitationRow>(conn, 'SELECT * FROM account_invitations WHERE id = ?', [invId]))!;
      await issueInvitation(ctx, conn, inv, { adminId: a.user.id, invitedBy: a.user.display_name, displayName: u.display_name });
      await audit(conn, { actorType: 'platform_admin', actorAdminId: a.user.id, action: 'invitation.create', targetType: 'invitation', targetId: invId, outcome: 'success', correlationId: req.meta.correlationId, ip: req.meta.ip });
    });
    kickOutbox(ctx);
    return reply.code(201).send({ id: invId });
  });

  // ================= invitations =================
  app.get('/admin/invitations', async (req) => {
    requirePermission(ctx, req, 'users.read');
    return listInvitations(ctx.db, parse(z.object({ status: z.enum(['pending', 'consumed', 'revoked', 'expired']).optional(), q: z.string().max(100).optional(), ...page }), req.query));
  });

  app.post('/admin/invitations/:invitationId/resend', { config: limit(ctx, 20) }, async (req) => {
    const a = requirePermission(ctx, req, 'users.update');
    const { invitationId } = parse(z.object({ invitationId: id }), req.params);
    return resendInvitation(ctx, invitationId, { id: a.user.id, display_name: a.user.display_name }, req.meta);
  });

  app.post('/admin/invitations/:invitationId/revoke', { config: limit(ctx, 30) }, async (req) => {
    const a = requirePermission(ctx, req, 'users.update');
    const { invitationId } = parse(z.object({ invitationId: id }), req.params);
    const body = parse(z.object({ reason }), req.body);
    await revokeInvitation(ctx, invitationId, a.user.id, body.reason, req.meta);
    return { ok: true };
  });

  // ================= email delivery =================
  app.get('/admin/notifications', async (req) => {
    requirePermission(ctx, req, 'notifications.read');
    const q = parse(z.object({ status: z.enum(['queued', 'sending', 'sent', 'failed', 'cancelled']).optional(), ...page }), req.query);
    const where = q.status ? 'WHERE status = ?' : '';
    const params = q.status ? [q.status] : [];
    const total = await one<{ n: number }>(ctx.db, `SELECT COUNT(*) AS n FROM email_outbox ${where}`, params);
    const list = await rows(ctx.db, `SELECT id, kind, to_email, status, attempts, max_attempts, next_attempt_at, last_error, related_type, related_id, created_at, sent_at FROM email_outbox ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, q.pageSize, (q.page - 1) * q.pageSize]);
    return { total: Number(total?.n ?? 0), emails: list, mailer: { kind: ctx.mailer.kind, from: ctx.config.MAIL_FROM.replace(/<.*>/, '').trim() || 'configured' } };
  });

  app.post('/admin/notifications/:emailId/retry', { config: limit(ctx, 30) }, async (req) => {
    const a = requirePermission(ctx, req, 'notifications.manage');
    const { emailId } = parse(z.object({ emailId: id }), req.params);
    if (!(await retryEmail(ctx, emailId))) throw new AppError(409, 'invalid_state', 'Only failed messages can be retried.');
    await adminAudit(req, a, 'email.retry', 'email', emailId);
    kickOutbox(ctx);
    return { ok: true };
  });

  app.post('/admin/notifications/test', { config: limit(ctx, 5) }, async (req) => {
    const a = requirePermission(ctx, req, 'notifications.manage');
    const body = parse(z.object({ to: z.string().trim().max(254).pipe(z.email()).optional() }), req.body);
    const result = await testEmailConfiguration(ctx, body.to ?? null);
    await audit(ctx.db, { actorType: 'platform_admin', actorAdminId: a.user.id, action: 'email.test', targetType: 'mailer', outcome: result.ok ? 'success' : 'failure', correlationId: req.meta.correlationId, ip: req.meta.ip, metadata: { stage: result.stage, mailer: result.mailer } });
    return result;
  });

  // ================= domains =================
  app.get('/admin/domains', async (req) => {
    requirePermission(ctx, req, 'domains.read');
    const q = parse(z.object({ q: z.string().max(100).optional(), status: z.enum(['pending', 'verified', 'failed', 'expired']).optional(), ...page }), req.query);
    const where = ["d.status <> 'removed'"];
    const params: unknown[] = [];
    if (q.q) { where.push('d.name LIKE ?'); params.push(like(q.q)); }
    if (q.status) { where.push('d.ownership_status = ?'); params.push(q.status); }
    const total = await one<{ n: number }>(ctx.db, `SELECT COUNT(*) AS n FROM domains d WHERE ${where.join(' AND ')}`, params);
    const list = await rows<Record<string, unknown>>(ctx.db, `SELECT d.id, d.name, d.tenant_id, t.name AS workspace, d.status, d.ownership_status, d.inbound_status, d.outbound_status, d.provisioning_status,
        (SELECT COUNT(*) FROM mailboxes m WHERE m.domain_id = d.id AND m.status NOT IN ('deleted','retained')) AS mailboxes
        FROM domains d JOIN tenants t ON t.id = d.tenant_id WHERE ${where.join(' AND ')} ORDER BY d.name LIMIT ? OFFSET ?`, [...params, q.pageSize, (q.page - 1) * q.pageSize]);
    return { total: Number(total?.n ?? 0), domains: list.map((d) => ({ ...d, mailboxes: Number(d.mailboxes) })) };
  });

  // ================= mailboxes =================
  const MailboxList = z.object({ q: z.string().max(100).optional(), status: z.string().max(30).optional(), tenantId: id.optional(), domainId: id.optional(), sort: z.enum(['created', 'address', 'usage']).default('created'), dir: z.enum(['asc', 'desc']).default('desc'), ...page });
  const MB_SORT = { created: 'm.created_at', address: 'm.normalized_address', usage: 'm.used_bytes' } as const;

  app.get('/admin/mailboxes', async (req) => {
    requirePermission(ctx, req, 'mailboxes.read');
    const q = parse(MailboxList, req.query);
    const where = ["m.status NOT IN ('deleted','retained')"];
    const params: unknown[] = [];
    if (q.q) { where.push('(m.normalized_address LIKE ? OR m.display_name LIKE ?)'); params.push(like(q.q), like(q.q)); }
    if (q.status) { where.push('m.status = ?'); params.push(q.status); }
    if (q.tenantId) { where.push('m.tenant_id = ?'); params.push(q.tenantId); }
    if (q.domainId) { where.push('m.domain_id = ?'); params.push(q.domainId); }
    const total = await one<{ n: number }>(ctx.db, `SELECT COUNT(*) AS n FROM mailboxes m WHERE ${where.join(' AND ')}`, params);
    const list = await rows(
      ctx.db,
      `SELECT m.id, m.normalized_address AS address, m.display_name, m.status, m.quota_bytes, m.used_bytes, m.usage_collected_at, m.created_at, m.tenant_id, t.name AS workspace, t.name AS tenant_name,
              d.id AS domain_id, d.name AS domain, d.ownership_status AS domain_verification,
              (SELECT u.login_email FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id WHERE tm.mailbox_id = m.id AND tm.status = 'active' LIMIT 1) AS owner_email,
              COALESCE(q.daily_send_limit, p.daily_send_limit) AS daily_send_limit, p.hourly_send_limit,
              (SELECT j.status FROM provisioning_jobs j WHERE j.target_type = 'mailbox' AND j.target_id = m.id ORDER BY j.created_at DESC LIMIT 1) AS last_job_status
         FROM mailboxes m JOIN tenants t ON t.id = m.tenant_id JOIN domains d ON d.id = m.domain_id JOIN plans p ON p.id = t.plan_id LEFT JOIN tenant_quotas q ON q.tenant_id = t.id
        WHERE ${where.join(' AND ')} ORDER BY ${MB_SORT[q.sort]} ${q.dir === 'asc' ? 'ASC' : 'DESC'}, m.id LIMIT ? OFFSET ?`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { total: Number(total?.n ?? 0), mailboxes: list };
  });

  app.get('/admin/mailboxes/:mailboxId', async (req) => {
    const a = requirePermission(ctx, req, 'mailboxes.read');
    const { mailboxId } = parse(z.object({ mailboxId: id }), req.params);
    const m = await one<{ tenant_id: string; domain_id: string }>(ctx.db, 'SELECT tenant_id, domain_id FROM mailboxes WHERE id = ?', [mailboxId]);
    if (!m) throw notFound('Mailbox');
    const mailbox = await loadMailbox(ctx, m.tenant_id, mailboxId);
    const domain = await one(ctx.db, 'SELECT id, name, ownership_status, inbound_status, outbound_status, provisioning_status FROM domains WHERE id = ?', [m.domain_id]);
    const tenant = await one(ctx.db, 'SELECT id, name, status FROM tenants WHERE id = ?', [m.tenant_id]);
    const owner = await one(ctx.db, "SELECT u.id, u.login_email AS email, u.display_name FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id WHERE tm.mailbox_id = ? AND tm.status = 'active' LIMIT 1", [mailboxId]);
    const jobs = await rows(ctx.db, "SELECT id, operation, status, attempts, max_attempts, needs_reconcile, last_error_code, last_error_message, created_at, updated_at FROM provisioning_jobs WHERE target_type = 'mailbox' AND target_id = ? ORDER BY created_at DESC LIMIT 20", [mailboxId]);
    const aliases = await rows(ctx.db, "SELECT id, source_address, destination_type, destination_address, status FROM aliases WHERE destination_mailbox_id = ? AND status <> 'deleted' ORDER BY source_address", [mailboxId]);
    const forwarding = await rows(ctx.db, "SELECT id, destination_address, status FROM aliases WHERE destination_type = 'external' AND source_address = ? AND status <> 'deleted'", [mailbox.normalized_address]);
    const limits = await getTenantLimits(ctx, m.tenant_id);
    const events = a.user.permissions?.has('audit.read') ? await rows(ctx.db, "SELECT occurred_at, action, outcome, actor_type, reason FROM audit_logs WHERE target_type = 'mailbox' AND target_id = ? ORDER BY id DESC LIMIT 30", [mailboxId]) : null;
    return { mailbox: present(mailbox), tenant, domain, owner, jobs, aliases, forwarding, limits: { dailySendLimit: limits.dailySendLimit, hourlySendLimit: limits.hourlySendLimit, mailboxQuotaMaxBytes: limits.mailboxQuotaMaxBytes }, clientSettings: clientSettings(ctx, mailbox.normalized_address), audit: events };
  });

  app.post('/admin/mailboxes', { config: limit(ctx, 30) }, async (req, reply) => {
    const a = requirePermission(ctx, req, 'mailboxes.create');
    const body = parse(z.object({ tenantId: id, domainId: id, localPart: z.string().trim().min(1).max(64), displayName: z.string().trim().max(120).optional(), quotaBytes: z.number().int().positive().optional() }), req.body);
    // The domain must belong to the tenant: createMailbox → loadDomain(tenantId, domainId) enforces it.
    const mb = await createMailbox(ctx, body.tenantId, body.domainId, a.user.id, body, req.meta, 'platform_admin');
    return reply.code(201).send({ mailbox: mb });
  });

  const mailboxTenant = async (mailboxId: string) => {
    const m = await one<{ tenant_id: string }>(ctx.db, 'SELECT tenant_id FROM mailboxes WHERE id = ?', [mailboxId]);
    if (!m) throw notFound('Mailbox');
    return m.tenant_id;
  };

  app.patch('/admin/mailboxes/:mailboxId', async (req) => {
    const a = requirePermission(ctx, req, 'mailboxes.update');
    const { mailboxId } = parse(z.object({ mailboxId: id }), req.params);
    const body = parse(z.object({ displayName: z.string().trim().max(120).optional(), quotaBytes: z.number().int().positive().optional() }), req.body);
    if (body.quotaBytes !== undefined && !a.user.permissions?.has('mailboxes.quota.update')) throw forbidden('forbidden', 'Changing quotas requires mailboxes.quota.update.');
    return updateMailbox(ctx, await mailboxTenant(mailboxId), mailboxId, body, a.user.id, req.meta, 'platform_admin');
  });

  // The new credential is deliberately discarded: the owner is told to set their own password in their workspace.
  app.post('/admin/mailboxes/:mailboxId/reset-credentials', { config: limit(ctx, 10) }, async (req) => {
    const a = requirePermission(ctx, req, 'mailboxes.credentials.reset');
    const { mailboxId } = parse(z.object({ mailboxId: id }), req.params);
    const body = parse(Sensitive, req.body);
    const tenantId = await mailboxTenant(mailboxId);
    await resetCredentials(ctx, tenantId, mailboxId, undefined, a.user.id, req.meta, 'platform_admin');
    await exec(ctx.db, 'UPDATE mailboxes SET credentials_set_at = NULL WHERE id = ?', [mailboxId]);
    const owner = await one<{ login_email: string; display_name: string; address: string }>(ctx.db, "SELECT u.login_email, u.display_name, mb.normalized_address AS address FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id JOIN mailboxes mb ON mb.id = tm.mailbox_id WHERE tm.mailbox_id = ? AND tm.status = 'active' LIMIT 1", [mailboxId]);
    if (owner) await enqueueEmail(ctx, ctx.db, { kind: 'security_notice', to: owner.login_email, params: { name: owner.display_name, headline: 'Mailbox password was reset', detail: `The password for ${owner.address} was reset by an administrator. Sign in to your workspace and set a new mailbox password before using your email app.` }, dedupeKey: `mbxreset:${mailboxId}:${newId()}`, relatedType: 'mailbox', relatedId: mailboxId, tenantId });
    await adminAudit(req, a, 'mailbox.credentials_reset_admin', 'mailbox', mailboxId, { tenantId, reason: body.reason });
    kickOutbox(ctx);
    return { ok: true, ownerNotified: Boolean(owner) };
  });

  app.post('/admin/mailboxes/:mailboxId/schedule-deletion', { config: limit(ctx, 10) }, async (req) => {
    const a = requirePermission(ctx, req, 'mailboxes.delete');
    const { mailboxId } = parse(z.object({ mailboxId: id }), req.params);
    const body = parse(Sensitive.extend({ confirmAddress: z.string().trim().max(320) }), req.body);
    return scheduleDeletion(ctx, await mailboxTenant(mailboxId), mailboxId, body.confirmAddress, a.user.id, req.meta, 'platform_admin');
  });

  app.post('/admin/mailboxes/:mailboxId/cancel-deletion', async (req) => {
    const a = requirePermission(ctx, req, 'mailboxes.delete');
    const { mailboxId } = parse(z.object({ mailboxId: id }), req.params);
    return cancelDeletion(ctx, await mailboxTenant(mailboxId), mailboxId, a.user.id, req.meta, 'platform_admin');
  });

  // Provisioning drift: mailboxes whose database state and mail-server state disagree, surfaced for operators.
  app.get('/admin/mailboxes-attention', async (req) => {
    requirePermission(ctx, req, 'provisioning.read');
    return { mailboxes: await rows(ctx.db, `SELECT m.id, m.normalized_address AS address, m.status, m.created_at, j.status AS job_status, j.last_error_message, j.needs_reconcile
        FROM mailboxes m LEFT JOIN provisioning_jobs j ON j.id = (SELECT j2.id FROM provisioning_jobs j2 WHERE j2.target_type = 'mailbox' AND j2.target_id = m.id ORDER BY j2.created_at DESC LIMIT 1)
       WHERE m.status = 'provisioning_failed' OR j.needs_reconcile = 1 OR (m.status = 'provisioning' AND m.created_at < DATE_SUB(NOW(3), INTERVAL 15 MINUTE)) ORDER BY m.created_at DESC LIMIT 100`) };
  });

}
