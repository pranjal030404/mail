import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AppContext } from './context.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { tenantRoutes } from './modules/tenants/tenants.routes.js';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { consoleRoutes } from './modules/admin/console.routes.js';
import { aliasRoutes } from './modules/aliases/aliases.routes.js';
import { domainRoutes } from './modules/domains/domains.routes.js';
import { mailboxRoutes } from './modules/mailboxes/mailboxes.routes.js';
import { supportRoutes } from './modules/support/support.routes.js';
import { usageRoutes } from './modules/usage/usage.routes.js';
import { webmailRoutes } from './modules/webmail/webmail.routes.js';
import { registerSession } from './plugins/session.js';
import { AppError, type ErrorBody } from './shared/errors.js';

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: ctx.config.LOG_LEVEL === 'silent' ? false : { level: ctx.config.LOG_LEVEL, redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]'] },
    trustProxy: ctx.config.TRUST_PROXY === 'false' ? false : ctx.config.TRUST_PROXY,
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && /^[\w-]{8,64}$/.test(h) ? h : randomUUID();
    },
    bodyLimit: 256 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, hsts: ctx.config.isProduction });
  await app.register(rateLimit, { global: false, hook: 'onRequest' });
  await registerSession(app, ctx);

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('cache-control', 'no-store');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      const body: ErrorBody = { error: { code: err.code, message: err.message, correlationId: req.id, ...(err.details !== undefined ? { details: err.details } : {}) } };
      return reply.code(err.statusCode).send(body);
    }
    const fe = err as { statusCode?: number; code?: string; message: string };
    if (fe.statusCode === 429) return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many requests. Try again later.', correlationId: req.id } } satisfies ErrorBody);
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      return reply.code(fe.statusCode).send({ error: { code: fe.code?.toLowerCase() ?? 'bad_request', message: 'The request could not be processed.', correlationId: req.id } } satisfies ErrorBody);
    }
    // Unexpected: log in full, return nothing internal.
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Something went wrong. Quote the correlation ID if you contact support.', correlationId: req.id } } satisfies ErrorBody);
  });

  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Not found.', correlationId: req.id } } satisfies ErrorBody));

  await app.register(
    async (api) => {
      await healthRoutes(api, ctx);
      await authRoutes(api, ctx);
      await tenantRoutes(api, ctx);
      await domainRoutes(api, ctx);
      await mailboxRoutes(api, ctx);
      await aliasRoutes(api, ctx);
      await usageRoutes(api, ctx);
      await supportRoutes(api, ctx);
      await adminRoutes(api, ctx);
      await consoleRoutes(api, ctx);
      await webmailRoutes(api, ctx);
    },
    { prefix: '/api/v1' },
  );
  return app;
}
