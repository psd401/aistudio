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
import { getOidcSigningKeySet } from "./oidc-signing-key-store"
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

  const keys = await getVerificationKeys()

  cachedKeySet = createLocalJWKSet({
    keys,
  })

  cacheTimestamp = now
  log.info("JWKS cache refreshed", {
    kids: keys.map((key) => key.kid),
  })

  return cachedKeySet
}

/**
 * Force refresh the JWKS cache (e.g., on unknown kid).
 */
export async function refreshJwksCache(): Promise<void> {
  cacheTimestamp = 0
  await getJwksKeySet()
}

async function getVerificationKeys(): Promise<
  Array<Record<string, unknown>>
> {
  const oidcKeys = await getOidcSigningKeySet()
  const keys = oidcKeys.publicKeys.map((key) => ({
    ...key,
  })) as Array<Record<string, unknown>>

  // Delegated-agent tokens continue to use the non-exportable application KMS
  // key. Include that public key in the API verifier without exposing or
  // coupling it to oidc-provider's private OIDC key set.
  if (process.env.KMS_SIGNING_KEY_ARN) {
    const signer = await getJwtSigner()
    const delegatedKey = await signer.getPublicKeyJwk()
    if (!keys.some((key) => key.kid === delegatedKey.kid)) {
      keys.push({ ...delegatedKey })
    }
  }

  return keys
}
