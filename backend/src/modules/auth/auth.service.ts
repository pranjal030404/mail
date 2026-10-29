import { passwordProblem, type PlatformRole } from '../../core/index.js';
import type { AppContext } from '../../context.js';
import { exec, isDuplicateKey, one, rows, tx } from '../../db/pool.js';
import { AppError, badRequest, conflict, forbidden, unauthorized } from '../../shared/errors.js';
import { hmacHex, randomToken, safeEqual, sha256Hex } from '../../shared/crypto.js';
import { newId } from '../../shared/ids.js';
import { audit } from '../audit/audit.service.js';
import { templates } from '../notifications/templates.js';
import { getSettings } from '../settings/settings.service.js';
import { hashPassword, verifyPassword } from './password.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp.js';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;
const EMAIL_TOKEN_HOURS = 24;
const RESET_TOKEN_MINUTES = 30;
const RECOVERY_CODE_COUNT = 10;

/** Platform staff are a separate principal type from tenant users. */
export type PrincipalKind = 'user' | 'platform_admin';

/**
 * The authenticated principal. Admins are normalised to this shape so route code can stay
 * principal-agnostic, while every write still targets the correct table.
 */
export interface AuthUser {
  id: string;
  kind: PrincipalKind;
  login_email: string;
  display_name: string;
  password_hash: string;
  status: 'pending_verification' | 'active' | 'suspended' | 'closed';
  platform_role: PlatformRole;
  email_verified_at: Date | null;
  mfa_enabled: number;
  timezone: string;
  locale: string;
  failed_login_count: number;
  locked_until: Date | null;
}

/** Raw `users` row. Customer accounts never carry a platform role. */
export interface UserRecord {
  id: string;
  login_email: string;
  display_name: string;
  password_hash: string;
  status: 'pending_verification' | 'active' | 'suspended' | 'closed';
  email_verified_at: Date | null;
  mfa_enabled: number;
  timezone: string;
  locale: string;
  failed_login_count: number;
  locked_until: Date | null;
}

/** Raw `platform_admins` row. */
export interface AdminRecord {
  id: string;
  login_email: string;
  display_name: string;
  password_hash: string;
  role: 'operations' | 'super_admin';
  status: 'pending_verification' | 'active' | 'suspended' | 'closed';
  mfa_enabled: number;
  timezone: string;
  locale: string;
  failed_login_count: number;
  locked_until: Date | null;
}

export function userToPrincipal(u: UserRecord): AuthUser {
  return { ...u, kind: 'user', platform_role: 'none' };
}

export function adminToPrincipal(a: AdminRecord): AuthUser {
  return { ...a, kind: 'platform_admin', platform_role: a.role, email_verified_at: null };
}

/** Table that owns the principal's credentials. */
export function principalTable(kind: PrincipalKind): 'users' | 'platform_admins' {
  return kind === 'platform_admin' ? 'platform_admins' : 'users';
}

export function sessionColumn(kind: PrincipalKind): 'user_id' | 'admin_id' {
  return kind === 'platform_admin' ? 'admin_id' : 'user_id';
}

export function mfaTable(kind: PrincipalKind): 'mfa_credentials' | 'admin_mfa_credentials' {
  return kind === 'platform_admin' ? 'admin_mfa_credentials' : 'mfa_credentials';
}

export function recoveryTable(kind: PrincipalKind): 'mfa_recovery_codes' | 'admin_mfa_recovery_codes' {
  return kind === 'platform_admin' ? 'admin_mfa_recovery_codes' : 'mfa_recovery_codes';
}

export function principalOwnerColumn(kind: PrincipalKind): 'user_id' | 'admin_id' {
  return kind === 'platform_admin' ? 'admin_id' : 'user_id';
}

/** Audit attribution: admins are recorded against actor_admin_id, users against actor_user_id. */
export function auditActor(user: Pick<AuthUser, 'id' | 'kind'>) {
  return user.kind === 'platform_admin'
    ? { actorType: 'platform_admin' as const, actorUserId: null, actorAdminId: user.id }
    : { actorType: 'user' as const, actorUserId: user.id, actorAdminId: null };
}

export interface SessionRow {
  id: string;
  user_id: string | null;
  admin_id: string | null;
  mfa_verified: number;
  mfa_pending: number;
  ip: string | null;
  user_agent: string | null;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
}

