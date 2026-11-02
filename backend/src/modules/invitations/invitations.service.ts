import { passwordProblem } from '../../core/index.js';
import type { AppContext } from '../../context.js';
import { exec, one, rows, tx, type Queryable } from '../../db/pool.js';
import { AppError, badRequest, notFound } from '../../shared/errors.js';
import { randomToken, sha256Hex } from '../../shared/crypto.js';
import { newId } from '../../shared/ids.js';
import { audit } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/auth.service.js';
import { hashPassword } from '../auth/password.js';
import { enqueueEmail, cancelEmailsFor, processOutbox } from '../notifications/outbox.service.js';
import { getSettings } from '../settings/settings.service.js';

export interface InvitationRow {
  id: string;
  user_id: string;
  email: string;
  tenant_id: string | null;
  membership_role: string | null;
  mailbox_id: string | null;
  send_mailbox_info: number;
  status: 'pending' | 'consumed' | 'revoked' | 'expired';
  delivery: 'not_sent' | 'queued' | 'sent' | 'failed';
  last_email_id: string | null;
  resend_count: number;
  expires_at: Date;
}

const INVALID = () => badRequest('invalid_invitation', 'This invitation link is invalid, expired or has already been used.');

/** Starts a delivery attempt without blocking the request. In tests the caller drives the outbox explicitly. */
export function kickOutbox(ctx: AppContext): void {
  if (ctx.config.NODE_ENV === 'test') return;
  void processOutbox(ctx, 5).catch((e) => ctx.log.warn({ err: (e as Error).message }, 'outbox kick failed'));
}

export const activationUrl = (ctx: AppContext, token: string) => `${ctx.config.APP_BASE_URL}/activate#token=${token}`;

/**
 * Issues a fresh single-use token for an invitation and queues the email. Any earlier token stops
 * working the moment its hash is replaced. Must run inside the caller's transaction.
 */
export async function issueInvitation(ctx: AppContext, db: Queryable, inv: InvitationRow, opts: { adminId: string; invitedBy: string | null; displayName: string }): Promise<{ emailId: string | null; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + ctx.config.INVITE_TTL_HOURS * 3600_000);
  const tenant = inv.tenant_id ? await one<{ name: string }>(db, 'SELECT name FROM tenants WHERE id = ?', [inv.tenant_id]) : null;
  const mailbox = inv.mailbox_id ? await one<{ normalized_address: string }>(db, 'SELECT normalized_address FROM mailboxes WHERE id = ?', [inv.mailbox_id]) : null;
  await cancelEmailsFor(db, 'account_invitation', inv.id);
  const emailId = await enqueueEmail(ctx, db, {
    kind: 'account_invitation',
    to: inv.email,
    params: {
      name: opts.displayName,
      loginEmail: inv.email,
      workspaceName: tenant?.name ?? null,
      mailboxAddress: mailbox?.normalized_address ?? null,
      actionUrl: activationUrl(ctx, token),
      expiresAt: expiresAt.toISOString(),
      invitedBy: opts.invitedBy,
      setupGuideUrl: `${ctx.config.APP_BASE_URL}/setup-guide`,
    },
    dedupeKey: `invite:${inv.id}:${inv.resend_count + 1}`,
    relatedType: 'account_invitation',
    relatedId: inv.id,
    tenantId: inv.tenant_id,
    createdByAdminId: opts.adminId,
  });
  await exec(
    db,
    `UPDATE account_invitations SET token_hash = ?, status = 'pending', expires_at = ?, resend_count = resend_count + 1, last_email_id = ?, delivery = 'queued', revoked_at = NULL WHERE id = ?`,
    [sha256Hex(token), expiresAt, emailId, inv.id],
  );
  return { emailId, expiresAt };
}

export async function loadInvitation(db: Queryable, id: string): Promise<InvitationRow> {
  const inv = await one<InvitationRow>(db, 'SELECT * FROM account_invitations WHERE id = ?', [id]);
  if (!inv) throw notFound('Invitation');
  return inv;
}

