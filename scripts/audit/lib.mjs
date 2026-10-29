// Audit harness for ARTHVEX Mail. Drives the real HTTP API and the real development database.
// Not part of the application runtime; used by scripts/audit/*.mjs to produce evidence.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';

export const ROOT = new URL('../../', import.meta.url).pathname;
export const BACKEND = join(ROOT, 'backend');
export const BASE = process.env.AUDIT_BASE ?? 'http://127.0.0.1:4010/api/v1';
export const OUTBOX = join(BACKEND, 'var/dev-outbox');

export function loadEnv() {
  const text = readFileSync(join(BACKEND, '.env'), 'utf8');
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('=') || line.trim().startsWith('#')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return env;
}

let pool;
export function db() {
  if (!pool) {
    const env = loadEnv();
    pool = mysql.createPool({
      host: env.DB_HOST,
      port: Number(env.DB_PORT),
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      connectionLimit: 8,
      waitForConnections: true,
      // Match the application, which forces every session to UTC. Without this, DATETIME defaults
      // written by the audit harness are offset from the application's clock.
      timezone: 'Z',
    });
    pool.on('connection', (conn) => {
      conn.query("SET time_zone = '+00:00'");
    });
  }
  return pool;
}
export async function sql(query, params = []) {
  const [rows] = await db().query(query, params);
  return rows;
}
export async function closeDb() {
  if (pool) await pool.end();
  pool = undefined;
}

export function jar() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    absorb(res) {
      const set = res.headers.getSetCookie?.() ?? [];
      for (const c of set) {
        const [pair] = c.split(';');
        if (pair.startsWith('arthvex_sid=') || pair.startsWith('__Host-arthvex_sid=')) cookie = pair;
      }
    },
    set(v) {
      cookie = v;
    },
  };
}

export async function api(path, { method = 'GET', body, auth, headers = {}, base = BASE } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  const cookie = auth?.cookie ?? auth?.jar?.cookie;
  if (cookie) h.cookie = cookie;
  if (auth?.csrf) h['x-csrf-token'] = auth.csrf;
  const res = await fetch(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  if (auth?.jar) auth.jar.absorb(res);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, headers: res.headers };
}

export function rand(n = 8) {
  return Math.random().toString(36).slice(2, 2 + n);
}

export const PASSWORDS = 'Audit-Passw0rd!2026';

