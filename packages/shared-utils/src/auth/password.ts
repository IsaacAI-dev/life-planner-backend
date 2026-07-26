import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';

const ARGON2_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

/** Hash a plaintext password with argon2id. */
export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTS);
}

/** Verify a plaintext password against an argon2 hash. Never throws on mismatch. */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/**
 * Deterministic SHA-256 of a token, used to store refresh tokens hashed so a
 * DB leak does not expose usable tokens. (Tokens are high-entropy, so a fast
 * hash is appropriate here — unlike passwords.)
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A cryptographically-random url-safe token (e.g. for iCal feed URLs). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
