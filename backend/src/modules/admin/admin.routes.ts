import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { exec, one, rows } from '../../db/pool.js';
import { AppError, notFound, parse } from '../../shared/errors.js';
import { randomToken, sha256Hex } from '../../shared/crypto.js';
import { newId } from '../../shared/ids.js';
import { requirePlatform } from '../../plugins/session.js';
import { audit } from '../audit/audit.service.js';
import { revokeAllSessions } from '../auth/auth.service.js';
import { cancelJob, queueDepth, requeue, enqueue } from '../jobs/jobs.repository.js';
import { reconcileDomain } from '../mail-server/reconciliation.service.js';
import { reactivateMailbox, suspendMailbox } from '../mailboxes/mailboxes.service.js';
import { templates } from '../notifications/templates.js';
import { getSettings, SettingsSchema, updateSettings } from '../settings/settings.service.js';
import { getTenantUsage } from '../usage/usage.service.js';

const id = z.string().length(26);
/** Sensitive actions must carry a reason and an explicit confirmation flag. */
const Sensitive = z.object({ reason: z.string().trim().min(5).max(500), confirm: z.literal(true, { error: 'Explicit confirmation is required.' }) });

export async function adminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const platformAudit = (req: FastifyRequest, actorAdminId: string, action: string, tenantId: string | null, targetType: string, targetId: string | null, reason?: string, metadata?: Record<string, unknown>) =>
    audit(ctx.db, { actorType: 'platform_admin', actorAdminId, tenantId, action, targetType, targetId, outcome: 'success', ...(reason ? { reason } : {}), correlationId: req.meta.correlationId, ip: req.meta.ip, ...(metadata ? { metadata } : {}) });

  app.get('/admin/metrics', async (req) => {
    requirePlatform(ctx, req, 'admin.read');
    const one1 = async <T>(sql: string) => (await one<T>(ctx.db, sql))!;
    const c = await one1<Record<string, number | string>>(`SELECT
      (SELECT COUNT(*) FROM tenants WHERE status = 'active') AS tenants_active,
      (SELECT COUNT(*) FROM tenants WHERE status = 'suspended') AS tenants_suspended,
      (SELECT COUNT(*) FROM domains WHERE ownership_status = 'verified' AND status <> 'removed') AS domains_verified,
      (SELECT COUNT(*) FROM mailboxes WHERE status = 'active') AS mailboxes_active,
      (SELECT COUNT(*) FROM mailboxes WHERE status = 'suspended') AS mailboxes_suspended,
      (SELECT COUNT(*) FROM mailboxes WHERE status = 'provisioning_failed') AS mailboxes_failed,
      (SELECT COALESCE(SUM(used_bytes),0) FROM mailboxes WHERE status NOT IN ('deleted','retained')) AS storage_used,
      (SELECT COALESCE(SUM(quota_bytes),0) FROM mailboxes WHERE status NOT IN ('deleted','retained')) AS storage_allocated,
      (SELECT COUNT(*) FROM abuse_reports WHERE status IN ('open','investigating')) AS abuse_open,
      (SELECT COUNT(*) FROM support_tickets WHERE status IN ('open','awaiting_support')) AS tickets_open,
      (SELECT COUNT(*) FROM users WHERE status = 'active') AS users_active`);
    const workers = await rows<{ worker_id: string; last_seen_at: Date; jobs_processed: number }>(ctx.db, 'SELECT worker_id, last_seen_at, jobs_processed FROM worker_heartbeats WHERE last_seen_at > DATE_SUB(NOW(3), INTERVAL 1 HOUR)');
    const backup = await one<{ kind: string; status: string; finished_at: Date | null; started_at: Date; message: string | null }>(ctx.db, "SELECT kind, status, finished_at, started_at, message FROM backup_runs WHERE kind = 'backup' ORDER BY started_at DESC LIMIT 1");
    const restore = await one<{ status: string; finished_at: Date | null; message: string | null }>(ctx.db, "SELECT status, finished_at, message FROM backup_runs WHERE kind = 'restore_test' ORDER BY started_at DESC LIMIT 1");
    const engine = await ctx.mail.healthCheck().catch(() => ({ ok: false, detail: 'Health check failed' }));
    const webmail = ctx.config.WEBMAIL_ENABLED ? await ctx.webmail.healthCheck().catch(() => ({ ok: false, detail: 'Health check failed' })) : { ok: false, detail: 'Webmail is disabled' };
    const settings = await getSettings(ctx.db);
    const live = workers.filter((w) => Date.now() - w.last_seen_at.getTime() < 120_000);
    return {
      counts: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Number(v)])),
      jobs: await queueDepth(ctx.db),
      services: {
        database: { ok: true },
        mailEngine: { ...engine, kind: ctx.mail.kind, description: ctx.mail.description },
        webmail: { ...webmail, kind: ctx.webmail.kind, description: ctx.webmail.description },
        mailer: { kind: ctx.mailer.kind },
        workers: { ok: live.length > 0, live: live.length },
      },
      backup: { lastBackup: backup ?? null, lastRestoreTest: restore ?? null, stale: !backup || backup.status !== 'succeeded' || (backup.finished_at ? Date.now() - backup.finished_at.getTime() > ctx.config.BACKUP_MAX_AGE_HOURS * 3600_000 : true) },
      platform: { signupMode: settings.signup_mode, maintenanceMode: settings.maintenance_mode, simulatedMail: ctx.mail.kind === 'dev' },
      mailQueue: 'Mail queue depth is reported by the mail server (see docs/monitoring.md); it is not yet collected by the control plane.',
    };
  });

  app.get('/admin/tenants', async (req) => {
    requirePlatform(ctx, req, 'admin.read');
    const q = parse(z.object({ q: z.string().max(100).optional(), status: z.enum(['active', 'suspended', 'closed']).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }), req.query);
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (q.q) {
      where.push('(t.name LIKE ? OR t.slug LIKE ? OR EXISTS (SELECT 1 FROM domains d WHERE d.tenant_id = t.id AND d.name LIKE ?))');
      const like = `%${q.q.replace(/[%_\\]/g, '\\$&')}%`;
      params.push(like, like, like);
    }
    if (q.status) {
      where.push('t.status = ?');
      params.push(q.status);
    }
    const list = await rows<{ id: string; name: string; slug: string; status: string; plan: string; created_at: Date; mailboxes: number; domains: number }>(
      ctx.db,
      `SELECT t.id, t.name, t.slug, t.status, p.code AS plan, t.created_at,
              (SELECT COUNT(*) FROM mailboxes m WHERE m.tenant_id = t.id AND m.status NOT IN ('deleted','retained')) AS mailboxes,
              (SELECT COUNT(*) FROM domains d WHERE d.tenant_id = t.id AND d.status <> 'removed') AS domains
         FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { tenants: list.map((t) => ({ ...t, mailboxes: Number(t.mailboxes), domains: Number(t.domains) })) };
  });

  app.get('/admin/tenants/:tenantId', async (req) => {
    requirePlatform(ctx, req, 'admin.read');
    const { tenantId } = parse(z.object({ tenantId: id }), req.params);
    const t = await one<{ id: string; name: string; slug: string; status: string; suspended_reason: string | null; plan_code: string; created_at: Date }>(ctx.db, 'SELECT t.id, t.name, t.slug, t.status, t.suspended_reason, t.created_at, p.code AS plan_code FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = ?', [tenantId]);
    if (!t) throw notFound('Tenant');
    // Metadata only: staff never see mailbox contents.
    const domains = await rows(ctx.db, "SELECT id, name, status, ownership_status, inbound_status, outbound_status, provisioning_status FROM domains WHERE tenant_id = ? AND status <> 'removed'", [tenantId]);
    const mailboxes = await rows(ctx.db, "SELECT id, normalized_address AS address, status, quota_bytes, used_bytes, suspended_by FROM mailboxes WHERE tenant_id = ? AND status NOT IN ('deleted','retained') ORDER BY normalized_address LIMIT 200", [tenantId]);
    const members = await rows(ctx.db, "SELECT m.id, m.role, m.status, COALESCE(u.login_email, m.invited_email) AS email FROM tenant_memberships m LEFT JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? AND m.status <> 'revoked'", [tenantId]);
    const audits = await rows(ctx.db, 'SELECT occurred_at, action, outcome, actor_type, reason FROM audit_logs WHERE tenant_id = ? ORDER BY id DESC LIMIT 30', [tenantId]);
    return { tenant: t, usage: await getTenantUsage(ctx, tenantId), domains, mailboxes, members, recentAudit: audits };
  });

  app.post('/admin/tenants/:tenantId/suspend', async (req) => {
    const a = requirePlatform(ctx, req, 'admin.tenants.manage');
    const { tenantId } = parse(z.object({ tenantId: id }), req.params);
    const body = parse(Sensitive, req.body);
    const res = await exec(ctx.db, "UPDATE tenants SET status = 'suspended', suspended_reason = ?, suspended_at = NOW(3) WHERE id = ? AND status = 'active'", [body.reason, tenantId]);
    if (res.affectedRows !== 1) throw new AppError(409, 'invalid_state', 'The tenant is not active.');
    // Contain outbound immediately: block every active mailbox at the engine.
    const boxes = await rows<{ id: string }>(ctx.db, "SELECT id FROM mailboxes WHERE tenant_id = ? AND status = 'active'", [tenantId]);
    for (const b of boxes) {
      await exec(ctx.db, "UPDATE mailboxes SET status = 'suspended', suspended_by = 'tenant_suspension', suspended_reason = 'Workspace suspended' WHERE id = ? AND status = 'active'", [b.id]);
      await enqueue(ctx.db, { tenantId, operation: 'mailbox.suspend', targetType: 'mailbox', targetId: b.id, idempotencyKey: `mailbox.suspend:${b.id}:${newId()}`, createdBy: a.user.id });
    }
    await platformAudit(req, a.user.id, 'admin.tenant.suspend', tenantId, 'tenant', tenantId, body.reason, { mailboxesSuspended: boxes.length });
    return { ok: true, mailboxesSuspended: boxes.length };
  });

  app.post('/admin/tenants/:tenantId/reactivate', async (req) => {
    const a = requirePlatform(ctx, req, 'admin.tenants.manage');
    const { tenantId } = parse(z.object({ tenantId: id }), req.params);
    const body = parse(Sensitive, req.body);
    const res = await exec(ctx.db, "UPDATE tenants SET status = 'active', suspended_reason = NULL, suspended_at = NULL WHERE id = ? AND status = 'suspended'", [tenantId]);
    if (res.affectedRows !== 1) throw new AppError(409, 'invalid_state', 'The tenant is not suspended.');
    const boxes = await rows<{ id: string }>(ctx.db, "SELECT id FROM mailboxes WHERE tenant_id = ? AND status = 'suspended' AND suspended_by = 'tenant_suspension'", [tenantId]);
    for (const b of boxes) {
      await exec(ctx.db, "UPDATE mailboxes SET status = 'active', suspended_by = NULL, suspended_reason = NULL WHERE id = ?", [b.id]);
      await enqueue(ctx.db, { tenantId, operation: 'mailbox.reactivate', targetType: 'mailbox', targetId: b.id, idempotencyKey: `mailbox.reactivate:${b.id}:${newId()}`, createdBy: a.user.id });
    }
    await platformAudit(req, a.user.id, 'admin.tenant.reactivate', tenantId, 'tenant', tenantId, body.reason);
    return { ok: true };
  });

  app.patch('/admin/tenants/:tenantId/quotas', async (req) => {
    const a = requirePlatform(ctx, req, 'admin.plans.manage');
    const { tenantId } = parse(z.object({ tenantId: id }), req.params);
    const body = parse(
      Sensitive.extend({
        maxDomains: z.number().int().min(0).nullable().optional(),
        maxMailboxes: z.number().int().min(0).nullable().optional(),
        maxMailboxesPerDomain: z.number().int().min(0).nullable().optional(),
        maxAliases: z.number().int().min(0).nullable().optional(),
        tenantStorageMaxBytes: z.number().int().min(0).nullable().optional(),
        mailboxQuotaMaxBytes: z.number().int().min(0).nullable().optional(),
        dailySendLimit: z.number().int().min(0).nullable().optional(),
      }),
      req.body,
    );
    if (!(await one(ctx.db, 'SELECT id FROM tenants WHERE id = ?', [tenantId]))) throw notFound('Tenant');
    await exec(
      ctx.db,
      `INSERT INTO tenant_quotas (tenant_id, max_domains, max_mailboxes, max_mailboxes_per_domain, max_aliases, tenant_storage_max_bytes, mailbox_quota_max_bytes, daily_send_limit, reason, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE max_domains = VALUES(max_domains), max_mailboxes = VALUES(max_mailboxes), max_mailboxes_per_domain = VALUES(max_mailboxes_per_domain), max_aliases = VALUES(max_aliases),
         tenant_storage_max_bytes = VALUES(tenant_storage_max_bytes), mailbox_quota_max_bytes = VALUES(mailbox_quota_max_bytes), daily_send_limit = VALUES(daily_send_limit), reason = VALUES(reason), updated_by = VALUES(updated_by)`,
      [tenantId, body.maxDomains ?? null, body.maxMailboxes ?? null, body.maxMailboxesPerDomain ?? null, body.maxAliases ?? null, body.tenantStorageMaxBytes ?? null, body.mailboxQuotaMaxBytes ?? null, body.dailySendLimit ?? null, body.reason, a.user.id],
    );
    await platformAudit(req, a.user.id, 'admin.tenant.quotas', tenantId, 'tenant', tenantId, body.reason);
    return { ok: true };
  });

  async function mailboxTenant(mailboxId: string) {
    const m = await one<{ tenant_id: string }>(ctx.db, 'SELECT tenant_id FROM mailboxes WHERE id = ?', [mailboxId]);
    if (!m) throw notFound('Mailbox');
    return m.tenant_id;
  }

  app.post('/admin/mailboxes/:mailboxId/suspend', async (req) => {
    const a = requirePlatform(ctx, req, 'admin.mailboxes.manage');
    const { mailboxId } = parse(z.object({ mailboxId: id }), req.params);
    const body = parse(Sensitive, req.body);
    const tenantId = await mailboxTenant(mailboxId);
    return suspendMailbox(ctx, tenantId, mailboxId, 'platform', body.reason, a.user, req.meta);
  });

  app.post('/admin/mailboxes/:mailboxId/reactivate', async (req) => {
    const a = requirePlatform(ctx, req, 'admin.mailboxes.manage');
    const { mailboxId } = parse(z.object({ mailboxId: id }), req.params);
    const body = parse(Sensitive, req.body);
    const tenantId = await mailboxTenant(mailboxId);
    const result = await reactivateMailbox(ctx, tenantId, mailboxId, 'platform', a.user, req.meta);
    await platformAudit(req, a.user.id, 'admin.mailbox.reactivate', tenantId, 'mailbox', mailboxId, body.reason);
    return result;
  });

  // ---- provisioning
  app.get('/admin/provisioning-jobs', async (req) => {
    requirePlatform(ctx, req, 'admin.read');
    const q = parse(z.object({ status: z.string().max(30).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
    const list = await rows(
      ctx.db,
      `SELECT id, tenant_id, operation, target_type, target_id, status, attempts, max_attempts, needs_reconcile, last_error_code, last_error_message, created_at, updated_at, run_after
         FROM provisioning_jobs ${q.status ? 'WHERE status = ?' : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      q.status ? [q.status, q.pageSize, (q.page - 1) * q.pageSize] : [q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { jobs: list };
  });

  for (const action of ['retry', 'cancel'] as const) {
    app.post(`/admin/provisioning-jobs/:jobId/${action}`, async (req) => {
      const a = requirePlatform(ctx, req, 'admin.jobs.manage');
      const { jobId } = parse(z.object({ jobId: id }), req.params);
      const body = parse(Sensitive, req.body);
      const job = await one<{ tenant_id: string | null }>(ctx.db, 'SELECT tenant_id FROM provisioning_jobs WHERE id = ?', [jobId]);
      if (!job) throw notFound('Job');
      const ok = action === 'retry' ? await requeue(ctx.db, jobId) : await cancelJob(ctx.db, jobId);
      if (!ok) throw new AppError(409, 'invalid_state', `This job cannot be ${action === 'retry' ? 'retried' : 'cancelled'} in its current state.`);
      await platformAudit(req, a.user.id, `admin.job.${action}`, job.tenant_id, 'job', jobId, body.reason);
      return { ok: true };
    });
  }

  app.post('/admin/domains/:domainId/reconcile', async (req) => {
    const a = requirePlatform(ctx, req, 'admin.jobs.manage');
    const { domainId } = parse(z.object({ domainId: id }), req.params);
    const body = parse(z.object({ repair: z.boolean().default(false), reason: z.string().trim().min(5).max(500) }), req.body);
    const drift = await reconcileDomain(ctx, domainId, { repair: body.repair });
    await platformAudit(req, a.user.id, 'admin.domain.reconcile', null, 'domain', domainId, body.reason, { drift: drift.length, repair: body.repair });
    return { drift };
  });

  // ---- abuse
  app.get('/admin/abuse-reports', async (req) => {
    requirePlatform(ctx, req, 'admin.abuse.manage');
    const { status } = parse(z.object({ status: z.enum(['open', 'investigating', 'actioned', 'dismissed', 'closed']).optional() }), req.query);
    return { reports: await rows(ctx.db, `SELECT id, tenant_id, mailbox_id, reported_address, category, severity, status, source, summary, investigation_notes, created_at, resolved_at FROM abuse_reports ${status ? 'WHERE status = ?' : ''} ORDER BY FIELD(severity,'critical','high','medium','low'), created_at DESC LIMIT 200`, status ? [status] : []) };
  });

  app.patch('/admin/abuse-reports/:reportId', async (req) => {
    const a = requirePlatform(ctx, req, 'admin.abuse.manage');
    const { reportId } = parse(z.object({ reportId: id }), req.params);
    const body = parse(z.object({ status: z.enum(['open', 'investigating', 'actioned', 'dismissed', 'closed']), severity: z.enum(['low', 'medium', 'high', 'critical']).optional(), notes: z.string().trim().max(3000).optional(), reason: z.string().trim().min(5).max(500) }), req.body);
    const r = await one<{ tenant_id: string | null }>(ctx.db, 'SELECT tenant_id FROM abuse_reports WHERE id = ?', [reportId]);
    if (!r) throw notFound('Report');
    await exec(ctx.db, `UPDATE abuse_reports SET status = ?, severity = COALESCE(?, severity), investigation_notes = COALESCE(?, investigation_notes), assigned_to = ?, resolved_at = IF(? IN ('actioned','dismissed','closed'), NOW(3), NULL) WHERE id = ?`, [body.status, body.severity ?? null, body.notes ?? null, a.user.id, body.status, reportId]);
    await platformAudit(req, a.user.id, 'admin.abuse.update', r.tenant_id, 'abuse_report', reportId, body.reason, { status: body.status });
    return { ok: true };
  });

  // ---- users and sign-up
  app.post('/admin/users/:userId/revoke-sessions', async (req) => {
    const a = requirePlatform(ctx, req, 'admin.users.manage');
    const { userId } = parse(z.object({ userId: id }), req.params);
    const body = parse(Sensitive, req.body);
    const n = await revokeAllSessions(ctx, userId, 'admin_revoked');
    await platformAudit(req, a.user.id, 'admin.user.revoke_sessions', null, 'user', userId, body.reason, { revoked: n });
    return { revoked: n };
  });

  app.post('/admin/users/:userId/suspend', async (req) => {
    const a = requirePlatform(ctx, req, 'admin.users.manage');
    const { userId } = parse(z.object({ userId: id }), req.params);
    const body = parse(Sensitive, req.body);
    if (userId === a.user.id) throw new AppError(409, 'invalid_target', 'You cannot suspend yourself.');
    const res = await exec(ctx.db, "UPDATE users SET status = 'suspended', suspended_reason = ? WHERE id = ? AND status = 'active'", [body.reason, userId]);
    if (res.affectedRows !== 1) throw new AppError(409, 'invalid_state', 'The user is not active.');
    await revokeAllSessions(ctx, userId, 'user_suspended');
    await platformAudit(req, a.user.id, 'admin.user.suspend', null, 'user', userId, body.reason);
    return { ok: true };
  });

  app.get('/admin/users', async (req) => {
    requirePlatform(ctx, req, 'admin.users.manage');
    const { q } = parse(z.object({ q: z.string().max(100).optional() }), req.query);
    const list = await rows<{ id: string; email: string; display_name: string; status: string; mfa_enabled: number; last_login_at: Date | null; created_at: Date }>(ctx.db, `SELECT id, login_email AS email, display_name, status, mfa_enabled, last_login_at, created_at FROM users ${q ? 'WHERE login_email LIKE ?' : ''} ORDER BY created_at DESC LIMIT 50`, q ? [`%${q.replace(/[%_\\]/g, '\\$&')}%`] : []);
    // Customer rows never carry a platform role; admins are returned by /admin/admins.
    return { users: list.map((u) => ({ ...u, platform_role: 'none' })) };
  });

  // ---- platform administrators (separate principal/table from customers)
  app.get('/admin/admins', async (req) => {
    requirePlatform(ctx, req, 'admin.users.manage');
    const list = await rows(ctx.db, 'SELECT id, login_email AS email, display_name, role AS platform_role, status, mfa_enabled, last_login_at, created_at FROM platform_admins ORDER BY created_at DESC');
    return { admins: list };
  });

  app.post('/admin/admins/:adminId/revoke-sessions', async (req) => {
    const a = requirePlatform(ctx, req, 'admin.users.manage');
    const { adminId } = parse(z.object({ adminId: id }), req.params);
    const body = parse(Sensitive, req.body);
    if (!(await one(ctx.db, 'SELECT id FROM platform_admins WHERE id = ?', [adminId]))) throw notFound('Administrator');
    const n = await revokeAllSessions(ctx, adminId, 'admin_revoked', undefined, 'platform_admin');
    await platformAudit(req, a.user.id, 'admin.admin.revoke_sessions', null, 'platform_admin', adminId, body.reason, { revoked: n });
    return { revoked: n };
  });

  app.post('/admin/admins/:adminId/suspend', async (req) => {
    const a = requirePlatform(ctx, req, 'admin.users.manage');
    const { adminId } = parse(z.object({ adminId: id }), req.params);
    const body = parse(Sensitive, req.body);
    if (adminId === a.user.id) throw new AppError(409, 'invalid_target', 'You cannot suspend yourself.');
    const res = await exec(ctx.db, "UPDATE platform_admins SET status = 'suspended', suspended_reason = ? WHERE id = ? AND status = 'active'", [body.reason, adminId]);
    if (res.affectedRows !== 1) throw new AppError(409, 'invalid_state', 'The administrator is not active.');
    await revokeAllSessions(ctx, adminId, 'admin_suspended', undefined, 'platform_admin');
    await platformAudit(req, a.user.id, 'admin.admin.suspend', null, 'platform_admin', adminId, body.reason);
    return { ok: true };
  });

  app.post('/admin/signup-invitations', async (req, reply) => {
    const a = requirePlatform(ctx, req, 'admin.users.manage');
    const body = parse(z.object({ email: z.string().trim().max(254).pipe(z.email()) }), req.body);
    const email = body.email.toLowerCase();
    const token = randomToken();
    await exec(ctx.db, 'INSERT INTO signup_invitations (id, email, token_hash, created_by, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL 14 DAY))', [newId(), email, sha256Hex(token), a.user.id]);
    const m = templates.signupInvitation(ctx.config.APP_BASE_URL, token);
    await ctx.mailer.send({ to: email, subject: m.subject, text: m.text, category: 'signup_invitation' });
    await platformAudit(req, a.user.id, 'admin.invite.create', null, 'invitation', null, undefined, { email });
    return reply.code(201).send({ ok: true });
  });

  // ---- settings, plans
  app.get('/admin/settings', async (req) => {
    requirePlatform(ctx, req, 'admin.read');
    return getSettings(ctx.db);
  });

  app.patch('/admin/settings', async (req) => {
    const a = requirePlatform(ctx, req, 'admin.settings.manage');
    const body = parse(Sensitive.extend({ settings: SettingsSchema.partial() }), req.body);
    await updateSettings(ctx.db, body.settings, a.user.id);
    await platformAudit(req, a.user.id, 'admin.settings.update', null, 'settings', null, body.reason, { keys: Object.keys(body.settings) });
    return getSettings(ctx.db);
  });

  app.get('/admin/plans', async (req) => {
    requirePlatform(ctx, req, 'admin.read');
    return { plans: await rows(ctx.db, 'SELECT * FROM plans ORDER BY name') };
  });

  app.get('/admin/audit', async (req) => {
    requirePlatform(ctx, req, 'admin.read');
    const q = parse(z.object({ tenantId: id.optional(), action: z.string().max(100).optional(), actorUserId: id.optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (q.tenantId) {
      where.push('tenant_id = ?');
      params.push(q.tenantId);
    }
    if (q.action) {
      where.push('action LIKE ?');
      params.push(`${q.action}%`);
    }
    if (q.actorUserId) {
      where.push('(actor_user_id = ? OR actor_admin_id = ?)');
      params.push(q.actorUserId, q.actorUserId);
    }
    return { entries: await rows(ctx.db, `SELECT id, occurred_at, actor_type, actor_user_id, actor_admin_id, tenant_id, action, target_type, target_id, outcome, reason, correlation_id, ip FROM audit_logs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, q.pageSize, (q.page - 1) * q.pageSize]) };
  });

  // ---- support (metadata + customer-written text only)
  app.get('/admin/support-tickets', async (req) => {
    requirePlatform(ctx, req, 'admin.read');
    return { tickets: await rows(ctx.db, "SELECT id, tenant_id, category, urgency, subject, status, created_at, updated_at FROM support_tickets WHERE status <> 'closed' ORDER BY FIELD(urgency,'urgent','high','normal','low'), updated_at DESC LIMIT 100") };
  });

  app.post('/admin/support-tickets/:ticketId/reply', async (req) => {
    const a = requirePlatform(ctx, req, 'admin.users.manage');
    const { ticketId } = parse(z.object({ ticketId: id }), req.params);
    const body = parse(z.object({ message: z.string().trim().min(1).max(5000), status: z.enum(['awaiting_customer', 'resolved', 'closed']).default('awaiting_customer') }), req.body);
    const t = await one<{ tenant_id: string }>(ctx.db, 'SELECT tenant_id FROM support_tickets WHERE id = ?', [ticketId]);
    if (!t) throw notFound('Ticket');
    await exec(ctx.db, 'INSERT INTO support_ticket_messages (id, ticket_id, author_admin_id, is_staff, body) VALUES (?, ?, ?, 1, ?)', [newId(), ticketId, a.user.id, body.message]);
    await exec(ctx.db, 'UPDATE support_tickets SET status = ? WHERE id = ?', [body.status, ticketId]);
    await platformAudit(req, a.user.id, 'admin.support.reply', t.tenant_id, 'ticket', ticketId);
    return { ok: true };
  });
}