export interface RequestMeta {
  ip: string;
  userAgent: string;
  correlationId: string;
}

export function normalizeLoginEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function csrfTokenFor(ctx: AppContext, sessionId: string): string {
  return hmacHex(ctx.config.SESSION_SECRET, `csrf:${sessionId}`);
}

export function isCsrfValid(ctx: AppContext, sessionId: string, presented: string | undefined): boolean {
  return typeof presented === 'string' && safeEqual(csrfTokenFor(ctx, sessionId), presented);
}

// A precomputed hash lets login for unknown emails take the same time as a real verification.
let dummyHash: Promise<string> | null = null;
function getDummyHash(ctx: AppContext): Promise<string> {
  dummyHash ??= hashPassword(randomToken(16), ctx.config.ARGON2_MEMORY_KIB);
  return dummyHash;
}

async function issueEmailVerification(ctx: AppContext, user: Pick<UserRecord, 'id' | 'login_email'>): Promise<void> {
  const token = randomToken();
  await exec(ctx.db, 'UPDATE email_verification_tokens SET used_at = NOW(3) WHERE user_id = ? AND used_at IS NULL', [user.id]);
  await exec(
    ctx.db,
    'INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? HOUR))',
    [newId(), user.id, sha256Hex(token), EMAIL_TOKEN_HOURS],
  );
  const m = templates.verifyEmail(ctx.config.APP_BASE_URL, token);
  await ctx.mailer.send({ to: user.login_email, subject: m.subject, text: m.text, category: 'verify_email' });
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
  inviteToken?: string | undefined;
  acceptTerms: boolean;
}

/**
 * Always resolves the same way for the caller so the response cannot be used to learn
 * whether an address is registered. Genuine problems (policy, closed signup) are explicit.
 */
export async function register(ctx: AppContext, input: RegisterInput, meta: RequestMeta): Promise<void> {
  const email = normalizeLoginEmail(input.email);
  const problem = passwordProblem(input.password, { email });
  if (problem) throw badRequest('weak_password', problem);
  if (!input.acceptTerms) throw badRequest('terms_required', 'You must accept the terms and privacy notice.');

  const settings = await getSettings(ctx.db);
  let inviteId: string | null = null;
  if (settings.signup_mode === 'closed') throw forbidden('signup_closed', 'Registration is currently closed.');
  if (settings.signup_mode === 'invite_only') {
    if (!input.inviteToken) throw forbidden('invite_required', 'Registration is by invitation only during the private beta.');
    const inv = await one<{ id: string; email: string }>(
      ctx.db,
      'SELECT id, email FROM signup_invitations WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW(3)',
      [sha256Hex(input.inviteToken)],
    );
    if (!inv || inv.email !== email) throw forbidden('invite_invalid', 'This invitation is invalid, expired or for a different email address.');
    inviteId = inv.id;
  }

  const existing = await one<{ id: string }>(ctx.db, 'SELECT id FROM users WHERE login_email = ?', [email]);
  if (existing) {
    const m = templates.accountExists(ctx.config.APP_BASE_URL);
    await ctx.mailer.send({ to: email, subject: m.subject, text: m.text, category: 'account_exists' });
    await audit(ctx.db, { actorType: 'anonymous', action: 'auth.register', outcome: 'failure', reason: 'email_exists', correlationId: meta.correlationId, ip: meta.ip });
    return;
  }

  const userId = newId();
  const passwordHash = await hashPassword(input.password, ctx.config.ARGON2_MEMORY_KIB);
  try {
    await tx(ctx.db, async (conn) => {
      await exec(conn, 'INSERT INTO users (id, login_email, display_name, password_hash) VALUES (?, ?, ?, ?)', [userId, email, input.displayName.trim(), passwordHash]);
      await exec(conn, 'INSERT INTO notification_preferences (user_id) VALUES (?)', [userId]);
      for (const document of ['terms', 'privacy'] as const) {
        await exec(conn, 'INSERT INTO terms_acceptances (id, user_id, document, version, ip) VALUES (?, ?, ?, ?, ?)', [newId(), userId, document, settings.terms_version, meta.ip]);
      }
      if (inviteId) await exec(conn, 'UPDATE signup_invitations SET used_at = NOW(3) WHERE id = ?', [inviteId]);
      await audit(conn, { actorType: 'user', actorUserId: userId, action: 'auth.register', targetType: 'user', targetId: userId, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip });
    });
  } catch (err) {
    if (isDuplicateKey(err)) return; // concurrent registration of the same address
    throw err;
  }
  await issueEmailVerification(ctx, { id: userId, login_email: email });
}

