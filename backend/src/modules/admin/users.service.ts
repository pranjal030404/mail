import { TENANT_ROLES, type TenantRole } from '../../core/index.js';
import type { AppContext } from '../../context.js';
import { exec, isDuplicateKey, one, rows, tx, type Queryable } from '../../db/pool.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { randomToken, sha256Hex } from '../../shared/crypto.js';
import { newId } from '../../shared/ids.js';
import { audit } from '../audit/audit.service.js';
import { normalizeLoginEmail, revokeAllSessions, type RequestMeta } from '../auth/auth.service.js';
import { hashPassword } from '../auth/password.js';
import { issueInvitation, kickOutbox, type InvitationRow } from '../invitations/invitations.service.js';
import { createMailbox } from '../mailboxes/mailboxes.service.js';
import { enqueueEmail } from '../notifications/outbox.service.js';
import { getSettings } from '../settings/settings.service.js';
import { slugify } from '../tenants/tenants.service.js';

export interface AdminActor {
  id: string;
  display_name: string;
  permissions: ReadonlySet<string>;
}

const ctxMeta = (m: RequestMeta) => ({ correlationId: m.correlationId, ip: m.ip });
const adminAudit = (actor: AdminActor, m: RequestMeta) => ({ actorType: 'platform_admin' as const, actorAdminId: actor.id, ...ctxMeta(m) });

export interface CreateUserInput {
  fullName: string;
  email: string;
  displayName?: string | undefined;
  workspace: { mode: 'none' } | { mode: 'personal' } | { mode: 'company'; name: string } | { mode: 'existing'; tenantId: string };
  membershipRole: TenantRole;
  mailbox?: { domainId: string; localPart: string; displayName?: string | undefined; quotaBytes?: number | undefined } | undefined;
  invitation: 'send_now' | 'send_later' | 'none';
  sendMailboxInstructions: boolean;
}

export interface CreateUserResult {
  user: { id: string; email: string };
  workspace: { id: string; name: string } | null;
  invitation: { id: string; delivery: string; expiresAt: Date | null } | null;
  mailbox: { state: 'none' | 'provisioning' | 'failed'; id?: string; address?: string; error?: string };
}

/** Rejects an address already used by any principal; the two tables share one login namespace. */
async function assertEmailFree(db: Queryable, email: string): Promise<void> {
  const taken = (await one(db, 'SELECT id FROM users WHERE login_email = ?', [email])) ?? (await one(db, 'SELECT id FROM platform_admins WHERE login_email = ?', [email]));
  if (taken) throw conflict('email_taken', 'That email address already has an account.');
}

