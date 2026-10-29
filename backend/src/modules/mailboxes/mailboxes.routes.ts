import { tenantCan } from '../../core/index.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { one } from '../../db/pool.js';
import { forbidden, parse } from '../../shared/errors.js';
import { authorizeTenant } from '../tenants/access.js';
import { authorizeMailboxAccess } from './access.js';
import * as svc from './mailboxes.service.js';

const id = z.string().length(26);
const limit = (ctx: AppContext, max: number, windowMs = 60_000) => ({ rateLimit: { max: ctx.config.RATE_LIMIT_ENABLED ? max : 1_000_000, timeWindow: windowMs } });

export async function mailboxRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const T = z.object({ tenantId: id });
  const TM = z.object({ tenantId: id, mailboxId: id });

  app.get('/tenants/:tenantId/mailboxes', async (req) => {
    const { tenantId } = parse(T, req.params);
    const q = parse(
      z.object({
        q: z.string().max(100).optional(),
        status: z.string().max(30).optional(),
        domainId: id.optional(),
        sort: z.enum(['created', 'address', 'usage']).default('created'),
        order: z.enum(['asc', 'desc']).default('desc'),
        page: z.coerce.number().int().min(1).max(10_000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      }),
      req.query,
    );
    const access = await authorizeTenant(ctx, req, tenantId, 'tenant.read');
    let onlyMailboxId: string | null | undefined;
    if (!tenantCan(access.role, 'mailboxes.read')) {
      if (!tenantCan(access.role, 'mailbox.self')) throw forbidden();
      onlyMailboxId = (await one<{ mailbox_id: string | null }>(ctx.db, 'SELECT mailbox_id FROM tenant_memberships WHERE id = ?', [access.membershipId]))?.mailbox_id ?? null;
    }
    return svc.listMailboxes(ctx, tenantId, { ...q, ...(onlyMailboxId !== undefined ? { onlyMailboxId } : {}) });
  });

  app.post('/tenants/:tenantId/domains/:domainId/mailboxes', { config: limit(ctx, 30, 3600_000) }, async (req, reply) => {
    const p = parse(z.object({ tenantId: id, domainId: id }), req.params);
    const body = parse(z.object({ localPart: z.string().min(1).max(100), displayName: z.string().trim().max(120).optional(), quotaBytes: z.number().int().positive().optional() }), req.body);
    const a = await authorizeTenant(ctx, req, p.tenantId, 'mailboxes.manage', { write: true });
    return reply.code(202).send(await svc.createMailbox(ctx, p.tenantId, p.domainId, a.auth.user.id, body, req.meta));
  });

  app.get('/tenants/:tenantId/mailboxes/:mailboxId', async (req) => {
    const p = parse(TM, req.params);
    await authorizeMailboxAccess(ctx, req, p.tenantId, p.mailboxId, 'read');
    return svc.present(await svc.loadMailbox(ctx, p.tenantId, p.mailboxId));
  });

  app.get('/tenants/:tenantId/mailboxes/:mailboxId/client-settings', async (req) => {
    const p = parse(TM, req.params);
    await authorizeMailboxAccess(ctx, req, p.tenantId, p.mailboxId, 'read');
    const m = await svc.loadMailbox(ctx, p.tenantId, p.mailboxId);
    return svc.clientSettings(ctx, m.normalized_address);
  });

  app.patch('/tenants/:tenantId/mailboxes/:mailboxId', async (req) => {
    const p = parse(TM, req.params);
    const body = parse(z.object({ displayName: z.string().trim().max(120).optional(), quotaBytes: z.number().int().positive().optional() }), req.body);
    const a = await authorizeMailboxAccess(ctx, req, p.tenantId, p.mailboxId, 'manage');
    return svc.updateMailbox(ctx, p.tenantId, p.mailboxId, body, a.auth.user.id, req.meta);
  });

  app.post('/tenants/:tenantId/mailboxes/:mailboxId/reset-credentials', { config: limit(ctx, 10, 3600_000) }, async (req) => {
    const p = parse(TM, req.params);
    const body = parse(z.object({ password: z.string().max(256).optional() }), req.body ?? {});
    const a = await authorizeMailboxAccess(ctx, req, p.tenantId, p.mailboxId, 'self-write');
    return svc.resetCredentials(ctx, p.tenantId, p.mailboxId, body.password, a.auth.user.id, req.meta);
  });

  app.post('/tenants/:tenantId/mailboxes/:mailboxId/suspend', async (req) => {
    const p = parse(TM, req.params);
    const body = parse(z.object({ reason: z.string().trim().min(3).max(500) }), req.body);
    const a = await authorizeMailboxAccess(ctx, req, p.tenantId, p.mailboxId, 'manage');
    return svc.suspendMailbox(ctx, p.tenantId, p.mailboxId, 'tenant', body.reason, a.auth.user, req.meta);
  });

  app.post('/tenants/:tenantId/mailboxes/:mailboxId/reactivate', async (req) => {
    const p = parse(TM, req.params);
    const a = await authorizeMailboxAccess(ctx, req, p.tenantId, p.mailboxId, 'manage');
    return svc.reactivateMailbox(ctx, p.tenantId, p.mailboxId, 'tenant', a.auth.user, req.meta);
  });

  app.delete('/tenants/:tenantId/mailboxes/:mailboxId', async (req) => {
    const p = parse(TM, req.params);
    const body = parse(z.object({ confirmAddress: z.string().max(320) }), req.body);
    const a = await authorizeMailboxAccess(ctx, req, p.tenantId, p.mailboxId, 'manage');
    return svc.scheduleDeletion(ctx, p.tenantId, p.mailboxId, body.confirmAddress, a.auth.user.id, req.meta);
  });

  app.post('/tenants/:tenantId/mailboxes/:mailboxId/cancel-deletion', async (req) => {
    const p = parse(TM, req.params);
    const a = await authorizeMailboxAccess(ctx, req, p.tenantId, p.mailboxId, 'manage');
    return svc.cancelDeletion(ctx, p.tenantId, p.mailboxId, a.auth.user.id, req.meta);
  });
}
