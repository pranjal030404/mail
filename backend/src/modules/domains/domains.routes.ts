import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { parse } from '../../shared/errors.js';
import { authorizeTenant } from '../tenants/access.js';
import * as svc from './domains.service.js';

const id = z.string().length(26);
const limit = (ctx: AppContext, max: number, windowMs = 60_000) => ({ rateLimit: { max: ctx.config.RATE_LIMIT_ENABLED ? max : 1_000_000, timeWindow: windowMs } });

export async function domainRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const T = z.object({ tenantId: id });
  const TD = z.object({ tenantId: id, domainId: id });

  app.get('/tenants/:tenantId/domains', async (req) => {
    const { tenantId } = parse(T, req.params);
    await authorizeTenant(ctx, req, tenantId, 'domains.read');
    return { domains: await svc.listDomains(ctx, tenantId) };
  });

  app.post('/tenants/:tenantId/domains', { config: limit(ctx, 20, 3600_000) }, async (req, reply) => {
    const { tenantId } = parse(T, req.params);
    const body = parse(z.object({ name: z.string().min(1).max(300) }), req.body);
    const a = await authorizeTenant(ctx, req, tenantId, 'domains.manage', { write: true });
    return reply.code(201).send(await svc.addDomain(ctx, tenantId, a.auth.user.id, body.name, req.meta));
  });

  app.get('/tenants/:tenantId/domains/:domainId', async (req) => {
    const p = parse(TD, req.params);
    await authorizeTenant(ctx, req, p.tenantId, 'domains.read');
    return svc.getDomain(ctx, p.tenantId, p.domainId);
  });

  app.post('/tenants/:tenantId/domains/:domainId/verify', { config: limit(ctx, 20) }, async (req) => {
    const p = parse(TD, req.params);
    const a = await authorizeTenant(ctx, req, p.tenantId, 'domains.manage', { write: true });
    return svc.verifyOwnership(ctx, p.tenantId, p.domainId, a.auth.user.id, req.meta);
  });

  app.post('/tenants/:tenantId/domains/:domainId/rotate-token', { config: limit(ctx, 10, 3600_000) }, async (req) => {
    const p = parse(TD, req.params);
    const a = await authorizeTenant(ctx, req, p.tenantId, 'domains.manage', { write: true });
    return svc.rotateToken(ctx, p.tenantId, p.domainId, a.auth.user.id, req.meta);
  });

  app.post('/tenants/:tenantId/domains/:domainId/dns-check', { config: limit(ctx, 20) }, async (req) => {
    const p = parse(TD, req.params);
    await authorizeTenant(ctx, req, p.tenantId, 'domains.manage', { write: true });
    return svc.runDnsCheck(ctx, p.tenantId, p.domainId);
  });

  app.get('/tenants/:tenantId/domains/:domainId/removal-impact', async (req) => {
    const p = parse(TD, req.params);
    await authorizeTenant(ctx, req, p.tenantId, 'domains.manage');
    return svc.removalImpact(ctx, p.tenantId, p.domainId);
  });

  app.delete('/tenants/:tenantId/domains/:domainId', async (req) => {
    const p = parse(TD, req.params);
    const body = parse(z.object({ confirmName: z.string().max(300) }), req.body);
    const a = await authorizeTenant(ctx, req, p.tenantId, 'domains.manage', { write: true });
    await svc.removeDomain(ctx, p.tenantId, p.domainId, body.confirmName, a.auth.user.id, req.meta);
    return { ok: true };
  });
}
