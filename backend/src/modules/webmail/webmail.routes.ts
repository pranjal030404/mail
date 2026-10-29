import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { rows } from '../../db/pool.js';
import { AppError, parse } from '../../shared/errors.js';
import { requirePlatform } from '../../plugins/session.js';
import { authorizeMailboxAccess } from '../mailboxes/access.js';
import { loadMailbox } from '../mailboxes/mailboxes.service.js';
import {
  approveGrant,
  authorizeGrantUse,
  createGrant,
  denyGrant,
  listGrants,
  revokeGrant,
} from '../admin/access-grants.service.js';
import * as svc from './webmail.service.js';

const id = z.string().length(26);
const messageId = z.string().min(1).max(255);
const base64 = z.string().max(140_000_000);
const addressList = z.array(z.string().trim().max(320)).max(100).default([]);
const attachment = z.object({ name: z.string().trim().min(1).max(200), type: z.string().trim().min(1).max(200), data: base64 });
const draftBody = z.object({
  to: addressList,
  cc: addressList,
  bcc: addressList,
  subject: z.string().max(500).default(''),
  text: z.string().max(2_000_000).default(''),
  html: z.string().max(2_000_000).nullable().optional(),
  attachments: z.array(attachment).max(20).default([]),
  draftId: messageId.optional(),
});
const limit = (ctx: AppContext, max: number, windowMs = 60_000) => ({ rateLimit: { max: ctx.config.RATE_LIMIT_ENABLED ? max : 1_000_000, timeWindow: windowMs } });

const metaOf = (req: { meta: { ip: string; correlationId: string } }) => ({ ip: req.meta.ip, correlationId: req.meta.correlationId });

