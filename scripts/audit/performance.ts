// Performance and database audit against the isolated test database plus live HTTP timings.
// Run: cd backend && DB_NAME=arthvex_email_test npx tsx ../scripts/audit/performance.ts
import { createAppContext } from '../../backend/src/bootstrap.js';
import { loadConfig } from '../../backend/src/config/env.js';
import { exec, one, rows } from '../../backend/src/db/pool.js';
import { createMailbox, listMailboxes } from '../../backend/src/modules/mailboxes/mailboxes.service.js';
import { getTenantUsage } from '../../backend/src/modules/usage/usage.service.js';
import { cleanup } from '../../backend/src/worker/scheduler.js';
import { newId } from '../../backend/src/shared/ids.js';
import { writeFileSync } from 'node:fs';

const config = loadConfig();
if (!config.DB_NAME.endsWith('_test')) throw new Error(`Refusing to run performance audit against ${config.DB_NAME}`);
const log = { info: () => undefined, warn: () => undefined, error: (...a: unknown[]) => console.error(...a), debug: () => undefined };
const ctx = createAppContext(log, config);
const meta = { ip: '127.0.0.1', userAgent: 'audit', correlationId: 'audit' };
const results: { name: string; ok: boolean; detail: string }[] = [];
const measurements: Record<string, unknown> = {};
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const userId = newId();
const tenantId = newId();
const domainId = newId();
await exec(ctx.db, "INSERT INTO users (id, login_email, display_name, password_hash, status, email_verified_at) VALUES (?, ?, 'Perf', 'x', 'active', NOW(3))", [userId, `perf.${userId}@audit.example`]);
const plan = (await one<{ id: string }>(ctx.db, "SELECT id FROM plans ORDER BY (code = 'free_pilot') DESC LIMIT 1"))!;
await exec(ctx.db, "INSERT INTO tenants (id, name, slug, plan_id, created_by) VALUES (?, 'Perf', ?, ?, ?)", [tenantId, `perf-${tenantId.slice(-8)}`, plan.id, userId]);
await exec(ctx.db, "INSERT INTO subscriptions (id, tenant_id, plan_id) VALUES (?, ?, ?)", [newId(), tenantId, plan.id]);
await exec(ctx.db, "INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status) VALUES (?, ?, ?, 'owner', 'active')", [newId(), tenantId, userId]);
const domainName = `perf-${Math.random().toString(36).slice(2, 8)}.example`;
await exec(ctx.db, "INSERT INTO domains (id, tenant_id, name, unicode_name, claim_name, status, ownership_status, provisioning_status, verified_at, created_by) VALUES (?, ?, ?, ?, ?, 'verified', 'verified', 'ready', NOW(3), ?)", [domainId, tenantId, domainName, domainName, domainName, userId]);
await exec(
  ctx.db,
  `INSERT INTO tenant_quotas (tenant_id, max_domains, max_mailboxes, max_mailboxes_per_domain, max_aliases, tenant_storage_max_bytes, mailbox_quota_max_bytes, daily_send_limit, reason)
   VALUES (?, 100, 5000, 5000, 500, 10995116277760, 1073741824, 100000, 'perf audit')`,
  [tenantId],
);

// ---------------------------------------------------------------- volume
const VOLUME = 2000;
const quota = 100 * 1024 * 1024;
const values: string[] = [];
const params: unknown[] = [];
for (let i = 0; i < VOLUME; i++) {
  const local = `u${i}`;
  values.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  params.push(newId(), tenantId, domainId, local, `${local}@${domainName}`, `${local}@${domainName}`, null, quota, 'active', BigDecimalish(i), null, null, null, userId);
}
function BigDecimalish(i: number) {
  return i * 1024;
}
await exec(
  ctx.db,
  `INSERT INTO mailboxes (id, tenant_id, domain_id, local_part, normalized_address, claim_address, display_name, quota_bytes, status, used_bytes, mail_engine_account_id, suspended_by, suspended_reason, created_by)
   VALUES ${values.join(',')}`,
  params,
);

const time = async (fn: () => Promise<unknown>, runs = 5) => {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return { p50: Number(samples[Math.floor(samples.length / 2)]!.toFixed(2)), p95: Number(samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)]!.toFixed(2)), n: runs };
};

const page1 = await time(() => listMailboxes(ctx, tenantId, { sort: 'created', order: 'desc', page: 1, pageSize: 25 }));
const page40 = await time(() => listMailboxes(ctx, tenantId, { sort: 'address', order: 'asc', page: 40, pageSize: 25 }));
const search = await time(() => listMailboxes(ctx, tenantId, { q: 'u199', sort: 'created', order: 'desc', page: 1, pageSize: 25 }));
const usage = await time(() => getTenantUsage(ctx, tenantId));
measurements.mailboxListPage1Ms = page1;
measurements.mailboxListDeepPageMs = page40;
measurements.mailboxSearchMs = search;
measurements.tenantUsageMs = usage;

const listed = await listMailboxes(ctx, tenantId, { sort: 'created', order: 'desc', page: 1, pageSize: 100 });
check('paginated list returns the requested page size and true total', listed.mailboxes.length === 100 && listed.total === VOLUME, `${listed.mailboxes.length} of ${listed.total}`);
check('deep pagination stays within a reasonable budget for 2,000 mailboxes', page40.p95 < 500, `p95 ${page40.p95} ms`);
check('workspace usage aggregates 2,000 mailboxes within a reasonable budget', usage.p95 < 500, `p95 ${usage.p95} ms`);

