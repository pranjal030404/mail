import { AddressValidationError, buildAddress, checkCanAddAlias, detectAliasLoop, normalizeEmailAddress, normalizeLocalPart } from '../../core/index.js';
import type { AppContext } from '../../context.js';
import { exec, isDuplicateKey, one, rows, tx } from '../../db/pool.js';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../../shared/errors.js';
import { randomToken, sha256Hex } from '../../shared/crypto.js';
import { newId } from '../../shared/ids.js';
import { audit } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/auth.service.js';
import { assertDomainAcceptsMailboxes, loadDomain, tenantUsageCounts } from '../domains/domains.service.js';
import { enqueue } from '../jobs/jobs.repository.js';
import { templates } from '../notifications/templates.js';
import { getTenantLimits } from '../tenants/tenants.service.js';

export interface AliasRow {
  id: string;
  tenant_id: string;
  domain_id: string;
  source_address: string;
  destination_type: 'mailbox' | 'external';
  destination_mailbox_id: string | null;
  destination_address: string;
  status: string;
  forwarding_confirmed_at: Date | null;
  created_at: Date;
}

const present = (a: AliasRow) => ({
  id: a.id,
  domainId: a.domain_id,
  source: a.source_address,
  destinationType: a.destination_type,
  destination: a.destination_address,
  status: a.status,
  awaitingConfirmation: a.status === 'pending_confirmation',
  createdAt: a.created_at,
});

async function loadAlias(ctx: AppContext, tenantId: string, id: string): Promise<AliasRow> {
  const a = await one<AliasRow>(ctx.db, "SELECT * FROM aliases WHERE id = ? AND tenant_id = ? AND status <> 'deleted'", [id, tenantId]);
  if (!a) throw notFound('Alias');
  return a;
}

export async function listAliases(ctx: AppContext, tenantId: string, domainId?: string) {
  const list = await rows<AliasRow>(ctx.db, `SELECT * FROM aliases WHERE tenant_id = ? AND status <> 'deleted' ${domainId ? 'AND domain_id = ?' : ''} ORDER BY created_at DESC`, domainId ? [tenantId, domainId] : [tenantId]);
  return list.map(present);
}

