import type { AppContext } from '../../context.js';
import { exec, one } from '../../db/pool.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/audit.service.js';
import { buildWebmailMailbox, touchWebmailCredential } from './credentials.js';
import { sanitizeBody } from './sanitize.js';
import {
  KNOWN_ATTACHMENT_BLOCKLIST,
  WebmailError,
  type WebmailAdapter,
  type WebmailAttachmentInput,
  type WebmailDraftInput,
  type WebmailMailbox,
  type WebmailMessage,
} from './webmail.interface.js';

export interface WebmailMailboxRow {
  id: string;
  tenant_id: string;
  normalized_address: string;
  status: string;
  mail_engine_account_id: string | null;
}

export async function loadWebmailMailboxRow(ctx: AppContext, mailboxId: string): Promise<WebmailMailboxRow> {
  const row = await one<WebmailMailboxRow>(
    ctx.db,
    "SELECT id, tenant_id, normalized_address, status, mail_engine_account_id FROM mailboxes WHERE id = ? AND status NOT IN ('deleted','retained')",
    [mailboxId],
  );
  if (!row) throw new AppError(404, 'not_found', 'Mailbox not found.');
  return row;
}

function adapter(ctx: AppContext): WebmailAdapter {
  if (!ctx.config.WEBMAIL_ENABLED) throw new AppError(503, 'webmail_disabled', 'Webmail is disabled on this deployment.');
  return ctx.webmail;
}

function mapError(err: unknown): never {
  if (err instanceof WebmailError) {
    if (err.kind === 'not_found') throw new AppError(404, 'not_found', err.message);
    if (err.kind === 'invalid') throw new AppError(400, 'invalid_request', err.message);
    if (err.kind === 'too_large') throw new AppError(413, 'too_large', err.message);
    throw new AppError(503, 'mail_service_unavailable', err.kind === 'unauthorized' ? 'The mail service rejected this mailbox session. Ask an administrator to check the mail-engine integration.' : err.message);
  }
  throw err;
}

async function withBox<T>(ctx: AppContext, mailbox: WebmailMailboxRow, fn: (box: WebmailMailbox) => Promise<T>): Promise<T> {
  if (mailbox.status !== 'active') throw new AppError(409, 'mailbox_inactive', 'This mailbox is not active, so its messages cannot be opened.');
  try {
    const box = await buildWebmailMailbox(ctx, mailbox);
    const result = await fn(box);
    await touchWebmailCredential(ctx, mailbox.id).catch(() => undefined);
    return result;
  } catch (err) {
    return mapError(err);
  }
}

export async function listFolders(ctx: AppContext, mailbox: WebmailMailboxRow) {
  return withBox(ctx, mailbox, (box) => adapter(ctx).listFolders(box));
}

export async function listMessages(ctx: AppContext, mailbox: WebmailMailboxRow, input: { folderId?: string | undefined; q?: string | undefined; unreadOnly?: boolean | undefined; page: number; pageSize: number }) {
  return withBox(ctx, mailbox, async (box) => {
    const impl = adapter(ctx);
    const folders = await impl.listFolders(box);
    let folderId = input.folderId;
    if (folderId && !folders.some((f) => f.id === folderId)) throw new AppError(400, 'invalid_folder', 'Unknown folder.');
    folderId ??= folders.find((f) => f.role === 'inbox')?.id;
    if (!folderId) throw new AppError(409, 'no_inbox', 'This mailbox has no inbox folder on the mail server.');
    const result = await impl.listMessages(box, { folderId, q: input.q, unreadOnly: input.unreadOnly, page: input.page, pageSize: input.pageSize });
    return { ...result, folders };
  });
}

export async function getMessage(ctx: AppContext, mailbox: WebmailMailboxRow, messageId: string, opts: { blockRemoteImages: boolean }): Promise<WebmailMessage> {
  return withBox(ctx, mailbox, async (box) => {
    const raw = await adapter(ctx).getMessage(box, messageId, opts);
    const body = sanitizeBody(raw.html, raw.text, { blockRemoteImages: opts.blockRemoteImages });
    return { ...raw, html: body.html, text: body.text, remoteImagesBlocked: body.remoteImagesBlocked };
  });
}

export async function setRead(ctx: AppContext, mailbox: WebmailMailboxRow, messageId: string, read: boolean) {
  return withBox(ctx, mailbox, (box) => adapter(ctx).setRead(box, messageId, read));
}