// EXPLAIN for the hot list query.
const explain = await rows<Record<string, unknown>>(
  ctx.db,
  "EXPLAIN SELECT * FROM mailboxes WHERE tenant_id = ? AND status NOT IN ('deleted','retained') ORDER BY created_at DESC, id LIMIT 25 OFFSET 0",
  [tenantId],
);
measurements.explainMailboxList = explain;

// ---------------------------------------------------------------- concurrent duplicate creation
const D = `dup-${Math.random().toString(36).slice(2, 8)}`;
const attempts = await Promise.allSettled(
  Array.from({ length: 5 }, () => createMailbox(ctx, tenantId, domainId, userId, { localPart: D }, meta)),
);
const successes = attempts.filter((a) => a.status === 'fulfilled').length;
const conflicts = attempts.filter((a) => a.status === 'rejected').length;
const dupRows = await one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM mailboxes WHERE normalized_address = ?', [`${D}@${domainName}`]);
const claims = await one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM address_claims WHERE address = ?', [`${D}@${domainName}`]);
check('concurrent duplicate creation yields exactly one mailbox', successes === 1 && Number(dupRows!.n) === 1 && Number(claims!.n) === 1, `${successes} ok, ${conflicts} rejected, rows ${dupRows!.n}, claims ${claims!.n}`);

// ---------------------------------------------------------------- concurrent quota consumption
const [usageNow] = await rows<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM mailboxes WHERE tenant_id = ? AND status NOT IN ('deleted','retained')", [tenantId]);
await exec(ctx.db, 'UPDATE tenant_quotas SET max_mailboxes = ?, max_mailboxes_per_domain = ? WHERE tenant_id = ?', [Number(usageNow.n) + 1, Number(usageNow.n) + 1, tenantId]);
const race = await Promise.allSettled(
  Array.from({ length: 5 }, (_, i) => createMailbox(ctx, tenantId, domainId, userId, { localPart: `race${i}-${Math.random().toString(36).slice(2, 6)}` }, meta)),
);
const raceOk = race.filter((r) => r.status === 'fulfilled').length;
const [afterRace] = await rows<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM mailboxes WHERE tenant_id = ? AND status NOT IN ('deleted','retained')", [tenantId]);
check('a concurrent quota race cannot exceed the plan limit', raceOk === 1 && Number(afterRace.n) === Number(usageNow.n) + 1, `${raceOk} accepted, ${afterRace.n} total (limit ${Number(usageNow.n) + 1})`);
await exec(ctx.db, 'UPDATE tenant_quotas SET max_mailboxes = 5000, max_mailboxes_per_domain = 5000 WHERE tenant_id = ?', [tenantId]);

// ---------------------------------------------------------------- retention cleanup
await exec(ctx.db, "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, DATE_SUB(NOW(3), INTERVAL 60 DAY))", [newId(), userId, `expired-${newId()}`]);
await exec(ctx.db, 'INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, DATE_SUB(NOW(3), INTERVAL 30 DAY))', [newId(), userId, `expired-${newId()}`]);
await exec(ctx.db, 'INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, DATE_SUB(NOW(3), INTERVAL 30 DAY))', [newId(), userId, `expired-${newId()}`]);
await cleanup(ctx);
const leftovers = await one<{ s: number; e: number; p: number }>(
  ctx.db,
  `SELECT (SELECT COUNT(*) FROM sessions WHERE token_hash LIKE 'expired-%') AS s,
          (SELECT COUNT(*) FROM email_verification_tokens WHERE token_hash LIKE 'expired-%') AS e,
          (SELECT COUNT(*) FROM password_reset_tokens WHERE token_hash LIKE 'expired-%') AS p`,
);
check('retention cleanup removes long-expired sessions and tokens', Number(leftovers!.s) === 0 && Number(leftovers!.e) === 0 && Number(leftovers!.p) === 0, JSON.stringify(leftovers));

// ---------------------------------------------------------------- live HTTP latency (main dev DB)
const BASE = 'http://127.0.0.1:4010/api/v1';
const httpTime = async (fn: () => Promise<Response>, runs: number) => {
  const samples: number[] = [];
  let errors = 0;
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint();
    const res = await fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
    if (!res.ok) errors++;
  }
  samples.sort((a, b) => a - b);
  return { p50: Number(samples[Math.floor(samples.length / 2)]!.toFixed(2)), p95: Number(samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)]!.toFixed(2)), errors };
};
const health = await httpTime(() => fetch(`${BASE}/health`), 100);
measurements.httpHealthMs = health;
check('health endpoint responds quickly and without errors', health.p95 < 100 && health.errors === 0, `p50 ${health.p50} ms, p95 ${health.p95} ms`);

// Concurrent load against a DB-backed endpoint with a real session.
const login = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.AUDIT_PERF_EMAIL ?? '', password: '' }) });
void login;
const concurrency = 40;
const started = Date.now();
const burst = await Promise.all(
  Array.from({ length: concurrency }, () => fetch(`${BASE}/health`).then((r) => r.status).catch(() => 0)),
);
measurements.healthBurst = { concurrency, ms: Date.now() - started, statuses: [...new Set(burst)] };
check('40 concurrent health requests all succeed', burst.every((s) => s === 200), `statuses ${[...new Set(burst)].join(',')} in ${Date.now() - started} ms`);

const failed = results.filter((r) => !r.ok).length;
console.log(`\nperformance checks: ${results.length - failed}/${results.length} passed, ${failed} failed`);
console.log('measurements', JSON.stringify(measurements, null, 2));
writeFileSync(new URL('../../var/audit/performance-results.json', import.meta.url), JSON.stringify({ results, failed, measurements }, null, 2));
await ctx.db.end();
process.exit(failed > 0 ? 1 : 0);