export async function resendInvitation(ctx: AppContext, id: string, admin: { id: string; display_name: string }, meta: RequestMeta) {
  const result = await tx(ctx.db, async (conn) => {
    const inv = await one<InvitationRow>(conn, 'SELECT * FROM account_invitations WHERE id = ? FOR UPDATE', [id]);
    if (!inv) throw notFound('Invitation');
    if (inv.status === 'consumed') throw new AppError(409, 'already_activated', 'This invitation has already been used.');
    const user = await one<{ display_name: string; status: string }>(conn, 'SELECT display_name, status FROM users WHERE id = ?', [inv.user_id]);
    if (!user || user.status !== 'pending_verification') throw new AppError(409, 'invalid_state', 'The account is no longer waiting for activation.');
    if (inv.last_email_id) {
      const last = await one<{ age: number }>(conn, 'SELECT TIMESTAMPDIFF(SECOND, created_at, NOW(3)) AS age FROM email_outbox WHERE id = ?', [inv.last_email_id]);
      if (last && Number(last.age) < ctx.config.INVITE_RESEND_COOLDOWN_SECONDS) {
        throw new AppError(429, 'resend_throttled', `Wait ${ctx.config.INVITE_RESEND_COOLDOWN_SECONDS - Number(last.age)}s before sending another invitation.`);
      }
    }
    const issued = await issueInvitation(ctx, conn, inv, { adminId: admin.id, invitedBy: admin.display_name, displayName: user.display_name });
    await audit(conn, { actorType: 'platform_admin', actorAdminId: admin.id, tenantId: inv.tenant_id, action: 'invitation.resend', targetType: 'invitation', targetId: id, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip });
    return issued;
  });
  kickOutbox(ctx);
  return { expiresAt: result.expiresAt, delivery: 'queued' as const };
}

export async function revokeInvitation(ctx: AppContext, id: string, adminId: string, reason: string, meta: RequestMeta) {
  await tx(ctx.db, async (conn) => {
    const res = await exec(conn, "UPDATE account_invitations SET status = 'revoked', token_hash = NULL, revoked_at = NOW(3), delivery = IF(delivery = 'sent', delivery, 'not_sent') WHERE id = ? AND status = 'pending'", [id]);
    if (res.affectedRows !== 1) {
      if (!(await one(conn, 'SELECT id FROM account_invitations WHERE id = ?', [id]))) throw notFound('Invitation');
      throw new AppError(409, 'invalid_state', 'Only outstanding invitations can be revoked.');
    }
    await cancelEmailsFor(conn, 'account_invitation', id);
    const inv = (await one<{ tenant_id: string | null }>(conn, 'SELECT tenant_id FROM account_invitations WHERE id = ?', [id]))!;
    await audit(conn, { actorType: 'platform_admin', actorAdminId: adminId, tenantId: inv.tenant_id, action: 'invitation.revoke', targetType: 'invitation', targetId: id, outcome: 'success', reason, correlationId: meta.correlationId, ip: meta.ip });
  });
}

/** Public: what the activation page may show before a password is chosen. Reveals nothing for bad tokens. */
export async function invitationInfo(ctx: AppContext, token: string) {
  const row = await one<{ email: string; display_name: string; expires_at: Date; tenant_name: string | null; mailbox: string | null }>(
    ctx.db,
    `SELECT i.email, u.display_name, i.expires_at, t.name AS tenant_name, mb.normalized_address AS mailbox
       FROM account_invitations i JOIN users u ON u.id = i.user_id LEFT JOIN tenants t ON t.id = i.tenant_id LEFT JOIN mailboxes mb ON mb.id = i.mailbox_id
      WHERE i.token_hash = ? AND i.status = 'pending' AND i.expires_at > NOW(3) AND u.status = 'pending_verification'`,
    [sha256Hex(token)],
  );
  if (!row) throw INVALID();
  return { email: row.email, displayName: row.display_name, workspaceName: row.tenant_name, mailboxAddress: row.mailbox, expiresAt: row.expires_at };
}

/**
 * Consumes the token and sets the user's password in one transaction. The conditional UPDATE is the
 * single point of truth: of two concurrent requests with the same token exactly one matches a row.
 */
export async function activateAccount(ctx: AppContext, input: { token: string; email: string; password: string; acceptTerms: boolean }, meta: RequestMeta): Promise<void> {
  if (!input.acceptTerms) throw badRequest('terms_required', 'You must accept the terms and privacy notice.');
  const tokenHash = sha256Hex(input.token);
  const inv = await one<InvitationRow & { login_email: string; display_name: string }>(
    ctx.db,
    `SELECT i.*, u.login_email, u.display_name FROM account_invitations i JOIN users u ON u.id = i.user_id
      WHERE i.token_hash = ? AND i.status = 'pending' AND i.expires_at > NOW(3) AND u.status = 'pending_verification'`,
    [tokenHash],
  );
  // The token is bound to one recipient; a presented email that differs is treated exactly like a bad token.
  if (!inv || inv.login_email !== input.email.trim().toLowerCase()) throw INVALID();
  const problem = passwordProblem(input.password, { email: inv.login_email });
  if (problem) throw badRequest('weak_password', problem);
  const passwordHash = await hashPassword(input.password, ctx.config.ARGON2_MEMORY_KIB);
  const settings = await getSettings(ctx.db);

  await tx(ctx.db, async (conn) => {
    const consumed = await exec(conn, "UPDATE account_invitations SET status = 'consumed', consumed_at = NOW(3), token_hash = NULL WHERE id = ? AND token_hash = ? AND status = 'pending' AND expires_at > NOW(3)", [inv.id, tokenHash]);
    if (consumed.affectedRows !== 1) throw INVALID();
    const activated = await exec(conn, "UPDATE users SET password_hash = ?, status = 'active', email_verified_at = NOW(3), failed_login_count = 0, locked_until = NULL WHERE id = ? AND status = 'pending_verification'", [passwordHash, inv.user_id]);
    if (activated.affectedRows !== 1) throw INVALID();
    for (const document of ['terms', 'privacy'] as const) {
      await exec(conn, 'INSERT INTO terms_acceptances (id, user_id, document, version, ip) VALUES (?, ?, ?, ?, ?)', [newId(), inv.user_id, document, settings.terms_version, meta.ip]);
    }
    await audit(conn, { actorType: 'user', actorUserId: inv.user_id, tenantId: inv.tenant_id, action: 'invitation.consume', targetType: 'invitation', targetId: inv.id, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip });
    await enqueueEmail(ctx, conn, { kind: 'account_activated', to: inv.login_email, params: { name: inv.display_name, signInUrl: `${ctx.config.APP_BASE_URL}/login` }, dedupeKey: `activated:${inv.id}`, relatedType: 'user', relatedId: inv.user_id, tenantId: inv.tenant_id });
  });
  if (inv.mailbox_id) await afterMailboxActive(ctx, inv.mailbox_id).catch((e) => ctx.log.warn({ err: (e as Error).message }, 'mailbox instructions skipped'));
  kickOutbox(ctx);
}

