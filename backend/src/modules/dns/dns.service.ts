import { promises as dnsPromises } from 'node:dns';
import type { CheckStatus, ReadinessStatus } from '../../core/index.js';
import type { ExpectedDnsRecord } from '../mail-server/mail-server.interface.js';
import { safeEqual } from '../../shared/crypto.js';

/** Subset of node:dns/promises used by the checker; injectable for tests. */
export interface DnsResolverLike {
  resolveTxt(name: string): Promise<string[][]>;
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
  reverse(ip: string): Promise<string[]>;
}

export function createSystemResolver(opts: { servers: string[]; timeoutMs: number }): DnsResolverLike {
  const resolver = new dnsPromises.Resolver({ timeout: opts.timeoutMs, tries: 2 });
  if (opts.servers.length) resolver.setServers(opts.servers);
  // Overall bound in addition to per-try timeouts.
  const bounded =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      Promise.race([
        fn(...args),
        new Promise<R>((_, reject) => setTimeout(() => reject(Object.assign(new Error('DNS timeout'), { code: 'ETIMEOUT' })), opts.timeoutMs * 3).unref()),
      ]);
  return {
    resolveTxt: bounded((n: string) => resolver.resolveTxt(n)),
    resolveMx: bounded((n: string) => resolver.resolveMx(n)),
    resolve4: bounded((n: string) => resolver.resolve4(n)),
    resolve6: bounded((n: string) => resolver.resolve6(n)),
    reverse: bounded((ip: string) => resolver.reverse(ip)),
  };
}

type Lookup<T> = { ok: true; value: T } | { ok: false; kind: 'nodata' | 'transient'; code: string };

const NODATA_CODES = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN', 'ENONAME']);

async function lookup<T>(fn: () => Promise<T>): Promise<Lookup<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    const code = String((err as { code?: string }).code ?? 'EUNKNOWN');
    return { ok: false, kind: NODATA_CODES.has(code) ? 'nodata' : 'transient', code };
  }
}

export type DnsCheckType = 'ownership' | 'mx' | 'spf' | 'dkim' | 'dmarc' | 'mail_host' | 'ptr';

export interface DnsCheckResult {
  checkType: DnsCheckType;
  recordName: string;
  expected: string | null;
  observed: string | null;
  status: CheckStatus;
  message: string;
}

export const OWNERSHIP_PREFIX = '_arthvex-verification';
export const ownershipRecordName = (domain: string) => `${OWNERSHIP_PREFIX}.${domain}`;
export const ownershipRecordValue = (token: string) => `arthvex-verification=${token}`;

const TRANSIENT_MSG = 'The DNS lookup timed out or failed temporarily. This is usually transient — try again in a few minutes.';
const PROPAGATION_HINT = 'If you added it recently, DNS changes can take from a few minutes up to 48 hours to propagate.';

const norm = (h: string) => h.toLowerCase().replace(/\.$/, '');

export class DnsChecker {
  constructor(
    private readonly resolver: DnsResolverLike,
    private readonly platform: { mailHostname: string; ipv4?: string; ipv6?: string },
  ) {}

  async checkOwnership(domain: string, token: string): Promise<DnsCheckResult> {
    const name = ownershipRecordName(domain);
    const expected = ownershipRecordValue(token);
    const res = await lookup(() => this.resolver.resolveTxt(name));
    if (!res.ok) {
      return {
        checkType: 'ownership',
        recordName: name,
        expected,
        observed: null,
        status: res.kind === 'transient' ? 'error' : 'fail',
        message: res.kind === 'transient' ? TRANSIENT_MSG : `No TXT record found at ${name}. ${PROPAGATION_HINT}`,
      };
    }
    const values = res.value.map((chunks) => chunks.join(''));
    // Only an exact match of our prefixed value on our dedicated name counts as proof.
    const match = values.some((v) => safeEqual(v.trim(), expected));
    return {
      checkType: 'ownership',
      recordName: name,
      expected,
      observed: values.join(' | ').slice(0, 2000) || null,
      status: match ? 'pass' : 'fail',
      message: match
        ? 'Domain ownership verified.'
        : values.some((v) => v.startsWith('arthvex-verification='))
          ? 'A verification record was found but the token does not match. Make sure you copied the current token (tokens change when rotated).'
          : `The TXT record at ${name} does not contain the expected value. ${PROPAGATION_HINT}`,
    };
  }

