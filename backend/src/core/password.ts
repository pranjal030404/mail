const COMMON = new Set([
  'password',
  'password1',
  'password123',
  '123456789012',
  'qwertyuiop12',
  'letmein12345',
  'welcome12345',
  'administrator',
  'changeme1234',
  'iloveyou1234',
]);

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/** Returns a user-facing problem description, or null when the password is acceptable. */
export function passwordProblem(password: string, context: { email?: string } = {}): string | null {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'This password is too common.';
  if (/^(.)\1+$/.test(password)) return 'Do not repeat a single character.';
  if (context.email) {
    const local = context.email.split('@')[0]?.toLowerCase();
    if (lower === context.email.toLowerCase() || (local && local.length >= 4 && lower.includes(local))) {
      return 'Do not use your email address in your password.';
    }
  }
  if (new Set(password).size < 5) return 'Use a greater variety of characters.';
  return null;
}
