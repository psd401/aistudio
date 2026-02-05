/**
 * Argon2 Loader for Next.js
 *
 * Uses direct require('argon2') which works because argon2 is listed in
 * serverExternalPackages — both webpack and Turbopack preserve the require
 * call as-is without bundling it.
 *
 * Previous approach using createRequire was eliminated by webpack at build
 * time (replaced with `(void 0)`), breaking argon2 loading on ECS.
 *
 * This file is server-only — never imported by client components.
 */

// ============================================
// Types
// ============================================

interface Argon2Module {
  hash(password: string, options?: {
    type?: number;
    memoryCost?: number;
    timeCost?: number;
    parallelism?: number;
    hashLength?: number;
  }): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
  argon2id: number;
}

let argon2Module: Argon2Module | null = null;

/**
 * Lazy-load argon2 at runtime via require (preserved by webpack externals
 * and serverExternalPackages).
 */
function getArgon2(): Argon2Module {
  if (argon2Module) return argon2Module;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  argon2Module = require('argon2') as Argon2Module;
  return argon2Module;
}

/**
 * Hash a string using Argon2id with secure defaults.
 *
 * Configuration:
 * - memoryCost: 65536 (64 MB) - prevents GPU attacks
 * - timeCost: 3 iterations - balances security and performance
 * - parallelism: 4 threads - leverages multi-core CPUs
 * - hashLength: 32 bytes (256 bits)
 *
 * Output: ~97 char encoded string ($argon2id$v=19$m=...$salt$hash)
 */
export async function hashArgon2(input: string): Promise<string> {
  const argon2 = getArgon2();
  return await argon2.hash(input, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
    hashLength: 32,
  });
}

/**
 * Verify a string against an Argon2id hash.
 * Uses Argon2's built-in constant-time comparison.
 */
export async function verifyArgon2(hash: string, input: string): Promise<boolean> {
  try {
    const argon2 = getArgon2();
    return await argon2.verify(hash, input);
  } catch {
    return false;
  }
}
