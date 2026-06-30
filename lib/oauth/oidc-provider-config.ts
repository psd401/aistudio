/**
 * OIDC Provider Configuration
 * Configures node-oidc-provider with Drizzle adapter, KMS JWT signing,
 * and AI Studio-specific claims.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 */

import Provider from "oidc-provider"
import { DrizzleOidcAdapter } from "./drizzle-adapter"
import { getJwtSigner } from "./jwt-signer"
import { getIssuerUrl } from "./issuer-config"
import { ALL_OAUTH_SCOPES } from "./oauth-scopes"
import { createLogger } from "@/lib/logger"

// ============================================
// Types
// ============================================

interface OidcProviderOptions {
  issuer: string
}

// ============================================
// Provider Instance
// ============================================

let providerInstance: InstanceType<typeof Provider> | null = null

export async function getOidcProvider(
  options?: OidcProviderOptions
): Promise<InstanceType<typeof Provider>> {
  if (providerInstance) return providerInstance

  const log = createLogger({ action: "oidcProvider.init" })

  const issuer = getIssuerUrl(options?.issuer)

  const signer = await getJwtSigner()
  const jwk = await signer.getPublicKeyJwk()

  // For node-oidc-provider to issue JWT access tokens (which the API middleware
  // verifies via JWKS), it must SIGN with a private key whose public half is
  // served at /api/oauth/jwks. The local signer can export its private JWK; KMS
  // cannot (returns null), so JWT issuance is gated on having a signing key.
  // Prod with KMS needs an exportable OIDC signing key — see the Phase 5 runbook.
  const signingJwk = await signer.getSigningJwk()
  const canIssueJwtTokens = signingJwk != null
  if (!canIssueJwtTokens) {
    log.warn(
      "OIDC signing key is non-exportable (KMS); JWT access tokens disabled. " +
        "Client-credentials tokens will be opaque and unverifiable by the API " +
        "middleware until an exportable OIDC signing key is supplied."
    )
  }

  log.info("Initializing OIDC provider", {
    issuer,
    kid: jwk.kid,
    jwtTokens: canIssueJwtTokens,
  })

  const provider = new Provider(issuer, {
    // ==========================================
    // Adapter — uses Drizzle ORM for persistence
    // ==========================================
    adapter: DrizzleOidcAdapter,

    // ==========================================
    // Clients — loaded from DB via adapter
    // ==========================================
    // Dynamic client registration is not enabled;
    // clients are managed via admin UI and adapter.

    // ==========================================
    // JWKS — signing keys
    // ==========================================
    // Prefer the PRIVATE signing JWK so oidc-provider can sign JWT access/id
    // tokens; fall back to the public-only key (no signing) when unavailable.
    jwks: {
      keys: [(signingJwk ?? { ...jwk }) as Record<string, unknown>],
    },

    // ==========================================
    // Features
    // ==========================================
    features: {
      devInteractions: { enabled: false },
      introspection: { enabled: true },
      revocation: { enabled: true },
      // Atrium Phase 5 (#1055): machine-to-machine grant for autonomous agent
      // service identities (`agent_identities.oauthClientId`).
      clientCredentials: { enabled: true },
      // JWT access tokens (so the API middleware can verify bearer tokens via
      // JWKS). Only enabled when we have an exportable signing key; otherwise
      // tokens stay opaque to avoid an init failure (oidc-provider needs the
      // private key to sign).
      ...(canIssueJwtTokens
        ? {
            resourceIndicators: {
              enabled: true,
              defaultResource: async () => issuer,
              useGrantedResource: async () => true,
              getResourceServerInfo: async () => ({
                scope: ALL_OAUTH_SCOPES.join(" "),
                audience: issuer,
                accessTokenTTL: 900,
                accessTokenFormat: "jwt" as const,
              }),
            },
          }
        : {}),
    },

    // Stamp a `sub` on client-credentials JWTs (which have no end-user) so the
    // API middleware (sub -> users.id) and the audit/token tables resolve. The
    // agent's identity is carried by `client_id`; ownership is the system user.
    async extraTokenClaims(_ctx, token) {
      if ((token as { kind?: string }).kind === "ClientCredentials") {
        const sysId = process.env.ATRIUM_SYSTEM_USER_ID
        if (sysId) return { sub: sysId }
      }
      return {}
    },

    // ==========================================
    // PKCE — required (S256 only)
    // ==========================================
    pkce: {
      required: () => true,
    },

    // ==========================================
    // TTLs
    // ==========================================
    ttl: {
      AccessToken: 900, // 15 minutes
      AuthorizationCode: 60, // 1 minute
      RefreshToken: 86400, // 24 hours
      IdToken: 3600, // 1 hour
      Interaction: 600, // 10 minutes for consent flow
      Session: 86400, // 24 hours
      Grant: 86400,
    },

    // ==========================================
    // Claims
    // ==========================================
    claims: {
      openid: ["sub"],
      profile: ["name", "email"],
      email: ["email"],
    },

    // ==========================================
    // Scopes
    // ==========================================
    scopes: ALL_OAUTH_SCOPES,

    // ==========================================
    // Interactions — custom consent UI
    // ==========================================
    interactions: {
      url: (_ctx, interaction) => {
        return `/oauth/authorize?uid=${interaction.uid}`
      },
    },

    // ==========================================
    // Account claims
    // ==========================================
    async findAccount(_ctx, id) {
      const { executeQuery } = await import("@/lib/db/drizzle-client")
      const { eq } = await import("drizzle-orm")
      const { users } = await import("@/lib/db/schema")

      const [user] = await executeQuery(
        (db) =>
          db
            .select({
              id: users.id,
              cognitoSub: users.cognitoSub,
              email: users.email,
              firstName: users.firstName,
              lastName: users.lastName,
            })
            .from(users)
            .where(eq(users.id, Number.parseInt(id, 10)))
            .limit(1),
        "oidc.findAccount"
      )

      if (!user) return undefined

      return {
        accountId: String(user.id),
        async claims() {
          return {
            sub: String(user.id),
            email: user.email,
            name: [user.firstName, user.lastName].filter(Boolean).join(" "),
          }
        },
      }
    },

    // ==========================================
    // Response types & grant types
    // ==========================================
    responseTypes: ["code"],

    // ==========================================
    // Cookies
    // ==========================================
    cookies: {
      keys: (() => {
        const secret = process.env.OIDC_COOKIE_SECRET ?? process.env.NEXTAUTH_SECRET
        if (!secret) {
          if (process.env.NODE_ENV === "production") {
            throw new Error(
              "OIDC_COOKIE_SECRET or NEXTAUTH_SECRET must be set in production. " +
              "Generate with: openssl rand -base64 32"
            )
          }
          return ["dev-oidc-cookie-secret-change-in-production"]
        }
        return [secret]
      })(),
    },
  })

  // Silence the oidc-provider warning about cookies in dev
  provider.on("server_error", (ctx, err) => {
    log.error("OIDC provider error", {
      error: err.message,
      path: ctx?.path,
    })
  })

  providerInstance = provider
  log.info("OIDC provider initialized")
  return provider
}