export async function moveMessage(ctx: AppContext, mailbox: WebmailMailboxRow, messageId: string, folderId: string) {
  return withBox(ctx, mailbox, async (box) => {
    const impl = adapter(ctx);
    const folders = await impl.listFolders(box);
    if (!folders.some((f) => f.id === folderId)) throw new AppError(400, 'invalid_folder', 'Unknown folder.');
    await impl.move(box, messageId, folderId);
    return { ok: true };
  });
}

/** Deletes to Trash, or permanently when the message is already in Trash. */
export async function deleteMessage(ctx: AppContext, mailbox: WebmailMailboxRow, messageId: string, actor: { id: string; tenantId: string; kind: 'user' | 'platform_admin' }, meta: { ip: string; correlationId: string }) {
  return withBox(ctx, mailbox, async (box) => {
    const impl = adapter(ctx);
    const folders = await impl.listFolders(box);
    const trash = folders.find((f) => f.role === 'trash');
    const msg = await impl.getMessage(box, messageId, { blockRemoteImages: true });
    if (trash && !msg.folderIds.includes(trash.id)) {
      await impl.move(box, messageId, trash.id);
      return { permanentlyDeleted: false };
    }
    await impl.remove(box, messageId);
    await audit(ctx.db, {
      actorType: actor.kind,
      ...(actor.kind === 'platform_admin' ? { actorAdminId: actor.id } : { actorUserId: actor.id }),
      tenantId: actor.tenantId,
      action: 'webmail.message.delete_permanent',
      targetType: 'mailbox',
      targetId: mailbox.id,
      outcome: 'success',
      correlationId: meta.correlationId,
      ip: meta.ip,
    });
    return { permanentlyDeleted: true };
  });
}

// ------------------------------------------------------------- compose / drafts

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

function parseAddresses(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    // Accept both "a@b.c" and "Name <a@b.c>" from the compose form.
    const m = /<([^>]+)>/.exec(raw);
    const email = (m?.[1] ?? raw).trim().toLowerCase();
    if (!email) continue;
    if (!EMAIL_RE.test(email)) throw new AppError(400, 'invalid_recipient', `"${raw}" is not a valid email address.`);
    out.push(email);
  }
  return [...new Set(out)];
}

export function validateDraft(ctx: AppContext, input: { to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; html?: string | null; attachments?: WebmailAttachmentInput[] }): WebmailDraftInput {
  const to = parseAddresses(input.to);
  const cc = parseAddresses(input.cc);
  const bcc = parseAddresses(input.bcc);
  const attachments = input.attachments ?? [];
  if (attachments.length > ctx.config.WEBMAIL_MAX_ATTACHMENTS) {
    throw new AppError(413, 'too_many_attachments', `You can attach at most ${ctx.config.WEBMAIL_MAX_ATTACHMENTS} files.`);
  }
  let total = 0;
  const checked = attachments.map((a) => {
    const name = a.name.trim().slice(0, 200);
    if (!name) throw new AppError(400, 'invalid_attachment', 'Every attachment needs a file name.');
    const lower = name.toLowerCase();
    if (KNOWN_ATTACHMENT_BLOCKLIST.some((ext) => lower.endsWith(ext))) {
      throw new AppError(400, 'attachment_type_blocked', `Attachments ending in ${lower.slice(lower.lastIndexOf('.'))} are not allowed.`);
    }
    const bytes = Buffer.from(a.data, 'base64');
    if (bytes.length === 0) throw new AppError(400, 'invalid_attachment', `"${name}" is empty.`);
    if (bytes.length > ctx.config.WEBMAIL_MAX_ATTACHMENT_BYTES) {
      throw new AppError(413, 'attachment_too_large', `"${name}" exceeds the per-file limit of ${Math.floor(ctx.config.WEBMAIL_MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.`);
    }
    total += bytes.length;
    return { name, type: a.type || 'application/octet-stream', data: a.data };
  });
  if (total > ctx.config.WEBMAIL_MAX_ATTACHMENT_BYTES) {
    throw new AppError(413, 'attachments_too_large', `Attachments total ${Math.round(total / 1024 / 1024)} MB; the limit is ${Math.floor(ctx.config.WEBMAIL_MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB per message.`);
  }
  const subject = input.subject.trim().slice(0, 500);
  const text = input.text.slice(0, ctx.config.WEBMAIL_BODY_MAX_CHARS);
  const html = input.html ? input.html.slice(0, ctx.config.WEBMAIL_BODY_MAX_CHARS) : null;
  if (!subject && !text && !html && checked.length === 0) throw new AppError(400, 'empty_message', 'Write a message, add a subject or attach a file first.');
  return { to, cc, bcc, subject, text, html, attachments: checked };
}

