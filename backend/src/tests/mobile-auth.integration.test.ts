import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec } from '../db/pool.js';
import { createAdmin, dbAvailable, login, PASSWORD, startHarness, type Harness } from './harness.js';

const suite = (await dbAvailable()) ? describe : describe.skip;

suite('native client bearer auth (integration)', () => {
  let h: Harness;
  let email: string;
  beforeAll(async () => {
    h = await startHarness();
    await exec(h.ctx.db, 'DELETE FROM platform_admins');
    email = (await createAdmin(h, 'super_admin', 'mobile')).email;
  });
  afterAll(async () => h?.close());

  const mobileLogin = () => h.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-client': 'mobile' }, payload: { email, password: PASSWORD } });

  it('returns a token (and no cookie) for X-Client: mobile', async () => {
    const res = await mobileLogin();
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().token).toBe('string');
    expect(res.cookies).toHaveLength(0);
  });

  it('accepts the token as a Bearer credential, with no CSRF header on writes', async () => {
    const token = (await mobileLogin()).json().token as string;
    const me = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    const out = await h.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { authorization: `Bearer ${token}` } });
    expect(out.statusCode).toBe(200);
    const after = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } });
    expect(after.statusCode).toBe(401);
  });

  it('rejects a bogus bearer token', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: 'Bearer nope' } });
    expect(res.statusCode).toBe(401);
  });

  it('still enforces CSRF for cookie sessions', async () => {
    const s = await login(h, email);
    const res = await h.app.inject({ method: 'PATCH', url: '/api/v1/me', headers: { cookie: s.cookie }, payload: { displayName: 'x' } });
    expect(res.statusCode).toBe(403);
  });
});
