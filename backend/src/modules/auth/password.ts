import { hash, verify } from '@node-rs/argon2';

/** Argon2id (the library default) with parameters taken from configuration. */
export function hashPassword(password: string, memoryKiB: number): Promise<string> {
  return hash(password, { memoryCost: memoryKiB, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(phc: string, password: string): Promise<boolean> {
  try {
    return await verify(phc, password);
  } catch {
    return false;
  }
}
