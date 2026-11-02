import { randomBytes } from 'node:crypto';
import { loadConfig } from '../config/env.js';
import { createPool, exec, one } from '../db/pool.js';
import { hashPassword } from '../modules/auth/password.js';
import { newId } from '../shared/ids.js';
import { passwordProblem } from '../core/index.js';

/**
 * Idempotent platform-admin seeder.
 *
 *   npm run seed:admin                      # uses ADMIN_EMAIL / ADMIN_NAME / ADMIN_ROLE from .env
 *   npm run seed:admin -- you@x.com "Name"  # or pass them as arguments
 *   npm run seed:admin -- --reset           # also reset the password of an existing admin
 *
 * Password: ADMIN_PASSWORD if set (quote it in .env, an unquoted `#` starts a comment), otherwise a
 * strong random one is generated and printed ONCE. An existing admin is left untouched unless
 * --reset is passed, so this is safe to run on every deploy. Run `npm run db:migrate` first.
 */
const args = process.argv.slice(2);
const reset = args.includes('--reset');
const [emailArg, nameArg, roleArg] = args.filter((a) => !a.startsWith('--'));
const email = (emailArg ?? process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const name = (nameArg ?? process.env.ADMIN_NAME ?? 'Platform Admin').trim();
const role = roleArg ?? process.env.ADMIN_ROLE ?? 'super_admin';

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Set ADMIN_EMAIL in .env or pass an email: npm run seed:admin -- you@example.com "Your Name"');
  process.exit(1);
}
if (!['super_admin', 'operations', 'support'].includes(role)) {
  console.error('Role must be super_admin, operations or support.');
  process.exit(1);
}

const config = loadConfig();
const db = createPool(config);
try {
  const customer = await one<{ id: string }>(db, 'SELECT id FROM users WHERE login_email = ?', [email]);
  if (customer) {
    console.error(`${email} already belongs to a customer account. Use a different admin address.`);
    process.exit(1);
  }
  const roleRow = await one<{ id: string }>(db, 'SELECT id FROM rbac_roles WHERE role_key = ?', [role]);
  if (!roleRow) {
    console.error(`RBAC role "${role}" not found. Run: npm run db:migrate`);
    process.exit(1);
  }

  const existing = await one<{ id: string }>(db, 'SELECT id FROM platform_admins WHERE login_email = ?', [email]);
  if (existing && !reset) {
    console.log(`Admin ${email} already exists. Nothing changed (use --reset to set a new password).`);
    process.exit(0);
  }

  const supplied = process.env.ADMIN_PASSWORD;
  // Generated passwords use only unambiguous characters and always satisfy the policy.
  const generated = randomBytes(18).toString('base64url') + '-Aa1';
  const password = supplied || generated;
  const problem = passwordProblem(password, { email });
  if (problem) {
    console.error(`ADMIN_PASSWORD rejected: ${problem}`);
    process.exit(1);
  }
  const hash = await hashPassword(password, config.ARGON2_MEMORY_KIB);

  if (existing) {
    await exec(
      db,
      "UPDATE platform_admins SET display_name = ?, role = ?, role_id = ?, status = 'active', password_hash = ?, failed_login_count = 0, locked_until = NULL, suspended_reason = NULL WHERE id = ?",
      [name, role, roleRow.id, hash, existing.id],
    );
    console.log(`Reset ${role} ${email}.`);
  } else {
    await exec(
      db,
      "INSERT INTO platform_admins (id, login_email, display_name, password_hash, role, role_id, status) VALUES (?, ?, ?, ?, ?, ?, 'active')",
      [newId(), email, name, hash, role, roleRow.id],
    );
    console.log(`Created ${role} ${email}.`);
  }
  if (!supplied) {
    console.log(`\nGenerated password (shown once, store it now):\n\n  ${generated}\n`);
  }
  console.log('Sign in at /admin. Two-factor enrolment is required at first sign-in.');
} finally {
  await db.end();
}
