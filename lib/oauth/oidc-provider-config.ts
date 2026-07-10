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

    // Refresh-token rotation (REV-DB-164): node-oidc-provider's built-in default for
    // `rotateRefreshToken` is NOT `false` — it's a function that rotates refresh tokens
    // issued to public (`token_endpoint_auth_method: "none"`) clients and tokens nearing
    // expiry. Since this app supports public/PKCE-only clients, that default would rotate
    // their refresh tokens, and this adapter's `consume('RefreshToken')` now stamps
    // `rotated_at` on every consume — so an un-pinned default would mark a public client's
    // original refresh token as rotated/consumed on first use, breaking any client that
    // expects to reuse the same refresh token for the full 24h TTL. Pin it to `false`
    // explicitly so refresh tokens stay single-use-per-TTL, not rotated. The adapter is
    // correct-by-construction either way: flipping this to a rotating policy later is safe
    // without further adapter changes, and replay of a rotated token would be detected.
    rotateRefreshToken: false,

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