export async function createUser(ctx: AppContext, actor: AdminActor, input: CreateUserInput, meta: RequestMeta): Promise<CreateUserResult> {
  const can = (p: string) => actor.permissions.has(p);
  if (!can('users.create')) throw forbidden();
  if (input.workspace.mode === 'company' && !can('tenants.create')) throw forbidden('forbidden', 'You are not allowed to create workspaces.');
  if (input.workspace.mode === 'personal' && !can('tenants.create')) throw forbidden('forbidden', 'You are not allowed to create workspaces.');
  if (input.mailbox && !can('mailboxes.create')) throw forbidden('forbidden', 'You are not allowed to create mailboxes.');
  if (input.mailbox && input.workspace.mode === 'none') throw badRequest('workspace_required', 'A mailbox needs a workspace to belong to.');

  const email = normalizeLoginEmail(input.email);
  await assertEmailFree(ctx.db, email);
  const settings = await getSettings(ctx.db);
  const userId = newId();
  const displayName = (input.displayName?.trim() || input.fullName.trim()).slice(0, 120);
  // A random, never-disclosed password: the account cannot be signed in to until the invitation sets a real one.
  const unusable = await hashPassword(randomToken(32), ctx.config.ARGON2_MEMORY_KIB);

  let workspace: { id: string; name: string } | null = null;
  let invitationId: string | null = null;

  try {
    await tx(ctx.db, async (conn) => {
      await exec(conn, "INSERT INTO users (id, login_email, display_name, password_hash, status) VALUES (?, ?, ?, ?, 'pending_verification')", [userId, email, displayName, unusable]);
      await exec(conn, 'INSERT INTO notification_preferences (user_id) VALUES (?)', [userId]);

      const w = input.workspace;
      if (w.mode === 'existing') {
        const t = await one<{ id: string; name: string; status: string }>(conn, 'SELECT id, name, status FROM tenants WHERE id = ? FOR UPDATE', [w.tenantId]);
        if (!t || t.status === 'closed') throw badRequest('invalid_workspace', 'That workspace does not exist.');
        if (t.status !== 'active') throw new AppError(409, 'tenant_suspended', 'That workspace is suspended.');
        await exec(conn, "INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status, invited_by) VALUES (?, ?, ?, ?, 'active', NULL)", [newId(), t.id, userId, input.membershipRole]);
        workspace = { id: t.id, name: t.name };
      } else if (w.mode !== 'none') {
        const plan = await one<{ id: string }>(conn, 'SELECT id FROM plans WHERE code = ? AND is_active = 1', [settings.default_plan_code]);
        if (!plan) throw conflict('no_default_plan', 'No default plan is configured.');
        const name = (w.mode === 'company' ? w.name : `${displayName}'s workspace`).trim().slice(0, 120);
        const tenantId = newId();
        await exec(conn, 'INSERT INTO tenants (id, name, slug, plan_id, created_by) VALUES (?, ?, ?, ?, ?)', [tenantId, name, `${slugify(name)}-${tenantId.slice(-6).toLowerCase()}`, plan.id, userId]);
        await exec(conn, "INSERT INTO subscriptions (id, tenant_id, plan_id, status) VALUES (?, ?, ?, 'active')", [newId(), tenantId, plan.id]);
        // The creator of a brand-new workspace owns it, whatever role the form carried.
        await exec(conn, "INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status) VALUES (?, ?, ?, 'owner', 'active')", [newId(), tenantId, userId]);
        await audit(conn, { ...adminAudit(actor, meta), tenantId, action: 'tenant.create', targetType: 'tenant', targetId: tenantId, outcome: 'success', metadata: { via: 'admin_user_create' } });
        workspace = { id: tenantId, name };
      }

      if (input.invitation !== 'none') {
        invitationId = newId();
        await exec(conn, 'INSERT INTO account_invitations (id, user_id, email, tenant_id, membership_role, send_mailbox_info, expires_at, created_by_admin_id) VALUES (?, ?, ?, ?, ?, ?, NOW(3), ?)', [
          invitationId, userId, email, workspace?.id ?? null, workspace ? input.membershipRole : null, input.sendMailboxInstructions ? 1 : 0, actor.id,
        ]);
      }
      await audit(conn, { ...adminAudit(actor, meta), tenantId: workspace?.id ?? null, action: 'user.create', targetType: 'user', targetId: userId, outcome: 'success', metadata: { invitation: input.invitation, workspaceMode: input.workspace.mode, role: input.membershipRole } });
    });
  } catch (err) {
    if (isDuplicateKey(err)) throw conflict('email_taken', 'That email address already has an account.');
    throw err;
  }

  const result: CreateUserResult = {
    user: { id: userId, email },
    workspace,
    invitation: invitationId ? { id: invitationId, delivery: 'not_sent', expiresAt: null } : null,
    mailbox: { state: 'none' },
  };

  // Mailbox creation uses the established provisioning pipeline (job queue → Stalwart adapter).
  // Its failure must not undo the account; it is reported and can be retried from Mailboxes.
  const ws = workspace as { id: string; name: string } | null;
  if (input.mailbox && ws) {
    try {
      const mb = await createMailbox(ctx, ws.id, input.mailbox.domainId, actor.id, { localPart: input.mailbox.localPart, displayName: input.mailbox.displayName ?? displayName, quotaBytes: input.mailbox.quotaBytes }, meta, 'platform_admin');
      await exec(ctx.db, "UPDATE tenant_memberships SET mailbox_id = ? WHERE tenant_id = ? AND user_id = ?", [mb.id, ws.id, userId]);
      if (invitationId) await exec(ctx.db, 'UPDATE account_invitations SET mailbox_id = ? WHERE id = ?', [mb.id, invitationId]);
      result.mailbox = { state: 'provisioning', id: mb.id, address: mb.address };
    } catch (err) {
      const message = err instanceof AppError ? err.message : 'The mailbox could not be created.';
      result.mailbox = { state: 'failed', error: message };
      await audit(ctx.db, { ...adminAudit(actor, meta), tenantId: ws.id, action: 'user.create.mailbox', targetType: 'user', targetId: userId, outcome: 'failure', reason: message });
    }
  }
  // The invitation is issued last so its email can name the mailbox. If this step is interrupted the
  // invitation stays visible as "not sent" and can be sent with one click; nothing is lost or duplicated.
  if (invitationId && input.invitation === 'send_now') {
    const issued = await tx(ctx.db, async (conn) => {
      const inv = (await one<InvitationRow>(conn, 'SELECT * FROM account_invitations WHERE id = ? FOR UPDATE', [invitationId!]))!;
      return issueInvitation(ctx, conn, inv, { adminId: actor.id, invitedBy: actor.display_name, displayName });
    });
    result.invitation = { id: invitationId, delivery: 'queued', expiresAt: issued.expiresAt };
  }
  kickOutbox(ctx);
  return result;
}

