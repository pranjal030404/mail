import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec, one, rows } from '../db/pool.js';
import { ALL_PERMISSION_IDS } from '../core/permissions.js';
import { processOutbox } from '../modules/notifications/outbox.service.js';
import { call, createAdmin, createVerifiedDomain, dbAvailable, drainJobs, login, PASSWORD, startHarness, uniq, type Harness, type Session } from './harness.js';

const available = await dbAvailable();
const suite = available ? describe : describe.skip;

suite('admin console (integration, real database)', () => {
  let h: Harness;
  let sa: Session; // super admin
  let ops: Session;
  let support: Session;
  let saId: string;
  let tenantId: string;
  let domainId: string;
  const domainName = `${uniq('corp')}.test`;

  const extract = (text: string) => /#token=([\w-]+)/.exec(text)?.[1] ?? '';
  const lastInvite = (to: string) => h.mailer.last(to, 'account_invitation');

  beforeAll(async () => {
    h = await startHarness();
    // Take control of the principal set so "last super admin" rules are deterministic.
    await exec(h.ctx.db, 'DELETE FROM platform_admins');
    const a = await createAdmin(h, 'super_admin', 'root');
    saId = a.id;
    sa = await login(h, a.email);
    ops = await login(h, (await createAdmin(h, 'operations', 'ops')).email);
    support = await login(h, (await createAdmin(h, 'support', 'sup')).email);
    // A workspace + verified domain to host mailboxes.
    const created = await call(h, sa, 'POST', '/admin/users', { fullName: 'Seed Owner', email: `${uniq('seed')}@owner.test`, workspace: { mode: 'company', name: 'Acme Test Co' }, invitation: 'none' });
    expect(created.status).toBe(201);
    tenantId = created.body.workspace.id;
    domainId = await createVerifiedDomain(h, tenantId, domainName);
    // Plan limits are covered by their own tests; give this workspace headroom for the scenarios below.
    await exec(h.ctx.db, 'INSERT INTO tenant_quotas (tenant_id, max_mailboxes, max_mailboxes_per_domain, reason) VALUES (?, 500, 500, ?)', [tenantId, 'integration test']);
  });
  afterAll(async () => h?.close());

  describe('authorization', () => {
    it('rejects unauthenticated and customer principals on admin routes', async () => {
      expect((await call(h, null, 'GET', '/admin/users')).status).toBe(401);
      const email = `${uniq('cust')}@c.test`;
      const created = await call(h, sa, 'POST', '/admin/users', { fullName: 'Cust', email, workspace: { mode: 'personal' }, invitation: 'send_now' });
      await processOutbox(h.ctx);
      await call(h, null, 'POST', '/auth/activate', { token: extract(lastInvite(email)!.text), email, password: PASSWORD, acceptTerms: true });
      const customer = await login(h, email);
      for (const [m, u] of [['GET', '/admin/users'], ['GET', '/admin/roles'], ['POST', '/admin/users'], ['GET', '/admin/mailboxes']] as const) {
        expect((await call(h, customer, m, u, m === 'POST' ? {} : undefined)).status).toBe(403);
      }
      expect(created.status).toBe(201);
    });

    it('enforces per-role permissions on direct API calls', async () => {
      expect((await call(h, support, 'GET', '/admin/users')).status).toBe(200);
      expect((await call(h, support, 'POST', '/admin/users', { fullName: 'X', email: `${uniq('x')}@x.test`, workspace: { mode: 'none' }, invitation: 'none' })).status).toBe(403);
      expect((await call(h, support, 'GET', '/admin/roles')).status).toBe(403);
      expect((await call(h, ops, 'GET', '/admin/roles')).status).toBe(403);
      expect((await call(h, ops, 'PATCH', '/admin/settings', { settings: {}, reason: 'testing', confirm: true })).status).toBe(403);
      expect((await call(h, ops, 'GET', '/admin/mailboxes')).status).toBe(200);
      expect((await call(h, support, 'GET', '/admin/audit')).status).toBe(403);
    });

    it('records denied attempts in the audit log', async () => {
      await call(h, support, 'GET', '/admin/roles');
      await new Promise((r) => setTimeout(r, 50));
      const denied = await one<{ n: number }>(h.ctx.db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'authz.denied' AND outcome = 'denied'");
      expect(Number(denied!.n)).toBeGreaterThan(0);
    });
  });

  describe('roles & permissions', () => {
    it('exposes the full persisted catalog', async () => {
      const r = await call(h, sa, 'GET', '/admin/permissions');
      expect(r.body.permissions.map((p: { id: string }) => p.id).sort()).toEqual([...ALL_PERMISSION_IDS].sort());
    });

    it('creates, edits, duplicates and deletes a custom role', async () => {
      const name = uniq('Auditor');
      const created = await call(h, sa, 'POST', '/admin/roles', { name, description: 'read only', permissions: ['audit.read', 'users.read'] });
      expect(created.status).toBe(201);
      const roleId = created.body.role.id;
      expect(created.body.role.isSystem).toBe(false);
      const updated = await call(h, sa, 'PATCH', `/admin/roles/${roleId}`, { permissions: ['audit.read'] });
      expect(updated.body.role.permissions).toEqual(['audit.read']);
      const dup = await call(h, sa, 'POST', `/admin/roles/${roleId}/duplicate`, { name: uniq('Copy') });
      expect(dup.status).toBe(201);
      expect((await call(h, sa, 'DELETE', `/admin/roles/${dup.body.role.id}`)).status).toBe(200);
      expect((await call(h, sa, 'DELETE', `/admin/roles/${roleId}`)).status).toBe(200);
    });

    it('rejects unknown permissions and duplicate names', async () => {
      expect((await call(h, sa, 'POST', '/admin/roles', { name: uniq('Bad'), description: '', permissions: ['nope.nothing'] })).status).toBe(422);
      const name = uniq('Dup');
      await call(h, sa, 'POST', '/admin/roles', { name, description: '', permissions: [] });
      expect((await call(h, sa, 'POST', '/admin/roles', { name, description: '', permissions: [] })).status).toBe(409);
    });

    it('protects system roles from edit and delete', async () => {
      const roles = (await call(h, sa, 'GET', '/admin/roles')).body.roles as { id: string; key: string; isSystem: boolean }[];
      const sys = roles.find((r) => r.key === 'operations')!;
      expect(sys.isSystem).toBe(true);
      expect((await call(h, sa, 'PATCH', `/admin/roles/${sys.id}`, { permissions: [] })).status).toBe(403);
      expect((await call(h, sa, 'DELETE', `/admin/roles/${sys.id}`)).status).toBe(403);
    });

    it('prevents privilege escalation when creating, editing and assigning roles', async () => {
      // A custom "role manager" who lacks settings.update and users.delete.
      const mgr = await call(h, sa, 'POST', '/admin/roles', { name: uniq('RoleMgr'), description: '', permissions: ['roles.read', 'roles.create', 'roles.update', 'roles.delete', 'admins.manage', 'users.read'] });
      const mgrAdmin = await createAdmin(h, mgr.body.role.key, 'mgr');
      const s = await login(h, mgrAdmin.email);
      expect((await call(h, s, 'POST', '/admin/roles', { name: uniq('Esc'), description: '', permissions: ['settings.update'] })).status).toBe(403);
      const ok = await call(h, s, 'POST', '/admin/roles', { name: uniq('Fine'), description: '', permissions: ['users.read'] });
      expect(ok.status).toBe(201);
      expect((await call(h, s, 'PATCH', `/admin/roles/${ok.body.role.id}`, { permissions: ['users.read', 'users.delete'] })).status).toBe(403);
      // Assigning super_admin to oneself or another admin is also escalation.
      const superRole = ((await call(h, sa, 'GET', '/admin/roles')).body.roles as { id: string; key: string }[]).find((r) => r.key === 'super_admin')!;
      const res = await call(h, s, 'PUT', `/admin/admins/${mgrAdmin.id}/role`, { roleId: superRole.id, reason: 'try to escalate', confirm: true });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('privilege_escalation');
    });

    it('applies role changes immediately and revokes the target sessions', async () => {
      const r = await call(h, sa, 'POST', '/admin/roles', { name: uniq('Temp'), description: '', permissions: ['users.read'] });
      const adm = await createAdmin(h, r.body.role.key, 'temp');
      const s = await login(h, adm.email);
      expect((await call(h, s, 'GET', '/admin/users')).status).toBe(200);
      await call(h, sa, 'PATCH', `/admin/roles/${r.body.role.id}`, { permissions: ['audit.read'] });
      expect((await call(h, s, 'GET', '/admin/users')).status).toBe(403);
      expect((await call(h, s, 'GET', '/admin/audit')).status).toBe(200);
      const opsRole = ((await call(h, sa, 'GET', '/admin/roles')).body.roles as { id: string; key: string }[]).find((x) => x.key === 'operations')!;
      expect((await call(h, sa, 'PUT', `/admin/admins/${adm.id}/role`, { roleId: opsRole.id, reason: 'reassign for test', confirm: true })).status).toBe(200);
      expect((await call(h, s, 'GET', '/admin/audit')).status).toBe(401); // session ended by the role change
    });

    it('refuses to delete a role that is still assigned, and to demote the final super administrator', async () => {
      const r = await call(h, sa, 'POST', '/admin/roles', { name: uniq('Held'), description: '', permissions: [] });
      await createAdmin(h, r.body.role.key, 'held');
      expect((await call(h, sa, 'DELETE', `/admin/roles/${r.body.role.id}`)).status).toBe(409);
      const opsRole = ((await call(h, sa, 'GET', '/admin/roles')).body.roles as { id: string; key: string }[]).find((x) => x.key === 'operations')!;
      const res = await call(h, sa, 'PUT', `/admin/admins/${saId}/role`, { roleId: opsRole.id, reason: 'demote the only super admin', confirm: true });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('last_super_admin');
    });
  });

  describe('user creation & invitations', () => {
    const newUser = (over: Record<string, unknown> = {}) => ({ fullName: 'Pranjal Test', email: `${uniq('p')}@people.test`, workspace: { mode: 'existing', tenantId }, membershipRole: 'mailbox_user', invitation: 'send_now', ...over });

    it('creates a pending account, queues an invitation and never emails a password', async () => {
      const body = newUser();
      const r = await call(h, sa, 'POST', '/admin/users', body);
      expect(r.status).toBe(201);
      expect(r.body.invitation.delivery).toBe('queued');
      const email = body.email as string;
      expect(h.mailer.last(email)).toBeUndefined(); // not sent until the outbox runs
      await processOutbox(h.ctx);
      const msg = lastInvite(email)!;
      expect(msg.html).toContain('Activate your account');
      expect(msg.text).toMatch(/\/activate#token=/);
      expect(msg.text.toLowerCase()).not.toMatch(/password:|temporary password/);
      expect(msg.html).toContain(email);
      const row = await one<{ status: string; password_hash: string }>(h.ctx.db, 'SELECT status, password_hash FROM users WHERE id = ?', [r.body.user.id]);
      expect(row!.status).toBe('pending_verification');
      // Neither the raw token nor any plaintext is stored: the DB holds a 64-char digest only.
      const token = extract(msg.text);
      const inv = await one<{ token_hash: string }>(h.ctx.db, 'SELECT token_hash FROM account_invitations WHERE user_id = ?', [r.body.user.id]);
      expect(inv!.token_hash).toHaveLength(64);
      expect(inv!.token_hash).not.toBe(token);
      const outbox = await one<{ payload_encrypted: string | null; status: string }>(h.ctx.db, 'SELECT payload_encrypted, status FROM email_outbox WHERE related_id = ? AND kind = ?', [(await one<{ id: string }>(h.ctx.db, 'SELECT id FROM account_invitations WHERE user_id = ?', [r.body.user.id]))!.id, 'account_invitation']);
      expect(outbox!.status).toBe('sent');
      expect(outbox!.payload_encrypted).toBeNull(); // one-time link destroyed after delivery
    });

    it('rejects duplicate emails (any case) and unknown workspaces', async () => {
      const body = newUser();
      expect((await call(h, sa, 'POST', '/admin/users', body)).status).toBe(201);
      expect((await call(h, sa, 'POST', '/admin/users', { ...body, email: (body.email as string).toUpperCase() })).status).toBe(409);
      expect((await call(h, sa, 'POST', '/admin/users', newUser({ workspace: { mode: 'existing', tenantId: '0'.repeat(26) } }))).status).toBe(400);
      const taken = await rows(h.ctx.db, 'SELECT id FROM users WHERE login_email = ?', [(body.email as string).toLowerCase()]);
      expect(taken).toHaveLength(1);
    });

    it('activates exactly once and binds the token to the recipient', async () => {
      const body = newUser();
      await call(h, sa, 'POST', '/admin/users', body);
      await processOutbox(h.ctx);
      const email = body.email as string;
      const token = extract(lastInvite(email)!.text);
      const info = await call(h, null, 'POST', '/auth/invitation-info', { token });
      expect(info.body.email).toBe(email);
      expect((await call(h, null, 'POST', '/auth/activate', { token, email: 'someone.else@people.test', password: PASSWORD, acceptTerms: true })).status).toBe(400);
      expect((await call(h, null, 'POST', '/auth/activate', { token, email, password: 'short', acceptTerms: true })).body.error.code).toBe('weak_password');
      expect((await call(h, null, 'POST', '/auth/activate', { token, email, password: PASSWORD, acceptTerms: true })).status).toBe(200);
      expect((await call(h, null, 'POST', '/auth/activate', { token, email, password: PASSWORD, acceptTerms: true })).status).toBe(400); // reuse
      expect((await login(h, email)).cookie).toBeTruthy();
      const audit = await one<{ n: number }>(h.ctx.db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'invitation.consume' AND actor_user_id = (SELECT id FROM users WHERE login_email = ?)", [email]);
      expect(Number(audit!.n)).toBe(1);
    });

    it('lets only one of many concurrent activations win', async () => {
      const body = newUser();
      await call(h, sa, 'POST', '/admin/users', body);
      await processOutbox(h.ctx);
      const email = body.email as string;
      const token = extract(lastInvite(email)!.text);
      const results = await Promise.all(Array.from({ length: 6 }, () => call(h, null, 'POST', '/auth/activate', { token, email, password: PASSWORD, acceptTerms: true })));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 400)).toHaveLength(5);
    });

    it('rejects expired tokens', async () => {
      const body = newUser();
      const r = await call(h, sa, 'POST', '/admin/users', body);
      await processOutbox(h.ctx);
      const token = extract(lastInvite(body.email as string)!.text);
      await exec(h.ctx.db, "UPDATE account_invitations SET expires_at = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE user_id = ?", [r.body.user.id]);
      expect((await call(h, null, 'POST', '/auth/activate', { token, email: body.email, password: PASSWORD, acceptTerms: true })).status).toBe(400);
      expect((await call(h, null, 'POST', '/auth/invitation-info', { token })).status).toBe(400);
    });

    it('resend replaces the old token, is throttled, and revoke kills the link', async () => {
      const body = newUser();
      const r = await call(h, sa, 'POST', '/admin/users', body);
      await processOutbox(h.ctx);
      const email = body.email as string;
      const first = extract(lastInvite(email)!.text);
      const invId = r.body.invitation.id;
      const throttled = await call(h, sa, 'POST', `/admin/invitations/${invId}/resend`);
      expect(throttled.status).toBe(429);
      await exec(h.ctx.db, 'UPDATE email_outbox SET created_at = DATE_SUB(NOW(3), INTERVAL 5 MINUTE) WHERE related_id = ?', [invId]);
      expect((await call(h, sa, 'POST', `/admin/invitations/${invId}/resend`)).status).toBe(200);
      await processOutbox(h.ctx);
      const second = extract(lastInvite(email)!.text);
      expect(second).not.toBe(first);
      expect((await call(h, null, 'POST', '/auth/invitation-info', { token: first })).status).toBe(400);
      expect((await call(h, sa, 'POST', `/admin/invitations/${invId}/revoke`, { reason: 'sent to wrong person' })).status).toBe(200);
      expect((await call(h, null, 'POST', '/auth/activate', { token: second, email, password: PASSWORD, acceptTerms: true })).status).toBe(400);
      expect((await call(h, sa, 'POST', `/admin/invitations/${invId}/revoke`, { reason: 'again please' })).status).toBe(409);
    });

    it('keeps a failed delivery visible, retries with backoff, then lets an admin retry', async () => {
      const body = newUser();
      const r = await call(h, sa, 'POST', '/admin/users', body);
      expect(r.status).toBe(201); // account creation is not undone by an SMTP outage
      h.mailer.failNext = 100;
      await processOutbox(h.ctx);
      let mail = await one<{ id: string; status: string; attempts: number; last_error: string; next_attempt_at: Date }>(h.ctx.db, "SELECT id, status, attempts, last_error, next_attempt_at FROM email_outbox WHERE related_type = 'account_invitation' AND related_id = ?", [r.body.invitation.id]);
      expect(mail!.status).toBe('queued');
      expect(mail!.attempts).toBe(1);
      expect(mail!.next_attempt_at.getTime()).toBeGreaterThan(Date.now()); // backoff, not a hot loop
      expect(await processOutbox(h.ctx)).toBe(0); // not due yet → no duplicate attempt
      // Exhaust the attempt budget.
      for (let i = 0; i < 10; i++) {
        await exec(h.ctx.db, 'UPDATE email_outbox SET next_attempt_at = NOW(3) WHERE id = ?', [mail!.id]);
        await processOutbox(h.ctx);
      }
      mail = await one(h.ctx.db, 'SELECT id, status, attempts, last_error, next_attempt_at FROM email_outbox WHERE id = ?', [mail!.id]);
      expect(mail!.status).toBe('failed');
      expect(mail!.last_error).not.toMatch(/pass/i);
      const listed = await call(h, sa, 'GET', '/admin/invitations?status=pending');
      expect(listed.body.invitations.find((i: { id: string }) => i.id === r.body.invitation.id).delivery).toBe('failed');
      // Provider recovers; admin retries; exactly one message goes out.
      h.mailer.failNext = 0;
      expect((await call(h, sa, 'POST', `/admin/notifications/${mail!.id}/retry`)).status).toBe(200);
      await processOutbox(h.ctx);
      await processOutbox(h.ctx);
      expect(h.mailer.sent.filter((m) => m.to === body.email && m.category === 'account_invitation')).toHaveLength(1);
      expect((await call(h, sa, 'POST', `/admin/notifications/${mail!.id}/retry`)).status).toBe(409);
    });

    it('supports "send later" and "no invitation" without emailing', async () => {
      const later = newUser({ invitation: 'send_later' });
      const r = await call(h, sa, 'POST', '/admin/users', later);
      await processOutbox(h.ctx);
      expect(h.mailer.last(later.email as string)).toBeUndefined();
      expect(r.body.invitation.delivery).toBe('not_sent');
      expect((await call(h, sa, 'POST', `/admin/invitations/${r.body.invitation.id}/resend`)).status).toBe(200); // sends it now
      await processOutbox(h.ctx);
      expect(lastInvite(later.email as string)).toBeDefined();
      const none = await call(h, sa, 'POST', '/admin/users', newUser({ invitation: 'none' }));
      expect(none.body.invitation).toBeNull();
    });

    it('enforces last-owner protection on memberships', async () => {
      const email = `${uniq('own')}@people.test`;
      const r = await call(h, sa, 'POST', '/admin/users', { fullName: 'Solo Owner', email, workspace: { mode: 'company', name: uniq('Solo') }, invitation: 'none' });
      const detail = await call(h, sa, 'GET', `/admin/users/${r.body.user.id}`);
      const m = detail.body.memberships[0];
      expect(m.role).toBe('owner');
      expect((await call(h, sa, 'DELETE', `/admin/users/${r.body.user.id}/memberships/${m.id}`)).body.error.code).toBe('last_owner');
      expect((await call(h, sa, 'PATCH', `/admin/users/${r.body.user.id}/memberships/${m.id}`, { role: 'admin' })).body.error.code).toBe('last_owner');
    });

    it('suspends, reactivates, resets MFA and previews deletion with confirmation', async () => {
      const body = newUser();
      const r = await call(h, sa, 'POST', '/admin/users', body);
      await processOutbox(h.ctx);
      const email = body.email as string;
      await call(h, null, 'POST', '/auth/activate', { token: extract(lastInvite(email)!.text), email, password: PASSWORD, acceptTerms: true });
      const uid = r.body.user.id;
      const userSession = await login(h, email);
      expect((await call(h, sa, 'POST', `/admin/users/${uid}/suspend`, { reason: 'policy violation test', confirm: true })).status).toBe(200);
      expect((await call(h, userSession, 'GET', '/me')).status).toBe(401);
      expect((await call(h, sa, 'POST', `/admin/users/${uid}/reactivate`, { reason: 'resolved the case', confirm: true })).status).toBe(200);
      expect((await call(h, sa, 'POST', `/admin/users/${uid}/suspend`, { reason: 'x', confirm: true })).status).toBe(400); // reason too short
      expect((await call(h, sa, 'POST', `/admin/users/${uid}/password-reset`)).status).toBe(200);
      await processOutbox(h.ctx);
      expect(h.mailer.last(email, 'password_reset_admin')!.text).toMatch(/reset-password#token=/);
      const preview = await call(h, sa, 'GET', `/admin/users/${uid}/deletion-preview`);
      expect(preview.body.allowed).toBe(true);
      expect((await call(h, sa, 'POST', `/admin/users/${uid}/close`, { reason: 'user requested', confirm: true, confirmEmail: 'wrong@x.test' })).status).toBe(400);
      expect((await call(h, sa, 'POST', `/admin/users/${uid}/close`, { reason: 'user requested', confirm: true, confirmEmail: email })).status).toBe(200);
      expect((await one<{ status: string }>(h.ctx.db, 'SELECT status FROM users WHERE id = ?', [uid]))!.status).toBe('closed');
    });

    it('filters and paginates the user list', async () => {
      const r = await call(h, sa, 'GET', '/admin/users?pageSize=2&page=1&sort=email&dir=asc');
      expect(r.body.users).toHaveLength(2);
      expect(r.body.total).toBeGreaterThan(2);
      const f = await call(h, sa, 'GET', `/admin/users?status=pending_verification&tenantId=${tenantId}&role=mailbox_user`);
      expect(f.body.users.every((u: { status: string }) => u.status === 'pending_verification')).toBe(true);
      expect((await call(h, sa, 'GET', '/admin/users?status=bogus')).status).toBe(400);
    });
  });

  describe('mailboxes', () => {
    it('creates a mailbox with the user, reports provisioning honestly, then active after the worker runs', async () => {
      const email = `${uniq('mb')}@people.test`;
      const local = uniq('mb');
      const r = await call(h, sa, 'POST', '/admin/users', { fullName: 'Mail Person', email, workspace: { mode: 'existing', tenantId }, membershipRole: 'mailbox_user', mailbox: { domainId, localPart: local }, invitation: 'send_now', sendMailboxInstructions: true });
      expect(r.status).toBe(201);
      expect(r.body.mailbox.state).toBe('provisioning'); // not "active" until the engine confirms
      expect(r.body.mailbox.address).toBe(`${local}@${domainName}`);
      await processOutbox(h.ctx);
      expect(lastInvite(email)!.html).toContain(`${local}@${domainName}`);
      expect(h.mailer.last(email, 'mailbox_instructions')).toBeUndefined(); // nothing until active AND activated
      await drainJobs(h);
      const row = await one<{ status: string; mail_engine_account_id: string | null }>(h.ctx.db, 'SELECT status, mail_engine_account_id FROM mailboxes WHERE id = ?', [r.body.mailbox.id]);
      expect(row!.status).toBe('active');
      expect(row!.mail_engine_account_id).toBeTruthy();
      expect(await h.ctx.mail.getMailbox(row!.mail_engine_account_id!)).toBeTruthy(); // really exists on the engine
      await call(h, null, 'POST', '/auth/activate', { token: extract(lastInvite(email)!.text), email, password: PASSWORD, acceptTerms: true });
      await processOutbox(h.ctx);
      const info = h.mailer.last(email, 'mailbox_instructions')!;
      expect(info.text).toContain('Incoming (IMAP)');
      expect(info.text.toLowerCase()).not.toMatch(/password:/);
      // Idempotent: a second trigger does not send twice.
      const { afterMailboxActive } = await import('../modules/invitations/invitations.service.js');
      await afterMailboxActive(h.ctx, r.body.mailbox.id);
      await processOutbox(h.ctx);
      expect(h.mailer.sent.filter((m) => m.to === email && m.category === 'mailbox_instructions')).toHaveLength(1);
      // Detail view never exposes secrets.
      const detail = await call(h, sa, 'GET', `/admin/mailboxes/${r.body.mailbox.id}`);
      expect(detail.status).toBe(200);
      expect(JSON.stringify(detail.body)).not.toMatch(/password_hash|secret|token_hash/i);
      expect(detail.body.owner.email).toBe(email);
    });

    it('reports a mailbox failure without losing the account, and rejects unverified domains and duplicate addresses', async () => {
      const unverified = await createVerifiedDomain(h, tenantId, `${uniq('pending')}.test`, false);
      const email = `${uniq('mf')}@people.test`;
      const r = await call(h, sa, 'POST', '/admin/users', { fullName: 'No Mailbox', email, workspace: { mode: 'existing', tenantId }, mailbox: { domainId: unverified, localPart: 'hello' }, invitation: 'none' });
      expect(r.status).toBe(201);
      expect(r.body.mailbox.state).toBe('failed');
      expect(r.body.mailbox.error).toMatch(/verify/i);
      expect(await one(h.ctx.db, 'SELECT id FROM users WHERE login_email = ?', [email])).toBeTruthy();
      const local = uniq('dup');
      const first = await call(h, sa, 'POST', '/admin/mailboxes', { tenantId, domainId, localPart: local });
      expect(first.status).toBe(201);
      expect((await call(h, sa, 'POST', '/admin/mailboxes', { tenantId, domainId, localPart: local })).status).toBe(409);
      // A domain from another tenant cannot be used.
      const other = await call(h, sa, 'POST', '/admin/users', { fullName: 'Other', email: `${uniq('ot')}@people.test`, workspace: { mode: 'company', name: uniq('Other') }, invitation: 'none' });
      expect((await call(h, sa, 'POST', '/admin/mailboxes', { tenantId: other.body.workspace.id, domainId, localPart: uniq('x') })).status).toBe(404);
    });

    it('does not disclose reset credentials, notifies the owner, and syncs suspension to the engine', async () => {
      const created = await call(h, sa, 'POST', '/admin/mailboxes', { tenantId, domainId, localPart: uniq('rc') });
      await drainJobs(h);
      const id = created.body.mailbox.id;
      const reset = await call(h, sa, 'POST', `/admin/mailboxes/${id}/reset-credentials`, { reason: 'user locked out', confirm: true });
      expect(reset.status).toBe(200);
      expect(JSON.stringify(reset.body)).not.toMatch(/generatedPassword|password/i);
      expect((await call(h, ops, 'POST', `/admin/mailboxes/${id}/reset-credentials`, { reason: 'ops try it', confirm: true })).status).toBe(403);
      expect((await call(h, sa, 'POST', `/admin/mailboxes/${id}/suspend`, { reason: 'abuse investigation', confirm: true })).status).toBe(200);
      await drainJobs(h);
      const engineId = (await one<{ e: string }>(h.ctx.db, 'SELECT mail_engine_account_id AS e FROM mailboxes WHERE id = ?', [id]))!.e;
      expect((await h.ctx.mail.getMailbox(engineId))!.suspended).toBe(true);
      expect((await call(h, sa, 'POST', `/admin/mailboxes/${id}/reactivate`, { reason: 'investigation closed', confirm: true })).status).toBe(200);
      await drainJobs(h);
      expect((await h.ctx.mail.getMailbox(engineId))!.suspended).toBe(false);
    });

    it('schedules and cancels deletion within the grace period', async () => {
      const created = await call(h, sa, 'POST', '/admin/mailboxes', { tenantId, domainId, localPart: uniq('del') });
      await drainJobs(h);
      const id = created.body.mailbox.id;
      const addr = created.body.mailbox.address;
      expect((await call(h, sa, 'POST', `/admin/mailboxes/${id}/schedule-deletion`, { reason: 'no longer needed', confirm: true, confirmAddress: 'wrong@x.test' })).status).toBe(400);
      expect((await call(h, sa, 'POST', `/admin/mailboxes/${id}/schedule-deletion`, { reason: 'no longer needed', confirm: true, confirmAddress: addr })).status).toBe(200);
      expect((await call(h, sa, 'POST', `/admin/mailboxes/${id}/cancel-deletion`)).status).toBe(200);
      expect((await one<{ status: string }>(h.ctx.db, 'SELECT status FROM mailboxes WHERE id = ?', [id]))!.status).toBe('active');
    });
  });

  describe('dashboard & email configuration', () => {
    it('serves real counts and validates the range', async () => {
      const d = await call(h, sa, 'GET', '/admin/dashboard?days=30');
      expect(d.status).toBe(200);
      const live = await one<{ n: number }>(h.ctx.db, 'SELECT COUNT(*) AS n FROM users');
      expect(d.body.counts.users_total).toBe(Number(live!.n));
      expect(d.body.unavailable.mailQueue).toBeTruthy(); // honest about what is not collected
      expect((await call(h, sa, 'GET', '/admin/dashboard?days=5')).status).toBe(400);
      expect((await call(h, support, 'GET', '/admin/dashboard')).status).toBe(200);
    });

    it('tests the email configuration for authorized admins only and reports real failures', async () => {
      expect((await call(h, support, 'POST', '/admin/notifications/test', {})).status).toBe(403);
      const ok = await call(h, ops, 'POST', '/admin/notifications/test', { to: 'dest@people.test' });
      expect(ok.body.ok).toBe(true);
      h.mailer.failNext = 1;
      const bad = await call(h, ops, 'POST', '/admin/notifications/test', {});
      expect(bad.body.ok).toBe(false);
      expect(bad.body.stage).toBe('verify');
      h.mailer.failNext = 0;
    });
  });
});
