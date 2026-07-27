import NextAuth from "next-auth"
import Cognito from "next-auth/providers/cognito"
import type { Account, NextAuthConfig, Profile, User } from "next-auth"
import type { JWT } from "next-auth/jwt"
import { refreshAccessToken, shouldRefreshToken } from "@/lib/auth/token-refresh-client"
import { createLogger } from "@/lib/auth/edge-logger"

/**
 * Fire-and-forget mirror of the user's Cognito refresh token to Secrets
 * Manager so the AgentCore agent (running in a different environment) can
 * authenticate to the data MCP server on their behalf.
 *
 * Skipped outright on the Edge Runtime, and any failure (missing env vars,
 * IAM, AWS unavailable) is logged but does NOT break the auth flow.
 *
 * NOTE (#1297): a dynamic import with a static specifier is still *bundled*
 * into the importing runtime — it is not a runtime boundary. `agent-token-sync`
 * pulls in `@/lib/logger` → `winston`, which the Edge sandbox cannot load, so
 * on Edge the import throws `TypeError: Native module not found: winston`.
 * That has always been caught below (the sync is best-effort), but the explicit
 * EdgeRuntime guard means the refresh path no longer even attempts the load, and
 * stops emitting a misleading warning on every middleware-driven refresh.
 *
 * What this does and does not cover, precisely:
 *   - Initial sign-in DOES mirror — the NextAuth callback route runs in Node.
 *   - A refresh driven by a Node-runtime `auth()` call DOES mirror.
 *   - A refresh driven by middleware does NOT mirror, so a Cognito-ROTATED
 *     refresh token is not written through on that path. This is unchanged
 *     behaviour (the import threw and was swallowed before), and
 *     /agent-connect-data remains the explicit fallback for users whose token
 *     never makes it here. Fixing it properly needs a real Node hop, not a
 *     dynamic import — see docs/guides/edge-runtime-boundaries.md.
 */
