import { AddressValidationError, buildAddress, canTransitionMailbox, checkCanAddMailbox, checkQuotaAllocation, normalizeLocalPart, passwordProblem, type MailboxStatus } from '../../core/index.js';
import type { AppContext } from '../../context.js';
import { exec, isDuplicateKey, one, rows, tx } from '../../db/pool.js';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../../shared/errors.js';
import { generateMailboxPassword } from '../../shared/crypto.js';
import { newId } from '../../shared/ids.js';
import { audit } from '../audit/audit.service.js';
import { auditActor, type AuthUser, type PrincipalKind, type RequestMeta } from '../auth/auth.service.js';
import { assertDomainAcceptsMailboxes, loadDomain, tenantUsageCounts } from '../domains/domains.service.js';
import { enqueue } from '../jobs/jobs.repository.js';
import { MailServerError } from '../mail-server/mail-server.interface.js';
import { getSettings } from '../settings/settings.service.js';
import { getTenantLimits } from '../tenants/tenants.service.js';

export interface MailboxRow {
  id: string;
  tenant_id: string;
  domain_id: string;
  local_part: string;
  normalized_address: string;
  display_name: string | null;
  quota_bytes: number | string;
  status: MailboxStatus;
  status_before_deletion: 'active' | 'suspended' | null;
  mail_engine_account_id: string | null;
  used_bytes: number | string | null;
  usage_collected_at: Date | null;
  credentials_set_at: Date | null;
  suspended_reason: string | null;
  suspended_by: 'tenant' | 'platform' | 'tenant_suspension' | null;
  deletion_scheduled_for: Date | null;
  created_at: Date;
}

export const present = (m: MailboxRow) => ({
  id: m.id,
  domainId: m.domain_id,
  address: m.normalized_address,
  localPart: m.local_part,
  displayName: m.display_name,
  quotaBytes: Number(m.quota_bytes),
  usedBytes: m.used_bytes === null ? null : Number(m.used_bytes),
  usageCollectedAt: m.usage_collected_at,
  status: m.status,
  suspendedReason: m.suspended_by === 'platform' ? 'Suspended by ARTHVEX. Contact support.' : m.suspended_reason,
  suspendedBy: m.suspended_by,
  credentialsSet: Boolean(m.credentials_set_at),
  deletionScheduledFor: m.deletion_scheduled_for,
  createdAt: m.created_at,
});

export async function loadMailbox(ctx: AppContext, tenantId: string, mailboxId: string): Promise<MailboxRow> {
  const m = await one<MailboxRow>(ctx.db, "SELECT * FROM mailboxes WHERE id = ? AND tenant_id = ? AND status NOT IN ('deleted','retained')", [mailboxId, tenantId]);
  if (!m) throw notFound('Mailbox');
  return m;
}

export async function createMailbox(ctx: AppContext, tenantId: string, domainId: string, actorId: string, input: { localPart: string; displayName?: string | undefined; quotaBytes?: number | undefined }, meta: RequestMeta, actorKind: PrincipalKind = 'user') {
  const domain = await loadDomain(ctx, tenantId, domainId);
  await assertDomainAcceptsMailboxes(ctx, domain);
  let localPart: string;
  try {
    localPart = normalizeLocalPart(input.localPart);
  } catch (err) {
    if (err instanceof AddressValidationError) throw unprocessable(err.code, err.message);
    throw err;
  }
  const address = buildAddress(localPart, domain.name);
  const limits = await getTenantLimits(ctx, tenantId);
  const quota = input.quotaBytes ?? limits.mailboxQuotaDefaultBytes;
  const id = newId();
  try {
    await tx(ctx.db, async (conn) => {
      await one(conn, 'SELECT id FROM tenants WHERE id = ? FOR UPDATE', [tenantId]);
      const usage = await tenantUsageCounts(ctx, tenantId, conn as never);
      const inDomain = (await one<{ n: number }>(conn, "SELECT COUNT(*) AS n FROM mailboxes WHERE domain_id = ? AND status NOT IN ('deleted','retained')", [domainId]))!.n;
      const check = checkCanAddMailbox(usage, Number(inDomain), quota, limits);
      if (!check.ok) throw new AppError(403, check.code, check.message);
      await exec(conn, "INSERT INTO address_claims (address, kind, owner_id, tenant_id) VALUES (?, 'mailbox', ?, ?)", [address, id, tenantId]);
      await exec(
        conn,
        `INSERT INTO mailboxes (id, tenant_id, domain_id, local_part, normalized_address, claim_address, display_name, quota_bytes, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?)`,
        [id, tenantId, domainId, localPart, address, address, input.displayName?.trim() || null, quota, actorId],
      );
      await enqueue(conn, { tenantId, operation: 'mailbox.create', targetType: 'mailbox', targetId: id, idempotencyKey: `mailbox.create:${id}`, createdBy: actorId });
      await audit(conn, { ...auditActor({ id: actorId, kind: actorKind }), tenantId, action: 'mailbox.create', targetType: 'mailbox', targetId: id, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip, metadata: { address } });
    });
  } catch (err) {
    if (isDuplicateKey(err)) throw conflict('address_taken', 'That address is already in use.');
    throw err;
  }
  return present(await loadMailbox(ctx, tenantId, id));
}

