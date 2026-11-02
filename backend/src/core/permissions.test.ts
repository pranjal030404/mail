import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderEmail } from '../modules/notifications/email-templates.js';
import { backoffSeconds, safeError } from '../modules/notifications/outbox.service.js';
import { ALL_PERMISSION_IDS, customRoleKey, escalation, isKnownPermission, PRIVILEGE_MANAGEMENT, SYSTEM_ROLES } from './permissions.js';

describe('permission catalog', () => {
  it('has unique, well-formed identifiers', () => {
    expect(new Set(ALL_PERMISSION_IDS).size).toBe(ALL_PERMISSION_IDS.length);
    for (const id of ALL_PERMISSION_IDS) expect(id).toMatch(/^[a-z_]+\.[a-z_.]+$/);
    expect(isKnownPermission('users.create')).toBe(true);
    expect(isKnownPermission('users.everything')).toBe(false);
  });

  it('only references catalog permissions in built-in roles', () => {
    for (const r of SYSTEM_ROLES) for (const p of r.permissions) expect(isKnownPermission(p), `${r.key}:${p}`).toBe(true);
  });

  it('keeps least privilege: only Super Administrator manages roles, admins, plans and settings', () => {
    for (const r of SYSTEM_ROLES.filter((x) => x.key !== 'super_admin')) {
      for (const p of [...PRIVILEGE_MANAGEMENT, 'settings.update', 'plans.update', 'mailbox_access.approve', 'users.delete', 'mailboxes.credentials.reset']) expect(r.permissions, `${r.key} must not hold ${p}`).not.toContain(p);
    }
    expect(SYSTEM_ROLES.find((r) => r.key === 'super_admin')!.permissions).toHaveLength(ALL_PERMISSION_IDS.length);
  });

  it('gives Support no mailbox credential or access powers', () => {
    const support = SYSTEM_ROLES.find((r) => r.key === 'support')!.permissions;
    expect(support.filter((p) => p.startsWith('mailbox_access') || p.includes('credentials') || p === 'mailboxes.create')).toEqual([]);
  });

  it('computes escalation as the set a grantor lacks', () => {
    expect(escalation(new Set(['a.b', 'c.d']), ['a.b', 'x.y'])).toEqual(['x.y']);
    expect(escalation(new Set(['a.b']), [])).toEqual([]);
  });

  it('derives safe custom role keys that cannot shadow built-ins', () => {
    expect(customRoleKey('Super Admin')).toBe('custom_super_admin');
    expect(customRoleKey('  Read-only Auditor!! ')).toBe('read_only_auditor');
  });

  it('is mirrored by the SQL migration seed', () => {
    const sql = readFileSync(new URL('../../migrations/005_rbac_and_invitations.up.sql', import.meta.url), 'utf8');
    for (const id of ALL_PERMISSION_IDS) expect(sql, id).toContain(`'${id}'`);
  });
});

describe('email templates', () => {
  it('escapes interpolated values and never needs a password', () => {
    const m = renderEmail('account_invitation', { name: '<script>alert(1)</script>', loginEmail: 'a@b.test', actionUrl: 'https://x.test/activate#token=abc', expiresAt: '2030-01-01T00:00:00Z', workspaceName: 'A & B "Co"' });
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).toContain('A &amp; B &quot;Co&quot;');
    expect(m.text).toContain('https://x.test/activate#token=abc');
    expect(`${m.html}${m.text}`.toLowerCase()).not.toMatch(/your password is|temporary password/);
    expect(m.html).toContain('lang="en"');
    expect(m.html).toContain('viewport');
  });

  it('renders every template kind', () => {
    for (const k of ['account_invitation', 'account_activated', 'password_reset_admin', 'mailbox_created', 'mailbox_instructions', 'account_suspended', 'account_reactivated', 'security_notice', 'config_test'] as const) {
      const m = renderEmail(k, { name: 'N', loginEmail: 'a@b.test', actionUrl: 'https://x.test', mailboxAddress: 'm@b.test' });
      expect(m.subject.length).toBeGreaterThan(3);
      expect(m.text.length).toBeGreaterThan(10);
    }
  });
});

describe('outbox helpers', () => {
  it('backs off exponentially with a cap', () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffSeconds)).toEqual([60, 240, 960, 3840, 7200, 7200]);
  });
  it('redacts credential-like text from provider errors', () => {
    expect(safeError(new Error('535 auth failed for password=hunter2'))).not.toContain('hunter2');
  });
});
