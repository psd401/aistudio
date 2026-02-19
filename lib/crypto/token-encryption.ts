/**
 * Token Encryption Module (AES-256-GCM)
 *
 * Provides field-level encryption for per-user OAuth tokens and other sensitive
 * connector credentials before database storage. Aurora at-rest encryption alone
 * is insufficient for token-level data protection.
 *
 * - Data Encryption Key (DEK) fetched from AWS Secrets Manager
 * - Key derived via HKDF-SHA-256 (NIST SP 800-56C) with domain separation
 * - In-process DEK cache with 5-minute TTL, concurrency-safe (single in-flight fetch)
 * - Store format: base64 JSON string containing { iv, tag, data }
 * - Provider-agnostic — works for any connector
 *
 * @see Issue #777 — Part of Epic #774 (Nexus MCP Connectors)
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto"
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager"
import { createLogger } from "@/lib/logger"

const log = createLogger({ action: "token-encryption" })

// ─── Constants ───────────────────────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm"
const IV_LENGTH = 12 // 96 bits — recommended for GCM
const AUTH_TAG_LENGTH = 16 // 128 bits
const DEK_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

// HKDF domain separation labels — changing these invalidates all existing ciphertext
const HKDF_SALT = Buffer.from("aistudio-mcp-token-encryption")
const HKDF_INFO = Buffer.from("aes-256-gcm-dek-v1")

// ─── DEK Cache ───────────────────────────────────────────────────────────────

interface CachedDEK {
  key: Buffer
  fetchedAt: number
}

let dekCache: CachedDEK | null = null
let dekFetchPromise: Promise<Buffer> | null = null
let smClient: SecretsManagerClient | null = null

function getSecretsManagerClient(): SecretsManagerClient {
  if (!smClient) {
    smClient = new SecretsManagerClient({
      region: process.env.AWS_REGION || "us-west-2",
      maxAttempts: 3,
    })
  }
  return smClient
}

/**
 * Resolves the Secrets Manager secret name for the token encryption DEK.
 *
 * Priority: ENVIRONMENT (set by ECS task definition) → DEPLOYMENT_ENV → "dev"
 *
 * Note: NODE_ENV is NOT used because the ECS task definition sets NODE_ENV=production
 * for all environments (dev and prod alike). ENVIRONMENT is the correct discriminator.
 */
function getSecretName(): string {
  const env = process.env.ENVIRONMENT || process.env.DEPLOYMENT_ENV || "dev"
  return `aistudio/${env}/mcp/token-encryption-key`
}

/**
 * Fetches and caches the DEK. Separated from getDEK for concurrency safety.
 */
async function fetchAndCacheDEK(): Promise<Buffer> {
  const secretName = getSecretName()
  log.info("Fetching token encryption DEK from Secrets Manager")

  const client = getSecretsManagerClient()
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretName })
  )

  if (!response.SecretString) {
    log.warn("Token encryption DEK secret is empty", { secretName })
    throw new Error("Token encryption DEK is unavailable: secret is empty")
  }

  // Derive a 32-byte key via HKDF-SHA-256 (NIST SP 800-56C Rev 2).
  // HKDF provides:
  // - Domain separation via salt and info labels
  // - Proper key stretching beyond a raw hash
  // - Compatibility with any secret string format from Secrets Manager
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(response.SecretString, "utf8"),
      HKDF_SALT,
      HKDF_INFO,
      32
    )
  )

  dekCache = { key, fetchedAt: Date.now() }
  log.info("Token encryption DEK cached successfully")

  return key
}

/**
 * Fetches the Data Encryption Key with in-process caching and concurrency safety.
 *
 * Cache TTL: 5 minutes. Concurrent callers on a cold cache share a single Secrets
 * Manager fetch (thundering-herd protection via the shared in-flight promise).
 *
 * @throws Error if the secret cannot be retrieved
 */
async function getDEK(): Promise<Buffer> {
  // Return cached DEK if still valid
  if (dekCache && Date.now() - dekCache.fetchedAt < DEK_CACHE_TTL) {
    return dekCache.key
  }

  // Concurrency guard: if a fetch is already in progress, join it
  if (dekFetchPromise) {
    return dekFetchPromise
  }

  // Start a new fetch and share the promise with concurrent callers
  dekFetchPromise = fetchAndCacheDEK().finally(() => {
    dekFetchPromise = null
  })

  return dekFetchPromise
}

// ─── Encrypted Token Format ──────────────────────────────────────────────────

interface EncryptedPayload {
  /** Base64-encoded initialization vector (12 bytes) */
  iv: string
  /** Base64-encoded GCM auth tag (16 bytes) */
  tag: string
  /** Base64-encoded ciphertext */
  data: string
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Encrypts a plaintext token using AES-256-GCM.
 *
 * @param plaintext - The token value to encrypt
 * @returns A base64-encoded JSON string containing { iv, tag, data }
 * @throws Error if the DEK cannot be fetched
 */
export async function encryptToken(plaintext: string): Promise<string> {
  const key = await getDEK()
  const iv = randomBytes(IV_LENGTH)

  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  })

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])

  const tag = cipher.getAuthTag()

  const payload: EncryptedPayload = {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  }

  return Buffer.from(JSON.stringify(payload)).toString("base64")
}

/**
 * Decrypts a token that was encrypted with `encryptToken`.
 *
 * @param ciphertext - The base64-encoded JSON string from `encryptToken`
 * @returns The original plaintext token
 * @throws Error if decryption fails (wrong key, tampered data, or invalid format)
 */
export async function decryptToken(ciphertext: string): Promise<string> {
  const key = await getDEK()

  let payload: EncryptedPayload
  try {
    const json = Buffer.from(ciphertext, "base64").toString("utf8")
    payload = JSON.parse(json) as EncryptedPayload
  } catch {
    throw new Error("Invalid encrypted token format: failed to parse payload")
  }

  if (payload.iv == null || payload.tag == null || payload.data == null) {
    throw new Error("Invalid encrypted token format: missing iv, tag, or data")
  }

  const iv = Buffer.from(payload.iv, "base64")
  const tag = Buffer.from(payload.tag, "base64")
  const data = Buffer.from(payload.data, "base64")

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  })
  decipher.setAuthTag(tag)

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()])

  return decrypted.toString("utf8")
}

/**
 * Invalidates the cached DEK, forcing a fresh fetch on the next encrypt/decrypt call.
 * Useful after secret rotation.
 */
export function invalidateDEKCache(): void {
  dekCache = null
  dekFetchPromise = null
  log.info("Token encryption DEK cache invalidated")
}

// ─── Testing Utilities ───────────────────────────────────────────────────────

/**
 * Resets internal module state. Only for use in tests.
 * Throws in non-test environments to prevent accidental production use.
 */
export function _resetForTesting(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("_resetForTesting is only available in test environments")
  }
  dekCache = null
  dekFetchPromise = null
  smClient = null
}
