import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  APP_BASE_URL: z.url().default('http://localhost:5173'),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  TRUST_PROXY: z.string().default('loopback'),
  COOKIE_SECURE: bool(true),

  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().default(3306),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().default(''),
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),

  /** 32 random bytes, base64. Encrypts MFA secrets and redisplayable verification tokens. */
  APP_ENCRYPTION_KEY: z.string().min(40),
  /** Secret for HMAC-derived CSRF tokens. */
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).default(24 * 7),
  SESSION_IDLE_HOURS: z.coerce.number().int().min(1).default(24),
  ADMIN_MFA_REQUIRED: bool(true),
  RATE_LIMIT_ENABLED: bool(true),
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(4096).default(19456),

  MAIL_ADAPTER: z.enum(['stalwart', 'dev']).default('dev'),
  STALWART_URL: z.string().optional(),
  STALWART_ADMIN_USER: z.string().optional(),
  STALWART_ADMIN_SECRET: z.string().optional(),
  STALWART_TIMEOUT_MS: z.coerce.number().int().min(500).default(10000),
  DEV_MAIL_ENGINE_STATE: z.string().default('./var/dev-mail-engine/state.json'),

  /** Public mail hostname used in MX records and client settings, e.g. mail.arthvex.example */
  MAIL_HOSTNAME: z.string().min(1),
  MAIL_PUBLIC_IPV4: z.string().optional(),
  MAIL_PUBLIC_IPV6: z.string().optional(),
  IMAP_PORT: z.coerce.number().int().default(993),
  SUBMISSION_PORT: z.coerce.number().int().default(465),
  SUBMISSION_STARTTLS_PORT: z.coerce.number().int().optional(),
  JMAP_URL: z.string().optional(),
  WEBMAIL_URL: z.string().optional(),

  /** Built-in webmail. Requires a real mail engine in production (never the dev simulator). */
  WEBMAIL_ENABLED: bool(true),
  /** Base URL of the mailbox JMAP endpoint. Defaults to STALWART_URL when set. */
  WEBMAIL_JMAP_URL: z.string().optional(),
  WEBMAIL_MAX_ATTACHMENT_BYTES: z.coerce.number().int().min(1024).max(100 * 1024 * 1024).default(10 * 1024 * 1024),
  WEBMAIL_MAX_ATTACHMENTS: z.coerce.number().int().min(1).max(20).default(10),
  WEBMAIL_BODY_MAX_CHARS: z.coerce.number().int().min(1000).max(2_000_000).default(400_000),
  WEBMAIL_DEV_STATE: z.string().default('./var/dev-webmail/state.json'),

  /** Exceptional mailbox access grants (two-person rule, short-lived). */
  ADMIN_ACCESS_GRANT_TTL_MINUTES: z.coerce.number().int().min(5).max(240).default(60),
  RESERVED_DOMAINS: csv,
  ALLOW_TEST_DOMAINS: bool(false),

  MAILER: z.enum(['smtp', 'dev']).default('dev'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(465),
  SMTP_SECURE: bool(true),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default('ARTHVEX <no-reply@localhost>'),
  /** Lifetime of admin-issued account invitations. */
  INVITE_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(72),
  /** Minimum gap between invitation resends for the same account. */
  INVITE_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(60),
  /** Delivery attempts for a queued email before it is marked failed (retryable by an administrator). */
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(12).default(6),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  DEV_OUTBOX_DIR: z.string().default('./var/dev-outbox'),

  DNS_RESOLVERS: csv,
  DNS_TIMEOUT_MS: z.coerce.number().int().min(200).max(20000).default(4000),
  DOMAIN_VERIFICATION_TTL_DAYS: z.coerce.number().int().min(1).default(14),

  WORKER_POLL_MS: z.coerce.number().int().min(100).default(2000),
  WORKER_LEASE_SECONDS: z.coerce.number().int().min(10).default(120),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  BACKUP_MAX_AGE_HOURS: z.coerce.number().int().default(26),
});

export type Config = z.infer<typeof EnvSchema> & { appOrigin: string; isProduction: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  const config: Config = { ...cfg, appOrigin: new URL(cfg.APP_BASE_URL).origin, isProduction: cfg.NODE_ENV === 'production' };
  assertSafeConfig(config);
  return config;
}

/** Refuses to start production with development-only shortcuts enabled. */
export function assertSafeConfig(c: Config): void {
  const problems: string[] = [];
  if (Buffer.from(c.APP_ENCRYPTION_KEY, 'base64').length !== 32) {
    problems.push('APP_ENCRYPTION_KEY must be 32 bytes encoded as base64 (openssl rand -base64 32).');
  }
  if (c.MAIL_ADAPTER === 'stalwart' && (!c.STALWART_URL || !c.STALWART_ADMIN_USER || !c.STALWART_ADMIN_SECRET)) {
    problems.push('MAIL_ADAPTER=stalwart requires STALWART_URL, STALWART_ADMIN_USER and STALWART_ADMIN_SECRET.');
  }
  if (c.MAILER === 'smtp' && !c.SMTP_HOST) problems.push('MAILER=smtp requires SMTP_HOST.');
  if (c.WEBMAIL_ENABLED && c.MAIL_ADAPTER === 'stalwart' && !c.WEBMAIL_JMAP_URL && !c.STALWART_URL) {
    problems.push('WEBMAIL_ENABLED with MAIL_ADAPTER=stalwart requires STALWART_URL or WEBMAIL_JMAP_URL.');
  }
  if (c.isProduction) {
    if (c.MAIL_ADAPTER === 'dev') problems.push('The development mail adapter cannot be used in production.');
    if (c.WEBMAIL_ENABLED && c.MAIL_ADAPTER === 'dev') problems.push('Built-in webmail cannot use the development mail simulator in production.');
    if (c.WEBMAIL_ENABLED && c.WEBMAIL_MAX_ATTACHMENT_BYTES > 50 * 1024 * 1024) problems.push('WEBMAIL_MAX_ATTACHMENT_BYTES above 50 MiB is not allowed in production.');
    if (c.MAILER === 'dev') problems.push('The development mailer (file outbox) cannot be used in production.');
    if (!c.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true in production.');
    if (!c.ADMIN_MFA_REQUIRED) problems.push('ADMIN_MFA_REQUIRED must be true in production.');
    if (c.ALLOW_TEST_DOMAINS) problems.push('ALLOW_TEST_DOMAINS must be false in production.');
    if (!c.APP_BASE_URL.startsWith('https://')) problems.push('APP_BASE_URL must use https:// in production.');
  }
  if (problems.length) throw new Error(`Unsafe configuration:\n  ${problems.join('\n  ')}`);
}
