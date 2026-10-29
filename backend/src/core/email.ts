import { normalizeDomain, type NormalizeDomainOptions } from './domain.js';

export class AddressValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AddressValidationError';
  }
}

/**
 * Local parts that customers may never create: system identities and names the
 * platform relies on. Role addresses such as postmaster@ and abuse@ are allowed
 * (and recommended) so each customer domain can receive them.
 */
export const RESERVED_LOCAL_PARTS = new Set([
  'mailer-daemon',
  'root',
  'daemon',
  'nobody',
  'system',
  'arthvex',
  'arthvex-verification',
]);

export const ROLE_LOCAL_PARTS = ['postmaster', 'abuse', 'hostmaster', 'webmaster', 'security'];

/**
 * Mailbox local parts are case-insensitive on this platform and stored in lowercase.
 * Allowed: a-z, 0-9, dot, underscore, hyphen. "+" is reserved for sub-addressing.
 */
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export function normalizeLocalPart(raw: string): string {
  if (typeof raw !== 'string') throw new AddressValidationError('invalid_local_part', 'Enter a mailbox name.');
  const lp = raw.trim().toLowerCase();
  if (lp.length === 0) throw new AddressValidationError('invalid_local_part', 'Enter a mailbox name.');
  if (lp.length > 64) throw new AddressValidationError('invalid_local_part', 'Mailbox names can be at most 64 characters.');
  if (lp.includes('+')) {
    throw new AddressValidationError('invalid_local_part', '"+" is reserved for sub-addressing and cannot be used in a mailbox name.');
  }
  if (!LOCAL_PART_RE.test(lp) || lp.includes('..')) {
    throw new AddressValidationError(
      'invalid_local_part',
      'Use letters, numbers, dots, hyphens or underscores. The name must start and end with a letter or number.',
    );
  }
  if (RESERVED_LOCAL_PARTS.has(lp)) {
    throw new AddressValidationError('reserved_local_part', `"${lp}" is a reserved name and cannot be used.`);
  }
  return lp;
}

export function buildAddress(localPart: string, domain: string): string {
  return `${localPart}@${domain}`;
}

/**
 * Normalizes an arbitrary email address (login emails, forwarding destinations).
 * The whole address is lowercased; the domain is converted to ASCII.
 */
export function normalizeEmailAddress(raw: string, opts: NormalizeDomainOptions = { allowTestDomains: true }): string {
  if (typeof raw !== 'string') throw new AddressValidationError('invalid_email', 'Enter a valid email address.');
  const input = raw.trim();
  if (input.length === 0 || input.length > 254) throw new AddressValidationError('invalid_email', 'Enter a valid email address.');
  const at = input.lastIndexOf('@');
  if (at <= 0 || at === input.length - 1) throw new AddressValidationError('invalid_email', 'Enter a valid email address.');
  const local = input.slice(0, at).toLowerCase();
  if (local.length > 64 || !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    throw new AddressValidationError('invalid_email', 'Enter a valid email address.');
  }
  let domain: string;
  try {
    domain = normalizeDomain(input.slice(at + 1), opts);
  } catch {
    throw new AddressValidationError('invalid_email', 'Enter a valid email address.');
  }
  return `${local}@${domain}`;
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1);
}
