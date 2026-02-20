/**
 * Server-Side OAuth Provider for MCP Protocol
 *
 * Implements @ai-sdk/mcp's OAuthClientProvider interface for server-side use.
 * Handles dynamic client registration, token storage (encrypted in DB),
 * and the MCP-native OAuth flow (metadata discovery, PKCE, token exchange).
 *
 * Key design decisions:
 * - `redirectToAuthorization` captures the URL in an instance var (no real redirect)
 * - `saveCodeVerifier` / `codeVerifier` use instance state (single-request lifecycle)
 * - `clientInformation` is per-server (shared across users) — stored in nexus_mcp_servers
 * - tokens are per-user-per-server — stored in nexus_mcp_user_tokens
 *
 * Part of Epic #774 — Nexus MCP Connectors
 * Issue #797
 */

import { eq, and } from "drizzle-orm"
import { executeQuery } from "@/lib/db/drizzle-client"
import { nexusMcpServers, nexusMcpUserTokens } from "@/lib/db/schema"
import { encryptToken, decryptToken } from "@/lib/crypto/token-encryption"
import { createLogger } from "@/lib/logger"
import type {
  OAuthClientProvider,
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthTokens,
} from "@ai-sdk/mcp"

const log = createLogger({ action: "mcp-oauth-provider" })

interface ServerSideOAuthProviderOptions {
  serverId: string
  userId: number
  redirectUrl: string
  /** Pre-loaded code verifier (used in callback path) */
  preloadedCodeVerifier?: string
}

/**
 * Implements OAuthClientProvider for server-side MCP OAuth flows.
 *
 * Used in two contexts:
 * 1. Initiate: creates provider, calls auth() → captures authUrl, stores verifier
 * 2. Callback: creates provider with pre-loaded verifier, calls auth(code) → stores tokens
 */
export class ServerSideOAuthProvider implements OAuthClientProvider {
  private serverId: string
  private userId: number
  private _redirectUrl: string
  private _capturedAuthUrl: URL | null = null
  private _codeVerifier: string = ""

  constructor(options: ServerSideOAuthProviderOptions) {
    this.serverId = options.serverId
    this.userId = options.userId
    this._redirectUrl = options.redirectUrl
    if (options.preloadedCodeVerifier) {
      this._codeVerifier = options.preloadedCodeVerifier
    }
  }

  /** The authorization URL captured during the initiate flow */
  get capturedAuthUrl(): URL | null {
    return this._capturedAuthUrl
  }

