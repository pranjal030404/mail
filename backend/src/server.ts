import { buildApp } from './app.js';
import { createAppContext } from './bootstrap.js';
import { loadConfig } from './config/env.js';

const config = loadConfig();
const bootLog = { info: console.log, warn: console.warn, error: console.error, debug: () => undefined };
const ctx = createAppContext(bootLog, config);
const app = await buildApp(ctx);
ctx.log = app.log;

if (ctx.mail.kind === 'dev') app.log.warn('DEVELOPMENT mail adapter active: no real email is sent or received.');
if (ctx.mailer.kind === 'dev') app.log.warn('DEVELOPMENT mailer active: notifications are written to a local outbox, not sent.');

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await ctx.db.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