export async function verifyEmail(ctx: AppContext, token: string, meta: RequestMeta): Promise<void> {
  const row = await one<{ id: string; user_id: string }>(
    ctx.db,
    'SELECT id, user_id FROM email_verification_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW(3)',
    [sha256Hex(token)],
  );
  if (!row) throw badRequest('invalid_token', 'This verification link is invalid or has expired.');
  await tx(ctx.db, async (conn) => {
    // Single-use: the conditional update fails if a concurrent request used the token first.
    const res = await exec(conn, 'UPDATE email_verification_tokens SET used_at = NOW(3) WHERE id = ? AND used_at IS NULL', [row.id]);
    if (res.affectedRows !== 1) throw badRequest('invalid_token', 'This verification link is invalid or has expired.');
    await exec(conn, "UPDATE users SET email_verified_at = NOW(3), status = IF(status = 'pending_verification', 'active', status) WHERE id = ?", [row.user_id]);
    await audit(conn, { actorType: 'user', actorUserId: row.user_id, action: 'auth.verify_email', targetType: 'user', targetId: row.user_id, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip });
  });
}

export async function resendVerification(ctx: AppContext, emailRaw: string): Promise<void> {
  const user = await one<UserRecord>(ctx.db, "SELECT * FROM users WHERE login_email = ? AND status = 'pending_verification'", [normalizeLoginEmail(emailRaw)]);
  if (!user) return;
  const recent = await one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM email_verification_tokens WHERE user_id = ? AND created_at > DATE_SUB(NOW(3), INTERVAL 5 MINUTE)', [user.id]);
  if (recent && recent.n > 0) return;
  await issueEmailVerification(ctx, user);
}

export interface LoginResult {
  token: string;
  session: { id: string; expiresAt: Date; mfaRequired: boolean };
  user: AuthUser;
}

const GENERIC_LOGIN_ERROR = () => new AppError(401, 'invalid_credentials', 'Incorrect email or password.');

/** Steps common to customer and platform-admin sign-in. Every write is routed to the owning table. */
async function completeLogin(ctx: AppContext, user: AuthUser, password: string, meta: RequestMeta): Promise<LoginResult> {
  const table = principalTable(user.kind);
  const locked = user.locked_until && user.locked_until.getTime() > Date.now();
  const ok = await verifyPassword(user.password_hash, password);
  if (locked || !ok) {
    if (!locked) {
      const count = user.failed_login_count + 1;
      await exec(ctx.db, `UPDATE ${table} SET failed_login_count = ?, locked_until = IF(? >= ?, DATE_ADD(NOW(3), INTERVAL ? MINUTE), locked_until) WHERE id = ?`, [
        count,
        count,
        MAX_FAILED_LOGINS,
        LOCKOUT_MINUTES,
        user.id,
      ]);
    }
    await audit(ctx.db, { ...auditActor(user), action: 'auth.login', outcome: 'failure', reason: locked ? 'locked' : 'bad_password', correlationId: meta.correlationId, ip: meta.ip });
    throw GENERIC_LOGIN_ERROR();
  }
  // Correct password past this point; these states are safe to describe.
  if (user.status === 'pending_verification') throw new AppError(403, 'email_not_verified', 'Verify your email address before signing in.');
  if (user.status !== 'active') {
    await audit(ctx.db, { ...auditActor(user), action: 'auth.login', outcome: 'denied', reason: `status_${user.status}`, correlationId: meta.correlationId, ip: meta.ip });
    throw new AppError(403, 'account_unavailable', 'This account is not available. Contact support.');
  }

  const ownerColumn = sessionColumn(user.kind);
  const priorSameIp = await one<{ n: number }>(
    ctx.db,
    `SELECT COUNT(*) AS n FROM sessions WHERE ${ownerColumn} = ? AND ip = ? AND created_at > DATE_SUB(NOW(3), INTERVAL 30 DAY)`,
    [user.id, meta.ip],
  );
  const mfaRequired = Boolean(user.mfa_enabled);
  const token = randomToken();
  const sessionId = newId();
  await exec(ctx.db, `UPDATE ${table} SET failed_login_count = 0, locked_until = NULL, last_login_at = NOW(3) WHERE id = ?`, [user.id]);
  await exec(
    ctx.db,
    `INSERT INTO sessions (id, user_id, admin_id, token_hash, mfa_verified, mfa_pending, ip, user_agent, expires_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? HOUR))`,
    [
      sessionId,
      user.kind === 'user' ? user.id : null,
      user.kind === 'platform_admin' ? user.id : null,
      sha256Hex(token),
      mfaRequired ? 1 : 0,
      meta.ip,
      meta.userAgent.slice(0, 255),
      ctx.config.SESSION_TTL_HOURS,
    ],
  );
  await audit(ctx.db, { ...auditActor(user), action: 'auth.login', targetType: 'session', targetId: sessionId, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip, metadata: { mfaPending: mfaRequired } });
  if (!priorSameIp || priorSameIp.n === 0) {
    const m = templates.newLogin(meta.ip, meta.userAgent);
    await ctx.mailer.send({ to: user.login_email, subject: m.subject, text: m.text, category: 'new_login' }).catch((e) => ctx.log.warn({ err: (e as Error).message }, 'new-login email failed'));
  }
  const expires = new Date(Date.now() + ctx.config.SESSION_TTL_HOURS * 3600_000);
  return { token, session: { id: sessionId, expiresAt: expires, mfaRequired }, user };
}

