// Reliability audit: runs against the isolated `arthvex_email_test` database with an in-memory
// development mail engine, so provider failures can be injected deterministically.
// Run: cd backend && DB_NAME=arthvex_email_test npx tsx ../scripts/audit/reliability.ts
import { createAppContext } from '../../backend/src/bootstrap.js';
import { loadConfig } from '../../backend/src/config/env.js';
import { exec, one, rows } from '../../backend/src/db/pool.js';
import { claimNext, queueDepth, reclaimExpired } from '../../backend/src/modules/jobs/jobs.repository.js';
import { runJob, startDueDeletions } from '../../backend/src/modules/mail-server/provisioning.service.js';
import { DevMailServerAdapter } from '../../backend/src/modules/mail-server/dev.adapter.js';
import { createMailbox, suspendMailbox } from '../../backend/src/modules/mailboxes/mailboxes.service.js';
import { reconcileDomain } from '../../backend/src/modules/mail-server/reconciliation.service.js';
import { addDomain, verifyOwnership } from '../../backend/src/modules/domains/domains.service.js';
import { newId } from '../../backend/src/shared/ids.js';
import { writeFileSync } from 'node:fs';

const config = loadConfig();
if (!config.DB_NAME.endsWith('_test')) throw new Error(`Refusing to run reliability audit against ${config.DB_NAME}`);
const log = { info: () => undefined, warn: () => undefined, error: (...a: unknown[]) => console.error(...a), debug: () => undefined };
const ctx = createAppContext(log, config);
ctx.mail = new DevMailServerAdapter({ statePath: null, mailHostname: 'mail.audit.test' });
const devMail = ctx.mail as DevMailServerAdapter;
const meta = { ip: '127.0.0.1', userAgent: 'audit', correlationId: 'audit' };

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function fixture(label: string) {
  const userId = newId();
  const tenantId = newId();
  await exec(ctx.db, "INSERT INTO users (id, login_email, display_name, password_hash, status, email_verified_at) VALUES (?, ?, ?, 'x', 'active', NOW(3))", [userId, `${label}.${userId}@audit.example`, label]);
  const plan = (await one<{ id: string }>(ctx.db, 'SELECT id FROM plans ORDER BY (code = ?) DESC, id LIMIT 1', ['free_pilot']))!;
  await exec(ctx.db, "INSERT INTO tenants (id, name, slug, plan_id, created_by) VALUES (?, ?, ?, ?, ?)", [tenantId, `Audit ${label}`, `audit-${label}-${tenantId.slice(-6)}`, plan.id, userId]);
  await exec(ctx.db, "INSERT INTO subscriptions (id, tenant_id, plan_id) VALUES (?, ?, ?)", [newId(), tenantId, plan.id]);
  await exec(ctx.db, "INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status) VALUES (?, ?, ?, 'owner', 'active')", [newId(), tenantId, userId]);
  // Raise limits for this isolated fixture so lifecycle scenarios are not blocked by the 2-mailbox plan.
  await exec(
    ctx.db,
    `INSERT INTO tenant_quotas (tenant_id, max_domains, max_mailboxes, max_mailboxes_per_domain, max_aliases, tenant_storage_max_bytes, mailbox_quota_max_bytes, daily_send_limit, reason)
     VALUES (?, 20, 100, 100, 100, 10737418240, 1073741824, 5000, 'audit fixture')`,
    [tenantId],
  );
  const name = `audit-${label}-${Math.random().toString(36).slice(2, 8)}.example`;
  const { engineDomainId } = await ctx.mail.ensureDomain(name);
  const domainId = newId();
  await exec(ctx.db, "INSERT INTO domains (id, tenant_id, name, unicode_name, claim_name, status, ownership_status, provisioning_status, mail_engine_domain_id, verified_at, created_by) VALUES (?, ?, ?, ?, ?, 'verified', 'verified', 'ready', ?, NOW(3), ?)", [domainId, tenantId, name, name, name, engineDomainId, userId]);
  return { userId, tenantId, domainId, engineDomainId };
}

async function jobFor(targetId: string) {
  return one<{ id: string; attempts: number; status: string }>(ctx.db, "SELECT id, attempts, status FROM provisioning_jobs WHERE target_id = ? AND status IN ('queued','retrying','running') ORDER BY created_at DESC LIMIT 1", [targetId]);
}

