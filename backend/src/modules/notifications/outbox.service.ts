import type { AppContext } from '../../context.js';
import { exec, isDuplicateKey, one, rows, type Queryable } from '../../db/pool.js';
import { newId } from '../../shared/ids.js';
import { renderEmail, type EmailKind, type TemplateParams } from './email-templates.js';

export interface EnqueueInput {
  kind: EmailKind;
  to: string;
  params: TemplateParams;
  /** Same key → same message: retries of the caller never produce a second email. */
  dedupeKey: string;
  relatedType?: string;
  relatedId?: string;
  tenantId?: string | null;
  createdByAdminId?: string | null;
}

/** Bounded exponential backoff: 1m, 4m, 16m, 64m, then capped at 2h. */
export function backoffSeconds(attempt: number): number {
  return Math.min(60 * 4 ** Math.max(0, attempt - 1), 7200);
}

/** Strips anything that could resemble a credential from provider errors before they are stored or shown. */
export function safeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/(pass(word)?|auth|token|secret)[^\s,;]*/gi, '[redacted]').slice(0, 300);
}

/** Persists a message for delivery. Returns the outbox id, or null when this dedupe key already exists. */
export async function enqueueEmail(ctx: AppContext, db: Queryable, e: EnqueueInput): Promise<string | null> {
  const id = newId();
  try {
    await exec(
      db,
      `INSERT INTO email_outbox (id, kind, to_email, payload_encrypted, max_attempts, dedupe_key, related_type, related_id, tenant_id, created_by_admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, e.kind, e.to.toLowerCase(), ctx.secrets.encrypt(JSON.stringify(e.params)), ctx.config.OUTBOX_MAX_ATTEMPTS, e.dedupeKey.slice(0, 120), e.relatedType ?? null, e.relatedId ?? null, e.tenantId ?? null, e.createdByAdminId ?? null],
    );
    return id;
  } catch (err) {
    if (isDuplicateKey(err)) return null;
    throw err;
  }
}

interface OutboxRow {
  id: string;
  kind: EmailKind;
  to_email: string;
  payload_encrypted: string | null;
  attempts: number;
  max_attempts: number;
  related_type: string | null;
  related_id: string | null;
}

/** Atomically takes one due message; a concurrent worker loses the race and gets nothing. */
async function claim(ctx: AppContext): Promise<OutboxRow | null> {
  const candidate = await one<{ id: string }>(
    ctx.db,
    `SELECT id FROM email_outbox WHERE (status = 'queued' AND next_attempt_at <= NOW(3)) OR (status = 'sending' AND locked_until < NOW(3))
      ORDER BY next_attempt_at LIMIT 1`,
  );
  if (!candidate) return null;
  const res = await exec(
    ctx.db,
    `UPDATE email_outbox SET status = 'sending', attempts = attempts + 1, locked_until = DATE_ADD(NOW(3), INTERVAL 2 MINUTE)
      WHERE id = ? AND ((status = 'queued' AND next_attempt_at <= NOW(3)) OR (status = 'sending' AND locked_until < NOW(3)))`,
    [candidate.id],
  );
  if (res.affectedRows !== 1) return null;
  return one<OutboxRow>(ctx.db, 'SELECT id, kind, to_email, payload_encrypted, attempts, max_attempts, related_type, related_id FROM email_outbox WHERE id = ?', [candidate.id]);
}

async function syncInvitationDelivery(db: Queryable, row: OutboxRow, delivery: 'sent' | 'failed' | 'queued'): Promise<void> {
  if (row.related_type !== 'account_invitation' || !row.related_id) return;
  await exec(db, `UPDATE account_invitations SET delivery = ?, last_sent_at = IF(? = 'sent', NOW(3), last_sent_at) WHERE id = ? AND last_email_id = ?`, [delivery, delivery, row.related_id, row.id]);
}

/** Delivers due messages. Safe to call from several processes at once. Returns the number attempted. */
export async function processOutbox(ctx: AppContext, limit = 20): Promise<number> {
  let n = 0;
  for (; n < limit; n++) {
    const row = await claim(ctx);
    if (!row) break;
    try {
      if (!row.payload_encrypted) throw new Error('Message payload is missing.');
      const params = JSON.parse(ctx.secrets.decrypt(row.payload_encrypted)) as TemplateParams;
      const m = renderEmail(row.kind, params);
      await ctx.mailer.send({ to: row.to_email, subject: m.subject, text: m.text, html: m.html, category: row.kind });
      // Sent: the payload (which may hold a one-time link) is destroyed.
      await exec(ctx.db, "UPDATE email_outbox SET status = 'sent', sent_at = NOW(3), payload_encrypted = NULL, last_error = NULL, locked_until = NULL WHERE id = ?", [row.id]);
      await syncInvitationDelivery(ctx.db, row, 'sent');
    } catch (err) {
      const message = safeError(err);
      const terminal = row.attempts >= row.max_attempts;
      ctx.log.warn({ category: row.kind, attempt: row.attempts, terminal, err: message }, 'email delivery failed');
      await exec(
        ctx.db,
        `UPDATE email_outbox SET status = ?, last_error = ?, locked_until = NULL, next_attempt_at = DATE_ADD(NOW(3), INTERVAL ? SECOND) WHERE id = ?`,
        [terminal ? 'failed' : 'queued', message, backoffSeconds(row.attempts), row.id],
      );
      await syncInvitationDelivery(ctx.db, row, terminal ? 'failed' : 'queued');
    }
  }
  return n;
}

/** Puts a failed (or cancelled) message back in the queue with a fresh attempt budget. */
export async function retryEmail(ctx: AppContext, id: string): Promise<boolean> {
  const row = await one<{ related_type: string | null; related_id: string | null }>(ctx.db, 'SELECT related_type, related_id FROM email_outbox WHERE id = ?', [id]);
  const res = await exec(ctx.db, "UPDATE email_outbox SET status = 'queued', attempts = 0, next_attempt_at = NOW(3), locked_until = NULL WHERE id = ? AND status = 'failed' AND payload_encrypted IS NOT NULL", [id]);
  if (res.affectedRows === 1 && row?.related_type === 'account_invitation' && row.related_id) {
    await exec(ctx.db, "UPDATE account_invitations SET delivery = 'queued' WHERE id = ? AND last_email_id = ?", [row.related_id, id]);
  }
  return res.affectedRows === 1;
}

export async function cancelEmailsFor(db: Queryable, relatedType: string, relatedId: string): Promise<void> {
  await exec(db, "UPDATE email_outbox SET status = 'cancelled', payload_encrypted = NULL WHERE related_type = ? AND related_id = ? AND status IN ('queued','failed')", [relatedType, relatedId]);
}

export async function outboxStats(db: Queryable) {
  const r = await rows<{ status: string; n: number }>(db, "SELECT status, COUNT(*) AS n FROM email_outbox WHERE created_at > DATE_SUB(NOW(3), INTERVAL 30 DAY) GROUP BY status");
  return Object.fromEntries(r.map((x) => [x.status, Number(x.n)]));
}

/** Validates configuration and, when `to` is given, sends a real test message. Never returns secrets. */
export async function testEmailConfiguration(ctx: AppContext, to: string | null): Promise<{ ok: boolean; mailer: string; stage: 'verify' | 'send' | 'done'; detail: string }> {
  const kind = ctx.mailer.kind;
  try {
    await ctx.mailer.verify();
  } catch (err) {
    return { ok: false, mailer: kind, stage: 'verify', detail: safeError(err) };
  }
  if (!to) return { ok: true, mailer: kind, stage: 'done', detail: kind === 'smtp' ? 'SMTP connection and authentication succeeded.' : 'Development mailer is writable (messages are captured to disk, not sent).' };
  try {
    const m = renderEmail('config_test', {});
    await ctx.mailer.send({ to, subject: m.subject, text: m.text, html: m.html, category: 'config_test' });
    return { ok: true, mailer: kind, stage: 'done', detail: kind === 'smtp' ? 'Test message accepted by the SMTP server.' : 'Test message captured by the development mailer (not delivered).' };
  } catch (err) {
    return { ok: false, mailer: kind, stage: 'send', detail: safeError(err) };
  }
}