  get redirectUrl(): string {
    return this._redirectUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this._redirectUrl],
      client_name: "AI Studio",
      token_endpoint_auth_method: "client_secret_post",
    }
  }

  /**
   * Load tokens from nexus_mcp_user_tokens (per-user-per-server).
   * Returns undefined if no token exists (triggers auth flow).
   */
  async tokens(): Promise<OAuthTokens | undefined> {
    const rows = await executeQuery(
      (db) =>
        db
          .select()
          .from(nexusMcpUserTokens)
          .where(
            and(
              eq(nexusMcpUserTokens.userId, this.userId),
              eq(nexusMcpUserTokens.serverId, this.serverId)
            )
          )
          .limit(1),
      "mcp-oauth:tokens"
    )

    if (rows.length === 0 || !rows[0].encryptedAccessToken) {
      return undefined
    }

    const row = rows[0]
    const accessToken = await decryptToken(row.encryptedAccessToken)

    const tokens: OAuthTokens = {
      access_token: accessToken,
      token_type: "bearer",
    }

    if (row.encryptedRefreshToken) {
      tokens.refresh_token = await decryptToken(row.encryptedRefreshToken)
    }

    if (row.tokenExpiresAt) {
      tokens.expires_in = Math.max(
        0,
        Math.floor((row.tokenExpiresAt.getTime() - Date.now()) / 1000)
      )
    }

    if (row.scope) {
      tokens.scope = row.scope
    }

    return tokens
  }

  /**
   * Encrypt and upsert tokens into nexus_mcp_user_tokens.
   */
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    log.info("Saving MCP OAuth tokens", {
      serverId: this.serverId,
      userId: this.userId,
      hasRefreshToken: !!tokens.refresh_token,
    })

    const encryptedAccess = await encryptToken(tokens.access_token)
    const encryptedRefresh = tokens.refresh_token
      ? await encryptToken(tokens.refresh_token)
      : null

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : null

    // Upsert: insert or update on conflict (userId + serverId unique index)
    await executeQuery(
      (db) =>
        db
          .insert(nexusMcpUserTokens)
          .values({
            userId: this.userId,
            serverId: this.serverId,
            encryptedAccessToken: encryptedAccess,
            encryptedRefreshToken: encryptedRefresh,
            tokenExpiresAt: expiresAt,
            scope: tokens.scope ?? null,
          })
          .onConflictDoUpdate({
            target: [nexusMcpUserTokens.userId, nexusMcpUserTokens.serverId],
            set: {
              encryptedAccessToken: encryptedAccess,
              encryptedRefreshToken: encryptedRefresh,
              tokenExpiresAt: expiresAt,
              scope: tokens.scope ?? null,
              updatedAt: new Date(),
            },
          }),
      "mcp-oauth:saveTokens"
    )
  }

  /**
   * Called by the SDK when it needs the user to authorize.
   * We capture the URL instead of performing a real redirect (server-side context).
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this._capturedAuthUrl = authorizationUrl
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this._codeVerifier = codeVerifier
  }

  async codeVerifier(): Promise<string> {
    return this._codeVerifier
  }

  /**
   * Load dynamic client registration info from nexus_mcp_servers.mcp_oauth_registration.
   * Per-server (shared across users).
   */
  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const rows = await executeQuery(
      (db) =>
        db
          .select({ mcpOauthRegistration: nexusMcpServers.mcpOauthRegistration })
          .from(nexusMcpServers)
          .where(eq(nexusMcpServers.id, this.serverId))
          .limit(1),
      "mcp-oauth:clientInformation"
    )

    if (rows.length === 0 || !rows[0].mcpOauthRegistration) {
      return undefined
    }

    const reg = rows[0].mcpOauthRegistration as Record<string, unknown>

    // Decrypt client_secret if present
    let clientSecret: string | undefined
    if (typeof reg.encrypted_client_secret === "string") {
      clientSecret = await decryptToken(reg.encrypted_client_secret)
    }

    return {
      client_id: reg.client_id as string,
      ...(clientSecret && { client_secret: clientSecret }),
      ...(typeof reg.client_id_issued_at === "number" && {
        client_id_issued_at: reg.client_id_issued_at,
      }),
      ...(typeof reg.client_secret_expires_at === "number" && {
        client_secret_expires_at: reg.client_secret_expires_at,
      }),
    }
  }

  /**
   * Save dynamic client registration info to nexus_mcp_servers.mcp_oauth_registration.
   * Encrypts client_secret if present.
   */
  async saveClientInformation(clientInformation: OAuthClientInformation): Promise<void> {
    log.info("Saving MCP OAuth client registration", {
      serverId: this.serverId,
      clientId: clientInformation.client_id,
    })

    // Encrypt client_secret before storing
    const registration: Record<string, unknown> = {
      client_id: clientInformation.client_id,
    }

    if (clientInformation.client_secret) {
      registration.encrypted_client_secret = await encryptToken(
        clientInformation.client_secret
      )
    }

    if (clientInformation.client_id_issued_at != null) {
      registration.client_id_issued_at = clientInformation.client_id_issued_at
    }
    if (clientInformation.client_secret_expires_at != null) {
      registration.client_secret_expires_at = clientInformation.client_secret_expires_at
    }

    await executeQuery(
      (db) =>
        db
          .update(nexusMcpServers)
          .set({
            mcpOauthRegistration: registration,
            updatedAt: new Date(),
          })
          .where(eq(nexusMcpServers.id, this.serverId)),
      "mcp-oauth:saveClientInformation"
    )
  }

  /**
   * Invalidates stored credentials when the server indicates they are no longer valid.
   */
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): Promise<void> {
    log.warn("MCP OAuth credentials invalidated", {
      serverId: this.serverId,
      userId: this.userId,
      scope,
    })

    if (scope === "all" || scope === "tokens") {
      await executeQuery(
        (db) =>
          db
            .delete(nexusMcpUserTokens)
            .where(
              and(
                eq(nexusMcpUserTokens.userId, this.userId),
                eq(nexusMcpUserTokens.serverId, this.serverId)
              )
            ),
        "mcp-oauth:invalidateTokens"
      )
    }

    if (scope === "all" || scope === "client") {
      await executeQuery(
        (db) =>
          db
            .update(nexusMcpServers)
            .set({ mcpOauthRegistration: null, updatedAt: new Date() })
            .where(eq(nexusMcpServers.id, this.serverId)),
        "mcp-oauth:invalidateClient"
      )
    }

    if (scope === "all" || scope === "verifier") {
      this._codeVerifier = ""
    }
  }
}