export async function login(ctx: AppContext, emailRaw: string, password: string, meta: RequestMeta): Promise<LoginResult> {
  const email = normalizeLoginEmail(emailRaw);
  // Platform admins are checked first: an address belongs to exactly one principal type.
  const admin = await one<AdminRecord>(ctx.db, 'SELECT * FROM platform_admins WHERE login_email = ?', [email]);
  if (admin) return completeLogin(ctx, adminToPrincipal(admin), password, meta);
  const user = await one<UserRecord>(ctx.db, 'SELECT * FROM users WHERE login_email = ?', [email]);
  if (!user) {
    await verifyPassword(await getDummyHash(ctx), password);
    await audit(ctx.db, { actorType: 'anonymous', action: 'auth.login', outcome: 'failure', reason: 'unknown_user', correlationId: meta.correlationId, ip: meta.ip });
    throw GENERIC_LOGIN_ERROR();
  }
  return completeLogin(ctx, userToPrincipal(user), password, meta);
}

/** Resolves a session token to a live session and principal, enforcing absolute and idle expiry. */
export async function resolveSession(ctx: AppContext, token: string): Promise<{ session: SessionRow; user: AuthUser } | null> {
  const s = await one<SessionRow>(
    ctx.db,
    `SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > NOW(3)
       AND last_seen_at > DATE_SUB(NOW(3), INTERVAL ? HOUR)`,
    [sha256Hex(token), ctx.config.SESSION_IDLE_HOURS],
  );
  if (!s) return null;
  let user: AuthUser | null = null;
  if (s.admin_id) {
    const admin = await one<AdminRecord>(ctx.db, "SELECT * FROM platform_admins WHERE id = ? AND status = 'active'", [s.admin_id]);
    if (admin) user = adminToPrincipal(admin);
  } else if (s.user_id) {
    const record = await one<UserRecord>(ctx.db, "SELECT * FROM users WHERE id = ? AND status = 'active'", [s.user_id]);
    if (record) user = userToPrincipal(record);
  }
  if (!user) return null;
  // Throttle write amplification: touch at most once a minute.
  if (Date.now() - s.last_seen_at.getTime() > 60_000) await exec(ctx.db, 'UPDATE sessions SET last_seen_at = NOW(3) WHERE id = ?', [s.id]);
  return { session: s, user };
}

export async function revokeSession(ctx: AppContext, principalId: string, sessionId: string, reason: string, kind: PrincipalKind = 'user'): Promise<boolean> {
  const column = sessionColumn(kind);
  const res = await exec(ctx.db, `UPDATE sessions SET revoked_at = NOW(3), revoked_reason = ? WHERE id = ? AND ${column} = ? AND revoked_at IS NULL`, [reason, sessionId, principalId]);
  return res.affectedRows === 1;
}

export async function revokeAllSessions(ctx: AppContext, principalId: string, reason: string, exceptSessionId?: string, kind: PrincipalKind = 'user'): Promise<number> {
  const column = sessionColumn(kind);
  const res = await exec(
    ctx.db,
    `UPDATE sessions SET revoked_at = NOW(3), revoked_reason = ? WHERE ${column} = ? AND revoked_at IS NULL AND id <> ?`,
    [reason, principalId, exceptSessionId ?? ''],
  );
  return res.affectedRows;
}

