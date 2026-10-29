/**
 * Domain-name normalization shared by the API, the worker and the browser.
 *
 * Canonical form: lowercase ASCII (IDNA/punycode), no trailing dot.
 * Uses the WHATWG URL parser for IDNA conversion so behaviour is identical in
 * Node.js and browsers.
 */

export class DomainValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainValidationError';
  }
}

/** Suffixes that can never be claimed as customer domains. */
const ALWAYS_RESERVED_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'private',
  'arpa',
  'invalid',
  'onion',
  'alt',
];

/** RFC 2606 / RFC 6761 names that are only allowed when test domains are enabled (development). */
const TEST_SUFFIXES = ['test', 'example', 'example.com', 'example.net', 'example.org'];

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export interface NormalizeDomainOptions {
  allowTestDomains?: boolean;
  /** Extra platform-owned domains that customers must not claim (e.g. the mail hostname's domain). */
  reservedDomains?: string[];
}

function toAscii(input: string): string {
  // The URL parser applies UTS #46 processing (IDNA) and lowercases.
  let host: string;
  try {
    host = new URL(`http://${input}/`).hostname;
  } catch {
    throw new DomainValidationError('invalid_domain', 'Enter a valid domain name, for example company.com.');
  }
  return host;
}

export function normalizeDomain(raw: string, opts: NormalizeDomainOptions = {}): string {
  if (typeof raw !== 'string') {
    throw new DomainValidationError('invalid_domain', 'Enter a valid domain name.');
  }
  let input = raw.trim().toLowerCase();
  if (input.endsWith('.')) input = input.slice(0, -1);
  if (input.length === 0) {
    throw new DomainValidationError('invalid_domain', 'Enter a domain name.');
  }
  // Reject anything that looks like a URL, address, path or port rather than a bare domain.
  if (/[\s/@:?#\\[\]*]/.test(input) || input.includes('..')) {
    throw new DomainValidationError(
      'invalid_domain',
      'Enter only the domain name (for example company.com), without http://, paths, ports or email addresses.',
    );
  }
  const ascii = toAscii(input);
  if (ascii !== ascii.toLowerCase() || ascii.length > 253) {
    throw new DomainValidationError('invalid_domain', 'The domain name is too long or invalid.');
  }
  // IPv4 literals are parsed by the URL parser as hosts — reject them explicitly.
  if (/^[0-9.]+$/.test(ascii)) {
    throw new DomainValidationError('invalid_domain', 'IP addresses cannot be used as email domains.');
  }
  const labels = ascii.split('.');
  if (labels.length < 2) {
    throw new DomainValidationError('invalid_domain', 'Enter a fully qualified domain such as company.com.');
  }
  for (const label of labels) {
    if (!LABEL_RE.test(label)) {
      throw new DomainValidationError('invalid_domain', `The domain contains an invalid label: "${label}".`);
    }
  }
  const tld = labels[labels.length - 1]!;
  if (/^[0-9]+$/.test(tld)) {
    throw new DomainValidationError('invalid_domain', 'The top-level domain is invalid.');
  }
  if (matchesSuffix(ascii, ALWAYS_RESERVED_SUFFIXES)) {
    throw new DomainValidationError('reserved_domain', 'This domain uses a reserved or private suffix and cannot host public email.');
  }
  if (!opts.allowTestDomains && matchesSuffix(ascii, TEST_SUFFIXES)) {
    throw new DomainValidationError('reserved_domain', 'Documentation and test domains cannot be used.');
  }
  for (const reserved of opts.reservedDomains ?? []) {
    const r = reserved.toLowerCase().replace(/\.$/, '');
    if (r && (ascii === r || ascii.endsWith(`.${r}`))) {
      throw new DomainValidationError('reserved_domain', 'This domain is reserved by the platform.');
    }
  }
  return ascii;
}

function matchesSuffix(domain: string, suffixes: string[]): boolean {
  return suffixes.some((s) => domain === s || domain.endsWith(`.${s}`));
}

/** True when `candidate` is equal to or a subdomain of `parent`. */
export function isSameOrSubdomain(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.endsWith(`.${parent}`);
}
