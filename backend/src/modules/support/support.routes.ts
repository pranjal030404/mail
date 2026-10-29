import { tenantCan } from '../../core/index.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { exec, one, rows } from '../../db/pool.js';
import { notFound, parse, unauthorized } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { audit } from '../audit/audit.service.js';
import { requireUser } from '../../plugins/session.js';
import { authorizeTenant } from '../tenants/access.js';

const id = z.string().length(26);
const limit = (ctx: AppContext, max: number, windowMs = 60_000) => ({ rateLimit: { max: ctx.config.RATE_LIMIT_ENABLED ? max : 1_000_000, timeWindow: windowMs } });

export async function supportRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // ---- tickets (tenant scoped)
  app.post('/tenants/:tenantId/support-tickets', { config: limit(ctx, 10, 3600_000) }, async (req, reply) => {
    const { tenantId } = parse(z.object({ tenantId: id }), req.params);
    const body = parse(
      z.object({
        category: z.enum(['dns', 'mailbox', 'delivery', 'client_setup', 'account', 'billing', 'abuse', 'other']),
        urgency: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
        subject: z.string().trim().min(3).max(200),
        message: z.string().trim().min(10).max(5000),
        domainId: id.optional(),
        mailboxId: id.optional(),
      }),
      req.body,
    );
    const a = await authorizeTenant(ctx, req, tenantId, 'support.use', { write: false });
    // Referenced objects must belong to the same tenant.
    if (body.domainId && !(await one(ctx.db, 'SELECT id FROM domains WHERE id = ? AND tenant_id = ?', [body.domainId, tenantId]))) throw notFound('Domain');
    if (body.mailboxId && !(await one(ctx.db, 'SELECT id FROM mailboxes WHERE id = ? AND tenant_id = ?', [body.mailboxId, tenantId]))) throw notFound('Mailbox');
    const ticketId = newId();
    await exec(ctx.db, 'INSERT INTO support_tickets (id, tenant_id, requester_user_id, category, urgency, subject, domain_id, mailbox_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      ticketId, tenantId, a.auth.user.id, body.category, body.urgency, body.subject, body.domainId ?? null, body.mailboxId ?? null,
    ]);
    await exec(ctx.db, 'INSERT INTO support_ticket_messages (id, ticket_id, author_user_id, is_staff, body) VALUES (?, ?, ?, 0, ?)', [newId(), ticketId, a.auth.user.id, body.message]);
    await audit(ctx.db, { actorType: 'user', actorUserId: a.auth.user.id, tenantId, action: 'support.create', targetType: 'ticket', targetId: ticketId, outcome: 'success', correlationId: req.meta.correlationId, ip: req.meta.ip });
    return reply.code(201).send({ id: ticketId });
  });

  app.get('/tenants/:tenantId/support-tickets', async (req) => {
    const { tenantId } = parse(z.object({ tenantId: id }), req.params);
    const a = await authorizeTenant(ctx, req, tenantId, 'support.use');
    const own = !tenantCan(a.role, 'members.read');
    const list = await rows<{ id: string; category: string; urgency: string; subject: string; status: string; created_at: Date; updated_at: Date }>(
      ctx.db,
      `SELECT id, category, urgency, subject, status, created_at, updated_at FROM support_tickets WHERE tenant_id = ? ${own ? 'AND requester_user_id = ?' : ''} ORDER BY updated_at DESC LIMIT 100`,
      own ? [tenantId, a.auth.user.id] : [tenantId],
    );
    return { tickets: list.map((t) => ({ id: t.id, category: t.category, urgency: t.urgency, subject: t.subject, status: t.status, createdAt: t.created_at, updatedAt: t.updated_at })) };
  });

  app.get('/tenants/:tenantId/support-tickets/:ticketId', async (req) => {
    const p = parse(z.object({ tenantId: id, ticketId: id }), req.params);
    const a = await authorizeTenant(ctx, req, p.tenantId, 'support.use');
    const own = !tenantCan(a.role, 'members.read');
    const t = await one<{ id: string; category: string; urgency: string; subject: string; status: string }>(ctx.db, `SELECT id, category, urgency, subject, status FROM support_tickets WHERE id = ? AND tenant_id = ? ${own ? 'AND requester_user_id = ?' : ''}`, own ? [p.ticketId, p.tenantId, a.auth.user.id] : [p.ticketId, p.tenantId]);
    if (!t) throw notFound('Ticket');
    const messages = await rows<{ is_staff: number; body: string; created_at: Date }>(ctx.db, 'SELECT is_staff, body, created_at FROM support_ticket_messages WHERE ticket_id = ? ORDER BY created_at', [t.id]);
    return { ...t, messages: messages.map((m) => ({ fromStaff: Boolean(m.is_staff), body: m.body, createdAt: m.created_at })) };
  });

  app.post('/tenants/:tenantId/support-tickets/:ticketId/messages', async (req) => {
    const p = parse(z.object({ tenantId: id, ticketId: id }), req.params);
    const body = parse(z.object({ message: z.string().trim().min(1).max(5000) }), req.body);
    const a = await authorizeTenant(ctx, req, p.tenantId, 'support.use');
    const own = !tenantCan(a.role, 'members.read');
    const t = await one<{ id: string }>(ctx.db, `SELECT id FROM support_tickets WHERE id = ? AND tenant_id = ? ${own ? 'AND requester_user_id = ?' : ''}`, own ? [p.ticketId, p.tenantId, a.auth.user.id] : [p.ticketId, p.tenantId]);
    if (!t) throw notFound('Ticket');
    await exec(ctx.db, 'INSERT INTO support_ticket_messages (id, ticket_id, author_user_id, is_staff, body) VALUES (?, ?, ?, 0, ?)', [newId(), t.id, a.auth.user.id, body.message]);
    await exec(ctx.db, "UPDATE support_tickets SET status = 'awaiting_support' WHERE id = ? AND status <> 'closed'", [t.id]);
    return { ok: true };
  });

  // ---- abuse reports: public form, no account needed, strictly rate limited
  app.post('/abuse-reports', { config: limit(ctx, 5, 3600_000) }, async (req, reply) => {
    const body = parse(
      z.object({
        reportedAddress: z.string().trim().max(320).optional(),
        reporterEmail: z.string().trim().max(254).pipe(z.email()).optional(),
        category: z.enum(['spam', 'phishing', 'malware', 'compromised_account', 'unusual_sending', 'other']),
        summary: z.string().trim().min(10).max(3000),
      }),
      req.body,
    );
    // Link to a hosted address only to route the report; the reporter learns nothing about it.
    const hosted = body.reportedAddress ? await one<{ tenant_id: string; owner_id: string; kind: string }>(ctx.db, 'SELECT tenant_id, owner_id, kind FROM address_claims WHERE address = ?', [body.reportedAddress.toLowerCase()]) : null;
    const reportId = newId();
    await exec(
      ctx.db,
      `INSERT INTO abuse_reports (id, tenant_id, mailbox_id, reported_address, reporter_email, reporter_user_id, source, category, severity, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [reportId, hosted?.tenant_id ?? null, hosted?.kind === 'mailbox' ? hosted.owner_id : null, body.reportedAddress?.toLowerCase() ?? null, body.reporterEmail ?? null, req.auth?.user.id ?? null, req.auth ? 'customer' : 'public_form', body.category, ['malware', 'phishing', 'compromised_account'].includes(body.category) ? 'high' : 'medium', body.summary],
    );
    await audit(ctx.db, { actorType: req.auth ? 'user' : 'anonymous', actorUserId: req.auth?.user.id ?? null, action: 'abuse.report', targetType: 'abuse_report', targetId: reportId, outcome: 'success', correlationId: req.meta.correlationId, ip: req.meta.ip });
    return reply.code(202).send({ ok: true, message: 'Thank you. Our team will review this report.' });
  });

  // ---- notifications (per user)
  app.get('/notifications', async (req) => {
    const { user } = requireUser(req);
    const list = await rows<{ id: string; tenant_id: string | null; type: string; severity: string; title: string; body: string; link: string | null; read_at: Date | null; created_at: Date }>(
      ctx.db,
      'SELECT id, tenant_id, type, severity, title, body, link, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [user.id],
    );
    return { notifications: list.map((n) => ({ id: n.id, tenantId: n.tenant_id, type: n.type, severity: n.severity, title: n.title, body: n.body, link: n.link, read: Boolean(n.read_at), createdAt: n.created_at })) };
  });

  app.post('/notifications/read-all', async (req) => {
    const { user } = requireUser(req);
    await exec(ctx.db, 'UPDATE notifications SET read_at = NOW(3) WHERE user_id = ? AND read_at IS NULL', [user.id]);
    return { ok: true };
  });

  app.get('/notification-preferences', async (req) => {
    const { user } = requireUser(req);
    const p = await one<Record<string, number>>(ctx.db, 'SELECT email_quota_warnings, email_dns_alerts, email_product_updates, email_maintenance FROM notification_preferences WHERE user_id = ?', [user.id]);
    return { quotaWarnings: Boolean(p?.email_quota_warnings ?? 1), dnsAlerts: Boolean(p?.email_dns_alerts ?? 1), productUpdates: Boolean(p?.email_product_updates ?? 0), maintenance: Boolean(p?.email_maintenance ?? 1), note: 'Security and critical service notices are always sent.' };
  });

  app.patch('/notification-preferences', async (req) => {
    const { user } = requireUser(req);
    const b = parse(z.object({ quotaWarnings: z.boolean().optional(), dnsAlerts: z.boolean().optional(), productUpdates: z.boolean().optional(), maintenance: z.boolean().optional() }), req.body);
    await exec(
      ctx.db,
      `INSERT INTO notification_preferences (user_id, email_quota_warnings, email_dns_alerts, email_product_updates, email_maintenance) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE email_quota_warnings = COALESCE(?, email_quota_warnings), email_dns_alerts = COALESCE(?, email_dns_alerts),
                               email_product_updates = COALESCE(?, email_product_updates), email_maintenance = COALESCE(?, email_maintenance)`,
      [user.id, b.quotaWarnings ?? 1, b.dnsAlerts ?? 1, b.productUpdates ?? 0, b.maintenance ?? 1, b.quotaWarnings ?? null, b.dnsAlerts ?? null, b.productUpdates ?? null, b.maintenance ?? null],
    );
    return { ok: true };
  });
  void unauthorized;
}
