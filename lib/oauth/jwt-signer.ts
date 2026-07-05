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
  /**
   * The PRIVATE signing JWK for node-oidc-provider to sign JWT access/id tokens
   * with, or `null` when the key is non-exportable (KMS). The public counterpart
   * is served via `getPublicKeyJwk`, so the API middleware verifies tokens
   * against the same key. In production with KMS this returns null; an
   * exportable OIDC signing key must be supplied separately (see
   * oidc-provider-config.ts and the Phase 5 verification runbook).
   */
  getSigningJwk(): Promise<Record<string, unknown> | null>
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

    // `extractable: true` so the private key can be exported as a JWK for
    // node-oidc-provider to sign JWT access tokens (Atrium Phase 5,
    // `getSigningJwk`). Dev-only key; production uses KMS / an injected key.
    const { privateKey, publicKey } = await generateKeyPair("RS256", {
      extractable: true,
    })
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

  async getSigningJwk(): Promise<Record<string, unknown> | null> {
    await this.init()
    const { exportJWK } = await import("jose")
    const jwk = await exportJWK(this.privateKey as CryptoKey)
    // Include the metadata oidc-provider needs to select + advertise the key.
    return { ...jwk, use: "sig", alg: "RS256", kid: this.kid }
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
    // HARD-FAIL in production rather than silently using LocalJwtSigner. The local
    // signer generates an `extractable: true` in-memory RSA key PER PROCESS: on
    // Fargate (esp. Spot) container recycles it rotates, invalidating every issued
    // token, AND it violates the "private key never leaves KMS" invariant since it
    // exports the private JWK. If KMS_SIGNING_KEY_ARN is missing in prod (dropped
    // env var, bad Secrets Manager wiring, a new env stood up before its KMS key),
    // that must fail loudly at init, not fall back. Mirrors the OIDC_COOKIE_SECRET
    // prod guard in oidc-provider-config.ts. (NODE_ENV=production is set by the ECS
    // task definition, so this reliably fires in the deployed environment.)
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "KMS_SIGNING_KEY_ARN must be set in production — refusing to fall back to " +
          "the local (extractable, per-process, non-durable) JWT signer. Wire an " +
          "OIDC signing KMS key (or an injected signer) before serving tokens."
      )
    }
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
