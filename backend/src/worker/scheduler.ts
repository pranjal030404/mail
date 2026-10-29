import type { AppContext } from '../context.js';
import { exec, one, rows } from '../db/pool.js';
import { audit } from '../modules/audit/audit.service.js';
import { runDnsCheck, verifyOwnership } from '../modules/domains/domains.service.js';
import { reclaimExpired } from '../modules/jobs/jobs.repository.js';
import { startDueDeletions } from '../modules/mail-server/provisioning.service.js';
import { reconcileDomain } from '../modules/mail-server/reconciliation.service.js';
import { notifyTenantAdmins } from '../modules/notifications/notifications.service.js';
import { collectUsage } from '../modules/usage/usage.service.js';
import { expireGrants } from '../modules/admin/access-grants.service.js';

const SYSTEM_META = { ip: '', userAgent: 'worker', correlationId: 'worker' };

/** Runs `fn` only if no other worker holds the named lock, so scheduled work is not duplicated across workers. */
async function exclusive(ctx: AppContext, name: string, fn: () => Promise<void>): Promise<void> {
  const conn = await ctx.db.getConnection();
  try {
    const [[r]] = (await conn.query('SELECT GET_LOCK(?, 0) AS l', [`arthvex:${name}`])) as unknown as [[{ l: number }]];
    if (r.l !== 1) return;
    try {
      await fn();
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [`arthvex:${name}`]);
    }
  } finally {
    conn.release();
  }
}

async function safe(ctx: AppContext, name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    ctx.log.error({ task: name, err: (err as Error).message }, 'scheduled task failed');
  }
}

/** Domains awaiting TXT proof are re-checked automatically so customers do not have to keep clicking. */
export async function recheckPendingOwnership(ctx: AppContext): Promise<number> {
  const list = await rows<{ id: string; tenant_id: string }>(
    ctx.db,
    `SELECT id, tenant_id FROM domains WHERE ownership_status IN ('pending','failed') AND status = 'pending_verification'
        AND (last_dns_check_at IS NULL OR last_dns_check_at < DATE_SUB(NOW(3), INTERVAL 10 MINUTE)) AND created_at > DATE_SUB(NOW(3), INTERVAL ? DAY) LIMIT 20`,
    [ctx.config.DOMAIN_VERIFICATION_TTL_DAYS],
  );
  for (const d of list) await safe(ctx, 'ownership', () => verifyOwnership(ctx, d.tenant_id, d.id, null, SYSTEM_META).catch(() => undefined));
  return list.length;
}

/** Periodic mail-record checks; customers are told when a previously healthy domain regresses. */
export async function recheckMailRecords(ctx: AppContext): Promise<number> {
  const list = await rows<{ id: string; tenant_id: string; name: string; inbound_status: string; outbound_status: string }>(
    ctx.db,
    `SELECT id, tenant_id, name, inbound_status, outbound_status FROM domains
      WHERE ownership_status = 'verified' AND provisioning_status = 'ready' AND status IN ('verified','active')
        AND (last_dns_check_at IS NULL OR last_dns_check_at < DATE_SUB(NOW(3), INTERVAL 6 HOUR)) LIMIT 20`,
  );
  for (const d of list) {
    await safe(ctx, 'dns-recheck', async () => {
      const after = await runDnsCheck(ctx, d.tenant_id, d.id);
      const regressed = (d.inbound_status === 'ok' && after.inboundStatus !== 'ok') || (d.outbound_status === 'ok' && after.outboundStatus !== 'ok');
      if (regressed) {
        await notifyTenantAdmins(ctx, ctx.db, d.tenant_id, {
          type: 'dns_issue',
          severity: 'warning',
          title: `DNS problem detected for ${d.name}`,
          body: `A DNS check for ${d.name} no longer passes (inbound: ${after.inboundStatus}, outbound: ${after.outboundStatus}). Open the domain page to see which record changed. Mail may not be delivered until it is fixed.`,
          link: `/dashboard/domains/${d.id}`,
          dedupeKey: `dns:${d.id}:${new Date().toISOString().slice(0, 10)}`,
        });
      }
    });
  }
  return list.length;
}

