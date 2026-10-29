import type { AppContext } from '../../context.js';
import { exec, isDuplicateKey, one, rows, type Queryable } from '../../db/pool.js';
import { newId } from '../../shared/ids.js';

export type NotificationType =
  | 'quota_warning'
  | 'dns_issue'
  | 'provisioning_failed'
  | 'security'
  | 'maintenance'
  | 'tenant_suspended'
  | 'mailbox_suspended'
  | 'support_reply';

/** Preference key that may disable the email copy; security/critical notices cannot be disabled. */
const EMAIL_PREF: Partial<Record<NotificationType, string>> = {
  quota_warning: 'email_quota_warnings',
  dns_issue: 'email_dns_alerts',
  maintenance: 'email_maintenance',
};

export interface NotifyInput {
  userId: string;
  tenantId?: string | null;
  type: NotificationType;
  severity?: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  link?: string | null;
  /** Prevents duplicate notifications for the same condition. */
  dedupeKey?: string | null;
  email?: boolean;
}

export async function notify(ctx: AppContext, db: Queryable, n: NotifyInput): Promise<boolean> {
  try {
    await exec(
      db,
      `INSERT INTO notifications (id, user_id, tenant_id, type, severity, title, body, link, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(), n.userId, n.tenantId ?? null, n.type, n.severity ?? 'info', n.title.slice(0, 200), n.body.slice(0, 1000), n.link ?? null, n.dedupeKey ?? null],
    );
  } catch (err) {
    if (isDuplicateKey(err)) return false;
    throw err;
  }
  if (n.email !== false) {
    const user = await one<{ login_email: string; status: string }>(db, 'SELECT login_email, status FROM users WHERE id = ?', [n.userId]);
    const prefKey = EMAIL_PREF[n.type];
    let wantsEmail = true;
    if (prefKey && n.severity !== 'critical') {
      const pref = await one<Record<string, number>>(db, `SELECT ${prefKey} AS v FROM notification_preferences WHERE user_id = ?`, [n.userId]);
      wantsEmail = pref ? Boolean(pref.v) : true;
    }
    if (user && user.status === 'active' && wantsEmail) {
      try {
        await ctx.mailer.send({
          to: user.login_email,
          subject: `[ARTHVEX] ${n.title}`,
          text: `${n.body}\n\n${n.link ? `${ctx.config.APP_BASE_URL}${n.link}\n\n` : ''}— ARTHVEX Email Hosting`,
          category: n.type,
        });
      } catch (err) {
        ctx.log.warn({ category: n.type, err: (err as Error).message }, 'notification email failed');
      }
    }
  }
  return true;
}

/** Clears a dedupe key so the same condition can notify again (e.g. usage dropped below a threshold). */
export async function clearDedupe(db: Queryable, userId: string, dedupeKeyPrefix: string): Promise<void> {
  await exec(db, 'UPDATE notifications SET dedupe_key = NULL WHERE user_id = ? AND dedupe_key LIKE ?', [userId, `${dedupeKeyPrefix}%`]);
}

/** Owners and admins of a tenant (for operational notifications). */
export async function tenantAdmins(db: Queryable, tenantId: string): Promise<string[]> {
  const list = await rows<{ user_id: string }>(
    db,
    `SELECT user_id FROM tenant_memberships WHERE tenant_id = ? AND status = 'active' AND role IN ('owner','admin') AND user_id IS NOT NULL`,
    [tenantId],
  );
  return list.map((r) => r.user_id);
}

export async function notifyTenantAdmins(ctx: AppContext, db: Queryable, tenantId: string, n: Omit<NotifyInput, 'userId' | 'tenantId'>): Promise<void> {
  for (const userId of await tenantAdmins(db, tenantId)) {
    await notify(ctx, db, { ...n, userId, tenantId });
  }
}
