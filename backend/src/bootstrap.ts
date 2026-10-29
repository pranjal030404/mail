import { loadConfig, type Config } from './config/env.js';
import { createSecretBox, type AppContext } from './context.js';
import { createPool } from './db/pool.js';
import { createSystemResolver } from './modules/dns/dns.service.js';
import { createMailServerAdapter } from './modules/mail-server/factory.js';
import { createMailer } from './modules/notifications/mailer.js';
import { createWebmailAdapter } from './modules/webmail/factory.js';

type Logger = AppContext['log'];

/** Builds the production/development dependency graph shared by the API and the worker. */
export function createAppContext(log: Logger, config: Config = loadConfig()): AppContext {
  return {
    config,
    db: createPool(config),
    mail: createMailServerAdapter(config),
    webmail: createWebmailAdapter(config),
    mailer: createMailer(config),
    dnsResolver: createSystemResolver({ servers: config.DNS_RESOLVERS, timeoutMs: config.DNS_TIMEOUT_MS }),
    secrets: createSecretBox(config),
    log,
  };
}
