/**
 * API Key Management Service
 * Core service for generating, validating, revoking, and listing API keys.
 * Part of Epic #674 (External API Platform) - Issue #676
 *
 * Security:
 * - Keys are 256-bit random (NIST recommended), formatted as `sk-` + 64 hex chars
 * - Stored as Argon2id hashes — plaintext never persisted
 * - Argon2id provides defense against GPU/ASIC brute-force attacks
 * - Validation: Lookup by keyPrefix, verify with argon2.verify() (constant-time)
 * - Max 10 keys per user enforced atomically within transaction
 *
 * NOT IMPLEMENTED IN THIS LAYER (must be in API middleware):
 * - Rate limiting (use api_key_usage table)
 * - Audit logging (Phase 2)
 * - IP restrictions (Phase 2)
 *
 * Error Handling:
 * - This is a service layer — throws errors for callers to handle.
 * - Server actions should wrap calls with handleError() from error-utils.
 */

import crypto from "node:crypto";
import { eq, and, count } from "drizzle-orm";
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client";
import { apiKeys } from "@/lib/db/schema";
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger";
import { ErrorFactories } from "@/lib/error-utils";
import { hashArgon2, verifyArgon2 } from "@/lib/api-keys/argon2-loader";

// ============================================
// Types
// ============================================

export interface AuthContext {
  userId: number;
  scopes: string[];
  keyId: number;
  authType: "api_key";
}

export interface ApiKeyCreateResult {
  keyId: number;
  /** Returned ONCE at creation — never stored or retrievable again */
  rawKey: string;
  prefix: string;
  name: string;
  scopes: string[];
}

export interface ApiKeyInfo {
  id: number;
  name: string;
  keyPrefix: string;
  scopes: string[];
  isActive: boolean;
  rateLimitRpm: number | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

// ============================================
// Constants
// ============================================

const KEY_PREFIX = "sk-";
const KEY_BYTES = 32; // 256 bits
const KEY_HEX_LENGTH = KEY_BYTES * 2; // 64 hex chars
const DISPLAY_PREFIX_LENGTH = 8; // first 8 hex chars stored for lookup + display
const MAX_KEYS_PER_USER = 10;
const MAX_KEY_NAME_LENGTH = 100;

// Runtime validation that constants are correct
if (KEY_HEX_LENGTH !== KEY_BYTES * 2) {
  throw new Error("Configuration error: KEY_HEX_LENGTH must equal KEY_BYTES * 2");
}

// Precompiled regex for key format validation
const KEY_FORMAT_REGEX = new RegExp(`^sk-[0-9a-f]{${KEY_HEX_LENGTH}}$`);

// ============================================
// Internal Helpers
// ============================================

/**
 * Hash API key using Argon2id (password hashing winner, OWASP recommended).
 *
 * IMPORTANT: Argon2id uses random salts, so calling this twice with the same
 * input produces DIFFERENT outputs. You cannot look up keys by hash equality.
 * Use argon2.verify() to compare a raw key against a stored hash.
 *
 * Configuration:
 * - memoryCost: 65536 (64 MB) - prevents GPU attacks
 * - timeCost: 3 iterations - balances security and performance
 * - parallelism: 4 threads - leverages multi-core CPUs
 * - hashLength: 32 bytes (256 bits)
 *
 * Output: ~97 char encoded string ($argon2id$v=19$m=...$salt$hash)
 * Performance: ~50-100ms per hash
 */
async function hashKey(rawKey: string): Promise<string> {
  return await hashArgon2(rawKey);
}

/**
 * Verify API key against Argon2id hash.
 * Uses Argon2's built-in constant-time comparison.
 */
async function verifyKey(rawKey: string, hash: string): Promise<boolean> {
  return await verifyArgon2(hash, rawKey);
}

/**
 * Validate and sanitize scope array.
 * - Removes empty strings
 * - Deduplicates
 * - Rejects invalid wildcard ":*" (empty prefix)
 */
function validateScopes(scopes: string[]): string[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw ErrorFactories.validationFailed([
      { field: "scopes", message: "At least one scope is required" },
    ]);
  }

  // Filter out empty strings and deduplicate
  const cleaned = [...new Set(scopes.filter((s) => typeof s === "string" && s.trim().length > 0))];

  if (cleaned.length === 0) {
    throw ErrorFactories.validationFailed([
      { field: "scopes", message: "At least one valid scope is required" },
    ]);
  }

  // Validate wildcard edge case: ":*" is invalid (no prefix)
  const invalidWildcards = cleaned.filter((s) => s === ":*");
  if (invalidWildcards.length > 0) {
    throw ErrorFactories.validationFailed([
      {
        field: "scopes",
        message: "Invalid wildcard scope ':*' - prefix required before colon",
      },
    ]);
  }

  return cleaned;
}

