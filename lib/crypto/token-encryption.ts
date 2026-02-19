/**
 * Token Encryption Module (AES-256-GCM)
 *
 * Provides field-level encryption for per-user OAuth tokens and other sensitive
 * connector credentials before database storage. Aurora at-rest encryption alone
 * is insufficient for token-level data protection.
 *
 * - Data Encryption Key (DEK) fetched from AWS Secrets Manager
 * - In-process DEK cache with 5-minute TTL
 * - Store format: base64 JSON string containing { iv, tag, data }
 * - Provider-agnostic — works for any connector
 *
 * @see Issue #777 — Part of Epic #774 (Nexus MCP Connectors)
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
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

// ─── DEK Cache ───────────────────────────────────────────────────────────────

interface CachedDEK {
  key: Buffer
  fetchedAt: number
}

let dekCache: CachedDEK | null = null
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
 * Uses the current deployment environment.
 */
function getSecretName(): string {
  const env = process.env.DEPLOYMENT_ENV || process.env.NODE_ENV || "dev"
  // Map NODE_ENV values to deployment environment names
  const envMap: Record<string, string> = {
    development: "dev",
    production: "prod",
    test: "dev",
  }
  const deployEnv = envMap[env] || env
  return `aistudio/${deployEnv}/mcp/token-encryption-key`
}

/**
 * Fetches the Data Encryption Key from AWS Secrets Manager, with in-process caching.
 * Cache has a 5-minute TTL.
 *
 * The secret value can be any string (e.g. Secrets Manager auto-generated password).
 * It is deterministically derived into a 32-byte key via SHA-256.
 *
 * @throws Error if the secret cannot be retrieved
 */
async function getDEK(): Promise<Buffer> {
  // Return cached DEK if still valid
  if (dekCache && Date.now() - dekCache.fetchedAt < DEK_CACHE_TTL) {
    return dekCache.key
  }

  const secretName = getSecretName()
  log.info("Fetching token encryption DEK from Secrets Manager", { secretName })

  const client = getSecretsManagerClient()
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretName })
  )

  if (!response.SecretString) {
    throw new Error(`Token encryption DEK secret "${secretName}" is empty`)
  }

  // Derive a 32-byte key from the secret via SHA-256.
  // This allows any secret format (hex, base64, auto-generated password, etc.)
  const key = createHash("sha256").update(response.SecretString).digest()

  dekCache = { key, fetchedAt: Date.now() }
  log.info("Token encryption DEK cached successfully")

  return key
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
  log.info("Token encryption DEK cache invalidated")
}

// ─── Testing Utilities ───────────────────────────────────────────────────────

/**
 * Resets internal module state. Only for use in tests.
 */
export function _resetForTesting(): void {
  dekCache = null
  smClient = null
}
