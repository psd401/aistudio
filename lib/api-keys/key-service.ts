/**
 * API Key Management Service
 * Core service for generating, validating, revoking, and listing API keys.
 * Part of Epic #674 (External API Platform) - Issue #676
 *
 * Security:
 * - Keys are 256-bit random (NIST recommended), formatted as `sk-` + 64 hex chars
 * - Stored as SHA-256 hashes — plaintext never persisted
 * - Constant-time comparison via crypto.timingSafeEqual for hash lookups
 * - Max 10 keys per user enforced at generation time
 */

import crypto from "node:crypto";
import { eq, and, count } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { apiKeys } from "@/lib/db/schema";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import { ErrorFactories } from "@/lib/error-utils";

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
const DISPLAY_PREFIX_LENGTH = 8; // first 8 hex chars stored for display
const MAX_KEYS_PER_USER = 10;
const MAX_KEY_NAME_LENGTH = 100;

// Precompiled regex for key format validation
const KEY_FORMAT_REGEX = new RegExp(`^sk-[0-9a-f]{${KEY_HEX_LENGTH}}$`);

// ============================================
// Internal Helpers
// ============================================

function hashKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Constant-time buffer comparison to prevent timing attacks on hash lookups.
 * Both inputs must be hex-encoded SHA-256 hashes (64 chars each).
 */
function safeCompareHashes(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  return crypto.timingSafeEqual(bufA, bufB);
}

// ============================================
// Core Functions
// ============================================

/**
 * Generate a new API key for a user.
 *
 * - Enforces max 10 keys per user
 * - Validates name length
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

  log.info("Generating API key", { userId, name, scopeCount: scopes.length });

  // Validate name
  if (!name || name.trim().length === 0) {
    throw ErrorFactories.validationFailed([
      { field: "name", message: "Key name is required" },
    ]);
  }
  if (name.length > MAX_KEY_NAME_LENGTH) {
    throw ErrorFactories.validationFailed([
      {
        field: "name",
        message: `Key name must not exceed ${MAX_KEY_NAME_LENGTH} characters`,
      },
    ]);
  }

  // Validate scopes
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw ErrorFactories.validationFailed([
      { field: "scopes", message: "At least one scope is required" },
    ]);
  }

  // Enforce max keys per user
  const [countResult] = await executeQuery(
    (db) =>
      db
        .select({ value: count() })
        .from(apiKeys)
        .where(and(eq(apiKeys.userId, userId), eq(apiKeys.isActive, true))),
    "countUserApiKeys"
  );

  if (countResult && countResult.value >= MAX_KEYS_PER_USER) {
    throw ErrorFactories.bizQuotaExceeded(
      "API key creation",
      MAX_KEYS_PER_USER,
      countResult.value
    );
  }

  // Generate key material
  const randomHex = crypto.randomBytes(KEY_BYTES).toString("hex");
  const rawKey = `${KEY_PREFIX}${randomHex}`;
  const keyHash = hashKey(rawKey);
  const keyPrefix = randomHex.slice(0, DISPLAY_PREFIX_LENGTH);

  // Store hashed key
  const [inserted] = await executeQuery(
    (db) =>
      db
        .insert(apiKeys)
        .values({
          userId,
          name: name.trim(),
          keyPrefix,
          keyHash,
          scopes,
          expiresAt: expiresAt ?? null,
        })
        .returning({ id: apiKeys.id }),
    "insertApiKey"
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
    name: name.trim(),
    scopes,
  };
}

/**
 * Validate an incoming API key and return auth context.
 *
 * - Validates key format
 * - Hashes and looks up by keyHash
 * - Checks isActive, expiration, revocation
 * - Uses constant-time comparison for the hash match verification
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

  const keyHash = hashKey(rawKey);

  // Lookup by hash
  const rows = await executeQuery(
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
        .where(eq(apiKeys.keyHash, keyHash))
        .limit(1),
    "validateApiKey"
  );

  if (rows.length === 0) {
    log.debug("Key not found");
    return null;
  }

  const key = rows[0];

  // Constant-time verification of stored hash against computed hash
  if (!safeCompareHashes(key.keyHash, keyHash)) {
    log.warn("Hash mismatch during validation");
    return null;
  }

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

  log.debug("Key validated", { keyId: key.id, userId: key.userId });

  return {
    userId: key.userId,
    scopes: key.scopes,
    keyId: key.id,
    authType: "api_key",
  };
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
 * Fire-and-forget — callers should not await this unless they need
 * confirmation. Errors are logged but not thrown.
 */
export function updateKeyLastUsed(keyId: number): void {
  const log = createLogger({ action: "updateKeyLastUsed" });

  executeQuery(
    (db) =>
      db
        .update(apiKeys)
        .set({
          lastUsedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(apiKeys.id, keyId)),
    "updateKeyLastUsed"
  ).catch((error) => {
    log.error("Failed to update lastUsedAt", {
      keyId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

// ============================================
// Scope Checking
// ============================================

/**
 * Check if a set of key scopes satisfies a required scope.
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
      return required.startsWith(prefix + ":");
    }
    return false;
  });
}