function syncCognitoRefreshForAgentBackground(
  email: string | undefined,
  refreshToken: string | undefined,
): void {
  if (!email || !refreshToken) return
  if (typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime !== "undefined") return
  // REV-COR-247: route this failure through the edge logger like the rest of
  // auth.ts rather than console.error — auth.ts runs inside the Next.js runtime,
  // where console.* is banned (CLAUDE.md). Only the error message is logged, never
  // the refresh token.
  const log = createLogger({ context: "agent-token-sync" })
  ;(async () => {
    try {
      const mod = await import("@/lib/auth/agent-token-sync")
      await mod.syncCognitoRefreshForAgent(email, refreshToken)
    } catch (err) {
      // edge runtime, missing IAM, etc. — swallow. The on-demand consent
      // flow is the fallback for users whose token never makes it here.
      log.warn("background sync failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })()
}

const DEFAULT_SESSION_MAX_AGE_SECONDS = 24 * 60 * 60 // 24 hours

/**
 * Parse SESSION_MAX_AGE defensively (REV-COR-248). A set-but-invalid value
 * ("24h", "abc", "0", negative, empty, whitespace) must fall back to the 24h
 * default rather than passing NaN/0 to NextAuth's session/cookie config, which
 * produces undefined session-lifetime behavior (an invalid `Max-Age`).
 */
export function resolveSessionMaxAge(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_MAX_AGE_SECONDS
}

type AuthLogger = ReturnType<typeof createLogger>

function decodedIdToken(idToken: string): Record<string, unknown> {
  const base64Payload = idToken.split(".")[1]
  const payload = Buffer.from(base64Payload, "base64").toString("utf-8")
  const decoded: unknown = JSON.parse(payload)
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TypeError("Cognito ID token payload must be an object")
  }
  return decoded as Record<string, unknown>
}

function stringClaim(
  claims: Record<string, unknown>,
  name: string
): string | undefined {
  const value = claims[name]
  return typeof value === "string" ? value : undefined
}

function numberClaim(
  claims: Record<string, unknown>,
  name: string
): number | undefined {
  const value = claims[name]
  return typeof value === "number" ? value : undefined
}

function fallbackInitialToken(
  account: Account,
  profile: Profile | undefined,
  user: User | undefined
): JWT {
  const now = Date.now()
  return {
    sub: account.providerAccountId,
    email: user?.email || profile?.email || undefined,
    name: user?.name || profile?.name || undefined,
    accessToken: account.access_token,
    refreshToken: account.refresh_token,
    idToken: account.id_token,
    expiresAt: account.expires_at
      ? account.expires_at * 1000
      : now + 12 * 60 * 60 * 1000,
    tokenLifetimeMs: 12 * 60 * 60 * 1000,
    roleVersion: 0,
  }
}

function initialCognitoToken(
  account: Account,
  profile: Profile | undefined,
  user: User | undefined,
  log: AuthLogger
): JWT {
  try {
    const claims = decodedIdToken(account.id_token ?? "")
    const issuedAt = numberClaim(claims, "iat")
    const issuedAtMs = issuedAt ? issuedAt * 1000 : Date.now()
    const expiresAt = account.expires_at
      ? account.expires_at * 1000
      : Date.now() + 12 * 60 * 60 * 1000
    const email = stringClaim(claims, "email")
    const token: JWT = {
      sub: stringClaim(claims, "sub"),
      email,
      name:
        stringClaim(claims, "name") ||
        stringClaim(claims, "given_name") ||
        stringClaim(claims, "preferred_username") ||
        email,
      given_name: stringClaim(claims, "given_name"),
      family_name: stringClaim(claims, "family_name"),
      preferred_username: stringClaim(claims, "preferred_username"),
      accessToken: account.access_token,
      refreshToken: account.refresh_token,
      idToken: account.id_token,
      expiresAt,
      iat: issuedAt,
      tokenLifetimeMs: expiresAt - issuedAtMs,
      roleVersion: 0,
    }
    log.debug("Token lifetime information", {
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      tokenLifetimeHours: Math.round(
        (expiresAt - issuedAtMs) / (1000 * 60 * 60)
      ),
      cognitoProvidedExpiry: Boolean(account.expires_at),
    })
    syncCognitoRefreshForAgentBackground(
      token.email,
      typeof token.refreshToken === "string"
        ? token.refreshToken
        : undefined
    )
    return token
  } catch (error) {
    log.warn("Failed to parse ID token, using fallback approach", {
      error: error instanceof Error ? error.message : "Unknown error",
    })
    return fallbackInitialToken(account, profile, user)
  }
}

async function refreshExistingJwt(
  token: JWT,
  log: AuthLogger
): Promise<JWT | null> {
  if (!token.expiresAt) {
    log.warn("Token missing expiration time, allowing to continue")
    return token
  }
  const expiresAt = token.expiresAt as number
  const now = Date.now()
  const isExpired = now > expiresAt
  const isLongRunningOperation =
    typeof global !== "undefined" &&
    Boolean(
      (global as { __POLLING_CONTEXT__?: boolean }).__POLLING_CONTEXT__
    )
  const shouldRefresh = shouldRefreshToken(token, {
    isLongRunningOperation,
    operationType: isLongRunningOperation ? "polling" : "normal",
    estimatedDurationMs: isLongRunningOperation
      ? 30 * 60 * 1000
      : undefined,
  })
  if (!isExpired && !shouldRefresh) {
    log.debug("Token is valid, no refresh needed")
    return token
  }
  if (!token.refreshToken) {
    log.warn("No refresh token available - forcing re-authentication")
    return null
  }
  try {
    const refreshedTokens = await refreshAccessToken(token)
    if (!refreshedTokens) {
      log.warn("Token refresh failed - forcing re-authentication")
      return null
    }
    syncCognitoRefreshForAgentBackground(
      typeof token.email === "string" ? token.email : undefined,
      refreshedTokens.refreshToken
    )
    return {
      ...token,
      accessToken: refreshedTokens.accessToken,
      idToken: refreshedTokens.idToken,
      refreshToken: refreshedTokens.refreshToken,
      expiresAt: refreshedTokens.expiresAt,
      tokenLifetimeMs: token.tokenLifetimeMs,
    }
  } catch (error) {
    log.error("Token refresh threw error - forcing re-authentication", {
      error: error instanceof Error ? error.message : "Unknown error",
    })
    return null
  }
}

export const authConfig: NextAuthConfig = {
  providers: [
    Cognito({
      name: "AI Studio",
      clientId: process.env.AUTH_COGNITO_CLIENT_ID!,
      clientSecret: process.env.AUTH_COGNITO_CLIENT_SECRET || "",
      issuer: process.env.AUTH_COGNITO_ISSUER!,
      wellKnown: `${process.env.AUTH_COGNITO_ISSUER}/.well-known/openid-configuration`,
      authorization: {
        params: {
          scope: "openid email profile",
          response_type: "code",
          prompt: "login", // Force Cognito to show login screen and create new session
          redirect_uri: process.env.AUTH_URL ? `${process.env.AUTH_URL}/api/auth/callback/cognito` : undefined,
        },
      },
      client: {
        token_endpoint_auth_method: "none",
      },
      checks: ["pkce", "state", "nonce"], // Enable PKCE, state and nonce checks (CSRF protection)
      profile(profile) {
        return {
          id: profile.sub,
          name: profile.name || profile.given_name || profile.family_name,
          email: profile.email,
          image: profile.picture,
        }
      },
    })
  ],
  callbacks: {
    async jwt({ token, account, profile, user, trigger }) {
      const log = createLogger({
        context: "auth-jwt-callback",
        tokenSub: token?.sub as string || 'unknown'
      })

      // Handle session update trigger (when roles change)
      if (trigger === "update") {
        log.info("Session update triggered - forcing re-authentication")
        // Force token refresh by returning null
        // This will cause the user to re-authenticate
        return null;
      }

      // Initial sign in - store essential data
      if (account && account.id_token) {
        log.info("Initial sign in - processing new tokens", {
          hasAccessToken: !!account.access_token,
          hasRefreshToken: !!account.refresh_token,
          hasIdToken: !!account.id_token,
          expiresAt: account.expires_at ? new Date(account.expires_at * 1000).toISOString() : 'unknown'
        })
        return initialCognitoToken(account, profile, user, log)
      }

      return refreshExistingJwt(token, log)
    },
    async session({ session, token }) {
      const log = createLogger({
        context: "auth-session-callback",
        tokenSub: token?.sub as string || 'unknown'
      })

      // Check if token exists and is valid
      if (!token || !token.sub) {
        log.warn("Session callback called with invalid token")
        return session; // Return empty session instead of null
      }

      // Check if token is expired (shouldn't happen after JWT callback refresh logic)
      if (token.expiresAt && Date.now() > (token.expiresAt as number)) {
        log.warn("Session callback received expired token - returning empty session", {
          expiresAt: new Date(token.expiresAt as number).toISOString(),
          now: new Date().toISOString()
        })
        // Return an empty session to force re-authentication
        return {
          ...session,
          user: {
            id: '',
            email: '',
            name: '',
            givenName: null,
            familyName: null
          },
          accessToken: '',
          idToken: '',
          refreshToken: ''
        }
      }

      // Send properties to the client
      const givenName = token.given_name as string;
      const familyName = token.family_name as string;
      const fullName = token.name as string;
      const preferredUsername = token.preferred_username as string;
      const email = token.email as string;

      // Use given_name as display name, with multiple fallbacks
      const displayName = givenName || fullName || preferredUsername || familyName || email;

      session.user = {
        ...session.user,
        id: token.sub as string,
        email: email,
        name: displayName,
        givenName: givenName || null,
        familyName: familyName || null,
      }

      // Store tokens in session for server-side use
      // NOTE: These tokens are necessary for:
      // - accessToken: Making authenticated API calls to AWS services
      // - idToken: Contains user claims and is used for identity verification
      // - refreshToken: Required for token refresh when accessToken expires
      //
      // Security considerations:
      // - These tokens are encrypted in the JWT session cookie
      // - Never log or expose these tokens in client-side code
      // - Consider implementing token rotation for enhanced security
      session.accessToken = token.accessToken as string;
      session.idToken = token.idToken as string;
      session.refreshToken = token.refreshToken as string;

      log.debug("Session created successfully", {
        userId: session.user.id,
        userEmail: session.user.email,
        hasAccessToken: !!session.accessToken,
        hasIdToken: !!session.idToken,
        hasRefreshToken: !!session.refreshToken,
        tokenExpiresAt: token.expiresAt ? new Date(token.expiresAt as number).toISOString() : 'unknown'
      })

      return session
    },
    async redirect({ url, baseUrl }) {
      // Allows relative callback URLs
      if (url.startsWith("/")) return `${baseUrl}${url}`
      // Allows callback URLs on the same origin
      else if (new URL(url).origin === baseUrl) return url
      return baseUrl + "/dashboard"
    },
    async signIn() {
      return true;
    },
  },
  pages: {
    // We'll use the default NextAuth pages for now
    // Can customize later if needed
    error: "/auth/error",
  },
  session: {
    strategy: "jwt",
    // Session max age in seconds (default: 24 hours). Parsed defensively so a
    // malformed SESSION_MAX_AGE can never yield NaN (REV-COR-248).
    maxAge: resolveSessionMaxAge(process.env.SESSION_MAX_AGE),
  },
  cookies: {
    sessionToken: {
      name: `authjs.session-token`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production'
      }
    },
    callbackUrl: {
      name: `authjs.callback-url`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production'
      }
    },
    csrfToken: {
      name: `authjs.csrf-token`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production'
      }
    },
    pkceCodeVerifier: {
      name: `authjs.pkce.code_verifier`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 60 * 15 // 15 minutes
      }
    },
    state: {
      name: `authjs.state`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 60 * 15 // 15 minutes
      }
    },
    nonce: {
      name: `authjs.nonce`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production'
      }
    },
  },
  debug: false, // Disabled to suppress CHUNKING_SESSION_COOKIE warnings (#361)
  events: {
    async signOut() {
      // This event fires after NextAuth's signOut
      // We can use this for any cleanup needed
      // User signed out
    },
  },
}

// Factory function - creates new instance per request
export function createAuth() {
  return NextAuth(authConfig)
}

// For middleware only - stateless operations
// This is safe because middleware doesn't maintain user-specific state
const middlewareAuth = NextAuth(authConfig)
export const { auth: authMiddleware } = middlewareAuth

// Export auth handlers for route.ts files
// These need to be created per-request in the route handlers
export function createAuthHandlers() {
  const { handlers } = createAuth()
  return handlers
}