export async function listSessions(ctx: AppContext, principalId: string, kind: PrincipalKind = 'user') {
  const column = sessionColumn(kind);
  return rows<SessionRow>(
    ctx.db,
    `SELECT id, user_id, admin_id, mfa_verified, mfa_pending, ip, user_agent, created_at, last_seen_at, expires_at FROM sessions WHERE ${column} = ? AND revoked_at IS NULL AND expires_at > NOW(3) ORDER BY last_seen_at DESC`,
    [principalId],
  );
}

export async function forgotPassword(ctx: AppContext, emailRaw: string, meta: RequestMeta): Promise<void> {
  // Platform admins reset credentials via the operator runbook (env + admin:create), not email.
  const user = await one<UserRecord>(ctx.db, "SELECT * FROM users WHERE login_email = ? AND status IN ('active','pending_verification')", [normalizeLoginEmail(emailRaw)]);
  await audit(ctx.db, { actorType: 'anonymous', actorUserId: user?.id ?? null, action: 'auth.forgot_password', outcome: 'success', correlationId: meta.correlationId, ip: meta.ip });
  if (!user) return;
  const token = randomToken();
  await exec(ctx.db, 'UPDATE password_reset_tokens SET used_at = NOW(3) WHERE user_id = ? AND used_at IS NULL', [user.id]);
  await exec(ctx.db, 'INSERT INTO password_reset_tokens (id, user_id, token_hash, requested_ip, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? MINUTE))', [
    newId(),
    user.id,
    sha256Hex(token),
    meta.ip,
    RESET_TOKEN_MINUTES,
  ]);
  const m = templates.passwordReset(ctx.config.APP_BASE_URL, token);
  await ctx.mailer.send({ to: user.login_email, subject: m.subject, text: m.text, category: 'password_reset' });
}

export async function resetPassword(ctx: AppContext, token: string, newPassword: string, meta: RequestMeta): Promise<void> {
  const row = await one<{ id: string; user_id: string; login_email: string }>(
    ctx.db,
    `SELECT t.id, t.user_id, u.login_email FROM password_reset_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > NOW(3)`,
    [sha256Hex(token)],
  );
  if (!row) throw badRequest('invalid_token', 'This reset link is invalid or has expired.');
  const problem = passwordProblem(newPassword, { email: row.login_email });
  if (problem) throw badRequest('weak_password', problem);
  const passwordHash = await hashPassword(newPassword, ctx.config.ARGON2_MEMORY_KIB);
  await tx(ctx.db, async (conn) => {
    const res = await exec(conn, 'UPDATE password_reset_tokens SET used_at = NOW(3) WHERE id = ? AND used_at IS NULL', [row.id]);
    if (res.affectedRows !== 1) throw badRequest('invalid_token', 'This reset link is invalid or has expired.');
    await exec(conn, 'UPDATE users SET password_hash = ?, failed_login_count = 0, locked_until = NULL WHERE id = ?', [passwordHash, row.user_id]);
    await exec(conn, "UPDATE sessions SET revoked_at = NOW(3), revoked_reason = 'password_reset' WHERE user_id = ? AND revoked_at IS NULL", [row.user_id]);
    await audit(conn, { actorType: 'user', actorUserId: row.user_id, action: 'auth.reset_password', targetType: 'user', targetId: row.user_id, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip });
  });
  const m = templates.passwordChanged();
  await ctx.mailer.send({ to: row.login_email, subject: m.subject, text: m.text, category: 'password_changed' }).catch(() => undefined);
}

export async function changePassword(ctx: AppContext, user: AuthUser, sessionId: string, current: string, next: string, meta: RequestMeta): Promise<void> {
  if (!(await verifyPassword(user.password_hash, current))) throw new AppError(403, 'invalid_credentials', 'Current password is incorrect.');
  const problem = passwordProblem(next, { email: user.login_email });
  if (problem) throw badRequest('weak_password', problem);
  await exec(ctx.db, `UPDATE ${principalTable(user.kind)} SET password_hash = ? WHERE id = ?`, [await hashPassword(next, ctx.config.ARGON2_MEMORY_KIB), user.id]);
  await revokeAllSessions(ctx, user.id, 'password_changed', sessionId, user.kind);
  await audit(ctx.db, { ...auditActor(user), action: 'auth.change_password', targetType: user.kind === 'platform_admin' ? 'platform_admin' : 'user', targetId: user.id, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip });
  const m = templates.passwordChanged();
  await ctx.mailer.send({ to: user.login_email, subject: m.subject, text: m.text, category: 'password_changed' }).catch(() => undefined);
}

