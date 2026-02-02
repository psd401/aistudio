/**
 * OIDC Provider Configuration
 * Configures node-oidc-provider with Drizzle adapter, KMS JWT signing,
 * and AI Studio-specific claims.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 */

import Provider from "oidc-provider"
import { DrizzleOidcAdapter } from "./drizzle-adapter"
import { getJwtSigner } from "./jwt-signer"
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

  const issuer =
    options?.issuer ??
    process.env.NEXTAUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000"

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
    scopes: ["openid", "profile", "email", "offline_access"],

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
      keys: [
        process.env.OIDC_COOKIE_SECRET ??
          process.env.NEXTAUTH_SECRET ??
          "dev-oidc-cookie-secret-change-in-production",
      ],
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