async function waitForOutboxToken(email, category, timeoutMs = 4000) {
  const needle = `To: ${email}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = readdirSync(OUTBOX).filter((f) => f.endsWith('.eml')).sort().reverse();
    for (const f of files) {
      const text = readFileSync(join(OUTBOX, f), 'utf8');
      if (!text.includes(needle)) continue;
      if (!f.includes(category)) continue;
      const m = /#(?:token|invite)=([A-Za-z0-9_-]+)/.exec(text);
      if (m) {
        return m[1];
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`no ${category} outbox message for ${email}`);
}

/** Registers, verifies and logs in a customer. Returns the session plus identity. */
export async function newUser(prefix = 'audit') {
  const email = `${prefix}.${rand()}@audit.example`;
  const jarRef = jar();
  const r = await api('/auth/register', { method: 'POST', body: { email, password: PASSWORDS, displayName: `Audit ${prefix}`, acceptTerms: true } });
  if (r.status !== 202) throw new Error(`register ${email}: ${r.status} ${JSON.stringify(r.json)}`);
  const token = await waitForOutboxToken(email, 'verify_email');
  const v = await api('/auth/verify-email', { method: 'POST', body: { token } });
  if (v.status !== 200) throw new Error(`verify ${email}: ${v.status} ${JSON.stringify(v.json)}`);
  const login = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORDS }, auth: { jar: jarRef } });
  if (login.status !== 200) throw new Error(`login ${email}: ${login.status} ${JSON.stringify(login.json)}`);
  const me = await api('/me', { auth: { jar: jarRef } });
  const user = { id: me.json.user.id, email, password: PASSWORDS };
  return { ...user, auth: { cookie: jarRef.cookie, csrf: login.json.csrfToken, jar: jarRef } };
}

export async function login(email, password = PASSWORDS) {
  const jarRef = jar();
  const r = await api('/auth/login', { method: 'POST', body: { email, password }, auth: { jar: jarRef } });
  if (r.status !== 200) throw new Error(`admin login ${email}: ${r.status} ${JSON.stringify(r.json)}`);
  return { cookie: jarRef.cookie, csrf: r.json.csrfToken, jar: jarRef, mfaRequired: r.json.mfaRequired };
}

export async function newAdmin(role = 'super_admin') {
  const email = `admin.${role}.${rand()}@audit.example`;
  const { execFileSync } = await import('node:child_process');
  execFileSync('npx', ['tsx', '--env-file-if-exists=.env', 'src/scripts/create-admin.ts', email, `Audit ${role}`, role], {
    cwd: BACKEND,
    env: { ...process.env, ADMIN_PASSWORD: PASSWORDS },
    stdio: 'pipe',
  });
  const auth = await login(email);
  const me = await api('/me', { auth });
  return { id: me.json.user.id, email, auth, role, kind: 'platform_admin' };
}

export async function newWorkspace(user, name = 'Audit Workspace') {
  const r = await api('/tenants', { method: 'POST', body: { name }, auth: user.auth });
  if (r.status !== 201) throw new Error(`create workspace: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

/** Adds a domain and marks ownership verified out-of-band (no DNS control in this environment). */
export async function newVerifiedDomain(user, tenantId) {
  const name = `audit-${rand(10)}.example`;
  const r = await api(`/tenants/${tenantId}/domains`, { method: 'POST', body: { name }, auth: user.auth });
  if (r.status !== 201) throw new Error(`add domain: ${r.status} ${JSON.stringify(r.json)}`);
  const id = r.json.id;
  await sql("UPDATE domains SET ownership_status='verified', status='verified', verified_at=NOW(3) WHERE id = ?", [id]);
  await sql(
    "INSERT INTO provisioning_jobs (id, tenant_id, operation, target_type, target_id, idempotency_key, payload, max_attempts) VALUES (?, ?, 'domain.provision', 'domain', ?, ?, NULL, 6)",
    [newId(), tenantId, id, `domain.provision:${id}:audit`],
  );
  for (let i = 0; i < 100; i++) {
    const [d] = await sql('SELECT provisioning_status, mail_engine_domain_id FROM domains WHERE id = ?', [id]);
    if (d.provisioning_status === 'ready' && d.mail_engine_domain_id) return { id, name };
    await new Promise((r) => setTimeout(r, 200));
  }
  const [d] = await sql('SELECT * FROM domains WHERE id = ?', [id]);
  throw new Error(`domain provisioning did not complete: ${JSON.stringify(d)}`);
}

export async function newMailbox(user, tenantId, domainId, localPart, quotaBytes) {
  const r = await api(`/tenants/${tenantId}/domains/${domainId}/mailboxes`, {
    method: 'POST',
    body: { localPart, displayName: `Audit ${localPart}`, ...(quotaBytes ? { quotaBytes } : {}) },
    auth: user.auth,
  });
  if (r.status !== 202) throw new Error(`create mailbox: ${r.status} ${JSON.stringify(r.json)}`);
  const id = r.json.id;
  for (let i = 0; i < 150; i++) {
    const [m] = await sql('SELECT id, normalized_address, status, mail_engine_account_id FROM mailboxes WHERE id = ?', [id]);
    if (m.status === 'active' && m.mail_engine_account_id) return m;
    if (m.status === 'provisioning_failed') throw new Error(`mailbox provisioning failed: ${JSON.stringify(m)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('mailbox did not become active');
}

export function newId() {
  // 26 lowercase base36 characters, matching the application's ids.
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 26; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

export const results = [];
export function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

export function summary(label) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${label}: ${results.length - failed.length}/${results.length} passed, ${failed.length} failed`);
  for (const f of failed) console.log(`  FAILED: ${f.name} ${f.detail}`);
  return failed.length;
}
