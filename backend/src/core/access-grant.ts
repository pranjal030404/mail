/**
 * Rules for exceptional mailbox access by platform operators.
 *
 * Ordinary administrator privileges never include message content. An operator must request access
 * to one mailbox with a documented reason, a *different* super admin must approve it, the grant is
 * short-lived, and every use is audited. These pure rules are shared by the API and the tests.
 */

export type AccessGrantStatus = 'pending_approval' | 'active' | 'denied' | 'revoked' | 'expired';
export type AccessGrantScope = 'read';
export type AccessGrantAction = 'read';

export interface AccessGrantLike {
  status: AccessGrantStatus;
  requested_by: string;
  approved_by: string | null;
  expires_at: Date | null;
  scope: AccessGrantScope;
}

export type EffectiveGrantState = 'pending_approval' | 'active' | 'denied' | 'revoked' | 'expired';

/** Active grants past their expiry behave as expired without waiting for a worker sweep. */
export function effectiveGrantState(grant: Pick<AccessGrantLike, 'status' | 'expires_at'>, now: Date = new Date()): EffectiveGrantState {
  if (grant.status === 'active') {
    if (!grant.expires_at || grant.expires_at.getTime() <= now.getTime()) return 'expired';
    return 'active';
  }
  return grant.status;
}

export function canApproveGrant(grant: Pick<AccessGrantLike, 'status' | 'requested_by'>, approverId: string): { ok: true } | { ok: false; code: string; message: string } {
  if (grant.status !== 'pending_approval') return { ok: false, code: 'invalid_state', message: 'This request is no longer awaiting approval.' };
  if (grant.requested_by === approverId) return { ok: false, code: 'two_person_rule', message: 'A second super administrator must approve this request.' };
  return { ok: true };
}

export function grantAllows(grant: AccessGrantLike, action: AccessGrantAction, now: Date = new Date()): boolean {
  const state = effectiveGrantState(grant, now);
  if (state !== 'active') return false;
  if (grant.scope !== 'read') return false;
  // Read access covers only read actions in this release.
  return action === 'read';
}

/** Scopes currently issued. Write access is deliberately not implemented yet. */
export const ACCESS_GRANT_SCOPES: readonly AccessGrantScope[] = ['read'];
