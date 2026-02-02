/**
 * Drizzle OIDC Adapter
 * Implements node-oidc-provider's Adapter interface using Drizzle ORM.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 *
 * Models handled:
 * - Client: oauth_clients table
 * - AuthorizationCode: oauth_authorization_codes table
 * - AccessToken: oauth_access_tokens table
 * - RefreshToken: oauth_refresh_tokens table
 * - Session, Interaction, Grant: in-memory (ephemeral, acceptable for v1)
 */

import type { Adapter, AdapterPayload } from "oidc-provider"
import { executeQuery } from "@/lib/db/drizzle-client"
import { eq, and, isNull } from "drizzle-orm"
import {
  oauthClients,
  oauthAuthorizationCodes,
  oauthAccessTokens,
  oauthRefreshTokens,
} from "@/lib/db/schema"
import { createLogger } from "@/lib/logger"
import { createHash } from "node:crypto"

// ============================================
// In-Memory Store (for ephemeral models)
// ============================================

const ephemeralStore = new Map<string, { payload: AdapterPayload; expiresAt?: number }>()

function ephemeralKey(model: string, id: string): string {
  return `${model}:${id}`
}

function cleanupEphemeral(): void {
  const now = Date.now() / 1000
  for (const [key, entry] of ephemeralStore) {
    if (entry.expiresAt && entry.expiresAt < now) {
      ephemeralStore.delete(key)
    }
  }
}

// Run cleanup periodically
const cleanupInterval = setInterval(cleanupEphemeral, 60_000)
if (cleanupInterval.unref) cleanupInterval.unref()

// ============================================
// Hash Helper
// ============================================

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

// ============================================
// JSONB Validation Helpers
// ============================================

function asStringArray(val: unknown): string[] {
  if (Array.isArray(val) && val.every((v) => typeof v === "string")) {
    return val
  }
  return []
}

// ============================================
// Adapter Implementation
// ============================================

class DrizzleAdapter implements Adapter {
  private model: string
  private log = createLogger({ action: "oidcAdapter" })

  constructor(model: string) {
    this.model = model
  }

  async upsert(
    id: string,
    payload: AdapterPayload,
    expiresIn: number
  ): Promise<void> {
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : undefined

    switch (this.model) {
      case "AuthorizationCode":
        await this.upsertAuthCode(id, payload, expiresAt)
        break
      case "AccessToken":
        await this.upsertAccessToken(id, payload, expiresAt)
        break
      case "RefreshToken":
        await this.upsertRefreshToken(id, payload, expiresAt)
        break
      default:
        // Ephemeral: Session, Interaction, Grant, etc.
        ephemeralStore.set(ephemeralKey(this.model, id), {
          payload,
          expiresAt: expiresAt ? expiresAt.getTime() / 1000 : undefined,
        })
    }
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    switch (this.model) {
      case "Client":
        return this.findClient(id)
      case "AuthorizationCode":
        return this.findAuthCode(id)
      case "AccessToken":
        return this.findAccessToken(id)
      case "RefreshToken":
        return this.findRefreshToken(id)
      default: {
        const entry = ephemeralStore.get(ephemeralKey(this.model, id))
        if (!entry) return undefined
        if (entry.expiresAt && entry.expiresAt < Date.now() / 1000) {
          ephemeralStore.delete(ephemeralKey(this.model, id))
          return undefined
        }
        return entry.payload
      }
    }
  }

  async findByUserCode(_userCode: string): Promise<AdapterPayload | undefined> {
    // Device flow not supported
    return undefined
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    // Search ephemeral store for matching uid
    for (const entry of ephemeralStore.values()) {
      if (entry.payload.uid === uid) {
        return entry.payload
      }
    }
    return undefined
  }

  async consume(id: string): Promise<void> {
    switch (this.model) {
      case "AuthorizationCode": {
        const hash = sha256(id)
        const consumed = await executeQuery(
          (db) =>
            db
              .update(oauthAuthorizationCodes)
              .set({ consumedAt: new Date() })
              .where(
                and(
                  eq(oauthAuthorizationCodes.codeHash, hash),
                  isNull(oauthAuthorizationCodes.consumedAt)
                )
              )
              .returning({ id: oauthAuthorizationCodes.id }),
          "oidcAdapter.consumeAuthCode"
        )
        if (consumed.length === 0) {
          this.log.warn("Authorization code already consumed or not found", {
            codeHash: hash.slice(0, 8),
          })
        }
        break
      }
      default: {
        const entry = ephemeralStore.get(ephemeralKey(this.model, id))
        if (entry) {
          entry.payload.consumed = Math.floor(Date.now() / 1000)
        }
      }
    }
  }

  async destroy(id: string): Promise<void> {
    switch (this.model) {
      case "AccessToken":
        await executeQuery(
          (db) =>
            db
              .update(oauthAccessTokens)
              .set({ revokedAt: new Date() })
              .where(eq(oauthAccessTokens.jti, id)),
          "oidcAdapter.destroyAccessToken"
        )
        break
      case "RefreshToken": {
        const hash = sha256(id)
        await executeQuery(
          (db) =>
            db
              .update(oauthRefreshTokens)
              .set({ revokedAt: new Date() })
              .where(eq(oauthRefreshTokens.tokenHash, hash)),
          "oidcAdapter.destroyRefreshToken"
        )
        break
      }
      default:
        ephemeralStore.delete(ephemeralKey(this.model, id))
    }
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    // Revoke all tokens associated with a grant
    // For ephemeral models, just remove them
    for (const [key, entry] of ephemeralStore) {
      if (entry.payload.grantId === grantId) {
        ephemeralStore.delete(key)
      }
    }
    this.log.info("Revoked tokens by grant", { grantId })
  }