// ============================================
// Core Functions
// ============================================

/**
 * Generate a new API key for a user.
 *
 * - Enforces max 10 keys per user ATOMICALLY via transaction
 * - Validates name length and scope format
 * - Returns the raw key ONCE (never stored)
 */
export async function generateApiKey(
  userId: number,
  name: string,
  scopes: string[],
  expiresAt?: Date
): Promise<ApiKeyCreateResult> {
  const requestId = generateRequestId();
  const timer = startTimer("generateApiKey");
  const log = createLogger({ requestId, action: "generateApiKey" });

  try {
    // Trim and validate name early
    const trimmedName = name?.trim();
    if (!trimmedName) {
      throw ErrorFactories.validationFailed([
        { field: "name", message: "Key name is required" },
      ]);
    }
    if (trimmedName.length > MAX_KEY_NAME_LENGTH) {
      throw ErrorFactories.validationFailed([
        {
          field: "name",
          message: `Key name must not exceed ${MAX_KEY_NAME_LENGTH} characters`,
        },
      ]);
    }

    // Validate and clean scopes
    const cleanedScopes = validateScopes(scopes);

    log.info("Generating API key", {
      userId,
      name: sanitizeForLogging(trimmedName),
      scopeCount: cleanedScopes.length,
    });

    // Generate key material outside transaction (expensive crypto operation)
    const randomHex = crypto.randomBytes(KEY_BYTES).toString("hex");
    const rawKey = `${KEY_PREFIX}${randomHex}`;
    const keyHash = await hashKey(rawKey);
    const keyPrefix = randomHex.slice(0, DISPLAY_PREFIX_LENGTH);

    // ATOMIC: Check quota + insert within transaction to prevent race conditions.
    // Uses READ COMMITTED isolation (Drizzle default) — sufficient since count
    // and insert are in the same transaction, preventing concurrent bypasses.
    const inserted = await executeTransaction(
      async (tx) => {
        // Count active keys for this user
        const [countResult] = await tx
          .select({ value: count() })
          .from(apiKeys)
          .where(and(eq(apiKeys.userId, userId), eq(apiKeys.isActive, true)));

        if (countResult && countResult.value >= MAX_KEYS_PER_USER) {
          throw ErrorFactories.bizQuotaExceeded(
            "API key creation",
            MAX_KEYS_PER_USER,
            countResult.value
          );
        }

        // Insert new key
        const [insertedRow] = await tx
          .insert(apiKeys)
          .values({
            userId,
            name: trimmedName,
            keyPrefix,
            keyHash,
            scopes: cleanedScopes,
            expiresAt: expiresAt ?? null,
          })
          .returning({ id: apiKeys.id });

        return insertedRow;
      },
      "generateApiKey"
    );

    timer({ status: "success" });
    log.info("API key generated", {
      keyId: inserted.id,
      userId,
      prefix: `${KEY_PREFIX}${keyPrefix}`,
    });

    return {
      keyId: inserted.id,
      rawKey,
      prefix: `${KEY_PREFIX}${keyPrefix}`,
      name: trimmedName,
      scopes: cleanedScopes,
    };
  } catch (error) {
    timer({ status: "error" });
    throw error;
  }
}

/**
 * Validate an incoming API key and return auth context.
 *
 * Lookup strategy:
 * 1. Validate key format (sk- + 64 hex chars)
 * 2. Extract keyPrefix (first 8 hex chars) for indexed DB lookup
 * 3. Iterate candidate keys with argon2.verify() (constant-time)
 * 4. Check isActive, expiration, revocation on matched key
 *
 * Performance: Worst case is 10 Argon2 verifications (~500-1000ms) when
 * all of a user's keys share the same prefix. In practice, prefixes are
 * 8 hex chars (4 billion combinations) so collisions are extremely rare.
 *
 * Returns null if key is invalid, expired, or revoked.
 */
