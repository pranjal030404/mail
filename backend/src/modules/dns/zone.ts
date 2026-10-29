import type { ExpectedDnsRecord, ExpectedRecordPurpose } from '../mail-server/mail-server.interface.js';

/**
 * Parses the zone-file text returned by Stalwart's `x:Domain.dnsZoneFile`
 * (verified against v0.16.27) into structured records. Handles parenthesised
 * multi-line records and multi-string TXT values.
 */
export function parseZoneFile(zone: string, domain: string): ExpectedDnsRecord[] {
  const logical: string[] = [];
  let buf = '';
  let depth = 0;
  for (const rawLine of zone.split('\n')) {
    const line = stripComment(rawLine);
    if (!line.trim() && depth === 0) continue;
    for (const ch of line) {
      if (ch === '(') depth++;
      if (ch === ')') depth = Math.max(0, depth - 1);
    }
    buf += ` ${line.replace(/[()]/g, ' ')}`;
    if (depth === 0) {
      logical.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) logical.push(buf.trim());

  const out: ExpectedDnsRecord[] = [];
  for (const entry of logical) {
    const m = /^(\S+)\s+(?:\d+\s+)?IN\s+(MX|TXT|CNAME|SRV|A|AAAA)\s+(.+)$/i.exec(entry);
    if (!m) continue;
    const name = m[1]!.replace(/\.$/, '').toLowerCase();
    const type = m[2]!.toUpperCase() as ExpectedDnsRecord['type'];
    let rdata = m[3]!.trim();
    let priority: number | undefined;
    if (type === 'TXT') {
      rdata = joinTxtStrings(rdata);
    } else if (type === 'MX') {
      const mx = /^(\d+)\s+(\S+)$/.exec(rdata);
      if (!mx) continue;
      priority = Number(mx[1]);
      rdata = mx[2]!.replace(/\.$/, '').toLowerCase();
    } else {
      rdata = rdata.replace(/\.$/, '');
    }
    out.push({ type, name, value: rdata, priority, ...classify(type, name, rdata, domain) });
  }
  return out;
}

function stripComment(line: string): string {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== '\\') inQuote = !inQuote;
    if (ch === ';' && !inQuote) return line.slice(0, i);
  }
  return line;
}

export function joinTxtStrings(rdata: string): string {
  const parts = [...rdata.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((p) => p[1]!.replace(/\\"/g, '"'));
  return parts.length ? parts.join('') : rdata;
}

function classify(type: string, name: string, value: string, domain: string): { purpose: ExpectedRecordPurpose; required: boolean } {
  if (type === 'MX') return { purpose: 'inbound', required: true };
  if (type === 'TXT' && name === domain && value.toLowerCase().startsWith('v=spf1')) return { purpose: 'spf', required: true };
  if (type === 'TXT' && name.endsWith(`._domainkey.${domain}`)) return { purpose: 'dkim', required: true };
  if (type === 'TXT' && name === `_dmarc.${domain}`) return { purpose: 'dmarc', required: true };
  if (name.startsWith('mta-sts.') || name.startsWith('_mta-sts.')) return { purpose: 'mta_sts', required: false };
  if (name.startsWith('_smtp._tls.')) return { purpose: 'tls_rpt', required: false };
  if (type === 'SRV') return { purpose: 'srv', required: false };
  if (/^(_?ua-auto-config|autoconfig|autodiscover)\./.test(name)) return { purpose: 'autoconfig', required: false };
  return { purpose: 'other', required: false };
}
