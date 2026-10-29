import { checkCanAddDomain, DomainValidationError, normalizeDomain, type TenantUsageCounts } from '../../core/index.js';
import { domainToUnicode } from 'node:url';
import type { AppContext } from '../../context.js';
import { exec, isDuplicateKey, one, rows, tx } from '../../db/pool.js';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../../shared/errors.js';
import { randomToken, sha256Hex } from '../../shared/crypto.js';
import { newId } from '../../shared/ids.js';
import { audit } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/auth.service.js';
import { computeReadiness, DnsChecker, ownershipRecordName, ownershipRecordValue, type DnsCheckResult } from '../dns/dns.service.js';
import { enqueue } from '../jobs/jobs.repository.js';
import type { ExpectedDnsRecord } from '../mail-server/mail-server.interface.js';
import { getSettings } from '../settings/settings.service.js';
import { getTenantLimits } from '../tenants/tenants.service.js';

export interface DomainRow {
  id: string;
  tenant_id: string;
  name: string;
  unicode_name: string;
  status: string;
  ownership_status: string;
  inbound_status: string;
  outbound_status: string;
  provisioning_status: string;
  mail_engine_domain_id: string | null;
  expected_records: ExpectedDnsRecord[] | null;
  expected_records_at: Date | null;
  verified_at: Date | null;
  last_dns_check_at: Date | null;
  created_at: Date;
}

export function checker(ctx: AppContext): DnsChecker {
  return new DnsChecker(ctx.dnsResolver, { mailHostname: ctx.config.MAIL_HOSTNAME, ...(ctx.config.MAIL_PUBLIC_IPV4 ? { ipv4: ctx.config.MAIL_PUBLIC_IPV4 } : {}), ...(ctx.config.MAIL_PUBLIC_IPV6 ? { ipv6: ctx.config.MAIL_PUBLIC_IPV6 } : {}) });
}

export function normalizeForPlatform(ctx: AppContext, raw: string): string {
  try {
    const mailParent = ctx.config.MAIL_HOSTNAME.split('.').slice(-2).join('.');
    return normalizeDomain(raw, { allowTestDomains: ctx.config.ALLOW_TEST_DOMAINS, reservedDomains: [...ctx.config.RESERVED_DOMAINS, ctx.config.MAIL_HOSTNAME, ...(ctx.config.isProduction ? [mailParent] : [])] });
  } catch (err) {
    if (err instanceof DomainValidationError) throw unprocessable(err.code, err.message);
    throw err;
  }
}

export async function tenantUsageCounts(ctx: AppContext, tenantId: string, db = ctx.db): Promise<TenantUsageCounts> {
  const r = await one<{ domains: number; mailboxes: number; aliases: number; allocated: string | number }>(
    db,
    `SELECT (SELECT COUNT(*) FROM domains WHERE tenant_id = ? AND status <> 'removed') AS domains,
            (SELECT COUNT(*) FROM mailboxes WHERE tenant_id = ? AND status NOT IN ('deleted','retained')) AS mailboxes,
            (SELECT COUNT(*) FROM aliases WHERE tenant_id = ? AND status NOT IN ('deleted','deleting')) AS aliases,
            (SELECT COALESCE(SUM(quota_bytes),0) FROM mailboxes WHERE tenant_id = ? AND status NOT IN ('deleted','retained')) AS allocated`,
    [tenantId, tenantId, tenantId, tenantId],
  );
  return { domains: Number(r!.domains), mailboxes: Number(r!.mailboxes), aliases: Number(r!.aliases), allocatedBytes: Number(r!.allocated) };
}

