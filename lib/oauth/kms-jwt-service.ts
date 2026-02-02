/**
 * KMS JWT Signing Service
 * Signs JWTs via AWS KMS (RS256) for production use.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 *
 * Security:
 * - Private key never leaves KMS
 * - Public keys cached with 5-min TTL for JWKS endpoint
 * - CloudTrail audit trail on all signing operations
 */

import {
  KMSClient,
  SignCommand,
  GetPublicKeyCommand,
  type SigningAlgorithmSpec,
} from "@aws-sdk/client-kms"
import { createPublicKey } from "node:crypto"
import { createLogger } from "@/lib/logger"

// ============================================
// Types
// ============================================

export interface JwksKey {
  kty: string
  use: string
  kid: string
  alg: string
  n: string
  e: string
}

interface CachedPublicKey {
  pem: string
  jwk: JwksKey
  fetchedAt: number
}

// ============================================
// Constants
// ============================================

const PUBLIC_KEY_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const KMS_SIGNING_ALGORITHM: SigningAlgorithmSpec = "RSASSA_PKCS1_V1_5_SHA_256"

// ============================================
// KMS Signer
// ============================================

export class KmsJwtService {
  private kmsClient: KMSClient
  private keyArn: string
  private kid: string
  private publicKeyCache: CachedPublicKey | null = null

  constructor(keyArn: string, kid: string, region?: string) {
    this.kmsClient = new KMSClient({ region: region ?? process.env.AWS_REGION ?? "us-west-2" })
    this.keyArn = keyArn
    this.kid = kid
  }

  /**
   * Sign a JWT with KMS.
   * Constructs header.payload, signs via KMS, returns complete JWT string.
   */
  async signJwt(payload: Record<string, unknown>): Promise<string> {
    const log = createLogger({ action: "kmsJwtService.signJwt" })

    const header = {
      alg: "RS256",
      typ: "JWT",
      kid: this.kid,
    }

    const headerB64 = base64UrlEncode(JSON.stringify(header))
    const payloadB64 = base64UrlEncode(JSON.stringify(payload))
    const signingInput = `${headerB64}.${payloadB64}`

    // KMS has a 4096-byte message limit; our JWTs should be well under
    const message = new TextEncoder().encode(signingInput)

    try {
      const command = new SignCommand({
        KeyId: this.keyArn,
        Message: message,
        MessageType: "RAW",
        SigningAlgorithm: KMS_SIGNING_ALGORITHM,
      })

      const result = await this.kmsClient.send(command)

      if (!result.Signature) {
        throw new Error("KMS returned empty signature")
      }

      const signatureB64 = bufferToBase64Url(result.Signature)
      return `${signingInput}.${signatureB64}`
    } catch (error) {
      log.error("KMS JWT signing failed", {
        kid: this.kid,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  /**
   * Get the public key in JWK format for JWKS endpoint.
   * Cached with 5-min TTL.
   */
  async getPublicKeyJwk(): Promise<JwksKey> {
    const now = Date.now()

    if (this.publicKeyCache && now - this.publicKeyCache.fetchedAt < PUBLIC_KEY_CACHE_TTL_MS) {
      return this.publicKeyCache.jwk
    }

    const log = createLogger({ action: "kmsJwtService.getPublicKeyJwk" })

    const command = new GetPublicKeyCommand({ KeyId: this.keyArn })
    const result = await this.kmsClient.send(command)

    if (!result.PublicKey) {
      throw new Error("KMS returned no public key")
    }

    // Parse RSA public key from DER-encoded SubjectPublicKeyInfo
    const jwk = derToJwk(result.PublicKey, this.kid)

    this.publicKeyCache = {
      pem: "", // Not needed for JWKS
      jwk,
      fetchedAt: now,
    }

    log.info("Refreshed KMS public key", { kid: this.kid })
    return jwk
  }

  getKid(): string {
    return this.kid
  }
}

// ============================================
// Encoding Helpers
// ============================================

function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function bufferToBase64Url(buffer: Uint8Array): string {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

/**
 * Parse DER-encoded SubjectPublicKeyInfo (RSA) to JWK format.
 * AWS KMS returns public keys in this format.
 */
function derToJwk(der: Uint8Array, kid: string): JwksKey {
  const publicKey = createPublicKey({
    key: Buffer.from(der),
    format: "der",
    type: "spki",
  })

  const exported = publicKey.export({ format: "jwk" }) as {
    kty: string
    n: string
    e: string
  }

  return {
    kty: exported.kty,
    use: "sig",
    kid,
    alg: "RS256",
    n: exported.n,
    e: exported.e,
  }
}
