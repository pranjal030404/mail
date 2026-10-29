import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, totpCode, verifyTotp } from './totp.js';

describe('TOTP (RFC 6238)', () => {
  // RFC 6238 Appendix B, SHA-1, secret "12345678901234567890", T=59s → 94287082 (8 digits) → last 6 = 287082.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it('matches the RFC 6238 test vector', () => {
    expect(totpCode(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpCode(secret, Math.floor(1111111109 / 30))).toBe('081804');
  });
  it('round-trips base32', () => {
    expect(base32Decode(base32Encode(Buffer.from('hello world'))).toString()).toBe('hello world');
  });
  it('accepts ±1 step and rejects others and malformed input', () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 1000 / 30);
    expect(verifyTotp(secret, totpCode(secret, step), now)).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 5), now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });
});