export interface UserListQuery {
  q?: string | undefined;
  status?: string | undefined;
  tenantId?: string | undefined;
  role?: string | undefined;
  verified?: 'yes' | 'no' | undefined;
  mfa?: 'yes' | 'no' | undefined;
  createdFrom?: string | undefined;
  createdTo?: string | undefined;
  sort: 'created' | 'name' | 'email' | 'last_login';
  dir: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

const SORTS: Record<UserListQuery['sort'], string> = { created: 'u.created_at', name: 'u.display_name', email: 'u.login_email', last_login: 'u.last_login_at' };
const like = (s: string) => `%${s.replace(/[%_\\]/g, '\\$&')}%`;

export async function listUsers(ctx: AppContext, q: UserListQuery) {
  const where = ['1=1'];
  const params: unknown[] = [];
  if (q.q) { where.push('(u.login_email LIKE ? OR u.display_name LIKE ?)'); params.push(like(q.q), like(q.q)); }
  if (q.status) { where.push('u.status = ?'); params.push(q.status); }
  if (q.verified) where.push(q.verified === 'yes' ? 'u.email_verified_at IS NOT NULL' : 'u.email_verified_at IS NULL');
  if (q.mfa) where.push(q.mfa === 'yes' ? 'u.mfa_enabled = 1' : 'u.mfa_enabled = 0');
  if (q.createdFrom) { where.push('u.created_at >= ?'); params.push(new Date(q.createdFrom)); }
  if (q.createdTo) { where.push('u.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(new Date(q.createdTo)); }
  if (q.tenantId || q.role) {
    const parts = ["m.user_id = u.id AND m.status = 'active'"];
    if (q.tenantId) { parts.push('m.tenant_id = ?'); params.push(q.tenantId); }
    if (q.role) { parts.push('m.role = ?'); params.push(q.role); }
    where.push(`EXISTS (SELECT 1 FROM tenant_memberships m WHERE ${parts.join(' AND ')})`);
  }
  const total = await one<{ n: number }>(ctx.db, `SELECT COUNT(*) AS n FROM users u WHERE ${where.join(' AND ')}`, params);
  const list = await rows<{ id: string; email: string; display_name: string; status: string; mfa_enabled: number; email_verified_at: Date | null; last_login_at: Date | null; created_at: Date; invitation: string | null }>(
    ctx.db,
    `SELECT u.id, u.login_email AS email, u.display_name, u.status, u.mfa_enabled, u.email_verified_at, u.last_login_at, u.created_at,
            (SELECT IF(i.status = 'pending' AND i.expires_at <= NOW(3), 'expired', i.status) FROM account_invitations i WHERE i.user_id = u.id ORDER BY i.created_at DESC LIMIT 1) AS invitation
       FROM users u WHERE ${where.join(' AND ')} ORDER BY ${SORTS[q.sort]} ${q.dir === 'asc' ? 'ASC' : 'DESC'}, u.id LIMIT ? OFFSET ?`,
    [...params, q.pageSize, (q.page - 1) * q.pageSize],
  );
  const ids = list.map((u) => u.id);
  const ms = ids.length
    ? await rows<{ user_id: string; tenant_id: string; name: string; role: string }>(ctx.db, `SELECT m.user_id, m.tenant_id, t.name, m.role FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.status = 'active' AND m.user_id IN (?)`, [ids])
    : [];
  return {
    total: Number(total?.n ?? 0),
    users: list.map((u) => ({ ...u, mfa_enabled: Boolean(u.mfa_enabled), memberships: ms.filter((m) => m.user_id === u.id).map((m) => ({ tenantId: m.tenant_id, name: m.name, role: m.role })) })),
  };
}

export async function getUserDetail(ctx: AppContext, userId: string, includeAudit: boolean) {
  const u = await one<Record<string, unknown>>(
    ctx.db,
    `SELECT id, login_email AS email, display_name, status, mfa_enabled, email_verified_at, timezone, locale, last_login_at, locked_until, suspended_reason, deletion_requested_at, created_at FROM users WHERE id = ?`,
    [userId],
  );
  if (!u) throw notFound('User');
  const memberships = await rows(ctx.db, `SELECT m.id, m.tenant_id, t.name AS tenant_name, m.role, m.status, m.mailbox_id, m.created_at FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = ? AND m.status <> 'revoked' ORDER BY m.created_at`, [userId]);
  const mailboxes = await rows(ctx.db, `SELECT DISTINCT mb.id, mb.normalized_address AS address, mb.status, mb.tenant_id, t.name AS tenant_name, mb.quota_bytes, mb.used_bytes FROM tenant_memberships m JOIN mailboxes mb ON mb.id = m.mailbox_id JOIN tenants t ON t.id = mb.tenant_id WHERE m.user_id = ? AND mb.status NOT IN ('deleted','retained')`, [userId]);
  const sessions = await one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > NOW(3)', [userId]);
  const invitations = await rows(ctx.db, `SELECT i.id, i.status, i.delivery, i.resend_count, i.expires_at, i.last_sent_at, i.created_at, i.consumed_at, (i.status = 'pending' AND i.expires_at <= NOW(3)) AS is_expired, o.last_error FROM account_invitations i LEFT JOIN email_outbox o ON o.id = i.last_email_id WHERE i.user_id = ? ORDER BY i.created_at DESC`, [userId]);
  const history = includeAudit
    ? await rows(ctx.db, `SELECT occurred_at, action, outcome, actor_type, reason FROM audit_logs WHERE (target_type = 'user' AND target_id = ?) OR actor_user_id = ? ORDER BY id DESC LIMIT 50`, [userId, userId])
    : null;
  return { user: { ...u, mfa_enabled: Boolean(u.mfa_enabled) }, memberships, mailboxes, security: { activeSessions: Number(sessions?.n ?? 0), mfaEnabled: Boolean(u.mfa_enabled), emailVerified: Boolean(u.email_verified_at), locked: Boolean(u.locked_until && new Date(u.locked_until as string | Date).getTime() > Date.now()) }, invitations, audit: history };
}

async function loadUser(db: Queryable, userId: string) {
  const u = await one<{ id: string; login_email: string; display_name: string; status: string }>(db, 'SELECT id, login_email, display_name, status FROM users WHERE id = ?', [userId]);
  if (!u) throw notFound('User');
  return u;
}

async function activeOwnerCount(db: Queryable, tenantId: string, excludeMembershipId: string): Promise<number> {
  const n = await one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM tenant_memberships WHERE tenant_id = ? AND role = 'owner' AND status = 'active' AND id <> ?", [tenantId, excludeMembershipId]);
  return Number(n?.n ?? 0);
}

export async function addMembership(ctx: AppContext, actor: AdminActor, userId: string, tenantId: string, role: TenantRole, meta: RequestMeta) {
  await loadUser(ctx.db, userId);
  const t = await one<{ status: string }>(ctx.db, 'SELECT status FROM tenants WHERE id = ?', [tenantId]);
  if (!t || t.status === 'closed') throw badRequest('invalid_workspace', 'That workspace does not exist.');
  const id = newId();
  try {
    await exec(ctx.db, "INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status) VALUES (?, ?, ?, ?, 'active') ON DUPLICATE KEY UPDATE role = IF(status = 'revoked', VALUES(role), role), status = IF(status = 'revoked', 'active', status)", [id, tenantId, userId, role]);
  } catch (err) {
    if (isDuplicateKey(err)) throw conflict('already_member', 'The user is already a member.');
    throw err;
  }
  const m = (await one<{ id: string; role: string }>(ctx.db, "SELECT id, role FROM tenant_memberships WHERE tenant_id = ? AND user_id = ? AND status = 'active'", [tenantId, userId]))!;
  if (m.id !== id && m.role !== role) throw conflict('already_member', 'The user is already a member. Change their role instead.');
  await audit(ctx.db, { ...adminAudit(actor, meta), tenantId, action: 'user.membership.add', targetType: 'user', targetId: userId, outcome: 'success', metadata: { role } });
  return { membershipId: m.id };
}

export async function changeMembershipRole(ctx: AppContext, actor: AdminActor, userId: string, membershipId: string, role: TenantRole, meta: RequestMeta) {
  const m = await one<{ id: string; tenant_id: string; role: TenantRole }>(ctx.db, "SELECT id, tenant_id, role FROM tenant_memberships WHERE id = ? AND user_id = ? AND status = 'active'", [membershipId, userId]);
  if (!m) throw notFound('Membership');
  if (m.role === 'owner' && role !== 'owner' && (await activeOwnerCount(ctx.db, m.tenant_id, m.id)) === 0) throw new AppError(409, 'last_owner', 'A workspace must keep at least one owner.');
  await exec(ctx.db, 'UPDATE tenant_memberships SET role = ? WHERE id = ?', [role, membershipId]);
  await audit(ctx.db, { ...adminAudit(actor, meta), tenantId: m.tenant_id, action: 'user.membership.role', targetType: 'user', targetId: userId, outcome: 'success', metadata: { from: m.role, to: role } });
}

export async function removeMembership(ctx: AppContext, actor: AdminActor, userId: string, membershipId: string, meta: RequestMeta) {
  const m = await one<{ id: string; tenant_id: string; role: TenantRole }>(ctx.db, "SELECT id, tenant_id, role FROM tenant_memberships WHERE id = ? AND user_id = ? AND status = 'active'", [membershipId, userId]);
  if (!m) throw notFound('Membership');
  if (m.role === 'owner' && (await activeOwnerCount(ctx.db, m.tenant_id, m.id)) === 0) throw new AppError(409, 'last_owner', 'A workspace must keep at least one owner. Transfer ownership first.');
  await exec(ctx.db, "UPDATE tenant_memberships SET status = 'revoked', invitation_token_hash = NULL WHERE id = ?", [membershipId]);
  await audit(ctx.db, { ...adminAudit(actor, meta), tenantId: m.tenant_id, action: 'user.membership.remove', targetType: 'user', targetId: userId, outcome: 'success' });
}

export async function setUserStatus(ctx: AppContext, actor: AdminActor, userId: string, to: 'suspended' | 'active', reason: string, meta: RequestMeta) {
  const u = await loadUser(ctx.db, userId);
  const res = to === 'suspended'
    ? await exec(ctx.db, "UPDATE users SET status = 'suspended', suspended_reason = ? WHERE id = ? AND status = 'active'", [reason, userId])
    : await exec(ctx.db, "UPDATE users SET status = 'active', suspended_reason = NULL WHERE id = ? AND status = 'suspended'", [userId]);
  if (res.affectedRows !== 1) throw new AppError(409, 'invalid_state', to === 'suspended' ? 'The user is not active.' : 'The user is not suspended.');
  if (to === 'suspended') await revokeAllSessions(ctx, userId, 'user_suspended');
  await enqueueEmail(ctx, ctx.db, { kind: to === 'suspended' ? 'account_suspended' : 'account_reactivated', to: u.login_email, params: { name: u.display_name, reason: to === 'suspended' ? reason : null, signInUrl: `${ctx.config.APP_BASE_URL}/login` }, dedupeKey: `status:${userId}:${to}:${newId()}`, relatedType: 'user', relatedId: userId });
  await audit(ctx.db, { ...adminAudit(actor, meta), action: to === 'suspended' ? 'user.suspend' : 'user.reactivate', targetType: 'user', targetId: userId, outcome: 'success', reason });
  kickOutbox(ctx);
}

export async function initiatePasswordReset(ctx: AppContext, actor: AdminActor, userId: string, meta: RequestMeta) {
  const u = await loadUser(ctx.db, userId);
  if (u.status === 'pending_verification') throw new AppError(409, 'not_activated', 'The account has not been activated. Send an invitation instead.');
  if (u.status !== 'active') throw new AppError(409, 'invalid_state', 'Only active accounts can be reset.');
  const token = randomToken();
  await tx(ctx.db, async (conn) => {
    await exec(conn, 'UPDATE password_reset_tokens SET used_at = NOW(3) WHERE user_id = ? AND used_at IS NULL', [userId]);
    await exec(conn, 'INSERT INTO password_reset_tokens (id, user_id, token_hash, requested_ip, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? MINUTE))', [newId(), userId, sha256Hex(token), meta.ip, ctx.config.PASSWORD_RESET_TTL_MINUTES]);
    await enqueueEmail(ctx, conn, { kind: 'password_reset_admin', to: u.login_email, params: { name: u.display_name, actionUrl: `${ctx.config.APP_BASE_URL}/reset-password#token=${token}`, expiresInMinutes: ctx.config.PASSWORD_RESET_TTL_MINUTES }, dedupeKey: `pwreset:${userId}:${newId()}`, relatedType: 'user', relatedId: userId, createdByAdminId: actor.id });
    await audit(conn, { ...adminAudit(actor, meta), action: 'user.password_reset', targetType: 'user', targetId: userId, outcome: 'success' });
  });
  kickOutbox(ctx);
}

export async function resetMfa(ctx: AppContext, actor: AdminActor, userId: string, reason: string, meta: RequestMeta) {
  const u = await loadUser(ctx.db, userId);
  await tx(ctx.db, async (conn) => {
    await exec(conn, 'DELETE FROM mfa_credentials WHERE user_id = ?', [userId]);
    await exec(conn, 'DELETE FROM mfa_recovery_codes WHERE user_id = ?', [userId]);
    await exec(conn, 'UPDATE users SET mfa_enabled = 0 WHERE id = ?', [userId]);
    await enqueueEmail(ctx, conn, { kind: 'security_notice', to: u.login_email, params: { name: u.display_name, headline: 'Two-factor authentication was reset', detail: 'An administrator reset two-factor authentication on your account and signed you out everywhere. Sign in and set it up again.' }, dedupeKey: `mfareset:${userId}:${newId()}`, relatedType: 'user', relatedId: userId });
    await audit(conn, { ...adminAudit(actor, meta), action: 'user.mfa_reset', targetType: 'user', targetId: userId, outcome: 'success', reason });
  });
  await revokeAllSessions(ctx, userId, 'mfa_reset');
  kickOutbox(ctx);
}

export async function updateProfile(ctx: AppContext, actor: AdminActor, userId: string, patch: { displayName?: string | undefined; timezone?: string | undefined; locale?: string | undefined }, meta: RequestMeta) {
  await loadUser(ctx.db, userId);
  await exec(ctx.db, 'UPDATE users SET display_name = COALESCE(?, display_name), timezone = COALESCE(?, timezone), locale = COALESCE(?, locale) WHERE id = ?', [patch.displayName ?? null, patch.timezone ?? null, patch.locale ?? null, userId]);
  await audit(ctx.db, { ...adminAudit(actor, meta), action: 'user.update', targetType: 'user', targetId: userId, outcome: 'success', metadata: { fields: Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined) } });
}

/** What closing the account would affect, and what blocks it. */
export async function deletionPreview(ctx: AppContext, userId: string) {
  const u = await loadUser(ctx.db, userId);
  const owned = await rows<{ membership_id: string; tenant_id: string; name: string; owners: number; members: number; mailboxes: number; domains: number }>(
    ctx.db,
    `SELECT m.id AS membership_id, t.id AS tenant_id, t.name,
            (SELECT COUNT(*) FROM tenant_memberships x WHERE x.tenant_id = t.id AND x.role = 'owner' AND x.status = 'active') AS owners,
            (SELECT COUNT(*) FROM tenant_memberships x WHERE x.tenant_id = t.id AND x.status = 'active' AND x.user_id <> m.user_id) AS members,
            (SELECT COUNT(*) FROM mailboxes b WHERE b.tenant_id = t.id AND b.status NOT IN ('deleted','retained')) AS mailboxes,
            (SELECT COUNT(*) FROM domains d WHERE d.tenant_id = t.id AND d.status <> 'removed') AS domains
       FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = ? AND m.role = 'owner' AND m.status = 'active'`,
    [userId],
  );
  const blockers = owned.filter((o) => Number(o.owners) === 1 && (Number(o.mailboxes) > 0 || Number(o.domains) > 0 || Number(o.members) > 0)).map((o) => ({ tenantId: o.tenant_id, name: o.name, reason: `Sole owner of a workspace with ${o.mailboxes} mailbox(es), ${o.domains} domain(s) and ${o.members} other member(s). Transfer ownership or remove them first.` }));
  const memberships = await one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM tenant_memberships WHERE user_id = ? AND status = 'active'", [userId]);
  const sessions = await one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > NOW(3)', [userId]);
  return { user: { id: u.id, email: u.login_email, displayName: u.display_name, status: u.status }, impact: { memberships: Number(memberships?.n ?? 0), activeSessions: Number(sessions?.n ?? 0), ownedWorkspaces: owned.map((o) => ({ tenantId: o.tenant_id, name: o.name, mailboxes: Number(o.mailboxes), domains: Number(o.domains), otherMembers: Number(o.members) })) }, blockers, allowed: u.status !== 'closed' && blockers.length === 0 };
}

export async function closeAccount(ctx: AppContext, actor: AdminActor, userId: string, confirmEmail: string, reason: string, meta: RequestMeta) {
  const preview = await deletionPreview(ctx, userId);
  if (preview.user.email !== confirmEmail.trim().toLowerCase()) throw badRequest('confirmation_mismatch', 'Type the full account email to confirm.');
  if (!preview.allowed) throw new AppError(409, 'deletion_blocked', preview.blockers[0]?.reason ?? 'The account cannot be closed in its current state.', preview.blockers);
  await tx(ctx.db, async (conn) => {
    await exec(conn, "UPDATE users SET status = 'closed', deletion_requested_at = NOW(3) WHERE id = ?", [userId]);
    await exec(conn, "UPDATE tenant_memberships SET status = 'revoked', invitation_token_hash = NULL WHERE user_id = ? AND status <> 'revoked'", [userId]);
    await exec(conn, "UPDATE account_invitations SET status = 'revoked', token_hash = NULL, revoked_at = NOW(3) WHERE user_id = ? AND status = 'pending'", [userId]);
    await audit(conn, { ...adminAudit(actor, meta), action: 'user.close', targetType: 'user', targetId: userId, outcome: 'success', reason });
  });
  await revokeAllSessions(ctx, userId, 'account_closed');
}

export { TENANT_ROLES };
