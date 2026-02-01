/**
 * Argon2 Loader for Next.js with Turbopack
 *
 * Problem: argon2 is a native C++ addon that Turbopack cannot resolve at
 * compile time — not via static import, dynamic import(), webpackIgnore,
 * or require() with a literal string.
 *
 * Solution: Use createRequire with a variable module name so Turbopack's
 * static analysis cannot determine the module at compile time.
 *
 * This file is server-only — never imported by client components.
 */

import { createRequire } from "node:module";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let argon2Module: any = null;

// Module name stored in a variable to prevent Turbopack static analysis
const ARGON2_MODULE = "argon2";

/**
 * Lazy-load argon2 at runtime using createRequire with a non-literal module name.
 * Turbopack can only trace literal strings — variable references bypass analysis.
 */
function getArgon2() {
  if (argon2Module) return argon2Module;

  const dynamicRequire = createRequire(__filename);
  argon2Module = dynamicRequire(ARGON2_MODULE);
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
