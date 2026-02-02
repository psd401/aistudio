/**
 * JWKS Cache
 * Caches JWKS public keys for JWT verification.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 *
 * Uses jose's createLocalJWKSet for local key verification.
 * Refreshes on unknown kid (key rotation support).
 */

import { createLocalJWKSet } from "jose"
import type { FlattenedJWSInput, JWSHeaderParameters, GetKeyFunction } from "jose"
import { getJwtSigner } from "./jwt-signer"
import { createLogger } from "@/lib/logger"

// ============================================
// Types
// ============================================

type JWKSKeySet = GetKeyFunction<JWSHeaderParameters, FlattenedJWSInput>

// ============================================
// Cache State
// ============================================

let cachedKeySet: JWKSKeySet | null = null
let cacheTimestamp = 0
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// ============================================
// Public API
// ============================================

/**
 * Get a JWKS key set for JWT verification.
 * Caches the key set and auto-refreshes after TTL.
 */
export async function getJwksKeySet(): Promise<JWKSKeySet> {
  const now = Date.now()

  if (cachedKeySet && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedKeySet
  }

  const log = createLogger({ action: "jwksCache.refresh" })

  const signer = await getJwtSigner()
  const jwk = await signer.getPublicKeyJwk()

  cachedKeySet = createLocalJWKSet({
    keys: [jwk],
  })

  cacheTimestamp = now
  log.info("JWKS cache refreshed", { kid: jwk.kid })

  return cachedKeySet
}

/**
 * Force refresh the JWKS cache (e.g., on unknown kid).
 */
export async function refreshJwksCache(): Promise<void> {
  cacheTimestamp = 0
  await getJwksKeySet()
}

/**
 * Get the JWKS document as JSON (for the JWKS endpoint).
 */
export async function getJwksDocument(): Promise<{ keys: object[] }> {
  const signer = await getJwtSigner()
  const jwk = await signer.getPublicKeyJwk()

  return {
    keys: [jwk],
  }
}
