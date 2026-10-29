import { describe, expect, it } from 'vitest';
import { DomainValidationError, isSameOrSubdomain, normalizeDomain } from './domain.js';
import { AddressValidationError, buildAddress, normalizeEmailAddress, normalizeLocalPart } from './email.js';

describe('normalizeDomain', () => {
  it('lowercases, trims and strips a trailing dot', () => {
    expect(normalizeDomain('  Company.COM. ', { allowTestDomains: true })).toBe('company.com');
  });
  it('converts IDNs to punycode', () => {
    expect(normalizeDomain('bücher.example', { allowTestDomains: true })).toBe('xn--bcher-kva.example');
  });
  it.each(['http://company.com', 'company.com/path', 'user@company.com', 'company.com:25', 'a..b.com', 'localhost', '127.0.0.1', '', 'exa mple.com', '-bad.com', 'a.123'])('rejects %j', (bad) => {
    expect(() => normalizeDomain(bad, { allowTestDomains: true })).toThrow(DomainValidationError);
  });
  it('rejects test domains unless allowed, and platform-reserved domains always', () => {
    expect(() => normalizeDomain('foo.example')).toThrow(DomainValidationError);
    expect(normalizeDomain('foo.example', { allowTestDomains: true })).toBe('foo.example');
    expect(() => normalizeDomain('mail.arthvex.net', { reservedDomains: ['arthvex.net'] })).toThrow(DomainValidationError);
  });
  it('isSameOrSubdomain matches on label boundaries', () => {
    expect(isSameOrSubdomain('a.b.com', 'b.com')).toBe(true);
    expect(isSameOrSubdomain('b.com', 'b.com')).toBe(true);
    expect(isSameOrSubdomain('ab.com', 'b.com')).toBe(false);
  });
});

describe('email addresses', () => {
  it('normalizes local parts to lowercase', () => {
    expect(normalizeLocalPart(' Hello.World ')).toBe('hello.world');
  });
  it.each(['', '.start', 'end.', 'sp ace', 'a+tag', 'a'.repeat(65), 'mailer-daemon', 'root'])('rejects local part %j', (bad) => {
    expect(() => normalizeLocalPart(bad)).toThrow(AddressValidationError);
  });
  it('allows role addresses such as postmaster', () => {
    expect(normalizeLocalPart('postmaster')).toBe('postmaster');
  });
  it('builds and normalizes full addresses', () => {
    expect(buildAddress(normalizeLocalPart('Hello'), 'company.com')).toBe('hello@company.com');
    expect(normalizeEmailAddress('Hello@Company.COM')).toBe('hello@company.com');
    expect(() => normalizeEmailAddress('no-at-sign')).toThrow();
  });
});