// ---------------------------------------------------------------- MFA

export async function mfaBeginSetup(ctx: AppContext, user: AuthUser, password: string): Promise<{ secret: string; otpauthUri: string }> {
  if (!(await verifyPassword(user.password_hash, password))) throw new AppError(403, 'invalid_credentials', 'Password is incorrect.');
  if (user.mfa_enabled) throw conflict('mfa_already_enabled', 'Two-factor authentication is already enabled.');
  const secret = generateTotpSecret();
  await exec(
    ctx.db,
    `INSERT INTO ${mfaTable(user.kind)} (id, ${principalOwnerColumn(user.kind)}, type, secret_encrypted) VALUES (?, ?, 'totp', ?)
     ON DUPLICATE KEY UPDATE secret_encrypted = VALUES(secret_encrypted), confirmed_at = NULL, last_used_step = NULL`,
    [newId(), user.id, ctx.secrets.encrypt(secret)],
  );
  return { secret, otpauthUri: otpauthUri(secret, user.login_email) };
}

function newRecoveryCode(): string {
  const raw = randomToken(8).replace(/[-_]/g, 'x').slice(0, 10).toLowerCase();
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export async function mfaConfirmSetup(ctx: AppContext, user: AuthUser, sessionId: string, code: string, meta: RequestMeta): Promise<string[]> {
  const credTable = mfaTable(user.kind);
  const owner = principalOwnerColumn(user.kind);
  const cred = await one<{ id: string; secret_encrypted: string; confirmed_at: Date | null }>(ctx.db, `SELECT id, secret_encrypted, confirmed_at FROM ${credTable} WHERE ${owner} = ? AND type = 'totp'`, [user.id]);
  if (!cred || cred.confirmed_at) throw badRequest('mfa_not_pending', 'Start two-factor setup first.');
  const step = verifyTotp(ctx.secrets.decrypt(cred.secret_encrypted), code);
  if (step === null) throw badRequest('invalid_code', 'That code is not correct.');
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await tx(ctx.db, async (conn) => {
    await exec(conn, `UPDATE ${credTable} SET confirmed_at = NOW(3), last_used_step = ? WHERE id = ?`, [step, cred.id]);
    await exec(conn, `UPDATE ${principalTable(user.kind)} SET mfa_enabled = 1 WHERE id = ?`, [user.id]);
    const codesTable = recoveryTable(user.kind);
    await exec(conn, `DELETE FROM ${codesTable} WHERE ${owner} = ?`, [user.id]);
    for (const c of codes) await exec(conn, `INSERT INTO ${codesTable} (id, ${owner}, code_hash) VALUES (?, ?, ?)`, [newId(), user.id, sha256Hex(c)]);
    await exec(conn, 'UPDATE sessions SET mfa_verified = 1, mfa_pending = 0 WHERE id = ?', [sessionId]);
    await audit(conn, { ...auditActor(user), action: 'auth.mfa_enabled', targetType: user.kind === 'platform_admin' ? 'platform_admin' : 'user', targetId: user.id, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip });
  });
  const m = templates.mfaChanged(true);
  await ctx.mailer.send({ to: user.login_email, subject: m.subject, text: m.text, category: 'mfa_changed' }).catch(() => undefined);
  return codes;
}

/** Completes a pending (post-password) session with a TOTP code or a one-time recovery code. */
export async function mfaVerifySession(ctx: AppContext, user: AuthUser, sessionId: string, input: { code?: string | undefined; recoveryCode?: string | undefined }, meta: RequestMeta): Promise<void> {
  const credTable = mfaTable(user.kind);
  const owner = principalOwnerColumn(user.kind);
  let ok = false;
  if (input.code) {
    const cred = await one<{ id: string; secret_encrypted: string; last_used_step: number | null }>(
      ctx.db,
      `SELECT id, secret_encrypted, last_used_step FROM ${credTable} WHERE ${owner} = ? AND type = 'totp' AND confirmed_at IS NOT NULL`,
      [user.id],
    );
    const step = cred ? verifyTotp(ctx.secrets.decrypt(cred.secret_encrypted), input.code) : null;
    if (cred && step !== null) {
      // Replay protection: a time step may be used once. The conditional update makes it atomic.
      const res = await exec(ctx.db, `UPDATE ${credTable} SET last_used_step = ? WHERE id = ? AND (last_used_step IS NULL OR last_used_step < ?)`, [step, cred.id, step]);
      ok = res.affectedRows === 1;
    }
  } else if (input.recoveryCode) {
    const codesTable = recoveryTable(user.kind);
    const res = await exec(ctx.db, `UPDATE ${codesTable} SET used_at = NOW(3) WHERE ${owner} = ? AND code_hash = ? AND used_at IS NULL`, [user.id, sha256Hex(input.recoveryCode.trim().toLowerCase())]);
    ok = res.affectedRows === 1;
  }
  if (!ok) {
    await audit(ctx.db, { ...auditActor(user), action: 'auth.mfa_verify', outcome: 'failure', correlationId: meta.correlationId, ip: meta.ip });
    // Count against the account lockout so TOTP codes cannot be brute-forced.
    const table = principalTable(user.kind);
    await exec(ctx.db, `UPDATE ${table} SET failed_login_count = failed_login_count + 1, locked_until = IF(failed_login_count + 1 >= ?, DATE_ADD(NOW(3), INTERVAL ? MINUTE), locked_until) WHERE id = ?`, [MAX_FAILED_LOGINS, LOCKOUT_MINUTES, user.id]);
    const fresh = await one<{ locked_until: Date | null }>(ctx.db, `SELECT locked_until FROM ${table} WHERE id = ?`, [user.id]);
    if (fresh?.locked_until && fresh.locked_until.getTime() > Date.now()) {
      await revokeSession(ctx, user.id, sessionId, 'mfa_lockout', user.kind);
    }
    throw badRequest('invalid_code', 'That code is not correct.');
  }
  await exec(ctx.db, 'UPDATE sessions SET mfa_verified = 1, mfa_pending = 0 WHERE id = ?', [sessionId]);
  await exec(ctx.db, `UPDATE ${principalTable(user.kind)} SET failed_login_count = 0 WHERE id = ?`, [user.id]);
  await audit(ctx.db, { ...auditActor(user), action: 'auth.mfa_verify', outcome: 'success', correlationId: meta.correlationId, ip: meta.ip });
}

export async function mfaDisable(ctx: AppContext, user: AuthUser, password: string, code: string, meta: RequestMeta): Promise<void> {
  if (user.platform_role !== 'none' && ctx.config.ADMIN_MFA_REQUIRED) throw forbidden('mfa_required_for_admins', 'Platform administrators cannot disable two-factor authentication.');
  if (!(await verifyPassword(user.password_hash, password))) throw new AppError(403, 'invalid_credentials', 'Password is incorrect.');
  const credTable = mfaTable(user.kind);
  const owner = principalOwnerColumn(user.kind);
  const cred = await one<{ secret_encrypted: string }>(ctx.db, `SELECT secret_encrypted FROM ${credTable} WHERE ${owner} = ? AND type = 'totp' AND confirmed_at IS NOT NULL`, [user.id]);
  if (!cred || verifyTotp(ctx.secrets.decrypt(cred.secret_encrypted), code) === null) throw badRequest('invalid_code', 'That code is not correct.');
  await tx(ctx.db, async (conn) => {
    await exec(conn, `DELETE FROM ${credTable} WHERE ${owner} = ?`, [user.id]);
    await exec(conn, `DELETE FROM ${recoveryTable(user.kind)} WHERE ${owner} = ?`, [user.id]);
    await exec(conn, `UPDATE ${principalTable(user.kind)} SET mfa_enabled = 0 WHERE id = ?`, [user.id]);
    await audit(conn, { ...auditActor(user), action: 'auth.mfa_disabled', targetType: user.kind === 'platform_admin' ? 'platform_admin' : 'user', targetId: user.id, outcome: 'success', correlationId: meta.correlationId, ip: meta.ip });
  });
  const m = templates.mfaChanged(false);
  await ctx.mailer.send({ to: user.login_email, subject: m.subject, text: m.text, category: 'mfa_changed' }).catch(() => undefined);
}

export { unauthorized };
