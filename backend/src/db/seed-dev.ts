import { randomBytes } from 'node:crypto';
import { createAppContext } from '../bootstrap.js';
import { loadConfig } from '../config/env.js';
import { exec, one } from './pool.js';
import { claimNext } from '../modules/jobs/jobs.repository.js';
import { hashPassword } from '../modules/auth/password.js';
import { createMailbox } from '../modules/mailboxes/mailboxes.service.js';
import { runJob } from '../modules/mail-server/provisioning.service.js';
import { enqueue } from '../modules/jobs/jobs.repository.js';
import { newId } from '../shared/ids.js';

/**
 * DEVELOPMENT ONLY. Creates clearly-labelled demo data (is_demo = 1): a demo user, workspace, a domain that is
 * marked verified WITHOUT real DNS proof, and two mailboxes on the simulated mail engine. Refuses to run in production.
 */
const config = loadConfig();
if (config.isProduction) {
  console.error('Refusing to seed demo data in production.');
  process.exit(1);
}
const ctx = createAppContext({ info: () => undefined, warn: console.warn, error: console.error, debug: () => undefined }, config);
const DOMAIN = 'demo-company.example';
const EMAIL = 'demo@arthvex.example';
try {
  if (await one(ctx.db, 'SELECT id FROM users WHERE login_email = ?', [EMAIL])) {
    console.log('Demo data already exists.');
    process.exit(0);
  }
  const password = randomBytes(12).toString('base64url');
  const userId = newId();
  const tenantId = newId();
  const domainId = newId();
  const plan = (await one<{ id: string }>(ctx.db, "SELECT id FROM plans WHERE code = 'free_pilot'"))!;
  await exec(ctx.db, "INSERT INTO users (id, login_email, display_name, password_hash, status, email_verified_at, is_demo) VALUES (?, ?, 'Demo User (demo data)', ?, 'active', NOW(3), 1)", [userId, EMAIL, await hashPassword(password, config.ARGON2_MEMORY_KIB)]);
  await exec(ctx.db, 'INSERT INTO notification_preferences (user_id) VALUES (?)', [userId]);
  await exec(ctx.db, "INSERT INTO tenants (id, name, slug, plan_id, created_by, is_demo) VALUES (?, 'DEMO workspace (demo data)', ?, ?, ?, 1)", [tenantId, `demo-${tenantId.slice(-6).toLowerCase()}`, plan.id, userId]);
  await exec(ctx.db, "INSERT INTO subscriptions (id, tenant_id, plan_id) VALUES (?, ?, ?)", [newId(), tenantId, plan.id]);
  await exec(ctx.db, "INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status) VALUES (?, ?, ?, 'owner', 'active')", [newId(), tenantId, userId]);
  await exec(ctx.db, "INSERT INTO domains (id, tenant_id, name, unicode_name, claim_name, status, ownership_status, verified_at, created_by, is_demo) VALUES (?, ?, ?, ?, ?, 'verified', 'verified', NOW(3), ?, 1)", [domainId, tenantId, DOMAIN, DOMAIN, DOMAIN, userId]);
  await enqueue(ctx.db, { tenantId, operation: 'domain.provision', targetType: 'domain', targetId: domainId, idempotencyKey: `domain.provision:${domainId}` });
  const drain = async () => { for (let job = await claimNext(ctx.db, 'seed', 60); job; job = await claimNext(ctx.db, 'seed', 60)) await runJob(ctx, job); };
  await drain();
  const meta = { ip: '127.0.0.1', userAgent: 'seed', correlationId: 'seed' };
  for (const lp of ['demo', 'info']) {
    const mb = await createMailbox(ctx, tenantId, domainId, userId, { localPart: lp, displayName: `Demo ${lp} (demo data)` }, meta);
    await exec(ctx.db, 'UPDATE mailboxes SET is_demo = 1 WHERE id = ?', [mb.id]);
  }
  await drain();
  console.log(`Demo data created (simulated mail engine: ${ctx.mail.kind}).\n  Sign in: ${EMAIL}\n  Password: ${password}\n  Domain "${DOMAIN}" is marked verified without DNS proof — demo only.`);
} finally {
  await ctx.db.end();
}
