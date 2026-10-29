import { TENANT_ROLES } from '../../core/index.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../plugins/session.js';
import { parse } from '../../shared/errors.js';
import { memberships } from '../auth/auth.routes.js';
import { authorizeTenant } from './access.js';
import * as svc from './tenants.service.js';

const id = z.string().length(26);
const name = z.string().trim().min(2).max(120);
const role = z.enum(TENANT_ROLES);

export async function tenantRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/tenants', async (req) => {
    const { user } = requireUser(req);
    return { tenants: (await memberships(ctx, user.id)).map((m) => ({ id: m.tenant_id, name: m.name, slug: m.slug, role: m.role, status: m.tenant_status })) };
  });

  app.post('/tenants', async (req, reply) => {
    const { user } = requireUser(req);
    const body = parse(z.object({ name }), req.body);
    return reply.code(201).send(await svc.createTenant(ctx, user, body.name, req.meta));
  });

  app.get('/tenants/:tenantId', async (req) => {
    const { tenantId } = parse(z.object({ tenantId: id }), req.params);
    const access = await authorizeTenant(ctx, req, tenantId, 'tenant.read');
    return { ...(await svc.getTenantDetail(ctx, tenantId)), role: access.role };
  });

  app.patch('/tenants/:tenantId', async (req) => {
    const { tenantId } = parse(z.object({ tenantId: id }), req.params);
    const body = parse(z.object({ name }), req.body);
    const access = await authorizeTenant(ctx, req, tenantId, 'tenant.update', { write: true });
    await svc.renameTenant(ctx, tenantId, body.name, access.auth.user, req.meta);
    return svc.getTenantDetail(ctx, tenantId);
  });

  app.get('/tenants/:tenantId/members', async (req) => {
    const { tenantId } = parse(z.object({ tenantId: id }), req.params);
    await authorizeTenant(ctx, req, tenantId, 'members.read');
    const list = await svc.listMembers(ctx, tenantId);
    return { members: list.map((m) => ({ id: m.id, email: m.email, displayName: m.display_name, role: m.role, status: m.status, invitationExpiresAt: m.invitation_expires_at })) };
  });

  app.post('/tenants/:tenantId/members', async (req, reply) => {
    const { tenantId } = parse(z.object({ tenantId: id }), req.params);
    const body = parse(z.object({ email: z.string().trim().max(254).pipe(z.email()), role, mailboxId: id.optional() }), req.body);
    const access = await authorizeTenant(ctx, req, tenantId, 'members.manage', { write: true });
    return reply.code(201).send(await svc.inviteMember(ctx, tenantId, access.auth.user, access.role, body.email, body.role, req.meta, body.mailboxId));
  });

  app.patch('/tenants/:tenantId/members/:membershipId', async (req) => {
    const p = parse(z.object({ tenantId: id, membershipId: id }), req.params);
    const body = parse(z.object({ role }), req.body);
    const access = await authorizeTenant(ctx, req, p.tenantId, 'members.manage', { write: true });
    await svc.changeMemberRole(ctx, p.tenantId, access.auth.user, access.role, p.membershipId, body.role, req.meta);
    return { ok: true };
  });

  app.delete('/tenants/:tenantId/members/:membershipId', async (req) => {
    const p = parse(z.object({ tenantId: id, membershipId: id }), req.params);
    // Any member may remove themselves; removing others needs members.manage (checked in the service).
    const access = await authorizeTenant(ctx, req, p.tenantId, 'tenant.read', { write: true });
    await svc.removeMember(ctx, p.tenantId, access.auth.user, access.role, p.membershipId, req.meta);
    return { ok: true };
  });

  app.post('/invitations/accept', async (req) => {
    const { user } = requireUser(req);
    const body = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
    return svc.acceptInvitation(ctx, user, body.token, req.meta);
  });
}
