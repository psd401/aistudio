/**
 * JWT Signer Factory
 * KMS signer when KMS_SIGNING_KEY_ARN is set, local RSA fallback otherwise.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 */

import { createLogger } from "@/lib/logger"
import type { JwksKey } from "./kms-jwt-service"

// ============================================
// Interface
// ============================================

export interface JwtSigner {
  signJwt(payload: Record<string, unknown>): Promise<string>
  getPublicKeyJwk(): Promise<JwksKey>
  getKid(): string
}

// ============================================
// Local Dev Signer (RSA keypair via jose library)
// ============================================

class LocalJwtSigner implements JwtSigner {
  private kid: string
  // jose v6 uses CryptoKey | KeyObject union; store as unknown for simplicity
  private privateKey: unknown = null
  private publicKeyJwk: JwksKey | null = null
  private initPromise: Promise<void> | null = null

  constructor() {
    this.kid = `local-${Date.now()}`
  }

  private async init(): Promise<void> {
    if (this.privateKey) return
    if (this.initPromise) {
      await this.initPromise
      return
    }

    this.initPromise = this._generateKeyPair()
    await this.initPromise
  }

  private async _generateKeyPair(): Promise<void> {
    const { generateKeyPair, exportJWK } = await import("jose")

    const { privateKey, publicKey } = await generateKeyPair("RS256")
    this.privateKey = privateKey

    const jwk = await exportJWK(publicKey)

    this.publicKeyJwk = {
      kty: jwk.kty!,
      use: "sig",
      kid: this.kid,
      alg: "RS256",
      n: jwk.n!,
      e: jwk.e!,
    }
  }

  async signJwt(payload: Record<string, unknown>): Promise<string> {
    await this.init()

    const { SignJWT } = await import("jose")

    const jwt = await new SignJWT(payload as Record<string, unknown>)
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: this.kid })
      .sign(this.privateKey as CryptoKey)

    return jwt
  }

  async getPublicKeyJwk(): Promise<JwksKey> {
    await this.init()
    return this.publicKeyJwk!
  }

  getKid(): string {
    return this.kid
  }
}

// ============================================
// Factory
// ============================================

let signerInstance: JwtSigner | null = null

export async function getJwtSigner(): Promise<JwtSigner> {
  if (signerInstance) return signerInstance

  const log = createLogger({ action: "getJwtSigner" })
  const kmsArn = process.env.KMS_SIGNING_KEY_ARN

  if (kmsArn) {
    log.info("Using KMS JWT signer", { keyArn: kmsArn.substring(0, 40) + "..." })
    const { KmsJwtService } = await import("./kms-jwt-service")
    const kid = process.env.KMS_SIGNING_KEY_KID ?? `kms-${Date.now()}`
    signerInstance = new KmsJwtService(kmsArn, kid)
  } else {
    log.info("Using local RSA JWT signer (dev mode)")
    signerInstance = new LocalJwtSigner()
  }

  return signerInstance
}

/**
 * Reset the signer instance (for testing).
 */
export function resetJwtSigner(): void {
  signerInstance = null
}
