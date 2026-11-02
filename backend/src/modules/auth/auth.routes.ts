import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { one, rows } from '../../db/pool.js';
import { parse, unauthorized } from '../../shared/errors.js';
import { cookieName, requireUser } from '../../plugins/session.js';
import * as auth from './auth.service.js';

const email = z.string().trim().max(254).pipe(z.email());
const password = z.string().min(1).max(256);
const otp = z.string().trim().min(6).max(16);

const limit = (ctx: AppContext, max: number, windowMs = 60_000) => ({ rateLimit: { max: ctx.config.RATE_LIMIT_ENABLED ? max : 1_000_000, timeWindow: windowMs } });

function setSessionCookie(ctx: AppContext, reply: FastifyReply, token: string, expires: Date) {
  reply.setCookie(cookieName(ctx), token, { httpOnly: true, secure: ctx.config.COOKIE_SECURE, sameSite: 'lax', path: '/', expires });
}

export async function memberships(ctx: AppContext, userId: string) {
  return rows<{ tenant_id: string; name: string; slug: string; role: string; tenant_status: string }>(
    ctx.db,
    `SELECT m.tenant_id, t.name, t.slug, m.role, t.status AS tenant_status
       FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = ? AND m.status = 'active' ORDER BY t.name`,
    [userId],
  );
}

