import { createInterface } from 'node:readline';
import { loadConfig } from '../config/env.js';
import { createPool, exec, one } from '../db/pool.js';
import { hashPassword } from '../modules/auth/password.js';
import { newId } from '../shared/ids.js';
import { passwordProblem } from '../core/index.js';

/**
 * Usage: npm run admin:create -- [email] ["Display Name"] [super_admin|operations|support]
 *
 * Values fall back to ADMIN_EMAIL / ADMIN_NAME / ADMIN_ROLE / ADMIN_PASSWORD in the environment
 * (backend/.env), so the account can be provisioned non-interactively. The password is never
 * echoed. Platform administrators live in `platform_admins`, separate from customer `users`,
 * and must enrol two-factor authentication at first sign-in.
 */
async function promptHidden(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
  process.stdout.write(question);
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => undefined;
  return new Promise((resolve) =>
    rl.question('', (a) => {
      (rl as unknown as { _writeToOutput: typeof write })._writeToOutput = write;
      process.stdout.write('\n');
      rl.close();
      resolve(a);
    }),
  );
}

const [emailArg, nameArg, roleArg] = process.argv.slice(2);
const email = (emailArg ?? process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const name = (nameArg ?? process.env.ADMIN_NAME ?? '').trim();
const role = roleArg ?? process.env.ADMIN_ROLE ?? 'super_admin';
if (!email || !name || !['super_admin', 'operations', 'support'].includes(role)) {
  console.error('Usage: npm run admin:create -- <email> "<Display Name>" [super_admin|operations|support]');
  console.error('   or set ADMIN_EMAIL, ADMIN_NAME and ADMIN_ROLE in .env.');
  process.exit(1);
}
const emailProblem = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? null : 'Enter a valid email address.';
if (emailProblem) {
  console.error(emailProblem);
  process.exit(1);
}
const config = loadConfig();
const password = process.env.ADMIN_PASSWORD || (await promptHidden('Password (min 12 chars): '));
const problem = passwordProblem(password, { email });
if (problem) {
  console.error(problem);
  process.exit(1);
}
const db = createPool(config);
try {
  // An address belongs to exactly one principal type; never shadow a customer account.
  const customer = await one<{ id: string }>(db, 'SELECT id FROM users WHERE login_email = ?', [email]);
  if (customer) {
    console.error(`${email} already belongs to a customer account. Use a different admin address.`);
    process.exit(1);
  }
  const existing = await one<{ id: string }>(db, 'SELECT id FROM platform_admins WHERE login_email = ?', [email]);
  const passwordHash = await hashPassword(password, config.ARGON2_MEMORY_KIB);
  if (existing) {
    await exec(
      db,
      "UPDATE platform_admins SET display_name = ?, role = ?, role_id = (SELECT id FROM rbac_roles WHERE role_key = ?), status = 'active', password_hash = ?, failed_login_count = 0, locked_until = NULL, suspended_reason = NULL WHERE id = ?",
      [name, role, role, passwordHash, existing.id],
    );
    console.log(`Updated ${role} ${email}. Password and status synchronised from ADMIN_PASSWORD.`);
  } else {
    await exec(
      db,
      "INSERT INTO platform_admins (id, login_email, display_name, password_hash, role, role_id, status) VALUES (?, ?, ?, ?, ?, (SELECT id FROM rbac_roles WHERE role_key = ?), 'active')",
      [newId(), email, name, passwordHash, role, role],
    );
    console.log(`Created ${role} ${email}. They must enrol two-factor authentication at first sign-in.`);
  }
} finally {
  await db.end();
}
