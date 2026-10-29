import { highestThresholdReached, usagePercent } from '../../core/index.js';
import type { AppContext } from '../../context.js';
import { exec, one, rows } from '../../db/pool.js';
import { tenantUsageCounts } from '../domains/domains.service.js';
import { clearDedupe, notifyTenantAdmins } from '../notifications/notifications.service.js';
import { getTenantLimits } from '../tenants/tenants.service.js';

export async function getTenantUsage(ctx: AppContext, tenantId: string, onlyMailboxId?: string | null) {
  const limits = await getTenantLimits(ctx, tenantId);
  const counts = await tenantUsageCounts(ctx, tenantId);
  const boxes = await rows<{ id: string; normalized_address: string; quota_bytes: number | string; used_bytes: number | string | null; usage_collected_at: Date | null; status: string }>(
    ctx.db,
    `SELECT id, normalized_address, quota_bytes, used_bytes, usage_collected_at, status FROM mailboxes
      WHERE tenant_id = ? AND status NOT IN ('deleted','retained') ${onlyMailboxId !== undefined ? 'AND id = ?' : ''} ORDER BY normalized_address`,
    onlyMailboxId !== undefined ? [tenantId, onlyMailboxId ?? ''] : [tenantId],
  );
  const used = boxes.reduce((s, b) => s + Number(b.used_bytes ?? 0), 0);
  const collectedAt = boxes.reduce<Date | null>((latest, b) => (b.usage_collected_at && (!latest || b.usage_collected_at > latest) ? b.usage_collected_at : latest), null);
  return {
    counts: { domains: counts.domains, mailboxes: counts.mailboxes, aliases: counts.aliases },
    limits: { domains: limits.maxDomains, mailboxes: limits.maxMailboxes, aliases: limits.maxAliases, storageBytes: limits.tenantStorageMaxBytes, dailySendLimit: limits.dailySendLimit, attachmentMaxBytes: limits.attachmentMaxBytes },
    storage: { allocatedBytes: counts.allocatedBytes, usedBytes: used, allocatedPercent: usagePercent(counts.allocatedBytes, limits.tenantStorageMaxBytes) },
    mailboxes: boxes.map((b) => ({
      id: b.id,
      address: b.normalized_address,
      status: b.status,
      quotaBytes: Number(b.quota_bytes),
      usedBytes: b.used_bytes === null ? null : Number(b.used_bytes),
      percent: b.used_bytes === null ? null : usagePercent(Number(b.used_bytes), Number(b.quota_bytes)),
      threshold: b.used_bytes === null ? null : highestThresholdReached(Number(b.used_bytes), Number(b.quota_bytes), limits.warnThresholds),
    })),
    collectedAt,
    note: 'Usage is collected from the mail server periodically and may lag by several minutes.',
  };
}

export async function usageHistory(ctx: AppContext, tenantId: string, days: number) {
  return rows<{ usage_date: string; storage_bytes: number | string; quota_bytes: number | string; mailbox_count: number | null }>(
    ctx.db,
    `SELECT DATE_FORMAT(usage_date, '%Y-%m-%d') AS usage_date, storage_bytes, quota_bytes, mailbox_count FROM usage_daily
      WHERE tenant_id = ? AND scope_key = ? AND usage_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ORDER BY usage_date`,
    [tenantId, `t:${tenantId}`, days],
  );
}

/** Reads actual usage from the engine, stores snapshots and raises threshold notifications. Failures are per mailbox. */
export async function collectUsage(ctx: AppContext): Promise<{ collected: number; failed: number }> {
  const boxes = await rows<{ id: string; tenant_id: string; normalized_address: string; mail_engine_account_id: string; quota_bytes: number | string }>(
    ctx.db,
    "SELECT id, tenant_id, normalized_address, mail_engine_account_id, quota_bytes FROM mailboxes WHERE status IN ('active','suspended','deletion_scheduled') AND mail_engine_account_id IS NOT NULL",
  );
  let collected = 0;
  let failed = 0;
  const perTenant = new Map<string, { used: number; quota: number; n: number }>();
  for (const b of boxes) {
    try {
      const u = await ctx.mail.getMailboxUsage(b.mail_engine_account_id);
      await exec(ctx.db, 'UPDATE mailboxes SET used_bytes = ?, usage_collected_at = NOW(3) WHERE id = ?', [u.usedBytes, b.id]);
      await exec(
        ctx.db,
        `INSERT INTO usage_daily (tenant_id, mailbox_id, scope_key, usage_date, storage_bytes, quota_bytes, collected_at) VALUES (?, ?, ?, CURDATE(), ?, ?, NOW(3))
         ON DUPLICATE KEY UPDATE storage_bytes = VALUES(storage_bytes), quota_bytes = VALUES(quota_bytes), collected_at = VALUES(collected_at)`,
        [b.tenant_id, b.id, `m:${b.id}`, u.usedBytes, Number(b.quota_bytes)],
      );
      const t = perTenant.get(b.tenant_id) ?? { used: 0, quota: 0, n: 0 };
      perTenant.set(b.tenant_id, { used: t.used + u.usedBytes, quota: t.quota + Number(b.quota_bytes), n: t.n + 1 });
      const limits = await getTenantLimits(ctx, b.tenant_id);
      const reached = highestThresholdReached(u.usedBytes, Number(b.quota_bytes), limits.warnThresholds);
      if (reached !== null) {
        await notifyTenantAdmins(ctx, ctx.db, b.tenant_id, {
          type: 'quota_warning',
          severity: reached >= 100 ? 'critical' : 'warning',
          title: `Mailbox ${b.normalized_address} is ${reached}% full`,
          body: reached >= 100 ? `${b.normalized_address} has reached its storage limit and will reject new mail until space is freed or the quota is increased.` : `${b.normalized_address} has used at least ${reached}% of its storage quota.`,
          link: '/dashboard/usage',
          dedupeKey: `quota:${b.id}:${reached}`,
        });
      } else {
        // Usage dropped: allow future warnings for this mailbox.
        const ids = await one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM notifications WHERE dedupe_key LIKE ?", [`quota:${b.id}:%`]);
        if (ids && ids.n > 0) {
          for (const uid of await rows<{ user_id: string }>(ctx.db, "SELECT user_id FROM tenant_memberships WHERE tenant_id = ? AND status = 'active' AND role IN ('owner','admin') AND user_id IS NOT NULL", [b.tenant_id])) {
            await clearDedupe(ctx.db, uid.user_id, `quota:${b.id}:`);
          }
        }
      }
      collected++;
    } catch (err) {
      failed++;
      ctx.log.warn({ mailboxId: b.id, err: (err as Error).message }, 'usage collection failed');
    }
  }
  for (const [tenantId, t] of perTenant) {
    await exec(
      ctx.db,
      `INSERT INTO usage_daily (tenant_id, scope_key, usage_date, storage_bytes, quota_bytes, mailbox_count, collected_at) VALUES (?, ?, CURDATE(), ?, ?, ?, NOW(3))
       ON DUPLICATE KEY UPDATE storage_bytes = VALUES(storage_bytes), quota_bytes = VALUES(quota_bytes), mailbox_count = VALUES(mailbox_count), collected_at = VALUES(collected_at)`,
      [tenantId, `t:${tenantId}`, t.used, t.quota, t.n],
    );
  }
  return { collected, failed };
}