export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/auth/register', { config: limit(ctx, 5, 3600_000) }, async (req, reply) => {
    const body = parse(
      z.object({ email, password, displayName: z.string().trim().min(1).max(120), inviteToken: z.string().max(200).optional(), acceptTerms: z.boolean() }),
      req.body,
    );
    await auth.register(ctx, body, req.meta);
    return reply.code(202).send({ ok: true, message: 'If the address can be registered, a verification email has been sent.' });
  });

  app.post('/auth/verify-email', { config: limit(ctx, 20, 3600_000) }, async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
    await auth.verifyEmail(ctx, token, req.meta);
    return { ok: true };
  });

  app.post('/auth/resend-verification', { config: limit(ctx, 5, 3600_000) }, async (req, reply) => {
    const body = parse(z.object({ email }), req.body);
    await auth.resendVerification(ctx, body.email);
    return reply.code(202).send({ ok: true });
  });

  app.post('/auth/login', { config: limit(ctx, 10) }, async (req, reply) => {
    const body = parse(z.object({ email, password }), req.body);
    const result = await auth.login(ctx, body.email, body.password, req.meta);
    const native = req.headers['x-client'] === 'mobile';
    if (native) {
      // Native apps keep the opaque session token in secure storage and send it as a Bearer header.
      return { mfaRequired: result.session.mfaRequired, token: result.token, expiresAt: result.session.expiresAt };
    }
    setSessionCookie(ctx, reply, result.token, result.session.expiresAt);
    return { mfaRequired: result.session.mfaRequired, csrfToken: auth.csrfTokenFor(ctx, result.session.id) };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.auth) await auth.revokeSession(ctx, req.auth.user.id, req.auth.session.id, 'logout', req.auth.user.kind);
    reply.clearCookie(cookieName(ctx), { path: '/' });
    return { ok: true };
  });

  app.post('/auth/forgot-password', { config: limit(ctx, 5, 3600_000) }, async (req, reply) => {
    const body = parse(z.object({ email }), req.body);
    await auth.forgotPassword(ctx, body.email, req.meta);
    return reply.code(202).send({ ok: true, message: 'If an account exists for that address, a reset email has been sent.' });
  });

  app.post('/auth/reset-password', { config: limit(ctx, 10, 3600_000) }, async (req) => {
    const body = parse(z.object({ token: z.string().min(10).max(200), password }), req.body);
    await auth.resetPassword(ctx, body.token, body.password, req.meta);
    return { ok: true };
  });

  app.post('/auth/change-password', async (req) => {
    const { user, session } = requireUser(req);
    const body = parse(z.object({ currentPassword: password, newPassword: password }), req.body);
    await auth.changePassword(ctx, user, session.id, body.currentPassword, body.newPassword, req.meta);
    return { ok: true };
  });

  // ---- MFA
  app.post('/auth/mfa/verify', { config: limit(ctx, 10) }, async (req) => {
    if (!req.auth) throw unauthorized();
    const body = parse(z.object({ code: otp.optional(), recoveryCode: otp.optional() }).refine((v) => v.code || v.recoveryCode, 'Provide a code.'), req.body);
    await auth.mfaVerifySession(ctx, req.auth.user, req.auth.session.id, body, req.meta);
    return { ok: true };
  });

  app.post('/auth/mfa/setup', { config: limit(ctx, 10) }, async (req) => {
    const { user } = requireUser(req);
    const body = parse(z.object({ password }), req.body);
    return auth.mfaBeginSetup(ctx, user, body.password);
  });

  app.post('/auth/mfa/confirm', { config: limit(ctx, 10) }, async (req) => {
    const { user, session } = requireUser(req);
    const body = parse(z.object({ code: otp }), req.body);
    return { recoveryCodes: await auth.mfaConfirmSetup(ctx, user, session.id, body.code, req.meta) };
  });

  app.post('/auth/mfa/disable', { config: limit(ctx, 5) }, async (req) => {
    const { user } = requireUser(req);
    const body = parse(z.object({ password, code: otp }), req.body);
    await auth.mfaDisable(ctx, user, body.password, body.code, req.meta);
    return { ok: true };
  });

  // ---- Sessions
  app.get('/auth/sessions', async (req) => {
    const { user, session } = requireUser(req);
    const list = await auth.listSessions(ctx, user.id, user.kind);
    return {
      sessions: list.map((s) => ({ id: s.id, current: s.id === session.id, ip: s.ip, userAgent: s.user_agent, createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: s.expires_at })),
    };
  });

  app.delete('/auth/sessions/:id', async (req) => {
    const { user, session } = requireUser(req);
    const { id } = parse(z.object({ id: z.string().length(26) }), req.params);
    const revoked = await auth.revokeSession(ctx, user.id, id, 'user_revoked', user.kind);
    return { ok: revoked, current: id === session.id };
  });

  app.post('/auth/sessions/revoke-others', async (req) => {
    const { user, session } = requireUser(req);
    return { revoked: await auth.revokeAllSessions(ctx, user.id, 'user_revoked_others', session.id, user.kind) };
  });

  // ---- Current user
  app.get('/me', async (req) => {
    if (!req.auth) throw unauthorized();
    const { user, session, csrfToken } = req.auth;
    const mfaPending = Boolean(session.mfa_pending);
    const base = {
      csrfToken,
      mfaPending,
      user: { id: user.id, email: user.login_email, displayName: user.display_name, mfaEnabled: Boolean(user.mfa_enabled), platformRole: user.platform_role, roleKey: user.role_key ?? null, permissions: [...(user.permissions ?? [])].sort(), timezone: user.timezone, locale: user.locale },
    };
    if (mfaPending) return { ...base, memberships: [], mfaSetupRequired: false };
    const isPlatformAdmin = user.kind === 'platform_admin';
    return {
      ...base,
      mfaSetupRequired: isPlatformAdmin && ctx.config.ADMIN_MFA_REQUIRED && !user.mfa_enabled,
      memberships: isPlatformAdmin ? [] : (await memberships(ctx, user.id)).map((m) => ({ tenantId: m.tenant_id, name: m.name, slug: m.slug, role: m.role, tenantStatus: m.tenant_status })),
    };
  });

  app.patch('/me', async (req) => {
    const { user } = requireUser(req);
    const body = parse(z.object({ displayName: z.string().trim().min(1).max(120).optional(), timezone: z.string().max(64).optional(), locale: z.string().max(16).optional() }), req.body);
    const table = auth.principalTable(user.kind);
    await ctx.db.query(`UPDATE ${table} SET display_name = COALESCE(?, display_name), timezone = COALESCE(?, timezone), locale = COALESCE(?, locale) WHERE id = ?`, [body.displayName ?? null, body.timezone ?? null, body.locale ?? null, user.id]);
    const fresh = await one<{ display_name: string; timezone: string; locale: string }>(ctx.db, `SELECT display_name, timezone, locale FROM ${table} WHERE id = ?`, [user.id]);
    return { displayName: fresh?.display_name, timezone: fresh?.timezone, locale: fresh?.locale };
  });
}