export async function createAlias(
  ctx: AppContext,
  tenantId: string,
  domainId: string,
  actorId: string,
  input: { localPart: string; destinationMailboxId?: string | undefined; externalAddress?: string | undefined },
  meta: RequestMeta,
) {
  if (!!input.destinationMailboxId === !!input.externalAddress) throw badRequest('invalid_destination', 'Choose exactly one destination: a mailbox or an external address.');
  const domain = await loadDomain(ctx, tenantId, domainId);
  await assertDomainAcceptsMailboxes(ctx, domain);
  let lp: string;
  try {
    lp = normalizeLocalPart(input.localPart);
  } catch (err) {
    if (err instanceof AddressValidationError) throw unprocessable(err.code, err.message);
    throw err;
  }
  const source = buildAddress(lp, domain.name);
  const limits = await getTenantLimits(ctx, tenantId);

  let destType: 'mailbox' | 'external';
  let destMailboxId: string | null = null;
  let destAddress: string;
  if (input.destinationMailboxId) {
    // Ownership check: the mailbox must belong to this same tenant.
    const mb = await one<{ id: string; normalized_address: string }>(ctx.db, "SELECT id, normalized_address FROM mailboxes WHERE id = ? AND tenant_id = ? AND status IN ('active','suspended','provisioning')", [input.destinationMailboxId, tenantId]);
    if (!mb) throw unprocessable('invalid_destination', 'The destination mailbox was not found in this workspace.');
    destType = 'mailbox';
    destMailboxId = mb.id;
    destAddress = mb.normalized_address;
  } else {
    if (!limits.allowExternalForwarding) throw new AppError(403, 'external_forwarding_disabled', 'External forwarding is not available on your plan.');
    try {
      destAddress = normalizeEmailAddress(input.externalAddress!, { allowTestDomains: ctx.config.ALLOW_TEST_DOMAINS });
    } catch {
      throw unprocessable('invalid_destination', 'Enter a valid destination email address.');
    }
    const destDomain = destAddress.split('@')[1]!;
    const hosted = await one<{ tenant_id: string }>(ctx.db, "SELECT tenant_id FROM domains WHERE claim_name = ?", [destDomain]);
    if (hosted) throw unprocessable('invalid_destination', 'That address is hosted on ARTHVEX. Choose it as a mailbox destination, or use an address outside ARTHVEX.');
    destType = 'external';
  }

  // Loop detection over this tenant's existing routing graph (defence in depth: the structure already prevents most loops).
  const existing = await rows<{ source_address: string; destination_address: string }>(ctx.db, "SELECT source_address, destination_address FROM aliases WHERE tenant_id = ? AND status NOT IN ('deleted','failed')", [tenantId]);
  const routes = new Map<string, string[]>();
  for (const e of existing) routes.set(e.source_address, [...(routes.get(e.source_address) ?? []), e.destination_address]);
  const loop = detectAliasLoop(routes, source, [destAddress]);
  if (loop) throw unprocessable('alias_loop', `This alias would create a routing loop (${loop.join(' → ')}).`);

  const id = newId();
  const confirmToken = destType === 'external' ? randomToken() : null;
  try {
    await tx(ctx.db, async (conn) => {
      await one(conn, 'SELECT id FROM tenants WHERE id = ? FOR UPDATE', [tenantId]);
      const check = checkCanAddAlias(await tenantUsageCounts(ctx, tenantId, conn as never), limits);
      if (!check.ok) throw new AppError(403, check.code, check.message);
      await exec(conn, "INSERT INTO address_claims (address, kind, owner_id, tenant_id) VALUES (?, 'alias', ?, ?)", [source, id, tenantId]);
      await exec(
        conn,
        `INSERT INTO aliases (id, tenant_id, domain_id, local_part, source_address, claim_address, destination_type, destination_mailbox_id, destination_address, status,
                              forwarding_token_hash, forwarding_token_expires_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${confirmToken ? 'DATE_ADD(NOW(3), INTERVAL 7 DAY)' : 'NULL'}, ?)`,
        [id, tenantId, domainId, lp, source, source, destType, destMailboxId, destAddress, confirmToken ? 'pending_confirmation' : 'provisioning', confirmToken ? sha256Hex(confirmToken) : null, actorId],
      );
      if (!confirmToken) await enqueue(conn, { tenantId, operation: 'alias.ensure', targetType: 'alias', targetId: id, idempotencyKey: `alias.ensure:${id}:1`, createdBy: actorId });
      await audit(conn, { actorType: 'user', actorUserId: actorId, tenantId, action: 'alias.create', targetType: 'alias', targetId: id, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip, metadata: { source, destinationType: destType } });
    });
  } catch (err) {
    if (isDuplicateKey(err)) throw conflict('address_taken', 'That address is already in use.');
    throw err;
  }
  if (confirmToken) {
    // Forwarding to an outside address starts only after its owner confirms (prevents using ARTHVEX to spam third parties).
    const m = templates.forwardingConfirmation(ctx.config.APP_BASE_URL, source, confirmToken);
    await ctx.mailer.send({ to: destAddress, subject: m.subject, text: m.text, category: 'forwarding_confirmation' });
  }
  return present(await loadAlias(ctx, tenantId, id));
}

/** Public: confirms external forwarding using the emailed single-use token. */
export async function confirmForwarding(ctx: AppContext, token: string, meta: RequestMeta) {
  const a = await one<AliasRow>(ctx.db, "SELECT * FROM aliases WHERE forwarding_token_hash = ? AND status = 'pending_confirmation' AND forwarding_token_expires_at > NOW(3)", [sha256Hex(token)]);
  if (!a) throw badRequest('invalid_token', 'This confirmation link is invalid or has expired.');
  await tx(ctx.db, async (conn) => {
    const res = await exec(conn, "UPDATE aliases SET status = 'provisioning', forwarding_confirmed_at = NOW(3), forwarding_token_hash = NULL WHERE id = ? AND status = 'pending_confirmation'", [a.id]);
    if (res.affectedRows !== 1) throw badRequest('invalid_token', 'This confirmation link is invalid or has expired.');
    await enqueue(conn, { tenantId: a.tenant_id, operation: 'alias.ensure', targetType: 'alias', targetId: a.id, idempotencyKey: `alias.ensure:${a.id}:1`, createdBy: null });
    await audit(conn, { actorType: 'anonymous', tenantId: a.tenant_id, action: 'alias.forwarding_confirmed', targetType: 'alias', targetId: a.id, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip });
  });
}

export async function deleteAlias(ctx: AppContext, tenantId: string, id: string, actorId: string, meta: RequestMeta) {
  const a = await loadAlias(ctx, tenantId, id);
  await tx(ctx.db, async (conn) => {
    await exec(conn, "UPDATE aliases SET status = 'deleting', forwarding_token_hash = NULL WHERE id = ?", [a.id]);
    await enqueue(conn, { tenantId, operation: 'alias.remove', targetType: 'alias', targetId: a.id, idempotencyKey: `alias.remove:${a.id}`, createdBy: actorId });
    await audit(conn, { actorType: 'user', actorUserId: actorId, tenantId, action: 'alias.delete', targetType: 'alias', targetId: a.id, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip });
  });
}
