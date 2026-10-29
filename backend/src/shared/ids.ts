import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = 0;
let lastRandom: number[] = [];

function encodeTime(time: number): string {
  let out = '';
  for (let i = 9; i >= 0; i--) {
    const mod = time % 32;
    out = ALPHABET[mod] + out;
    time = (time - mod) / 32;
  }
  return out;
}

/**
 * Monotonic ULID: 26 chars, lexicographically sortable by creation time.
 * Within the same millisecond the random component is incremented, so ids
 * created later in the same process always sort after earlier ones.
 */
export function newId(): string {
  const now = Date.now();
  if (now === lastTime && lastRandom.length) {
    let i = lastRandom.length - 1;
    while (i >= 0) {
      if (lastRandom[i]! < 31) {
        lastRandom[i]!++;
        break;
      }
      lastRandom[i] = 0;
      i--;
    }
  } else {
    const bytes = randomBytes(16);
    lastRandom = Array.from(bytes, (b) => b % 32);
    lastTime = now;
  }
  return encodeTime(now) + lastRandom.map((n) => ALPHABET[n]).join('');
}

export function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}
