import type { AppContext } from '../../context.js';
import { exec, rows } from '../../db/pool.js';
import { audit } from '../audit/audit.service.js';
import { markerFor } from './mail-server.interface.js';

export type DriftKind = 'missing_in_engine' | 'orphan_in_engine' | 'suspension_mismatch' | 'quota_mismatch';
export interface Drift {
  kind: DriftKind;
  address: string;
  mailboxId: string | null;
  detail: string;
  repaired: boolean;
}

/**
 * Compares MySQL metadata with the mail engine for one domain.
 * With `repair`, only safe, reversible drift is fixed (suspension state, quota). Missing or orphaned
 * accounts are reported for an operator: guessing could destroy or expose mail.
 */
export async function reconcileDomain(ctx: AppContext, domainId: string, opts: { repair: boolean }): Promise<Drift[]> {
  const domains = await rows<{ id: string; tenant_id: string; mail_engine_domain_id: string | null }>(ctx.db, "SELECT id, tenant_id, mail_engine_domain_id FROM domains WHERE id = ? AND provisioning_status = 'ready'", [domainId]);
  const d = domains[0];
  if (!d?.mail_engine_domain_id) return [];
  const engine = await ctx.mail.listMailboxes(d.mail_engine_domain_id);
  const byId = new Map(engine.map((e) => [e.engineId, e]));
  const known = new Set<string>();
  const drift: Drift[] = [];
  const dbBoxes = await rows<{ id: string; normalized_address: string; mail_engine_account_id: string | null; status: string; quota_bytes: number | string }>(
    ctx.db,
    "SELECT id, normalized_address, mail_engine_account_id, status, quota_bytes FROM mailboxes WHERE domain_id = ? AND status IN ('active','suspended','deletion_scheduled')",
    [domainId],
  );
  for (const m of dbBoxes) {
    const e = m.mail_engine_account_id ? byId.get(m.mail_engine_account_id) : undefined;
    if (!e) {
      drift.push({ kind: 'missing_in_engine', address: m.normalized_address, mailboxId: m.id, detail: 'Recorded as present but the mail server has no such account.', repaired: false });
      continue;
    }
    known.add(e.engineId);
    const shouldBlock = m.status !== 'active';
    if (e.suspended !== shouldBlock) {
      let repaired = false;
      if (opts.repair) {
        await (shouldBlock ? ctx.mail.suspendMailbox(e.engineId) : ctx.mail.reactivateMailbox(e.engineId));
        repaired = true;
      }
      drift.push({ kind: 'suspension_mismatch', address: m.normalized_address, mailboxId: m.id, detail: `Application says ${shouldBlock ? 'blocked' : 'active'}, mail server says ${e.suspended ? 'blocked' : 'active'}.`, repaired });
    }
    if (e.quotaBytes !== null && e.quotaBytes !== Number(m.quota_bytes)) {
      let repaired = false;
      if (opts.repair) {
        await ctx.mail.updateMailboxQuota(e.engineId, Number(m.quota_bytes));
        repaired = true;
      }
      drift.push({ kind: 'quota_mismatch', address: m.normalized_address, mailboxId: m.id, detail: `Quota is ${e.quotaBytes} on the mail server but ${m.quota_bytes} in the application.`, repaired });
    }
  }
  for (const e of engine) {
    if (known.has(e.engineId)) continue;
    // Accounts the application knows are pending creation/deletion are not drift.
    const pending = await rows<{ id: string }>(ctx.db, "SELECT id FROM mailboxes WHERE domain_id = ? AND normalized_address = ? AND status IN ('provisioning','deleting')", [domainId, e.address]);
    if (pending.length) continue;
    drift.push({ kind: 'orphan_in_engine', address: e.address, mailboxId: null, detail: e.marker?.startsWith(markerFor('mailbox', '')) ? 'Account marked as ARTHVEX-managed but unknown to the application.' : 'Account exists on the mail server without an ARTHVEX record.', repaired: false });
  }
  await audit(ctx.db, {
    actorType: 'worker',
    tenantId: d.tenant_id,
    action: 'reconcile.domain',
    targetType: 'domain',
    targetId: domainId,
    outcome: drift.length ? 'failure' : 'success',
    metadata: { drift: drift.length, repaired: drift.filter((x) => x.repaired).length },
  });
  await exec(ctx.db, 'UPDATE domains SET updated_at = updated_at WHERE id = ?', [domainId]);
  return drift;
}
