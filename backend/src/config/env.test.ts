import { describe, expect, it } from 'vitest';
import { assertSafeConfig, loadConfig } from './env.js';

const base = {
  NODE_ENV: 'production',
  APP_BASE_URL: 'https://mail.example.test',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  SESSION_SECRET: 'x'.repeat(48),
  DB_NAME: 'arthvex',
  DB_USER: 'arthvex',
  MAIL_HOSTNAME: 'mail.example.test',
  COOKIE_SECURE: 'true',
  ADMIN_MFA_REQUIRED: 'true',
  ALLOW_TEST_DOMAINS: 'false',
  MAIL_ADAPTER: 'stalwart',
  MAILER: 'smtp',
  SMTP_HOST: 'smtp.example.test',
  STALWART_URL: 'https://127.0.0.1:8080',
  STALWART_ADMIN_USER: 'admin',
  STALWART_ADMIN_SECRET: 'secret',
  WEBMAIL_ENABLED: 'true',
} as const;

const cfg = (over: Record<string, string | undefined> = {}) => loadConfig({ ...base, ...over } as NodeJS.ProcessEnv);

describe('production configuration safety', () => {
  it('accepts a complete production configuration', () => {
    const c = cfg();
    expect(c.isProduction).toBe(true);
    expect(c.WEBMAIL_ENABLED).toBe(true);
    expect(c.WEBMAIL_MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
  });

  it('refuses the development mail adapter', () => {
    expect(() => cfg({ MAIL_ADAPTER: 'dev' })).toThrow(/development mail adapter/i);
  });

  it('refuses the development mailer', () => {
    expect(() => cfg({ MAILER: 'dev' })).toThrow(/development mailer/i);
  });

  it('refuses insecure cookies and non-HTTPS base URLs', () => {
    expect(() => cfg({ COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    expect(() => cfg({ APP_BASE_URL: 'http://mail.example.test' })).toThrow(/https/i);
  });

  it('refuses disabled admin MFA', () => {
    expect(() => cfg({ ADMIN_MFA_REQUIRED: 'false' })).toThrow(/ADMIN_MFA_REQUIRED/);
  });

  it('refuses a test-domain allowance', () => {
    expect(() => cfg({ ALLOW_TEST_DOMAINS: 'true' })).toThrow(/ALLOW_TEST_DOMAINS/);
  });

  it('refuses an oversized webmail attachment cap', () => {
    expect(() => cfg({ WEBMAIL_MAX_ATTACHMENT_BYTES: String(60 * 1024 * 1024) })).toThrow(/WEBMAIL_MAX_ATTACHMENT_BYTES/);
  });

  it('refuses missing Stalwart credentials and a bad encryption key', () => {
    expect(() => cfg({ STALWART_ADMIN_SECRET: '' })).toThrow(/STALWART_ADMIN_SECRET/);
    expect(() => assertSafeConfig({ ...cfg(), APP_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') })).toThrow(/32 bytes/);
  });
});