  // ========================================
  // Client
  // ========================================

  private async findClient(clientId: string): Promise<AdapterPayload | undefined> {
    const [client] = await executeQuery(
      (db) =>
        db
          .select()
          .from(oauthClients)
          .where(and(eq(oauthClients.clientId, clientId), eq(oauthClients.isActive, true)))
          .limit(1),
      "oidcAdapter.findClient"
    )

    if (!client) return undefined

    return {
      client_id: client.clientId,
      client_name: client.clientName,
      client_secret: client.clientSecretHash ?? undefined,
      redirect_uris: asStringArray(client.redirectUris),
      grant_types: asStringArray(client.grantTypes),
      response_types: asStringArray(client.responseTypes) as ("code" | "id_token" | "none")[],
      scope: asStringArray(client.allowedScopes).join(" "),
      token_endpoint_auth_method: client.tokenEndpointAuthMethod as "none" | "client_secret_post" | "client_secret_basic",
    }
  }

  // ========================================
  // AuthorizationCode
  // ========================================

  private async upsertAuthCode(
    id: string,
    payload: AdapterPayload,
    expiresAt?: Date
  ): Promise<void> {
    const hash = sha256(id)

    await executeQuery(
      (db) =>
        db.insert(oauthAuthorizationCodes).values({
          codeHash: hash,
          clientId: payload.clientId as string,
          userId: Number.parseInt(payload.accountId as string, 10),
          redirectUri: payload.redirectUri as string,
          scopes: (payload.scope as string)?.split(" ") ?? [],
          codeChallenge: payload.codeChallenge as string | undefined,
          codeChallengeMethod: (payload.codeChallengeMethod as string) ?? "S256",
          nonce: payload.nonce as string | undefined,
          expiresAt: expiresAt ?? new Date(Date.now() + 60_000),
        }),
      "oidcAdapter.upsertAuthCode"
    )
  }

  private async findAuthCode(id: string): Promise<AdapterPayload | undefined> {
    const hash = sha256(id)

    const [code] = await executeQuery(
      (db) =>
        db
          .select()
          .from(oauthAuthorizationCodes)
          .where(eq(oauthAuthorizationCodes.codeHash, hash))
          .limit(1),
      "oidcAdapter.findAuthCode"
    )

    if (!code) return undefined

    return {
      accountId: String(code.userId),
      clientId: code.clientId,
      redirectUri: code.redirectUri,
      scope: asStringArray(code.scopes).join(" "),
      codeChallenge: code.codeChallenge ?? undefined,
      codeChallengeMethod: code.codeChallengeMethod ?? undefined,
      nonce: code.nonce ?? undefined,
      consumed: code.consumedAt ? Math.floor(code.consumedAt.getTime() / 1000) : undefined,
      expiresAt: code.expiresAt,
    }
  }

  // ========================================
  // AccessToken
  // ========================================

  private async upsertAccessToken(
    id: string,
    payload: AdapterPayload,
    expiresAt?: Date
  ): Promise<void> {
    await executeQuery(
      (db) =>
        db.insert(oauthAccessTokens).values({
          jti: id,
          clientId: payload.clientId as string,
          userId: Number.parseInt(payload.accountId as string, 10),
          scopes: (payload.scope as string)?.split(" ") ?? [],
          expiresAt: expiresAt ?? new Date(Date.now() + 900_000),
        }),
      "oidcAdapter.upsertAccessToken"
    )
  }

  private async findAccessToken(id: string): Promise<AdapterPayload | undefined> {
    const [token] = await executeQuery(
      (db) =>
        db
          .select()
          .from(oauthAccessTokens)
          .where(and(eq(oauthAccessTokens.jti, id), isNull(oauthAccessTokens.revokedAt)))
          .limit(1),
      "oidcAdapter.findAccessToken"
    )

    if (!token) return undefined

    return {
      jti: token.jti,
      accountId: String(token.userId),
      clientId: token.clientId,
      scope: asStringArray(token.scopes).join(" "),
      expiresAt: token.expiresAt,
    }
  }

  // ========================================
  // RefreshToken
  // ========================================

  private async upsertRefreshToken(
    id: string,
    payload: AdapterPayload,
    expiresAt?: Date
  ): Promise<void> {
    const hash = sha256(id)

    await executeQuery(
      (db) =>
        db.insert(oauthRefreshTokens).values({
          tokenHash: hash,
          clientId: payload.clientId as string,
          userId: Number.parseInt(payload.accountId as string, 10),
          accessTokenJti: payload.jti as string | undefined,
          scopes: (payload.scope as string)?.split(" ") ?? [],
          expiresAt: expiresAt ?? new Date(Date.now() + 86_400_000),
        }),
      "oidcAdapter.upsertRefreshToken"
    )
  }

  private async findRefreshToken(id: string): Promise<AdapterPayload | undefined> {
    const hash = sha256(id)

    const [token] = await executeQuery(
      (db) =>
        db
          .select()
          .from(oauthRefreshTokens)
          .where(
            and(
              eq(oauthRefreshTokens.tokenHash, hash),
              isNull(oauthRefreshTokens.revokedAt)
            )
          )
          .limit(1),
      "oidcAdapter.findRefreshToken"
    )

    if (!token) return undefined

    return {
      accountId: String(token.userId),
      clientId: token.clientId,
      scope: asStringArray(token.scopes).join(" "),
      expiresAt: token.expiresAt,
      consumed: token.rotatedAt ? Math.floor(token.rotatedAt.getTime() / 1000) : undefined,
    }
  }
}

// ============================================
// Export Factory (required by oidc-provider)
// ============================================

export function DrizzleOidcAdapter(model: string): Adapter {
  return new DrizzleAdapter(model)
}
