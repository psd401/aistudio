/**
 * OIDC Provider Configuration
 * Configures node-oidc-provider with the durable Drizzle adapter, shared OIDC
 * signing keys, and AI Studio-specific claims.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 */

import Provider from "oidc-provider"
import { DrizzleOidcAdapter } from "./drizzle-adapter"
import { getOidcSigningKeySet } from "./oidc-signing-key-store"
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
let providerKeyFingerprint: string | null = null

/**
 * Security guard (#1055): a client-credentials token is stamped
 * `sub = ATRIUM_SYSTEM_USER_ID`. If that account is an administrator, the machine
 * token would (a) let an autonomous agent with `content:update` edit the account's
 * OWN content (it owns via the same id) and (b) pass `isAdminByUserId(auth.userId)`
 * on admin-gated non-content endpoints (e.g. /api/v1/assistants). Log LOUDLY at
 * init so an operator repoints it at a dedicated non-admin service account. Not a
 * hard failure — that would break all OAuth (incl. interactive login) on a
 * misconfig; the error log is the alarm.
 */
async function warnIfSystemUserIsAdmin(
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const raw = process.env.ATRIUM_SYSTEM_USER_ID
  const id = Number.parseInt(raw ?? "", 10)
  if (!Number.isInteger(id) || id <= 0) return
  try {
    const { executeQuery } = await import("@/lib/db/drizzle-client")
    const { and, eq } = await import("drizzle-orm")
    const { userRoles, roles } = await import("@/lib/db/schema")
    const rows = await executeQuery(
      (db) =>
        db
          .select({ id: roles.id })
          .from(userRoles)
          .innerJoin(roles, eq(userRoles.roleId, roles.id))
          .where(and(eq(userRoles.userId, id), eq(roles.name, "administrator")))
          .limit(1),
      "oidc.systemUserAdminGuard"
    )
    if (rows[0]) {
      log.error(
        "SECURITY: ATRIUM_SYSTEM_USER_ID points at an ADMINISTRATOR account. " +
          "Client-credentials tokens are stamped sub=this id, so autonomous agents " +
          "could edit that account's content and pass admin gates on non-content " +
          "endpoints. Use a dedicated NON-ADMIN service account.",
        { systemUserId: id }
      )
    }
  } catch (err) {
    log.warn("Could not verify ATRIUM_SYSTEM_USER_ID admin status", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function getOidcProvider(
  options?: OidcProviderOptions
): Promise<InstanceType<typeof Provider>> {
  const log = createLogger({ action: "oidcProvider.init" })
  const issuer = getIssuerUrl(options?.issuer)
  const oidcKeys = await getOidcSigningKeySet()
  const keyFingerprint = oidcKeys.publicKeys
    .map((key) => key.kid)
    .join(":")
  if (
    providerInstance &&
    providerKeyFingerprint === keyFingerprint
  ) {
    return providerInstance
  }

  log.info("Initializing OIDC provider", {
    issuer,
    kid: oidcKeys.activeKid,
    verificationKeyCount: oidcKeys.publicKeys.length,
    jwtTokens: true,
  })

  // One-time (cached provider) security check for the client-credentials sub.
  await warnIfSystemUserIsAdmin(log)

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
    // The active private JWK is first. Retiring private JWKs remain present only
    // for the bounded overlap window so old tokens verify through the provider's
    // JWKS endpoint while all new tokens use the active key.
    jwks: {
      keys: oidcKeys.signingKeys as Record<string, unknown>[],
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
      // OAuth access tokens are always RS256 JWTs for the API issuer/audience.
      // Initialization fails closed if the shared key set is unavailable.
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

    // Public clients cannot protect a client secret, so every successful refresh
    // rotates the token. Replaying a consumed token revokes its full grant family.
    rotateRefreshToken: (ctx) =>
      ctx.oidc.client?.clientAuthMethod === "none",

    // Non-standard field documents the access-token profile alongside the
    // standard grant, PKCE, endpoint, scope, and signing metadata.
    discovery: {
      access_token_format: "jwt",
      access_token_signing_alg_values_supported: ["RS256"],
    },

    // oidc-provider's structured JWT formatter is intentionally stateless and
    // otherwise skips Adapter.upsert entirely. Persist the token metadata inside
    // this awaited formatting hook before signing/returning the JWT. API auth can
    // then enforce token and client revocation on every request, and a DB failure
    // fails issuance closed instead of creating an untracked bearer token.
    formats: {
      customizers: {
        async jwt(_ctx, token, jwt) {
          jwt.payload.token_use = "access"
          const payload = {
            ...Object.fromEntries(Object.entries(token)),
            jti: token.jti,
            kind: token.kind,
          }
          await DrizzleOidcAdapter("AccessToken").upsert(
            token.jti,
            payload,
            token.remainingTTL
          )
          return jwt
        },
      },
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
  providerKeyFingerprint = keyFingerprint
  log.info("OIDC provider initialized")
  return provider
}