export interface ListQuery {
  q?: string | undefined;
  status?: string | undefined;
  domainId?: string | undefined;
  sort: 'created' | 'address' | 'usage';
  order: 'asc' | 'desc';
  page: number;
  pageSize: number;
  onlyMailboxId?: string | null;
}

export async function listMailboxes(ctx: AppContext, tenantId: string, q: ListQuery) {
  const where = ["tenant_id = ?", "status NOT IN ('deleted','retained')"];
  const params: unknown[] = [tenantId];
  if (q.q) {
    where.push('normalized_address LIKE ?');
    params.push(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`);
  }
  if (q.status) {
    where.push('status = ?');
    params.push(q.status);
  }
  if (q.domainId) {
    where.push('domain_id = ?');
    params.push(q.domainId);
  }
  if (q.onlyMailboxId !== undefined) {
    where.push('id = ?');
    params.push(q.onlyMailboxId ?? '');
  }
  const col = { created: 'created_at', address: 'normalized_address', usage: 'used_bytes' }[q.sort];
  const total = (await one<{ n: number }>(ctx.db, `SELECT COUNT(*) AS n FROM mailboxes WHERE ${where.join(' AND ')}`, params))!.n;
  const list = await rows<MailboxRow>(ctx.db, `SELECT * FROM mailboxes WHERE ${where.join(' AND ')} ORDER BY ${col} ${q.order === 'asc' ? 'ASC' : 'DESC'}, id LIMIT ? OFFSET ?`, [...params, q.pageSize, (q.page - 1) * q.pageSize]);
  return { mailboxes: list.map(present), total: Number(total), page: q.page, pageSize: q.pageSize };
}

async function transition(ctx: AppContext, m: MailboxRow, to: MailboxStatus, extra: string, params: unknown[]) {
  if (!canTransitionMailbox(m.status, to)) throw new AppError(409, 'invalid_state', `A mailbox that is ${m.status.replace(/_/g, ' ')} cannot change to ${to.replace(/_/g, ' ')}.`);
  // Conditional update: concurrent requests cannot both win.
  const res = await exec(ctx.db, `UPDATE mailboxes SET status = ?${extra} WHERE id = ? AND status = ?`, [to, ...params, m.id, m.status]);
  if (res.affectedRows !== 1) throw new AppError(409, 'invalid_state', 'The mailbox changed while processing your request. Refresh and try again.');
}

export async function suspendMailbox(ctx: AppContext, tenantId: string, mailboxId: string, by: 'tenant' | 'platform', reason: string | null, actor: Pick<AuthUser, 'id' | 'kind'>, meta: RequestMeta) {
  const m = await loadMailbox(ctx, tenantId, mailboxId);
  await transition(ctx, m, 'suspended', ', suspended_by = ?, suspended_reason = ?', [by, reason?.slice(0, 500) ?? null]);
  await enqueue(ctx.db, { tenantId, operation: 'mailbox.suspend', targetType: 'mailbox', targetId: mailboxId, idempotencyKey: `mailbox.suspend:${mailboxId}:${newId()}`, createdBy: actor.id });
  await audit(ctx.db, { ...auditActor(actor), tenantId, action: 'mailbox.suspend', targetType: 'mailbox', targetId: mailboxId, outcome: 'success', reason, correlationId: meta.correlationId, ip: meta.ip });
  return present(await loadMailbox(ctx, tenantId, mailboxId));
}

export async function reactivateMailbox(ctx: AppContext, tenantId: string, mailboxId: string, by: 'tenant' | 'platform', actor: Pick<AuthUser, 'id' | 'kind'>, meta: RequestMeta) {
  const m = await loadMailbox(ctx, tenantId, mailboxId);
  if (by === 'tenant' && m.status === 'suspended' && m.suspended_by !== 'tenant') throw new AppError(403, 'suspended_by_platform', 'This mailbox was suspended by ARTHVEX. Contact support to have it reinstated.');
  await transition(ctx, m, 'active', ', suspended_by = NULL, suspended_reason = NULL', []);
  await enqueue(ctx.db, { tenantId, operation: 'mailbox.reactivate', targetType: 'mailbox', targetId: mailboxId, idempotencyKey: `mailbox.reactivate:${mailboxId}:${newId()}`, createdBy: actor.id });
  await audit(ctx.db, { ...auditActor(actor), tenantId, action: 'mailbox.reactivate', targetType: 'mailbox', targetId: mailboxId, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip });
  return present(await loadMailbox(ctx, tenantId, mailboxId));
}

export async function scheduleDeletion(ctx: AppContext, tenantId: string, mailboxId: string, confirmAddress: string, actorId: string, meta: RequestMeta, actorKind: PrincipalKind = 'user') {
  const m = await loadMailbox(ctx, tenantId, mailboxId);
  if (confirmAddress.trim().toLowerCase() !== m.normalized_address) throw badRequest('confirmation_mismatch', 'Type the full mailbox address to confirm deletion.');
  const { mailbox_deletion_grace_days: days } = await getSettings(ctx.db);
  if (m.status === 'provisioning_failed') {
    await transition(ctx, m, 'deleted', ', deleted_at = NOW(3), claim_address = NULL', []);
    await exec(ctx.db, 'DELETE FROM address_claims WHERE address = ? AND owner_id = ?', [m.normalized_address, m.id]);
  } else {
    await transition(ctx, m, 'deletion_scheduled', ', status_before_deletion = ?, deletion_scheduled_for = DATE_ADD(NOW(3), INTERVAL ? DAY)', [m.status === 'suspended' ? 'suspended' : 'active', days]);
    // Access stops immediately; data is removed after the grace period.
    await enqueue(ctx.db, { tenantId, operation: 'mailbox.suspend', targetType: 'mailbox', targetId: mailboxId, idempotencyKey: `mailbox.suspend:${mailboxId}:${newId()}`, createdBy: actorId });
  }
  await audit(ctx.db, { ...auditActor({ id: actorId, kind: actorKind }), tenantId, action: 'mailbox.schedule_deletion', targetType: 'mailbox', targetId: mailboxId, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip, metadata: { graceDays: days } });
  return { ok: true, graceDays: days };
}

export async function cancelDeletion(ctx: AppContext, tenantId: string, mailboxId: string, actorId: string, meta: RequestMeta, actorKind: PrincipalKind = 'user') {
  const m = await loadMailbox(ctx, tenantId, mailboxId);
  if (m.status !== 'deletion_scheduled') throw new AppError(409, 'invalid_state', 'This mailbox is not scheduled for deletion.');
  const back = m.status_before_deletion ?? 'active';
  await transition(ctx, m, back, ', status_before_deletion = NULL, deletion_scheduled_for = NULL', []);
  if (back === 'active') await enqueue(ctx.db, { tenantId, operation: 'mailbox.reactivate', targetType: 'mailbox', targetId: mailboxId, idempotencyKey: `mailbox.reactivate:${mailboxId}:${newId()}`, createdBy: actorId });
  await audit(ctx.db, { ...auditActor({ id: actorId, kind: actorKind }), tenantId, action: 'mailbox.cancel_deletion', targetType: 'mailbox', targetId: mailboxId, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip });
  return present(await loadMailbox(ctx, tenantId, mailboxId));
}

export async function updateMailbox(ctx: AppContext, tenantId: string, mailboxId: string, patch: { displayName?: string | undefined; quotaBytes?: number | undefined }, actorId: string, meta: RequestMeta, actorKind: PrincipalKind = 'user') {
  const m = await loadMailbox(ctx, tenantId, mailboxId);
  if (patch.displayName !== undefined) await exec(ctx.db, 'UPDATE mailboxes SET display_name = ? WHERE id = ?', [patch.displayName.trim() || null, mailboxId]);
  if (patch.quotaBytes !== undefined && patch.quotaBytes !== Number(m.quota_bytes)) {
    if (m.status !== 'active' && m.status !== 'suspended') throw new AppError(409, 'invalid_state', 'The quota can only change for active or suspended mailboxes.');
    const limits = await getTenantLimits(ctx, tenantId);
    const usage = await tenantUsageCounts(ctx, tenantId);
    const check = checkQuotaAllocation(usage.allocatedBytes - Number(m.quota_bytes), patch.quotaBytes, limits);
    if (!check.ok) throw new AppError(403, check.code, check.message);
    if (m.used_bytes !== null && patch.quotaBytes < Number(m.used_bytes)) throw unprocessable('quota_below_usage', 'The new quota is smaller than the space already used.');
    await exec(ctx.db, 'UPDATE mailboxes SET quota_bytes = ? WHERE id = ?', [patch.quotaBytes, mailboxId]);
    await enqueue(ctx.db, { tenantId, operation: 'mailbox.quota', targetType: 'mailbox', targetId: mailboxId, idempotencyKey: `mailbox.quota:${mailboxId}:${newId()}`, createdBy: actorId });
  }
  await audit(ctx.db, { ...auditActor({ id: actorId, kind: actorKind }), tenantId, action: 'mailbox.update', targetType: 'mailbox', targetId: mailboxId, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip });
  return present(await loadMailbox(ctx, tenantId, mailboxId));
}

/**
 * Sets the mailbox password through the adapter. The password exists only in this call:
 * it is never written to the database, a job payload or a log. A generated password is returned once.
 */
export async function resetCredentials(ctx: AppContext, tenantId: string, mailboxId: string, requested: string | undefined, actorId: string, meta: RequestMeta, actorKind: PrincipalKind = 'user') {
  const m = await loadMailbox(ctx, tenantId, mailboxId);
  if (!m.mail_engine_account_id || (m.status !== 'active' && m.status !== 'suspended')) throw new AppError(409, 'invalid_state', 'Credentials can be set once the mailbox is active.');
  if (requested !== undefined) {
    const problem = passwordProblem(requested);
    if (problem) throw badRequest('weak_password', problem);
  }
  const password = requested ?? generateMailboxPassword();
  try {
    await ctx.mail.setMailboxPassword(m.mail_engine_account_id, password);
  } catch (err) {
    ctx.log.warn({ kind: (err as MailServerError).kind, mailboxId }, 'set mailbox password failed');
    await audit(ctx.db, { ...auditActor({ id: actorId, kind: actorKind }), tenantId, action: 'mailbox.reset_credentials', targetType: 'mailbox', targetId: mailboxId, outcome: 'failure', correlationId: meta.correlationId, ip: meta.ip });
    throw new AppError(503, 'mail_service_unavailable', 'The mail service could not update the password right now. Try again shortly.');
  }
  await exec(ctx.db, 'UPDATE mailboxes SET credentials_set_at = NOW(3) WHERE id = ?', [mailboxId]);
  await audit(ctx.db, { ...auditActor({ id: actorId, kind: actorKind }), tenantId, action: 'mailbox.reset_credentials', targetType: 'mailbox', targetId: mailboxId, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip });
  return requested === undefined ? { generatedPassword: password } : { ok: true };
}

export function clientSettings(ctx: AppContext, address: string) {
  const c = ctx.config;
  return {
    username: address,
    note: 'Use your full email address as the username and your mailbox password. Settings reflect the services enabled on this deployment.',
    imap: { host: c.MAIL_HOSTNAME, port: c.IMAP_PORT, security: 'SSL/TLS' },
    smtp: { host: c.MAIL_HOSTNAME, port: c.SUBMISSION_PORT, security: 'SSL/TLS', authentication: 'required' },
    smtpStarttls: c.SUBMISSION_STARTTLS_PORT ? { host: c.MAIL_HOSTNAME, port: c.SUBMISSION_STARTTLS_PORT, security: 'STARTTLS', authentication: 'required' } : null,
    jmap: c.JMAP_URL ? { url: c.JMAP_URL } : null,
    webmailUrl: c.WEBMAIL_URL ?? null,
    simulated: c.MAIL_ADAPTER === 'dev' ? 'This deployment uses the DEVELOPMENT mail simulation; these settings do not connect to a real mail server.' : null,
  };
}