  async checkMailRecords(domain: string, expected: ExpectedDnsRecord[]): Promise<DnsCheckResult[]> {
    const results = await Promise.all([
      this.checkMx(domain, expected),
      this.checkSpf(domain, expected),
      ...expected.filter((r) => r.purpose === 'dkim').map((r) => this.checkDkim(r)),
      this.checkDmarc(domain),
      this.checkMailHost(),
      this.checkPtr(),
    ]);
    return results.filter((r): r is DnsCheckResult => r !== null);
  }

  private async checkMx(domain: string, expected: ExpectedDnsRecord[]): Promise<DnsCheckResult> {
    const target = norm(expected.find((r) => r.type === 'MX')?.value ?? this.platform.mailHostname);
    const res = await lookup(() => this.resolver.resolveMx(domain));
    const base = { checkType: 'mx' as const, recordName: domain, expected: `10 ${target}` };
    if (!res.ok) {
      return { ...base, observed: null, status: res.kind === 'transient' ? 'error' : 'fail', message: res.kind === 'transient' ? TRANSIENT_MSG : `No MX record found. Inbound mail cannot reach this domain. ${PROPAGATION_HINT}` };
    }
    const observed = res.value.map((m) => `${m.priority} ${norm(m.exchange)}`).join(', ');
    const ours = res.value.filter((m) => norm(m.exchange) === target);
    if (!ours.length) {
      return { ...base, observed, status: 'fail', message: `MX records do not point to ${target}. Mail is still being delivered to another provider.` };
    }
    const others = res.value.filter((m) => norm(m.exchange) !== target);
    if (others.length) {
      const bestOurs = Math.min(...ours.map((m) => m.priority));
      const bestOther = Math.min(...others.map((m) => m.priority));
      return {
        ...base,
        observed,
        status: 'warning',
        message:
          bestOther <= bestOurs
            ? 'Another provider has equal or higher MX priority, so some or all mail will not arrive here. Remove the old MX records.'
            : 'Additional MX records for other providers exist. Remove them unless you intentionally use a backup MX.',
      };
    }
    return { ...base, observed, status: 'pass', message: 'Inbound mail is routed to ARTHVEX.' };
  }

  private async checkSpf(domain: string, expected: ExpectedDnsRecord[]): Promise<DnsCheckResult> {
    const exp = expected.find((r) => r.purpose === 'spf')?.value ?? 'v=spf1 mx -all';
    const res = await lookup(() => this.resolver.resolveTxt(domain));
    const base = { checkType: 'spf' as const, recordName: domain, expected: exp };
    if (!res.ok && res.kind === 'transient') return { ...base, observed: null, status: 'error', message: TRANSIENT_MSG };
    const spf = res.ok ? res.value.map((c) => c.join('')).filter((v) => /^v=spf1(\s|$)/i.test(v.trim())) : [];
    if (spf.length === 0) return { ...base, observed: null, status: 'fail', message: `No SPF record found. Add the TXT record shown. ${PROPAGATION_HINT}` };
    const observed = spf.join(' | ');
    if (spf.length > 1) {
      return { ...base, observed, status: 'fail', message: 'Multiple SPF records were found. Receivers treat this as a permanent error — merge them into a single record.' };
    }
    const record = spf[0]!.toLowerCase();
    if (/\s\+?all(\s|$)/.test(record)) {
      return { ...base, observed, status: 'fail', message: 'The SPF record ends with "+all", which authorises every server on the internet to send as your domain.' };
    }
    const mechanisms = record.split(/\s+/);
    const authorises =
      mechanisms.includes('mx') ||
      mechanisms.includes('+mx') ||
      mechanisms.includes(`a:${norm(this.platform.mailHostname)}`) ||
      (this.platform.ipv4 ? mechanisms.includes(`ip4:${this.platform.ipv4}`) : false) ||
      exp
        .toLowerCase()
        .split(/\s+/)
        .filter((m) => m.startsWith('include:'))
        .some((m) => mechanisms.includes(m));
    if (!authorises) {
      return { ...base, observed, status: 'warning', message: 'Your SPF record exists but does not appear to authorise ARTHVEX mail servers. Add "mx" (or the mechanism shown) to it.' };
    }
    if (/\s\?all(\s|$)/.test(record)) {
      return { ...base, observed, status: 'warning', message: 'SPF uses "?all" (neutral). Consider "~all" or "-all" once you have confirmed all legitimate senders.' };
    }
    return { ...base, observed, status: 'pass', message: 'SPF authorises ARTHVEX to send for this domain.' };
  }