/** Claims a specific queued job the way the worker does, then runs it. */
async function runTarget(targetId: string) {
  const row = (await one<{ id: string; operation: string; status: string }>(ctx.db, "SELECT * FROM provisioning_jobs WHERE target_id = ? ORDER BY created_at DESC LIMIT 1", [targetId]))!;
  await exec(ctx.db, "UPDATE provisioning_jobs SET status = 'running', attempts = attempts + 1, locked_by = 'audit', locked_until = DATE_ADD(NOW(3), INTERVAL 60 SECOND) WHERE id = ? AND status IN ('queued','retrying')", [row.id]);
  const claimed = (await one<{ id: string; operation: string; attempts: number; max_attempts: number; target_id: string }>(ctx.db, 'SELECT * FROM provisioning_jobs WHERE id = ?', [row.id]))!;
  return runJob(ctx, claimed as never);
}

const boxCount = async (engineDomainId: string) => (await ctx.mail.listMailboxes(engineDomainId)).length;

// ---------------------------------------------------------------- A. create is idempotent
const f = await fixture('reliability');
const m1 = await createMailbox(ctx, f.tenantId, f.domainId, f.userId, { localPart: 'alpha' }, meta);
const first = await runTarget(m1.id);
const [afterFirst] = await rows<{ status: string }>(ctx.db, 'SELECT status FROM mailboxes WHERE id = ?', [m1.id]);
const countAfterFirst = await boxCount(f.engineDomainId);
const replay = await runTarget(m1.id); // re-running the same completed job
const countAfterReplay = await boxCount(f.engineDomainId);
check('mailbox.create activates the mailbox', first === 'succeeded' && afterFirst.status === 'active', `outcome ${first}, status ${afterFirst.status}`);
check('replaying a completed job creates no duplicate account', replay === 'succeeded' && countAfterReplay === countAfterFirst, `accounts ${countAfterFirst}→${countAfterReplay}`);

// ---------------------------------------------------------------- B. provider unavailable
const m2 = await createMailbox(ctx, f.tenantId, f.domainId, f.userId, { localPart: 'beta' }, meta);
devMail.failNext('unavailable', 2);
const b1 = await runTarget(m2.id);
const b2 = await runTarget(m2.id);
const b3 = await runTarget(m2.id);
const [mb2] = await rows<{ status: string }>(ctx.db, 'SELECT status FROM mailboxes WHERE id = ?', [m2.id]);
check('provider outage retries with backoff instead of failing', b1 === 'retrying' && b2 === 'retrying', `${b1}, ${b2}`);
check('provisioning succeeds after the provider recovers', b3 === 'succeeded' && mb2.status === 'active', `${b3}, ${mb2.status}`);
check('retries never duplicate the account', (await boxCount(f.engineDomainId)) === 2, `accounts ${await boxCount(f.engineDomainId)}`);

// ---------------------------------------------------------------- C. applied but unacknowledged
const m3 = await createMailbox(ctx, f.tenantId, f.domainId, f.userId, { localPart: 'gamma' }, meta);
devMail.failNext('uncertain', 1, true);
const c1 = await runTarget(m3.id);
const [jobC] = await rows<{ needs_reconcile: number; status: string }>(ctx.db, "SELECT needs_reconcile, status FROM provisioning_jobs WHERE target_id = ? ORDER BY created_at DESC LIMIT 1", [m3.id]);
const c2 = await runTarget(m3.id);
const [mb3] = await rows<{ status: string; mail_engine_account_id: string }>(ctx.db, 'SELECT status, mail_engine_account_id FROM mailboxes WHERE id = ?', [m3.id]);
check('an uncertain provider outcome is flagged for reconciliation', c1 === 'retrying' && jobC.needs_reconcile === 1, `${c1}, needs_reconcile=${jobC.needs_reconcile}`);
check('the retry adopts the existing account instead of duplicating it', c2 === 'succeeded' && mb3.status === 'active' && (await boxCount(f.engineDomainId)) === 3, `accounts ${await boxCount(f.engineDomainId)}`);