/**
 * Sends mail-client instructions once BOTH the account is active and the mailbox is provisioned.
 * Called from the provisioning worker and from activation, so whichever happens last triggers it;
 * the dedupe key makes the double call harmless.
 */
export async function afterMailboxActive(ctx: AppContext, mailboxId: string): Promise<void> {
  const r = await one<{ inv_id: string; email: string; display_name: string; address: string; tenant_id: string; tenant_name: string }>(
    ctx.db,
    `SELECT i.id AS inv_id, u.login_email AS email, u.display_name, mb.normalized_address AS address, mb.tenant_id, t.name AS tenant_name
       FROM account_invitations i JOIN users u ON u.id = i.user_id JOIN mailboxes mb ON mb.id = i.mailbox_id JOIN tenants t ON t.id = mb.tenant_id
      WHERE i.mailbox_id = ? AND i.send_mailbox_info = 1 AND i.status = 'consumed' AND u.status = 'active' AND mb.status = 'active' LIMIT 1`,
    [mailboxId],
  );
  if (!r) return;
  const c = ctx.config;
  await enqueueEmail(ctx, ctx.db, {
    kind: 'mailbox_instructions',
    to: r.email,
    params: {
      name: r.display_name,
      mailboxAddress: r.address,
      workspaceName: r.tenant_name,
      client: { imapHost: c.MAIL_HOSTNAME, imapPort: c.IMAP_PORT, smtpHost: c.MAIL_HOSTNAME, smtpPort: c.SUBMISSION_PORT, webmailUrl: c.WEBMAIL_URL ?? null },
      setupGuideUrl: `${c.APP_BASE_URL}/setup-guide`,
    },
    dedupeKey: `mailbox-info:${mailboxId}`,
    relatedType: 'mailbox',
    relatedId: mailboxId,
    tenantId: r.tenant_id,
  });
  kickOutbox(ctx);
}

export async function listInvitations(db: Queryable, q: { status?: string | undefined; q?: string | undefined; page: number; pageSize: number }) {
  const where = ['1=1'];
  const params: unknown[] = [];
  if (q.status) {
    where.push(q.status === 'expired' ? "(i.status = 'expired' OR (i.status = 'pending' AND i.expires_at <= NOW(3)))" : q.status === 'pending' ? "(i.status = 'pending' AND i.expires_at > NOW(3))" : 'i.status = ?');
    if (!['expired', 'pending'].includes(q.status)) params.push(q.status);
  }
  if (q.q) {
    where.push('i.email LIKE ?');
    params.push(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`);
  }
  const total = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM account_invitations i WHERE ${where.join(' AND ')}`, params);
  const list = await rows(
    db,
    `SELECT i.id, i.user_id, i.email, i.status, i.delivery, i.resend_count, i.expires_at, i.last_sent_at, i.created_at, i.consumed_at, t.name AS workspace, i.membership_role,
            (i.status = 'pending' AND i.expires_at <= NOW(3)) AS is_expired, o.last_error, o.attempts, o.status AS email_status
       FROM account_invitations i LEFT JOIN tenants t ON t.id = i.tenant_id LEFT JOIN email_outbox o ON o.id = i.last_email_id
      WHERE ${where.join(' AND ')} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`,
    [...params, q.pageSize, (q.page - 1) * q.pageSize],
  );
  return { total: Number(total?.n ?? 0), invitations: list };
}
