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

  log.info("Initializing OIDC provider", { issuer, kid: jwk.kid })

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
    jwks: {
      keys: [
        {
          ...jwk,
          // oidc-provider needs the key in JWK format
          // Our signer provides the public key; signing is done via the adapter
        },
      ],
    },

    // ==========================================
    // Features
    // ==========================================
    features: {
      devInteractions: { enabled: false },
      introspection: { enabled: true },
      revocation: { enabled: true },
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
