import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { parse } from '../../shared/errors.js';
import { authorizeTenant } from '../tenants/access.js';
import * as svc from './aliases.service.js';

const id = z.string().length(26);

export async function aliasRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/tenants/:tenantId/aliases', async (req) => {
    const { tenantId } = parse(z.object({ tenantId: id }), req.params);
    const { domainId } = parse(z.object({ domainId: id.optional() }), req.query);
    await authorizeTenant(ctx, req, tenantId, 'aliases.read');
    return { aliases: await svc.listAliases(ctx, tenantId, domainId) };
  });

  app.post('/tenants/:tenantId/domains/:domainId/aliases', async (req, reply) => {
    const p = parse(z.object({ tenantId: id, domainId: id }), req.params);
    const body = parse(z.object({ localPart: z.string().min(1).max(100), destinationMailboxId: id.optional(), externalAddress: z.string().max(320).optional() }), req.body);
    const a = await authorizeTenant(ctx, req, p.tenantId, 'aliases.manage', { write: true });
    return reply.code(201).send(await svc.createAlias(ctx, p.tenantId, p.domainId, a.auth.user.id, body, req.meta));
  });

  app.delete('/tenants/:tenantId/aliases/:aliasId', async (req) => {
    const p = parse(z.object({ tenantId: id, aliasId: id }), req.params);
    const a = await authorizeTenant(ctx, req, p.tenantId, 'aliases.manage', { write: true });
    await svc.deleteAlias(ctx, p.tenantId, p.aliasId, a.auth.user.id, req.meta);
    return { ok: true };
  });

  // Public: the owner of an outside address confirms forwarding from the emailed link.
  app.post('/forwarding/confirm', { config: { rateLimit: { max: ctx.config.RATE_LIMIT_ENABLED ? 20 : 1_000_000, timeWindow: 3600_000 } } }, async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
    await svc.confirmForwarding(ctx, token, req.meta);
    return { ok: true };
  });
}