  private async checkDkim(record: ExpectedDnsRecord): Promise<DnsCheckResult> {
    const res = await lookup(() => this.resolver.resolveTxt(record.name));
    const base = { checkType: 'dkim' as const, recordName: record.name, expected: record.value };
    if (!res.ok) {
      return { ...base, observed: null, status: res.kind === 'transient' ? 'error' : 'fail', message: res.kind === 'transient' ? TRANSIENT_MSG : `DKIM key not found at ${record.name}. ${PROPAGATION_HINT}` };
    }
    const values = res.value.map((c) => c.join(''));
    const keyOf = (v: string) => /(?:^|;)\s*p=([^;]+)/i.exec(v)?.[1]?.replace(/\s+/g, '') ?? '';
    const want = keyOf(record.value);
    const match = values.some((v) => keyOf(v) === want && want.length > 0);
    return {
      ...base,
      observed: values.join(' | ').slice(0, 2000),
      status: match ? 'pass' : 'fail',
      message: match ? 'DKIM public key published correctly.' : 'A record exists but the public key does not match. Copy the full value exactly; some DNS providers require long values to be split.',
    };
  }

  private async checkDmarc(domain: string): Promise<DnsCheckResult> {
    const name = `_dmarc.${domain}`;
    const res = await lookup(() => this.resolver.resolveTxt(name));
    const base = { checkType: 'dmarc' as const, recordName: name, expected: `v=DMARC1; p=none; rua=mailto:postmaster@${domain}` };
    if (!res.ok && res.kind === 'transient') return { ...base, observed: null, status: 'error', message: TRANSIENT_MSG };
    const records = res.ok ? res.value.map((c) => c.join('')).filter((v) => /^v=DMARC1/i.test(v.trim())) : [];
    if (!records.length) return { ...base, observed: null, status: 'fail', message: `No DMARC record found at ${name}. ${PROPAGATION_HINT}` };
    if (records.length > 1) return { ...base, observed: records.join(' | '), status: 'fail', message: 'Multiple DMARC records were found; receivers will ignore them. Keep exactly one.' };
    const policy = /;\s*p=(none|quarantine|reject)/i.exec(records[0]!)?.[1]?.toLowerCase();
    if (!policy) return { ...base, observed: records[0]!, status: 'fail', message: 'The DMARC record has no valid policy (p=none, p=quarantine or p=reject).' };
    if (policy === 'none') {
      return { ...base, observed: records[0]!, status: 'warning', message: 'DMARC is in monitoring mode (p=none). After reviewing reports, move to p=quarantine and then p=reject.' };
    }
    return { ...base, observed: records[0]!, status: 'pass', message: `DMARC policy is "${policy}".` };
  }

