import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config/env.js';
import type { Db } from './db/pool.js';
import type { DnsResolverLike } from './modules/dns/dns.service.js';
import type { MailServerAdapter } from './modules/mail-server/mail-server.interface.js';
import type { Mailer } from './modules/notifications/mailer.js';
import type { WebmailAdapter } from './modules/webmail/webmail.interface.js';
import { SecretBox } from './shared/crypto.js';

/** Dependencies shared by the API and the worker. Tests construct this with fakes. */
export interface AppContext {
  config: Config;
  db: Db;
  mail: MailServerAdapter;
  webmail: WebmailAdapter;
  mailer: Mailer;
  dnsResolver: DnsResolverLike;
  secrets: SecretBox;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
}

export function createSecretBox(config: Config): SecretBox {
  return new SecretBox(config.APP_ENCRYPTION_KEY);
}