export async function reconcileAll(ctx: AppContext): Promise<number> {
  const list = await rows<{ id: string; tenant_id: string; name: string }>(ctx.db, "SELECT id, tenant_id, name FROM domains WHERE provisioning_status = 'ready' AND status IN ('verified','active') LIMIT 500");
  let drifted = 0;
  for (const d of list) {
    await safe(ctx, 'reconcile', async () => {
      const drift = await reconcileDomain(ctx, d.id, { repair: false });
      if (drift.length) {
        drifted++;
        ctx.log.warn({ domainId: d.id, drift: drift.length }, 'mail-engine drift detected');
      }
    });
  }
  return drifted;
}

export async function cleanup(ctx: AppContext): Promise<void> {
  await exec(ctx.db, 'DELETE FROM email_verification_tokens WHERE expires_at < DATE_SUB(NOW(3), INTERVAL 7 DAY)');
  await exec(ctx.db, 'DELETE FROM password_reset_tokens WHERE expires_at < DATE_SUB(NOW(3), INTERVAL 7 DAY)');
  await exec(ctx.db, 'DELETE FROM sessions WHERE (expires_at < DATE_SUB(NOW(3), INTERVAL 30 DAY)) OR (revoked_at IS NOT NULL AND revoked_at < DATE_SUB(NOW(3), INTERVAL 30 DAY))');
  await exec(ctx.db, "UPDATE tenant_memberships SET status = 'revoked', invitation_token_hash = NULL WHERE status = 'invited' AND invitation_expires_at < NOW(3)");
  await exec(ctx.db, "UPDATE domain_verification_tokens SET status = 'expired' WHERE status = 'active' AND expires_at < NOW(3)");
  // Retention: DNS check history (90 days) and succeeded jobs (180 days). Audit logs are retained separately.
  await exec(ctx.db, 'DELETE FROM domain_dns_checks WHERE checked_at < DATE_SUB(NOW(3), INTERVAL 90 DAY)');
  await exec(ctx.db, "DELETE FROM provisioning_jobs WHERE status IN ('succeeded','cancelled') AND completed_at < DATE_SUB(NOW(3), INTERVAL 180 DAY)");
  void one;
  void audit;
}

export interface Scheduler {
  tick(): Promise<void>;
}

/** Interval-driven housekeeping. Each task runs at most once per interval cluster-wide (advisory locks). */
export function createScheduler(ctx: AppContext): Scheduler {
  const last: Record<string, number> = {};
  const every = (name: string, ms: number) => {
    const due = Date.now() - (last[name] ?? 0) >= ms;
    if (due) last[name] = Date.now();
    return due;
  };
  return {
    async tick() {
      if (every('lease', 30_000)) await safe(ctx, 'lease', () => reclaimExpired(ctx.db));
      if (every('deletions', 60_000)) await safe(ctx, 'deletions', () => exclusive(ctx, 'deletions', async () => void (await startDueDeletions(ctx))));
      if (every('ownership', 60_000)) await safe(ctx, 'ownership', () => exclusive(ctx, 'ownership', async () => void (await recheckPendingOwnership(ctx))));
      if (every('usage', 5 * 60_000)) await safe(ctx, 'usage', () => exclusive(ctx, 'usage', async () => void (await collectUsage(ctx))));
      if (every('dns', 15 * 60_000)) await safe(ctx, 'dns', () => exclusive(ctx, 'dns', async () => void (await recheckMailRecords(ctx))));
      if (every('reconcile', 6 * 3600_000)) await safe(ctx, 'reconcile', () => exclusive(ctx, 'reconcile', async () => void (await reconcileAll(ctx))));
      if (every('grants', 60_000)) await safe(ctx, 'grants', () => exclusive(ctx, 'grants', async () => void (await expireGrants(ctx))));
      if (every('cleanup', 3600_000)) await safe(ctx, 'cleanup', () => exclusive(ctx, 'cleanup', () => cleanup(ctx)));
    },
  };
}