  private async checkMailHost(): Promise<DnsCheckResult> {
    const host = norm(this.platform.mailHostname);
    const base = { checkType: 'mail_host' as const, recordName: host };
    if (!this.platform.ipv4 && !this.platform.ipv6) {
      return { ...base, expected: null, observed: null, status: 'warning', message: 'The platform public IP address is not configured, so the mail hostname cannot be validated.' };
    }
    const [v4, v6] = await Promise.all([this.platform.ipv4 ? lookup(() => this.resolver.resolve4(host)) : null, this.platform.ipv6 ? lookup(() => this.resolver.resolve6(host)) : null]);
    const expected = [this.platform.ipv4, this.platform.ipv6].filter(Boolean).join(', ');
    const observed = [v4?.ok ? v4.value.join(', ') : null, v6?.ok ? v6.value.join(', ') : null].filter(Boolean).join(' / ') || null;
    if ((v4 && !v4.ok && v4.kind === 'transient') || (v6 && !v6.ok && v6.kind === 'transient')) return { ...base, expected, observed, status: 'error', message: TRANSIENT_MSG };
    const ok4 = !this.platform.ipv4 || (v4?.ok && v4.value.includes(this.platform.ipv4));
    const ok6 = !this.platform.ipv6 || (v6?.ok && v6.value.map((a) => a.toLowerCase()).includes(this.platform.ipv6.toLowerCase()));
    return ok4 && ok6
      ? { ...base, expected, observed, status: 'pass', message: 'Mail hostname resolves to the platform address.' }
      : { ...base, expected, observed, status: 'fail', message: 'Mail hostname does not resolve to the configured platform address (platform operations issue).' };
  }

  private async checkPtr(): Promise<DnsCheckResult | null> {
    if (!this.platform.ipv4) return null;
    const host = norm(this.platform.mailHostname);
    const res = await lookup(() => this.resolver.reverse(this.platform.ipv4!));
    const base = { checkType: 'ptr' as const, recordName: this.platform.ipv4, expected: host };
    if (!res.ok) {
      return { ...base, observed: null, status: res.kind === 'transient' ? 'error' : 'fail', message: res.kind === 'transient' ? TRANSIENT_MSG : 'No reverse DNS (PTR) for the sending IP. This must be set by the hosting/network provider.' };
    }
    const names = res.value.map(norm);
    return names.includes(host)
      ? { ...base, observed: names.join(', '), status: 'pass', message: 'Reverse DNS matches the mail hostname.' }
      : { ...base, observed: names.join(', '), status: 'fail', message: 'Reverse DNS does not match the mail hostname (platform operations issue; set by the network provider).' };
  }
}

const rank: Record<CheckStatus, number> = { pass: 0, pending: 1, warning: 2, error: 3, fail: 4 };

function worst(statuses: CheckStatus[]): CheckStatus {
  return statuses.reduce<CheckStatus>((w, s) => (rank[s] > rank[w] ? s : w), 'pass');
}

function toReadiness(status: CheckStatus | null): ReadinessStatus {
  if (!status) return 'unknown';
  if (status === 'pass') return 'ok';
  if (status === 'warning') return 'warning';
  return 'error';
}

/** Inbound readiness depends on MX only; outbound on SPF + DKIM + DMARC. */
export function computeReadiness(results: DnsCheckResult[]): { inbound: ReadinessStatus; outbound: ReadinessStatus } {
  const mx = results.find((r) => r.checkType === 'mx');
  const outbound = results.filter((r) => r.checkType === 'spf' || r.checkType === 'dkim' || r.checkType === 'dmarc');
  let outboundStatus: CheckStatus | null = null;
  if (outbound.length) {
    const dkim = outbound.filter((r) => r.checkType === 'dkim');
    // One valid DKIM key is sufficient for DMARC alignment; missing additional keys is a warning.
    const dkimStatus: CheckStatus | null = dkim.length ? (dkim.some((d) => d.status === 'pass') ? (dkim.every((d) => d.status === 'pass') ? 'pass' : 'warning') : worst(dkim.map((d) => d.status))) : null;
    const others = outbound.filter((r) => r.checkType !== 'dkim').map((r) => r.status);
    outboundStatus = worst(dkimStatus ? [...others, dkimStatus] : others);
  }
  return { inbound: toReadiness(mx?.status ?? null), outbound: toReadiness(outboundStatus) };
}