export async function webmailRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const TM = z.object({ tenantId: id, mailboxId: id });

  async function mailbox(req: Parameters<typeof authorizeMailboxAccess>[1], tenantId: string, mailboxId: string, mode: 'read' | 'self-write') {
    await authorizeMailboxAccess(ctx, req, tenantId, mailboxId, mode);
    return loadMailbox(ctx, tenantId, mailboxId);
  }

  app.get('/tenants/:tenantId/mailboxes/:mailboxId/webmail/folders', { config: limit(ctx, 240) }, async (req) => {
    const p = parse(TM, req.params);
    const m = await mailbox(req, p.tenantId, p.mailboxId, 'read');
    return { folders: await svc.listFolders(ctx, m) };
  });

  app.get('/tenants/:tenantId/mailboxes/:mailboxId/webmail/messages', { config: limit(ctx, 240) }, async (req) => {
    const p = parse(TM, req.params);
    const q = parse(
      z.object({
        folderId: messageId.optional(),
        q: z.string().trim().max(200).optional(),
        unread: z.enum(['true', 'false']).optional(),
        page: z.coerce.number().int().min(1).max(10_000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      }),
      req.query,
    );
    const m = await mailbox(req, p.tenantId, p.mailboxId, 'read');
    return svc.listMessages(ctx, m, { folderId: q.folderId, q: q.q, unreadOnly: q.unread === 'true', page: q.page, pageSize: q.pageSize });
  });

  app.get('/tenants/:tenantId/mailboxes/:mailboxId/webmail/messages/:messageId', { config: limit(ctx, 300) }, async (req) => {
    const p = parse(TM.extend({ messageId }), req.params);
    const q = parse(z.object({ images: z.enum(['true', 'false']).default('false') }), req.query);
    const m = await mailbox(req, p.tenantId, p.mailboxId, 'read');
    return svc.getMessage(ctx, m, p.messageId, { blockRemoteImages: q.images !== 'true' });
  });

  app.patch('/tenants/:tenantId/mailboxes/:mailboxId/webmail/messages/:messageId', { config: limit(ctx, 240) }, async (req) => {
    const p = parse(TM.extend({ messageId }), req.params);
    const body = parse(z.object({ read: z.boolean() }), req.body);
    const m = await mailbox(req, p.tenantId, p.mailboxId, 'read');
    await svc.setRead(ctx, m, p.messageId, body.read);
    return { ok: true };
  });

  app.post('/tenants/:tenantId/mailboxes/:mailboxId/webmail/messages/:messageId/move', { config: limit(ctx, 120) }, async (req) => {
    const p = parse(TM.extend({ messageId }), req.params);
    const body = parse(z.object({ folderId: messageId }), req.body);
    const m = await mailbox(req, p.tenantId, p.mailboxId, 'self-write');
    return svc.moveMessage(ctx, m, p.messageId, body.folderId);
  });

  app.delete('/tenants/:tenantId/mailboxes/:mailboxId/webmail/messages/:messageId', { config: limit(ctx, 120) }, async (req) => {
    const p = parse(TM.extend({ messageId }), req.params);
    const a = await authorizeMailboxAccess(ctx, req, p.tenantId, p.mailboxId, 'self-write');
    const m = await loadMailbox(ctx, p.tenantId, p.mailboxId);
    return svc.deleteMessage(ctx, m, p.messageId, { id: a.auth.user.id, kind: a.auth.user.kind, tenantId: p.tenantId }, metaOf(req));
  });

  app.get('/tenants/:tenantId/mailboxes/:mailboxId/webmail/preferences', async (req) => {
    const p = parse(TM, req.params);
    const m = await mailbox(req, p.tenantId, p.mailboxId, 'read');
    return svc.getPreferences(ctx, m.id);
  });

  app.patch('/tenants/:tenantId/mailboxes/:mailboxId/webmail/preferences', async (req) => {
    const p = parse(TM, req.params);
    const body = parse(z.object({ signature: z.string().max(5000).optional(), blockRemoteImages: z.boolean().optional() }), req.body);
    const m = await mailbox(req, p.tenantId, p.mailboxId, 'self-write');
    return svc.updatePreferences(ctx, m.id, body);
  });

  const composeLimit = ctx.config.WEBMAIL_MAX_ATTACHMENT_BYTES + 512 * 1024;
  app.post('/tenants/:tenantId/mailboxes/:mailboxId/webmail/drafts', { bodyLimit: composeLimit, config: limit(ctx, 240) }, async (req) => {
    const p = parse(TM, req.params);
    const body = parse(draftBody, req.body);
    const m = await mailbox(req, p.tenantId, p.mailboxId, 'self-write');
    const input = svc.validateDraft(ctx, body);
    return svc.saveDraft(ctx, m, input, body.draftId);
  });

  app.post('/tenants/:tenantId/mailboxes/:mailboxId/webmail/send', { bodyLimit: composeLimit, config: limit(ctx, 120, 3600_000) }, async (req) => {
    const p = parse(TM, req.params);
    const body = parse(draftBody, req.body);
    const a = await authorizeMailboxAccess(ctx, req, p.tenantId, p.mailboxId, 'self-write');
    const m = await loadMailbox(ctx, p.tenantId, p.mailboxId);
    const input = svc.validateDraft(ctx, body);
    return svc.sendMessage(ctx, m, input, body.draftId, { id: a.auth.user.id, kind: a.auth.user.kind }, metaOf(req));
  });

  app.get('/tenants/:tenantId/mailboxes/:mailboxId/webmail/attachments/:blobId', { config: limit(ctx, 120) }, async (req, reply) => {
    const p = parse(TM.extend({ blobId: messageId }), req.params);
    const q = parse(z.object({ name: z.string().max(255).default('attachment'), type: z.string().max(200).default('application/octet-stream') }), req.query);
    const m = await mailbox(req, p.tenantId, p.mailboxId, 'read');
    const file = await svc.downloadAttachment(ctx, m, p.blobId, q.name, q.type);
    return reply
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`)
      .header('x-content-type-options', 'nosniff')
      .send(file.data);
  });

  // ------------------------------------------------------------- exceptional access
  app.get('/admin/access-grants', async (req) => {
    requirePlatform(ctx, req, 'admin.read');
    const q = parse(z.object({ status: z.string().max(30).optional(), mine: z.enum(['true', 'false']).default('false') }), req.query);
    return { grants: await listGrants(ctx, { status: q.status, mine: q.mine === 'true' ? req.auth!.user.id : undefined }) };
  });

  app.get('/admin/mailboxes', async (req) => {
    requirePlatform(ctx, req, 'admin.read');
    const q = parse(z.object({ q: z.string().trim().max(120).optional() }), req.query);
    const list = await rows<{ id: string; address: string; tenant_id: string; tenant_name: string; status: string }>(
      ctx.db,
      `SELECT m.id, m.normalized_address AS address, m.tenant_id, t.name AS tenant_name, m.status
         FROM mailboxes m JOIN tenants t ON t.id = m.tenant_id
        WHERE m.status NOT IN ('deleted','retained') ${q.q ? 'AND m.normalized_address LIKE ?' : ''}
        ORDER BY m.normalized_address LIMIT 50`,
      q.q ? [`%${q.q.replace(/[%_\\]/g, '\\$&')}%`] : [],
    );
    return { mailboxes: list.map((m) => ({ ...m, address: String(m.address) })) };
  });

  app.post('/admin/access-grants', async (req, reply) => {
    const a = requirePlatform(ctx, req, 'admin.access.request');
    const body = parse(
      z.object({
        mailboxId: id,
        reason: z.string().trim().min(10).max(500),
        scope: z.enum(['read']).default('read'),
        supportTicketId: id.optional(),
      }),
      req.body,
    );
    const grant = await createGrant(ctx, a.user.id, body, metaOf(req));
    return reply.code(201).send(grant);
  });

  app.post('/admin/access-grants/:grantId/approve', async (req) => {
    const a = requirePlatform(ctx, req, 'admin.access.approve');
    const { grantId } = parse(z.object({ grantId: id }), req.params);
    return approveGrant(ctx, grantId, a.user.id, metaOf(req));
  });

  app.post('/admin/access-grants/:grantId/deny', async (req) => {
    const a = requirePlatform(ctx, req, 'admin.access.approve');
    const { grantId } = parse(z.object({ grantId: id }), req.params);
    const body = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
    return denyGrant(ctx, grantId, a.user.id, body.reason, metaOf(req));
  });

  app.post('/admin/access-grants/:grantId/revoke', async (req) => {
    const a = requirePlatform(ctx, req, 'admin.access.approve');
    const { grantId } = parse(z.object({ grantId: id }), req.params);
    const body = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
    return revokeGrant(ctx, grantId, a.user.id, body.reason, metaOf(req));
  });

  async function grantMailbox(grantId: string, adminId: string, meta: { ip: string; correlationId: string }) {
    const grant = await authorizeGrantUse(ctx, grantId, adminId, meta);
    const mailboxRow = await svc.loadWebmailMailboxRow(ctx, grant.mailbox_id);
    if (mailboxRow.tenant_id !== grant.tenant_id) throw new AppError(409, 'grant_mismatch', 'The access grant no longer matches this mailbox.');
    return { grant, mailbox: mailboxRow };
  }

  app.get('/admin/access-grants/:grantId/folders', async (req) => {
    const a = requirePlatform(ctx, req, 'admin.read');
    const { grantId } = parse(z.object({ grantId: id }), req.params);
    const { mailbox: m } = await grantMailbox(grantId, a.user.id, metaOf(req));
    return { folders: await svc.listFolders(ctx, m) };
  });

  app.get('/admin/access-grants/:grantId/messages', async (req) => {
    const a = requirePlatform(ctx, req, 'admin.read');
    const { grantId } = parse(z.object({ grantId: id }), req.params);
    const q = parse(
      z.object({
        folderId: messageId.optional(),
        q: z.string().trim().max(200).optional(),
        page: z.coerce.number().int().min(1).max(10_000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      }),
      req.query,
    );
    const { grant, mailbox: m } = await grantMailbox(grantId, a.user.id, metaOf(req));
    const result = await svc.listMessages(ctx, m, { folderId: q.folderId, q: q.q, page: q.page, pageSize: q.pageSize });
    await svc.auditMailboxRead(ctx, a.user.id, grant.tenant_id, m.id, metaOf(req), { grantId: grant.id, kind: 'list' });
    return result;
  });

  app.get('/admin/access-grants/:grantId/messages/:messageId', async (req) => {
    const a = requirePlatform(ctx, req, 'admin.read');
    const p = parse(z.object({ grantId: id, messageId }), req.params);
    const q = parse(z.object({ images: z.enum(['true', 'false']).default('false') }), req.query);
    const { grant, mailbox: m } = await grantMailbox(p.grantId, a.user.id, metaOf(req));
    const message = await svc.getMessage(ctx, m, p.messageId, { blockRemoteImages: q.images !== 'true' });
    await svc.auditMailboxRead(ctx, a.user.id, grant.tenant_id, m.id, metaOf(req), { grantId: grant.id, kind: 'message', messageId: p.messageId });
    return message;
  });

  app.get('/admin/access-grants/:grantId/attachments/:blobId', async (req, reply) => {
    const a = requirePlatform(ctx, req, 'admin.read');
    const p = parse(z.object({ grantId: id, blobId: messageId }), req.params);
    const q = parse(z.object({ name: z.string().max(255).default('attachment'), type: z.string().max(200).default('application/octet-stream') }), req.query);
    const { grant, mailbox: m } = await grantMailbox(p.grantId, a.user.id, metaOf(req));
    const file = await svc.downloadAttachment(ctx, m, p.blobId, q.name, q.type);
    await svc.auditMailboxRead(ctx, a.user.id, grant.tenant_id, m.id, metaOf(req), { grantId: grant.id, kind: 'attachment', blobId: p.blobId });
    return reply
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`)
      .header('x-content-type-options', 'nosniff')
      .send(file.data);
  });

}
