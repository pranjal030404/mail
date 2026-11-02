import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadConfig } from '../config/env.js';
import { createSecretBox, type AppContext } from '../context.js';
import { createPool, exec } from '../db/pool.js';
import { migrateUp } from '../db/migrate.js';
import { hashPassword } from '../modules/auth/password.js';
import { claimNext } from '../modules/jobs/jobs.repository.js';
import { DevMailServerAdapter } from '../modules/mail-server/dev.adapter.js';
import { runJob } from '../modules/mail-server/provisioning.service.js';
import { MemoryMailer } from '../modules/notifications/mailer.js';
import { syncPermissionCatalog } from '../modules/rbac/rbac.service.js';
import { createWebmailAdapter } from '../modules/webmail/factory.js';
import { newId } from '../shared/ids.js';

/**
 * Integration harness: the real Fastify app, real routes and a real MariaDB/MySQL schema, with a
 * capturing mailer and the development mail engine. It only ever touches a database whose name ends
 * in `_test`. Suites are skipped (not failed) when no such database is reachable.
 */
const TEST_DB = 'arthvex_email_test';

function readDotEnv(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]!] = m[2]!.replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

export async function dbAvailable(): Promise<boolean> {
  const env = { ...readDotEnv(), ...process.env };
  if (!env.DB_USER) return false;
  try {
    const c = await mysql.createConnection({ host: env.DB_HOST ?? '127.0.0.1', port: Number(env.DB_PORT ?? 3306), user: env.DB_USER, password: env.DB_PASSWORD ?? '', database: TEST_DB });
    await c.end();
    return true;
  } catch {
    return false;
  }
}

export interface Harness {
  ctx: AppContext;
  app: FastifyInstance;
  mailer: MemoryMailer;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const env = { ...readDotEnv(), ...process.env };
  Object.assign(process.env, env, { NODE_ENV: 'test', DB_NAME: TEST_DB, ADMIN_MFA_REQUIRED: 'false', RATE_LIMIT_ENABLED: 'false', COOKIE_SECURE: 'false', MAIL_ADAPTER: 'dev', MAILER: 'dev', LOG_LEVEL: 'silent', INVITE_RESEND_COOLDOWN_SECONDS: '60', APP_BASE_URL: 'http://localhost:5173' });
  const config = loadConfig();
  if (!config.DB_NAME.endsWith('_test')) throw new Error('Refusing to run integration tests against a non-test database.');
  await migrateUp(config, () => undefined);
  const db = createPool(config);
  const dir = mkdtempSync(join(tmpdir(), 'arthvex-it-'));
  const mailer = new MemoryMailer();
  const ctx: AppContext = {
    config,
    db,
    mail: new DevMailServerAdapter({ statePath: join(dir, 'engine.json'), mailHostname: 'mail.test' }),
    webmail: createWebmailAdapter({ ...config, WEBMAIL_ENABLED: false } as typeof config),
    mailer,
    dnsResolver: { resolveTxt: async () => [], resolveMx: async () => [], resolve4: async () => [], resolve6: async () => [], reverse: async () => [] },
    secrets: createSecretBox(config),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
  };
  await syncPermissionCatalog(db);
  const app = await buildApp(ctx);
  await app.ready();
  return { ctx, app, mailer, close: async () => { await app.close(); await db.end(); } };
}

export const PASSWORD = 'correct-horse-battery-9';

export async function createAdmin(h: Harness, roleKey: string, label: string): Promise<{ id: string; email: string }> {
  const id = newId();
  const email = `${label}-${id.slice(-6).toLowerCase()}@admin.test`;
  const legacy = ['super_admin', 'operations', 'support'].includes(roleKey) ? roleKey : 'custom';
  await exec(h.ctx.db, "INSERT INTO platform_admins (id, login_email, display_name, password_hash, role, role_id, status) VALUES (?, ?, ?, ?, ?, (SELECT id FROM rbac_roles WHERE role_key = ?), 'active')", [id, email, `Admin ${label}`, await hashPassword(PASSWORD, 4096), legacy, roleKey]);
  return { id, email };
}

export interface Session {
  cookie: string;
  csrf: string;
}

export async function login(h: Harness, email: string, password = PASSWORD): Promise<Session> {
  const res = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.map((c) => `${c.name}=${c.value}`)[0]!;
  return { cookie, csrf: res.json().csrfToken };
}

export async function call(h: Harness, s: Session | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const res = await h.app.inject({ method, url: `/api/v1${url}`, ...(payload !== undefined ? { payload: payload as object } : {}), headers: s ? { cookie: s.cookie, 'x-csrf-token': s.csrf } : {} });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, any>) : {} };
}

/** Runs queued provisioning jobs to completion with the real handlers. */
export async function drainJobs(h: Harness, max = 20): Promise<number> {
  let n = 0;
  for (; n < max; n++) {
    const job = await claimNext(h.ctx.db, 'test-worker', 60);
    if (!job) break;
    await runJob(h.ctx, job);
  }
  return n;
}

export async function createVerifiedDomain(h: Harness, tenantId: string, name: string, verified = true): Promise<string> {
  const id = newId();
  const { engineDomainId } = await h.ctx.mail.ensureDomain(name);
  await exec(h.ctx.db, `INSERT INTO domains (id, tenant_id, name, unicode_name, claim_name, status, ownership_status, provisioning_status, mail_engine_domain_id, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, NOW(3))`, [id, tenantId, name, name, name, verified ? 'verified' : 'pending_verification', verified ? 'verified' : 'pending', engineDomainId]);
  return id;
}

export const uniq = (p: string) => `${p}-${newId().slice(-8).toLowerCase()}`;
export { hashPassword };