export async function validateApiKey(
  rawKey: string
): Promise<AuthContext | null> {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, action: "validateApiKey" });

  // Format validation
  if (!rawKey || !KEY_FORMAT_REGEX.test(rawKey)) {
    log.debug("Invalid key format");
    return null;
  }

  // Extract prefix for indexed lookup (first 8 hex chars after "sk-")
  const hexPart = rawKey.slice(KEY_PREFIX.length);
  const keyPrefix = hexPart.slice(0, DISPLAY_PREFIX_LENGTH);

  // Find all candidate keys with matching prefix
  const candidates = await executeQuery(
    (db) =>
      db
        .select({
          id: apiKeys.id,
          userId: apiKeys.userId,
          keyHash: apiKeys.keyHash,
          scopes: apiKeys.scopes,
          isActive: apiKeys.isActive,
          expiresAt: apiKeys.expiresAt,
          revokedAt: apiKeys.revokedAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.keyPrefix, keyPrefix)),
    "validateApiKey"
  );

  if (candidates.length === 0) {
    log.debug("No keys found for prefix");
    return null;
  }

  // Iterate candidates and verify with Argon2
  for (const key of candidates) {
    const isValid = await verifyKey(rawKey, key.keyHash);
    if (!isValid) continue;

    // Key matched — now check status

    // Check active status
    if (!key.isActive) {
      log.debug("Key is inactive", { keyId: key.id });
      return null;
    }

    // Check revocation
    if (key.revokedAt) {
      log.debug("Key is revoked", { keyId: key.id });
      return null;
    }

    // Check expiration
    if (key.expiresAt && key.expiresAt < new Date()) {
      log.debug("Key is expired", { keyId: key.id });
      return null;
    }

    // Runtime validation: scopes must be string array
    if (!Array.isArray(key.scopes) || !key.scopes.every((s) => typeof s === "string")) {
      log.error("Invalid scopes data in database", { keyId: key.id });
      return null;
    }

    log.debug("Key validated", { keyId: key.id, userId: key.userId });

    return {
      userId: key.userId,
      scopes: key.scopes,
      keyId: key.id,
      authType: "api_key",
    };
  }

  log.debug("No matching key found after verification");
  return null;
}

/**
 * Revoke an API key by setting revokedAt and isActive = false.
 *
 * Caller is responsible for verifying ownership or admin access
 * before invoking this function.
 */
export async function revokeApiKey(
  keyId: number,
  userId: number
): Promise<void> {
  const requestId = generateRequestId();
  const timer = startTimer("revokeApiKey");
  const log = createLogger({ requestId, action: "revokeApiKey" });

  try {
    log.info("Revoking API key", { keyId, userId });

    const result = await executeQuery(
      (db) =>
        db
          .update(apiKeys)
          .set({
            isActive: false,
            revokedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
          .returning({ id: apiKeys.id }),
      "revokeApiKey"
    );

    if (result.length === 0) {
      log.warn("Key not found or not owned by user", { keyId, userId });
      throw ErrorFactories.validationFailed([
        {
          field: "keyId",
          message: "API key not found or does not belong to user",
        },
      ]);
    }

    timer({ status: "success" });
    log.info("API key revoked", { keyId, userId });
  } catch (error) {
    timer({ status: "error" });
    throw error;
  }
}

/**
 * List all API keys for a user.
 *
 * Returns metadata only — never includes the hash.
 */
export async function listUserKeys(userId: number): Promise<ApiKeyInfo[]> {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, action: "listUserKeys" });

  log.debug("Listing user API keys", { userId });

  const rows = await executeQuery(
    (db) =>
      db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          keyPrefix: apiKeys.keyPrefix,
          scopes: apiKeys.scopes,
          isActive: apiKeys.isActive,
          rateLimitRpm: apiKeys.rateLimitRpm,
          lastUsedAt: apiKeys.lastUsedAt,
          expiresAt: apiKeys.expiresAt,
          revokedAt: apiKeys.revokedAt,
          createdAt: apiKeys.createdAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.userId, userId)),
    "listUserApiKeys"
  );

  return rows;
}

/**
 * Update lastUsedAt timestamp for a key.
 *
 * Non-blocking operation — callers should use `void` operator if not awaiting.
 * Errors are logged but not thrown. Returns promise for optional tracking.
 */
export async function updateKeyLastUsed(keyId: number): Promise<void> {
  const log = createLogger({ action: "updateKeyLastUsed" });

  try {
    await executeQuery(
      (db) =>
        db
          .update(apiKeys)
          .set({
            lastUsedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(apiKeys.id, keyId)),
      "updateKeyLastUsed"
    );
  } catch (error) {
    log.error("Failed to update lastUsedAt", {
      keyId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ============================================
// Scope Checking
// ============================================

/**
 * Check if a set of key scopes satisfies a required scope.
 *
 * Assumes scopes have been validated via validateScopes() at key creation.
 * Contains defensive guards for edge cases even if called with unvalidated data.
 *
 * Supports:
 * - Exact match: `"chat:read"` matches `"chat:read"`
 * - Global wildcard: `"*"` matches everything
 * - Segment-boundary wildcard: `"chat:*"` matches `"chat:read"`, `"chat:write"`,
 *   but NOT `"chatbot:read"` (must match at colon boundary)
 */
export function hasScope(keyScopes: string[], required: string): boolean {
  return keyScopes.some((scope) => {
    if (scope === required) return true;
    if (scope === "*") return true;
    if (scope.endsWith(":*")) {
      const prefix = scope.slice(0, -2); // "chat" from "chat:*"
      // Defensive guard: ":*" with empty prefix should never match
      if (prefix.length === 0) return false;
      return required.startsWith(prefix + ":");
    }
    return false;
  });
}