// ---------------------------------------------------------------- D. expired lease recovery
const m4 = await createMailbox(ctx, f.tenantId, f.domainId, f.userId, { localPart: 'delta' }, meta);
const j4 = (await jobFor(m4.id))!;
await exec(ctx.db, "UPDATE provisioning_jobs SET status = 'running', attempts = 1, locked_by = 'dead-worker', locked_until = DATE_SUB(NOW(3), INTERVAL 5 MINUTE) WHERE id = ?", [j4.id]);
const reclaimed = await reclaimExpired(ctx.db);
const [j4after] = await rows<{ status: string; needs_reconcile: number; last_error_code: string }>(ctx.db, 'SELECT status, needs_reconcile, last_error_code FROM provisioning_jobs WHERE id = ?', [j4.id]);
const d1 = await runTarget(m4.id);
check('an expired worker lease is reclaimed for reconciliation', reclaimed >= 1 && j4after.status === 'retrying' && j4after.needs_reconcile === 1, `${j4after.status}/${j4after.last_error_code}`);
check('a reclaimed job completes without duplicating mail', d1 === 'succeeded' && (await boxCount(f.engineDomainId)) === 4, `accounts ${await boxCount(f.engineDomainId)}`);

// ---------------------------------------------------------------- E. duplicate concurrent claim
const m5 = await createMailbox(ctx, f.tenantId, f.domainId, f.userId, { localPart: 'epsilon' }, meta);
const claims = await Promise.all([claimNext(ctx.db, 'worker-a', 60), claimNext(ctx.db, 'worker-b', 60)]);
const claimedIds = claims.filter(Boolean).map((j) => j!.id);
const claimedEpsilon = claims.some((j) => j?.target_id === m5.id);
check(
  'two workers cannot claim the same job',
  claimedIds.length === 1 && claimedEpsilon,
  `claimed ${claimedIds.length} jobs (${claimedIds.join(',')}); epsilon claimed: ${claimedEpsilon}`,
);
if (claims[0]) await runJob(ctx, claims[0]);

// ---------------------------------------------------------------- F. deletion lifecycle
const m6 = await createMailbox(ctx, f.tenantId, f.domainId, f.userId, { localPart: 'zeta' }, meta);
await runTarget(m6.id);
await exec(ctx.db, "UPDATE mailboxes SET status = 'deletion_scheduled', deletion_scheduled_for = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE id = ?", [m6.id]);
const due = await startDueDeletions(ctx);
const [deleting] = await rows<{ status: string }>(ctx.db, 'SELECT status FROM mailboxes WHERE id = ?', [m6.id]);
await runTarget(m6.id);
const [deleted] = await rows<{ status: string; mail_engine_account_id: string | null }>(ctx.db, 'SELECT status, mail_engine_account_id FROM mailboxes WHERE id = ?', [m6.id]);
const claimsLeft = await one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM address_claims WHERE owner_id = ?', [m6.id]);
check('grace period expiry moves the mailbox to deleting', due >= 1 && deleting.status === 'deleting', `due ${due}, ${deleting.status}`);
check('deletion removes the engine account and the address claim', deleted.status === 'deleted' && deleted.mail_engine_account_id === null && Number(claimsLeft!.n) === 0, `${deleted.status}, claims ${claimsLeft!.n}`);
// alpha, beta, gamma, delta and epsilon exist; zeta was removed by the deletion job.
check('deleted mailbox is no longer in the engine', (await boxCount(f.engineDomainId)) === 5, `accounts ${await boxCount(f.engineDomainId)}`);

// ---------------------------------------------------------------- G. reconciliation detects orphans
const orphan = await ctx.mail.createMailbox({ appMailboxId: newId(), engineDomainId: f.engineDomainId, localPart: 'ghost', address: `ghost@${(await one<{ name: string }>(ctx.db, 'SELECT name FROM domains WHERE id = ?', [f.domainId]))!.name}`, displayName: null, quotaBytes: 1024 * 1024 });
const drift = await reconcileDomain(ctx, f.domainId, { repair: false });
const orphanDrift = drift.find((d) => d.kind === 'orphan_in_engine' && d.address.startsWith('ghost@'));
const orphanStillThere = await ctx.mail.getMailbox(orphan.engineId);
check('reconciliation reports an unmanaged engine account', Boolean(orphanDrift), `drift ${drift.map((d) => d.kind).join(',') || 'none'}`);
check('orphans are reported, never deleted automatically', Boolean(orphanStillThere), 'account intact');
if (orphanStillThere) await ctx.mail.deleteMailbox(orphan.engineId);

