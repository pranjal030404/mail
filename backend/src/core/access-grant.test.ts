import { describe, expect, it } from 'vitest';
import { canApproveGrant, effectiveGrantState, grantAllows, type AccessGrantLike } from './access-grant.js';

const now = new Date('2026-10-29T12:00:00Z');
const base: AccessGrantLike = {
  status: 'active',
  requested_by: 'admin-a',
  approved_by: 'admin-b',
  expires_at: new Date('2026-10-29T13:00:00Z'),
  scope: 'read',
};

describe('exceptional access grant rules', () => {
  it('requires a second super administrator to approve', () => {
    expect(canApproveGrant({ status: 'pending_approval', requested_by: 'admin-a' }, 'admin-a')).toMatchObject({ ok: false, code: 'two_person_rule' });
    expect(canApproveGrant({ status: 'pending_approval', requested_by: 'admin-a' }, 'admin-b')).toEqual({ ok: true });
    expect(canApproveGrant({ status: 'active', requested_by: 'admin-a' }, 'admin-b')).toMatchObject({ ok: false, code: 'invalid_state' });
  });

  it('treats an active grant past expiry as expired', () => {
    expect(effectiveGrantState(base, now)).toBe('active');
    expect(effectiveGrantState(base, new Date('2026-10-29T13:00:01Z'))).toBe('expired');
    expect(effectiveGrantState({ ...base, expires_at: null }, now)).toBe('expired');
    expect(effectiveGrantState({ ...base, status: 'revoked' }, now)).toBe('revoked');
  });

  it('allows read only while active and only for read scope', () => {
    expect(grantAllows(base, 'read', now)).toBe(true);
    expect(grantAllows({ ...base, status: 'pending_approval' }, 'read', now)).toBe(false);
    expect(grantAllows({ ...base, status: 'denied' }, 'read', now)).toBe(false);
    expect(grantAllows({ ...base, expires_at: new Date('2026-10-29T11:59:59Z') }, 'read', now)).toBe(false);
  });
});
