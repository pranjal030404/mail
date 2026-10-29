import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { platformCan, type PlatformAction } from '../core/index.js';
import type { AppContext } from '../context.js';
import { AppError, forbidden, unauthorized } from '../shared/errors.js';
import { csrfTokenFor, isCsrfValid, resolveSession, type AuthUser, type RequestMeta, type SessionRow } from '../modules/auth/auth.service.js';
import { getSettings } from '../modules/settings/settings.service.js';

export interface AuthState {
  user: AuthUser;
  session: SessionRow;
  csrfToken: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthState | null;
    meta: RequestMeta;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Public endpoints that run before a session exists; still protected by the Origin check. */
const CSRF_TOKEN_EXEMPT = new Set(['/api/v1/auth/login', '/api/v1/auth/register', '/api/v1/auth/forgot-password', '/api/v1/auth/reset-password', '/api/v1/auth/verify-email', '/api/v1/auth/resend-verification', '/api/v1/abuse-reports']);

export function cookieName(ctx: AppContext): string {
  return ctx.config.COOKIE_SECURE ? '__Host-arthvex_sid' : 'arthvex_sid';
}

export async function registerSession(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await app.register(cookie);
  app.decorateRequest('auth', null);
  app.decorateRequest('meta', null as unknown as RequestMeta);

  app.addHook('onRequest', async (req) => {
    req.meta = { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? ''), correlationId: req.id };
    const token = req.cookies[cookieName(ctx)];
    if (token) {
      const found = await resolveSession(ctx, token);
      if (found) req.auth = { user: found.user, session: found.session, csrfToken: csrfTokenFor(ctx, found.session.id) };
    }
  });

  // CSRF: Origin must match for browser-originated writes, and authenticated writes need the token header.
  app.addHook('preHandler', async (req) => {
    if (SAFE_METHODS.has(req.method)) return;
    const origin = req.headers.origin;
    if (origin && origin !== ctx.config.appOrigin) throw forbidden('bad_origin', 'Cross-origin request rejected.');
    const path = req.url.split('?')[0] ?? '';
    if (req.auth && !CSRF_TOKEN_EXEMPT.has(path)) {
      const presented = req.headers['x-csrf-token'];
      if (!isCsrfValid(ctx, req.auth.session.id, typeof presented === 'string' ? presented : undefined)) {
        throw forbidden('csrf_invalid', 'Missing or invalid CSRF token.');
      }
    }
  });

  // Maintenance mode blocks everything except health and platform staff.
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/api/v1/health') || req.url.startsWith('/api/v1/status')) return;
    const settings = await getSettings(ctx.db);
    if (settings.maintenance_mode && (!req.auth || req.auth.user.platform_role === 'none')) {
      throw new AppError(503, 'maintenance', settings.maintenance_message || 'ARTHVEX is undergoing maintenance. Please try again shortly.');
    }
  });
}

/** A fully authenticated user: session exists and any required second factor is complete. */
export function requireUser(req: FastifyRequest): AuthState {
  if (!req.auth) throw unauthorized();
  if (req.auth.session.mfa_pending) throw new AppError(401, 'mfa_required', 'Enter your two-factor code to continue.');
  return req.auth;
}

/** Platform staff access: role permission plus a verified second factor when policy requires it. */
export function requirePlatform(ctx: AppContext, req: FastifyRequest, action: PlatformAction): AuthState {
  const auth = requireUser(req);
  if (!platformCan(auth.user.platform_role, action)) throw forbidden();
  if (ctx.config.ADMIN_MFA_REQUIRED && !auth.session.mfa_verified) {
    throw new AppError(403, 'mfa_setup_required', 'Platform administrators must enable and use two-factor authentication.');
  }
  return auth;
}