// ---------------------------------------------------------------- H. signalled drift is repaired safely
const m7 = await createMailbox(ctx, f.tenantId, f.domainId, f.userId, { localPart: 'eta' }, meta);
await runTarget(m7.id);
await suspendMailbox(ctx, f.tenantId, m7.id, 'tenant', 'audit suspension', { id: f.userId, kind: 'user' }, meta);
const engineBefore = await ctx.mail.getMailbox((await one<{ mail_engine_account_id: string }>(ctx.db, 'SELECT mail_engine_account_id FROM mailboxes WHERE id = ?', [m7.id]))!.mail_engine_account_id);
await reconcileDomain(ctx, f.domainId, { repair: true });
const engineAfter = await ctx.mail.getMailbox(engineBefore!.engineId);
check('reconciliation repairs suspension drift', engineBefore?.suspended === false && engineAfter?.suspended === true, `before ${engineBefore?.suspended}, after ${engineAfter?.suspended}`);

// ---------------------------------------------------------------- I. expired domain token
const d = await addDomain(ctx, f.tenantId, f.userId, `token-${Math.random().toString(36).slice(2, 8)}.example`, meta);
await exec(ctx.db, 'UPDATE domain_verification_tokens SET expires_at = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE domain_id = ?', [d.id]);
let tokenError: { code?: string; message: string } | null = null;
try {
  await verifyOwnership(ctx, f.tenantId, d.id, f.userId, meta);
} catch (err) {
  tokenError = err as { code?: string; message: string };
}
check('expired domain verification tokens are rejected', tokenError?.code === 'token_expired', tokenError?.code ?? 'no error');

// ---------------------------------------------------------------- J. engine conflict is not retried blindly
const name = (await one<{ name: string }>(ctx.db, 'SELECT name FROM domains WHERE id = ?', [f.domainId]))!.name;
await ctx.mail.createMailbox({ appMailboxId: newId(), engineDomainId: f.engineDomainId, localPart: 'conflict', address: `conflict@${name}`, displayName: null, quotaBytes: 1024 });
const m8 = await createMailbox(ctx, f.tenantId, f.domainId, f.userId, { localPart: 'conflict' }, meta);
const j8 = await runTarget(m8.id);
const [job8] = await rows<{ status: string; last_error_code: string }>(ctx.db, "SELECT status, last_error_code FROM provisioning_jobs WHERE target_id = ? ORDER BY created_at DESC LIMIT 1", [m8.id]);
const [mb8] = await rows<{ status: string }>(ctx.db, 'SELECT status FROM mailboxes WHERE id = ?', [m8.id]);
check('an account owned by someone else is refused, not overwritten', j8 === 'needs_manual_review' && job8.last_error_code === 'engine_conflict', `${j8}, ${job8.last_error_code}`);
check('the conflicting mailbox is marked failed for an operator', mb8.status === 'provisioning_failed', mb8.status);

// ---------------------------------------------------------------- K. cancel deletion before it runs
const m9 = await createMailbox(ctx, f.tenantId, f.domainId, f.userId, { localPart: 'theta' }, meta);
await runTarget(m9.id);
await exec(ctx.db, "UPDATE mailboxes SET status = 'deletion_scheduled', status_before_deletion = 'active', deletion_scheduled_for = DATE_ADD(NOW(3), INTERVAL 7 DAY) WHERE id = ?", [m9.id]);
await exec(ctx.db, "UPDATE mailboxes SET status = 'active', status_before_deletion = NULL, deletion_scheduled_for = NULL WHERE id = ?", [m9.id]);
const cancelled = await startDueDeletions(ctx);
const [mb9] = await rows<{ status: string }>(ctx.db, 'SELECT status FROM mailboxes WHERE id = ?', [m9.id]);
check('cancelled deletions are not executed after a restart', cancelled === 0 && mb9.status === 'active', `due ${cancelled}, ${mb9.status}`);

// ---------------------------------------------------------------- L. queue health
const depth = await queueDepth(ctx.db);
check('no job is left running with a live lease', !depth.running, JSON.stringify(depth));

const failed = results.filter((r) => !r.ok).length;
console.log(`\nreliability checks: ${results.length - failed}/${results.length} passed, ${failed} failed`);
writeFileSync(new URL('../../var/audit/reliability-results.json', import.meta.url), JSON.stringify({ results, failed }, null, 2));
await ctx.db.end();
process.exit(failed > 0 ? 1 : 0);
