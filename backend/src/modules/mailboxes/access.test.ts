import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import type { Db } from '../../db/pool.js';
import { authorizeMailboxAccess } from './access.js';

/**
 * Minimal database fake for the authorization path. It answers the two queries the helper makes,
 * so the tests exercise the real tenant/mailbox decision logic without a MySQL server.
 */
function fakeDb(opts: { membership?: { id: string; role: string; tenant_status: string } | null; linkedMailboxId?: string | null }): Db {
  return {
    query: async (sql: string) => {
      if (sql.includes('m.tenant_id = ? AND m.user_id = ?')) {
        return [opts.membership ? [{ ...opts.membership, tenant_status: opts.membership.tenant_status }] : []];
      }
      if (sql.includes('SELECT mailbox_id FROM tenant_memberships')) {
        return [opts.linkedMailboxId ? [{ mailbox_id: opts.linkedMailboxId }] : []];
      }
      return [[]];
    },
  } as unknown as Db;
}

const ctx = (db: Db) => ({ db } as unknown as AppContext);
const req = () => ({ auth: { user: { id: 'user-1', kind: 'user' }, session: { mfa_pending: 0 } } } as unknown as FastifyRequest);

describe('mailbox authorization', () => {
  it('lets an owner reach any mailbox in their workspace', async () => {
    const access = await authorizeMailboxAccess(ctx(fakeDb({ membership: { id: 'm1', role: 'owner', tenant_status: 'active' } })), req(), 'tenant-1', 'mailbox-1', 'manage');
    expect(access.role).toBe('owner');
  });

  it('denies a non-member with 404 so workspace existence is not revealed', async () => {
    await expect(authorizeMailboxAccess(ctx(fakeDb({ membership: null })), req(), 'tenant-1', 'mailbox-1', 'read')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lets a mailbox user reach only the mailbox linked to their membership', async () => {
    const db = fakeDb({ membership: { id: 'm2', role: 'mailbox_user', tenant_status: 'active' }, linkedMailboxId: 'mailbox-1' });
    const ok = await authorizeMailboxAccess(ctx(db), req(), 'tenant-1', 'mailbox-1', 'self-write');
    expect(ok.role).toBe('mailbox_user');
    await expect(authorizeMailboxAccess(ctx(db), req(), 'tenant-1', 'mailbox-2', 'read')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('denies a mailbox user manage operations', async () => {
    const db = fakeDb({ membership: { id: 'm2', role: 'mailbox_user', tenant_status: 'active' }, linkedMailboxId: 'mailbox-1' });
    await expect(authorizeMailboxAccess(ctx(db), req(), 'tenant-1', 'mailbox-1', 'manage')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('denies writes in a suspended workspace', async () => {
    const db = fakeDb({ membership: { id: 'm1', role: 'owner', tenant_status: 'suspended' } });
    await expect(authorizeMailboxAccess(ctx(db), req(), 'tenant-1', 'mailbox-1', 'self-write')).rejects.toMatchObject({ statusCode: 403, code: 'tenant_suspended' });
  });

  it('denies a billing role any mailbox access', async () => {
    const db = fakeDb({ membership: { id: 'm3', role: 'billing', tenant_status: 'active' } });
    await expect(authorizeMailboxAccess(ctx(db), req(), 'tenant-1', 'mailbox-1', 'read')).rejects.toMatchObject({ statusCode: 404 });
  });
});
