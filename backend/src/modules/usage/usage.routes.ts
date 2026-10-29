import { tenantCan } from '../../core/index.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { one } from '../../db/pool.js';
import { parse } from '../../shared/errors.js';
import { authorizeTenant } from '../tenants/access.js';
import * as svc from './usage.service.js';

const id = z.string().length(26);

export async function usageRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/tenants/:tenantId/usage', async (req) => {
    const { tenantId } = parse(z.object({ tenantId: id }), req.params);
    const a = await authorizeTenant(ctx, req, tenantId, 'tenant.read');
    if (tenantCan(a.role, 'usage.read')) return svc.getTenantUsage(ctx, tenantId);
    // mailbox users see only their own mailbox
    const link = await one<{ mailbox_id: string | null }>(ctx.db, 'SELECT mailbox_id FROM tenant_memberships WHERE id = ?', [a.membershipId]);
    return svc.getTenantUsage(ctx, tenantId, link?.mailbox_id ?? null);
  });

  app.get('/tenants/:tenantId/usage/history', async (req) => {
    const { tenantId } = parse(z.object({ tenantId: id }), req.params);
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
    await authorizeTenant(ctx, req, tenantId, 'usage.read');
    return { history: (await svc.usageHistory(ctx, tenantId, days)).map((r) => ({ date: r.usage_date, storageBytes: Number(r.storage_bytes), quotaBytes: Number(r.quota_bytes), mailboxCount: r.mailbox_count })) };
  });
}