export async function saveDraft(ctx: AppContext, mailbox: WebmailMailboxRow, input: WebmailDraftInput, draftId: string | undefined) {
  return withBox(ctx, mailbox, async (box) => {
    try {
      return await adapter(ctx).saveDraft(box, input, draftId);
    } catch (err) {
      return mapError(err);
    }
  });
}

export async function sendMessage(ctx: AppContext, mailbox: WebmailMailboxRow, input: WebmailDraftInput, draftId: string | undefined, actor: { id: string; kind: 'user' | 'platform_admin' }, meta: { ip: string; correlationId: string }) {
  return withBox(ctx, mailbox, async (box) => {
    let result: { id: string };
    try {
      result = await adapter(ctx).send(box, input, draftId);
    } catch (err) {
      // Keep an audit trail of failed sends without recording message content.
      await audit(ctx.db, {
        actorType: actor.kind,
        ...(actor.kind === 'platform_admin' ? { actorAdminId: actor.id } : { actorUserId: actor.id }),
        tenantId: mailbox.tenant_id,
        action: 'webmail.send',
        targetType: 'mailbox',
        targetId: mailbox.id,
        outcome: 'failure',
        reason: err instanceof WebmailError ? err.kind : 'error',
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return mapError(err);
    }
    await audit(ctx.db, {
      actorType: actor.kind,
      ...(actor.kind === 'platform_admin' ? { actorAdminId: actor.id } : { actorUserId: actor.id }),
      tenantId: mailbox.tenant_id,
      action: 'webmail.send',
      targetType: 'mailbox',
      targetId: mailbox.id,
      outcome: 'success',
      correlationId: meta.correlationId,
      ip: meta.ip,
      metadata: { recipients: input.to.length + input.cc.length + input.bcc.length, attachments: input.attachments.length },
    });
    return result;
  });
}

export async function downloadAttachment(ctx: AppContext, mailbox: WebmailMailboxRow, blobId: string, name: string, type: string) {
  return withBox(ctx, mailbox, (box) => adapter(ctx).downloadAttachment(box, blobId, name, type));
}

// ------------------------------------------------------------- preferences

export async function getPreferences(ctx: AppContext, mailboxId: string) {
  const p = await one<{ signature: string | null; block_remote_images: number }>(ctx.db, 'SELECT signature, block_remote_images FROM mailbox_preferences WHERE mailbox_id = ?', [mailboxId]);
  return { signature: p?.signature ?? '', blockRemoteImages: p ? Boolean(p.block_remote_images) : true };
}

export async function updatePreferences(ctx: AppContext, mailboxId: string, patch: { signature?: string | undefined; blockRemoteImages?: boolean | undefined }) {
  const current = await getPreferences(ctx, mailboxId);
  await exec(
    ctx.db,
    `INSERT INTO mailbox_preferences (mailbox_id, signature, block_remote_images) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE signature = VALUES(signature), block_remote_images = VALUES(block_remote_images)`,
    [mailboxId, (patch.signature ?? current.signature).slice(0, 5000), (patch.blockRemoteImages ?? current.blockRemoteImages) ? 1 : 0],
  );
  return getPreferences(ctx, mailboxId);
}

/** Audit a single operator read of a mailbox (used by the exceptional-access routes). */
export async function auditMailboxRead(ctx: AppContext, adminId: string, tenantId: string, mailboxId: string, meta: { ip: string; correlationId: string }, extra?: Record<string, unknown>) {
  await audit(ctx.db, {
    actorType: 'platform_admin',
    actorAdminId: adminId,
    tenantId,
    action: 'admin.mailbox.read',
    targetType: 'mailbox',
    targetId: mailboxId,
    outcome: 'success',
    correlationId: meta.correlationId,
    ip: meta.ip,
    ...(extra ? { metadata: extra } : {}),
  });
}