export async function addDomain(ctx: AppContext, tenantId: string, userId: string, rawName: string, meta: RequestMeta) {
  const name = normalizeForPlatform(ctx, rawName);
  const limits = await getTenantLimits(ctx, tenantId);
  const id = newId();
  const token = randomToken(24);
  try {
    await tx(ctx.db, async (conn) => {
      // Serialize concurrent adds for the same tenant so the plan limit cannot be raced.
      await one(conn, 'SELECT id FROM tenants WHERE id = ? FOR UPDATE', [tenantId]);
      const check = checkCanAddDomain(await tenantUsageCounts(ctx, tenantId, conn as never), limits);
      if (!check.ok) throw new AppError(403, check.code, check.message);
      await exec(
        conn,
        `INSERT INTO domains (id, tenant_id, name, unicode_name, claim_name, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, tenantId, name, domainToUnicode(name), name, userId],
      );
      await exec(
        conn,
        `INSERT INTO domain_verification_tokens (id, domain_id, token_hash, token_encrypted, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? DAY))`,
        [newId(), id, sha256Hex(token), ctx.secrets.encrypt(token), ctx.config.DOMAIN_VERIFICATION_TTL_DAYS],
      );
      await audit(conn, { actorType: 'user', actorUserId: userId, tenantId, action: 'domain.add', targetType: 'domain', targetId: id, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip, metadata: { domain: name } });
    });
  } catch (err) {
    if (isDuplicateKey(err)) {
      await audit(ctx.db, { actorType: 'user', actorUserId: userId, tenantId, action: 'domain.add', outcome: 'denied', reason: 'already_claimed', correlationId: meta.correlationId, ip: meta.ip, metadata: { domain: name } });
      // Deliberately does not say which tenant holds the domain.
      throw conflict('domain_claimed', 'This domain is already registered on ARTHVEX. If you own it, contact support to resolve a dispute.');
    }
    throw err;
  }
  return getDomain(ctx, tenantId, id);
}

export async function loadDomain(ctx: AppContext, tenantId: string, domainId: string): Promise<DomainRow> {
  const d = await one<DomainRow>(ctx.db, "SELECT * FROM domains WHERE id = ? AND tenant_id = ? AND status <> 'removed'", [domainId, tenantId]);
  if (!d) throw notFound('Domain');
  return d;
}

export async function getDomain(ctx: AppContext, tenantId: string, domainId: string) {
  const d = await loadDomain(ctx, tenantId, domainId);
  const tokenRow = await one<{ token_encrypted: string; expires_at: Date; status: string }>(
    ctx.db,
    "SELECT token_encrypted, expires_at, status FROM domain_verification_tokens WHERE domain_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
    [domainId],
  );
  const checks = await rows<{ check_type: string; record_name: string; expected_value: string | null; observed_value: string | null; status: string; message: string | null; checked_at: Date }>(
    ctx.db,
    `SELECT c.check_type, c.record_name, c.expected_value, c.observed_value, c.status, c.message, c.checked_at
       FROM domain_dns_checks c
       JOIN (SELECT check_type, record_name, MAX(id) AS mid FROM domain_dns_checks WHERE domain_id = ? GROUP BY check_type, record_name) l ON l.mid = c.id`,
    [domainId],
  );
  const ownership =
    d.ownership_status === 'verified' || !tokenRow
      ? null
      : {
          recordType: 'TXT',
          name: ownershipRecordName(d.name),
          value: ownershipRecordValue(ctx.secrets.decrypt(tokenRow.token_encrypted)),
          expiresAt: tokenRow.expires_at,
          ttlGuidance: 'Use the default TTL or 300 seconds. You can remove the record after the domain is verified.',
        };
  return {
    id: d.id,
    name: d.name,
    unicodeName: d.unicode_name,
    status: d.status,
    ownershipStatus: d.ownership_status,
    inboundStatus: d.inbound_status,
    outboundStatus: d.outbound_status,
    provisioningStatus: d.provisioning_status,
    verifiedAt: d.verified_at,
    lastDnsCheckAt: d.last_dns_check_at,
    createdAt: d.created_at,
    ownershipInstruction: ownership,
    expectedRecords: d.ownership_status === 'verified' ? d.expected_records : null,
    expectedRecordsAt: d.expected_records_at,
    checks: checks.map((c) => ({ type: c.check_type, name: c.record_name, expected: c.expected_value, observed: c.observed_value, status: c.status, message: c.message, checkedAt: c.checked_at })),
    propagationNote: 'DNS changes can take from a few minutes up to 48 hours to become visible. ARTHVEX only reports what public DNS currently returns; it does not change your DNS.',
  };
}

export async function listDomains(ctx: AppContext, tenantId: string) {
  const list = await rows<DomainRow & { mailbox_count: number }>(
    ctx.db,
    `SELECT d.*, (SELECT COUNT(*) FROM mailboxes m WHERE m.domain_id = d.id AND m.status NOT IN ('deleted','retained')) AS mailbox_count
       FROM domains d WHERE d.tenant_id = ? AND d.status <> 'removed' ORDER BY d.created_at DESC`,
    [tenantId],
  );
  return list.map((d) => ({
    id: d.id, name: d.name, unicodeName: d.unicode_name, status: d.status, ownershipStatus: d.ownership_status, inboundStatus: d.inbound_status,
    outboundStatus: d.outbound_status, provisioningStatus: d.provisioning_status, mailboxCount: Number(d.mailbox_count), lastDnsCheckAt: d.last_dns_check_at, createdAt: d.created_at,
  }));
}

async function saveChecks(ctx: AppContext, domainId: string, results: DnsCheckResult[]) {
  for (const r of results) {
    await exec(ctx.db, 'INSERT INTO domain_dns_checks (domain_id, check_type, record_name, expected_value, observed_value, status, message) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      domainId, r.checkType, r.recordName, r.expected, r.observed, r.status, r.message.slice(0, 500),
    ]);
  }
}

export async function verifyOwnership(ctx: AppContext, tenantId: string, domainId: string, actorId: string | null, meta: RequestMeta) {
  const d = await loadDomain(ctx, tenantId, domainId);
  if (d.ownership_status === 'verified') return getDomain(ctx, tenantId, domainId);
  const tokenRow = await one<{ id: string; token_encrypted: string; expires_at: Date }>(
    ctx.db,
    "SELECT id, token_encrypted, expires_at FROM domain_verification_tokens WHERE domain_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
    [domainId],
  );
  if (!tokenRow || tokenRow.expires_at.getTime() < Date.now()) {
    await exec(ctx.db, "UPDATE domain_verification_tokens SET status = 'expired' WHERE domain_id = ? AND status = 'active'", [domainId]);
    await exec(ctx.db, "UPDATE domains SET ownership_status = 'expired' WHERE id = ? AND ownership_status <> 'verified'", [domainId]);
    throw unprocessable('token_expired', 'The verification token has expired. Generate a new one and update the TXT record.');
  }
  const result = await checker(ctx).checkOwnership(d.name, ctx.secrets.decrypt(tokenRow.token_encrypted));
  await saveChecks(ctx, domainId, [result]);
  await exec(ctx.db, 'UPDATE domains SET last_dns_check_at = NOW(3) WHERE id = ?', [domainId]);
  if (result.status === 'pass') {
    const became = await tx(ctx.db, async (conn) => {
      const res = await exec(conn, "UPDATE domains SET ownership_status = 'verified', status = 'verified', verified_at = NOW(3) WHERE id = ? AND ownership_status <> 'verified'", [domainId]);
      if (res.affectedRows !== 1) return false;
      await exec(conn, "UPDATE domain_verification_tokens SET status = 'used', verified_at = NOW(3) WHERE id = ?", [tokenRow.id]);
      await enqueue(conn, { tenantId, operation: 'domain.provision', targetType: 'domain', targetId: domainId, idempotencyKey: `domain.provision:${domainId}`, createdBy: actorId });
      await audit(conn, { actorType: actorId ? 'user' : 'system', actorUserId: actorId, tenantId, action: 'domain.verify', targetType: 'domain', targetId: domainId, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip });
      return true;
    });
    void became;
  } else if (result.status === 'fail') {
    await exec(ctx.db, "UPDATE domains SET ownership_status = IF(ownership_status = 'verified', ownership_status, 'failed') WHERE id = ?", [domainId]);
  }
  return getDomain(ctx, tenantId, domainId);
}

export async function rotateToken(ctx: AppContext, tenantId: string, domainId: string, actorId: string, meta: RequestMeta) {
  const d = await loadDomain(ctx, tenantId, domainId);
  if (d.ownership_status === 'verified') throw conflict('already_verified', 'This domain is already verified.');
  const token = randomToken(24);
  await tx(ctx.db, async (conn) => {
    await exec(conn, "UPDATE domain_verification_tokens SET status = 'rotated' WHERE domain_id = ? AND status = 'active'", [domainId]);
    await exec(conn, 'INSERT INTO domain_verification_tokens (id, domain_id, token_hash, token_encrypted, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? DAY))', [newId(), domainId, sha256Hex(token), ctx.secrets.encrypt(token), ctx.config.DOMAIN_VERIFICATION_TTL_DAYS]);
    await exec(conn, "UPDATE domains SET ownership_status = 'pending' WHERE id = ?", [domainId]);
    await audit(conn, { actorType: 'user', actorUserId: actorId, tenantId, action: 'domain.rotate_token', targetType: 'domain', targetId: domainId, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip });
  });
  return getDomain(ctx, tenantId, domainId);
}

export async function runDnsCheck(ctx: AppContext, tenantId: string, domainId: string) {
  const d = await loadDomain(ctx, tenantId, domainId);
  if (d.ownership_status !== 'verified') throw unprocessable('ownership_required', 'Verify domain ownership before checking mail records.');
  if (!d.expected_records) throw new AppError(409, 'not_provisioned', 'Mail records are not available yet. The domain is still being set up on the mail server; try again shortly.');
  const results = await checker(ctx).checkMailRecords(d.name, d.expected_records);
  await saveChecks(ctx, domainId, results);
  const { inbound, outbound } = computeReadiness(results);
  await exec(ctx.db, "UPDATE domains SET inbound_status = ?, outbound_status = ?, last_dns_check_at = NOW(3), status = IF(status = 'verified' AND ? = 'ok', 'active', status) WHERE id = ?", [inbound, outbound, inbound, domainId]);
  return getDomain(ctx, tenantId, domainId);
}

/** What removing a domain would affect; shown before confirmation and returned with refusals. */
export async function removalImpact(ctx: AppContext, tenantId: string, domainId: string) {
  const d = await loadDomain(ctx, tenantId, domainId);
  const mailboxes = await rows<{ normalized_address: string; status: string }>(ctx.db, "SELECT normalized_address, status FROM mailboxes WHERE domain_id = ? AND tenant_id = ? AND status NOT IN ('deleted','retained')", [domainId, tenantId]);
  const aliases = await rows<{ source_address: string }>(ctx.db, "SELECT source_address FROM aliases WHERE domain_id = ? AND tenant_id = ? AND status NOT IN ('deleted')", [domainId, tenantId]);
  return {
    domain: d.name,
    mailboxes: mailboxes.map((m) => ({ address: m.normalized_address, status: m.status })),
    aliases: aliases.map((a) => a.source_address),
    consequences: [
      'Mail sent to this domain will no longer be accepted by ARTHVEX once removal completes.',
      'Delete every mailbox and alias first. Mailbox data is deleted after the retention grace period and cannot be recovered afterwards.',
      'You can remove the DNS records at your DNS provider afterwards; ARTHVEX does not change your DNS.',
    ],
    canRemove: mailboxes.length === 0 && aliases.length === 0,
  };
}

export async function removeDomain(ctx: AppContext, tenantId: string, domainId: string, confirmName: string, actorId: string, meta: RequestMeta) {
  const impact = await removalImpact(ctx, tenantId, domainId);
  if (confirmName.trim().toLowerCase() !== impact.domain) throw badRequest('confirmation_mismatch', 'Type the domain name exactly to confirm removal.');
  if (!impact.canRemove) throw new AppError(409, 'domain_in_use', 'Delete this domain’s mailboxes and aliases before removing it.', impact);
  await tx(ctx.db, async (conn) => {
    await exec(conn, "UPDATE domains SET status = 'removal_scheduled', provisioning_status = 'removing' WHERE id = ? AND tenant_id = ?", [domainId, tenantId]);
    await enqueue(conn, { tenantId, operation: 'domain.remove', targetType: 'domain', targetId: domainId, idempotencyKey: `domain.remove:${domainId}`, createdBy: actorId });
    await audit(conn, { actorType: 'user', actorUserId: actorId, tenantId, action: 'domain.remove', targetType: 'domain', targetId: domainId, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip, metadata: { domain: impact.domain } });
  });
}

/** Mailbox creation policy: ownership is always required; MX can also be required by platform setting. */
export async function assertDomainAcceptsMailboxes(ctx: AppContext, d: Pick<DomainRow, 'status' | 'ownership_status' | 'provisioning_status' | 'inbound_status'>) {
  if (d.ownership_status !== 'verified') throw unprocessable('domain_not_verified', 'Verify domain ownership before creating mailboxes.');
  if (d.status === 'suspended') throw new AppError(403, 'domain_suspended', 'This domain is suspended.');
  if (d.provisioning_status !== 'ready') throw new AppError(409, 'domain_not_ready', 'The domain is still being set up on the mail server. Try again in a moment.');
  const settings = await getSettings(ctx.db);
  if (settings.mailbox_creation_requires === 'ownership_and_mx' && d.inbound_status !== 'ok') {
    throw unprocessable('mx_required', 'Platform policy requires the MX record to be configured before creating mailboxes. Run the DNS check once your MX record is published.');
  }
}
