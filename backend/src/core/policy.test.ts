import { describe, expect, it } from 'vitest';
import { detectAliasLoop } from './aliases.js';
import { checkCanAddAlias, checkCanAddDomain, checkCanAddMailbox, effectiveLimits, highestThresholdReached, MB, usagePercent, type Limits } from './entitlements.js';
import { canTransitionJob, canTransitionMailbox } from './lifecycle.js';
import { passwordProblem } from './password.js';
import { canAssignRole, platformCan, tenantCan } from './roles.js';

const plan: Limits = {
  maxDomains: 1, maxMailboxes: 2, maxMailboxesPerDomain: 2, maxAliases: 5,
  mailboxQuotaDefaultBytes: 100 * MB, mailboxQuotaMaxBytes: 250 * MB, tenantStorageMaxBytes: 500 * MB,
  attachmentMaxBytes: 10 * MB, dailySendLimit: 100, hourlySendLimit: 20,
  allowExternalForwarding: false, allowCatchAll: false, warnThresholds: [75, 90, 100],
};
const none = { domains: 0, mailboxes: 0, aliases: 0, allocatedBytes: 0 };

describe('entitlements', () => {
  it('enforces domain, mailbox, alias and storage limits', () => {
    expect(checkCanAddDomain({ ...none, domains: 1 }, plan)).toMatchObject({ ok: false, code: 'plan_limit_domains' });
    expect(checkCanAddDomain(none, plan).ok).toBe(true);
    expect(checkCanAddMailbox({ ...none, mailboxes: 2 }, 0, 100 * MB, plan)).toMatchObject({ code: 'plan_limit_mailboxes' });
    expect(checkCanAddMailbox({ ...none, mailboxes: 1 }, 2, 100 * MB, plan)).toMatchObject({ code: 'plan_limit_mailboxes_per_domain' });
    expect(checkCanAddMailbox(none, 0, 300 * MB, plan)).toMatchObject({ code: 'plan_limit_mailbox_quota' });
    expect(checkCanAddMailbox({ ...none, allocatedBytes: 400 * MB }, 0, 200 * MB, plan)).toMatchObject({ code: 'plan_limit_tenant_storage' });
    expect(checkCanAddMailbox(none, 0, 0, plan)).toMatchObject({ code: 'invalid_quota' });
    expect(checkCanAddAlias({ ...none, aliases: 5 }, plan).ok).toBe(false);
  });
  it('applies overrides but ignores null (never unlimited)', () => {
    const merged = effectiveLimits(plan, { maxMailboxes: 10, maxDomains: null });
    expect(merged.maxMailboxes).toBe(10);
    expect(merged.maxDomains).toBe(1);
  });
  it('computes usage thresholds', () => {
    expect(usagePercent(50, 100)).toBe(50);
    expect(usagePercent(1, 0)).toBe(100);
    expect(highestThresholdReached(74, 100, [75, 90, 100])).toBeNull();
    expect(highestThresholdReached(75, 100, [75, 90, 100])).toBe(75);
    expect(highestThresholdReached(95, 100, [100, 75, 90])).toBe(90);
    expect(highestThresholdReached(100, 100, [75, 90, 100])).toBe(100);
  });
});

describe('lifecycles', () => {
  it('permits only documented mailbox transitions', () => {
    expect(canTransitionMailbox('draft', 'provisioning')).toBe(true);
    expect(canTransitionMailbox('provisioning', 'active')).toBe(true);
    expect(canTransitionMailbox('draft', 'active')).toBe(false);
    expect(canTransitionMailbox('deleted', 'active')).toBe(false);
    expect(canTransitionMailbox('active', 'deleting')).toBe(false);
  });
  it('permits only documented job transitions', () => {
    expect(canTransitionJob('queued', 'running')).toBe(true);
    expect(canTransitionJob('succeeded', 'running')).toBe(false);
    expect(canTransitionJob('running', 'retrying')).toBe(true);
    expect(canTransitionJob('failed', 'succeeded')).toBe(false);
  });
});

describe('roles', () => {
  it('follows least privilege', () => {
    expect(tenantCan('billing', 'domains.manage')).toBe(false);
    expect(tenantCan('mailbox_user', 'members.manage')).toBe(false);
    expect(tenantCan('admin', 'domains.manage')).toBe(true);
    expect(tenantCan('admin', 'owners.manage')).toBe(false);
    expect(tenantCan(null, 'tenant.read')).toBe(false);
    expect(canAssignRole('admin', 'owner')).toBe(false);
    expect(canAssignRole('owner', 'owner')).toBe(true);
    expect(canAssignRole('mailbox_user', 'billing')).toBe(false);
  });
  it('keeps support staff out of settings and role administration', () => {
    expect(platformCan('operations', 'admin.jobs.manage')).toBe(true);
    expect(platformCan('operations', 'admin.settings.manage')).toBe(false);
    expect(platformCan('operations', 'admin.roles.manage')).toBe(false);
    expect(platformCan('super_admin', 'admin.roles.manage')).toBe(true);
    expect(platformCan('none', 'admin.read')).toBe(false);
  });
});

describe('alias loops', () => {
  const routes = new Map([['b@x.com', ['c@x.com']], ['c@x.com', ['mailbox@x.com']]]);
  it('allows chains that end at a mailbox', () => {
    expect(detectAliasLoop(routes, 'a@x.com', ['b@x.com'])).toBeNull();
  });
  it('detects direct, indirect and self loops', () => {
    expect(detectAliasLoop(routes, 'a@x.com', ['a@x.com'])).not.toBeNull();
    expect(detectAliasLoop(routes, 'mailbox@x.com', ['b@x.com'])).not.toBeNull();
    expect(detectAliasLoop(new Map([['b@x.com', ['a@x.com']]]), 'a@x.com', ['b@x.com'])).not.toBeNull();
  });
});

describe('password policy', () => {
  it('rejects short, common, repeated and email-derived passwords', () => {
    expect(passwordProblem('short')).toBeTruthy();
    expect(passwordProblem('password123')).toBeTruthy();
    expect(passwordProblem('aaaaaaaaaaaaaaaa')).toBeTruthy();
    expect(passwordProblem('johnsmith-2026!', { email: 'johnsmith@x.com' })).toBeTruthy();
    expect(passwordProblem('correct-horse-battery-9')).toBeNull();
  });
});
