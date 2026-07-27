/**
 * Edge-Runtime-safe Cognito refresh-token exchange (#1297).
 *
 * WHY THIS EXISTS
 * ---------------
 * `auth.ts` (and therefore its JWT callback) runs inside `middleware.ts`, which
 * Next.js compiles for the **Edge Runtime sandbox** — even in a self-hosted
 * `output: 'standalone'` Node server. That sandbox only exposes an allowlist of
 * native modules.
 *
 * The previous implementation tried to cross into Node by doing
 * `await import("@/actions/auth/refresh-token-action")` from the Edge graph.
 * That does NOT create a runtime boundary: a dynamic import with a *static*
 * specifier is still bundled into the importing runtime's chunk, and a
 * `"use server"` action is only turned into an RPC call when it is imported by
 * a **client** component. Importing it from server/Edge code inlines the real
 * implementation — dragging in `@/lib/logger` → `winston` (declared in
 * `serverExternalPackages`, so it compiles to a bare `require("winston")`).
 * The Edge sandbox rejected that require with
 * `TypeError: Native module not found: winston`, the JWT callback returned
 * `null`, and every session in the proactive-refresh window was bounced to
 * sign-in.
 *
 * THE FIX
 * -------
 * Perform the refresh with primitives the Edge Runtime actually has: `fetch`,
 * `URL`, `JSON`. Cognito's `InitiateAuth` with `AuthFlow=REFRESH_TOKEN_AUTH`
 * is an **unauthenticated** API for a public app client (this pool uses
 * `token_endpoint_auth_method: "none"` and sends no `SECRET_HASH`), so it needs
 * no SigV4 signing and no AWS SDK. The wire call below is exactly what
 * `@aws-sdk/client-cognito-identity-provider`'s `InitiateAuthCommand` emits.
 *
 * Everything in this module must stay Edge-safe:
 *   - no `winston` / `@/lib/logger` (use `@/lib/auth/edge-logger`)
 *   - no `@aws-sdk/*`
 *   - no `node:*` builtins
 * `tests/unit/lib/auth/edge-refresh-boundary.test.ts` walks the import graph and
 * fails the build if any of those ever reappear on this path.
 */

import { createLogger } from "@/lib/auth/edge-logger"

export interface RefreshedTokens {
  accessToken: string
  idToken: string
  refreshToken?: string
  expiresAt: number
}

/**
 * Why a refresh failed. Every value fails closed (the caller forces
 * re-authentication); the distinction exists so operators can tell a revoked
 * token apart from a Cognito outage in CloudWatch.
 */
export type RefreshFailureReason =
  | "invalid_input"
  | "rate_limited"
  | "configuration"
  | "permanent"
  | "transient"

export type RefreshResult =
  | { ok: true; tokens: RefreshedTokens }
  | { ok: false; reason: RefreshFailureReason; message: string }

const log = createLogger({ context: "cognito-refresh" })

// Rate limiting — constants, window semantics and eviction carried over from the
// retired server action so the observable behaviour of the refresh path is
// unchanged. Module state lives for the life of the server process (middleware
// runs in an in-process sandbox, not a per-request isolate), so these counters
// behave as they always did. One caveat worth knowing before tuning the numbers:
// this module is bundled into BOTH the Edge and Node graphs, so each runtime
// keeps its own counters and the effective budget is per-runtime, per-task.
const MAX_REFRESH_ATTEMPTS = 8 // Increased for long polling operations
const RATE_LIMIT_WINDOW_MS = 90 * 1000 // 90 second window for polling operations
const MAX_RATE_LIMIT_ENTRIES = 1000 // Max users to track
const POLLING_CONTEXT_MULTIPLIER = 1.5 // Extra allowance for polling operations
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

/** Cognito is a hard dependency of sign-in; do not let a hung socket stall the request. */
const REFRESH_TIMEOUT_MS = 10_000

const refreshAttempts = new Map<string, { count: number; lastAttempt: number; windowStart: number }>()
let lastCleanupTime = 0

/**
 * Promise deduplication so concurrent requests for one user issue one refresh.
 *
 * The value is a wrapper object rather than the bare promise so that ownership
 * can be established by comparing the *entry* (`get(key) === entry`) when
 * cleaning up. Comparing the promise itself would read to CodeQL's
 * `js/missing-await` as a promise used in a non-promise context — a false
 * positive, since identity is exactly what is wanted there, but an avoidable one.
 */
interface RefreshEntry {
  promise: Promise<RefreshResult>
}
const activeRefreshPromises = new Map<string, RefreshEntry>()

/**
 * Cognito error codes that mean "this refresh token will never work again".
 * The user must sign in; retrying is pointless. `NotAuthorizedException` is the
 * code Cognito returns for expired, invalid, and revoked refresh tokens alike.
 */
const PERMANENT_ERROR_TYPES = new Set([
  "NotAuthorizedException",
  "UserNotFoundException",
  "UserNotConfirmedException",
  "PasswordResetRequiredException",
  "ResourceNotFoundException",
  "InvalidParameterException",
])

// Exactly `cognito-idp.{region}.amazonaws.com` or its FIPS variant, and nothing
// else. The label pattern deliberately excludes `.` so the middle segment cannot
// expand into extra labels — a looser class would also accept unrelated AWS
// services under the same suffix (`cognito-idp-anything.s3.amazonaws.com`), and
// an S3 bucket name is globally first-come and covered by a real AWS
// certificate. Anchoring at both ends also rejects
// `cognito-idp.us-east-1.amazonaws.com.evil.test`.
const COGNITO_IDP_HOST_RE = /^cognito-idp(-fips)?\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/i

/**
 * Resolve the Cognito IDP endpoint to POST `InitiateAuth` at.
 *
 * Derived from `AUTH_COGNITO_ISSUER` first — the issuer is
 * `https://cognito-idp.{region}.amazonaws.com/{userPoolId}`, so its **origin**
 * is already the correct regional endpoint and carries the right partition
 * (`.amazonaws.com.cn`) or FIPS variant without any string surgery. The ECS task
 * definition sets `AUTH_COGNITO_ISSUER` but does NOT set `AWS_REGION`, so the
 * issuer is the only reliable source here; the env vars are a local-dev
 * fallback.
 *
 * @returns endpoint URL string, or null when nothing usable is configured
 *          (fail closed rather than guessing a region).
 */
export function resolveCognitoIdpEndpoint(
  issuer: string | undefined,
  envRegion?: string | undefined,
): string | null {
  if (issuer) {
    try {
      const url = new URL(issuer)
      if (url.protocol === "https:" && COGNITO_IDP_HOST_RE.test(url.hostname)) {
        return `${url.origin}/`
      }
    } catch {
      // Malformed issuer — fall through to the env-region fallback.
    }
  }

  // Region must look like a real AWS region; never interpolate arbitrary input
  // into a hostname we are about to POST a refresh token to.
  // The `(-iso|-iso[a-z])?` alternation is deliberate: the equivalent
  // `(-iso[a-z]?)?` nests a quantifier inside a quantified group, which is star
  // height 2 and an error under security/detect-unsafe-regex.
  if (envRegion && /^[a-z]{2}(-gov)?(-iso|-iso[a-z])?-[a-z]+-\d$/.test(envRegion)) {
    return `https://cognito-idp.${envRegion}.amazonaws.com/`
  }

  return null
}

/**
 * Deterministic cleanup of expired rate-limiting entries so the Maps cannot grow
 * without bound in a long-lived server process.
 */
function cleanupRateLimitingEntries(): void {
  const now = Date.now()
  const expiredThreshold = now - RATE_LIMIT_WINDOW_MS * 2

  for (const [userId, attempts] of refreshAttempts.entries()) {
    if (attempts.windowStart < expiredThreshold) {
      refreshAttempts.delete(userId)
    }
  }

  // Still oversized after dropping expired windows — evict least-recently-used.
  if (refreshAttempts.size > MAX_RATE_LIMIT_ENTRIES) {
    const entries = Array.from(refreshAttempts.entries())
    entries.sort((a, b) => a[1].lastAttempt - b[1].lastAttempt)

    const toRemove = refreshAttempts.size - MAX_RATE_LIMIT_ENTRIES
    for (let i = 0; i < toRemove; i++) {
      refreshAttempts.delete(entries[i][0])
    }
  }

  // Overflow valve for the dedup map. Entries normally remove themselves when
  // their promise settles; `fetchWithTimeout` guarantees settlement, so this
  // should never fire. It stays because a wedged entry is not a leak but a
  // deadlock: every later refresh for that user would join a promise that never
  // resolves and hang the JWT callback instead of failing closed.
  if (activeRefreshPromises.size > MAX_RATE_LIMIT_ENTRIES) {
    activeRefreshPromises.clear()
  }

  lastCleanupTime = now
}

function shouldRunCleanup(): boolean {
  const now = Date.now()
  return (
    now - lastCleanupTime > CLEANUP_INTERVAL_MS ||
    refreshAttempts.size > MAX_RATE_LIMIT_ENTRIES * 0.8
  )
}

/**
 * @param userId - User identifier (token.sub)
 * @param isPollingContext - Whether this is part of a long polling operation
 * @returns true if the caller is over its budget and must be refused
 */
function isRateLimited(userId: string, isPollingContext = false): boolean {
  const now = Date.now()

  if (shouldRunCleanup()) {
    cleanupRateLimitingEntries()
  }

  const attempts = refreshAttempts.get(userId)

  if (!attempts) {
    refreshAttempts.set(userId, { count: 1, lastAttempt: now, windowStart: now })
    return false
  }

  // New window — reset.
  if (now - attempts.windowStart >= RATE_LIMIT_WINDOW_MS) {
    refreshAttempts.set(userId, { count: 1, lastAttempt: now, windowStart: now })
    return false
  }

  const effectiveLimit = isPollingContext
    ? Math.ceil(MAX_REFRESH_ATTEMPTS * POLLING_CONTEXT_MULTIPLIER)
    : MAX_REFRESH_ATTEMPTS

  if (attempts.count >= effectiveLimit) {
    return true
  }

  refreshAttempts.set(userId, {
    count: attempts.count + 1,
    lastAttempt: now,
    windowStart: attempts.windowStart,
  })

  return false
}

/** Test-only reset so rate-limit/dedup state does not leak between test cases. */
export function __resetRefreshStateForTests(): void {
  refreshAttempts.clear()
  activeRefreshPromises.clear()
  lastCleanupTime = 0
}

/**
 * Narrow a value parsed out of an untrusted JSON body to a non-empty string.
 *
 * Returns `undefined` for every other shape, so callers can fail closed with a
 * single falsy check instead of trusting the declared interface — which is only
 * an assertion over `JSON.parse`, never a runtime guarantee.
 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Read the subject from a JWT payload without trusting its declared shape.
 *
 * This is deliberately not signature verification. The token arrived directly
 * from the configured Cognito HTTPS endpoint in the same response as the access
 * token, so TLS and the exact-host allowlist authenticate its source. The
 * remaining application-level invariant is that Cognito refreshed the same
 * subject as the signed NextAuth session that supplied the refresh token.
 *
 * Keep this implementation on Web Platform primitives so it remains usable in
 * Next's Edge Runtime (no Buffer or Node crypto).
 */
function readJwtSubject(token: string): string | undefined {
  const parts = token.split(".")
  if (parts.length !== 3 || !parts[1]) return undefined

  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes))

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined
    return nonEmptyString((payload as Record<string, unknown>).sub)
  } catch {
    return undefined
  }
}

interface InitiateAuthResponse {
  AuthenticationResult?: {
    AccessToken?: string
    IdToken?: string
    RefreshToken?: string
    ExpiresIn?: number
  }
  __type?: string
  message?: string
  Message?: string
}

/**
 * Classify a non-2xx `InitiateAuth` response.
 *
 * Cognito returns the error code in `__type`, sometimes namespaced
 * (`com.amazonaws.cognito.identity.provider#NotAuthorizedException`).
 */
export function classifyInitiateAuthError(
  status: number,
  body: { __type?: string } | null,
): { reason: Extract<RefreshFailureReason, "permanent" | "transient">; errorType: string } {
  const rawType = body?.__type ?? ""
  const errorType = rawType.includes("#") ? rawType.slice(rawType.lastIndexOf("#") + 1) : rawType

  if (PERMANENT_ERROR_TYPES.has(errorType)) {
    return { reason: "permanent", errorType: errorType || "unknown" }
  }

  // 5xx and throttling are Cognito-side and may succeed on the next request.
  if (status >= 500) {
    return { reason: "transient", errorType: errorType || `http_${status}` }
  }

  if (errorType === "TooManyRequestsException" || errorType === "LimitExceededException") {
    return { reason: "transient", errorType }
  }

  // Any other 4xx is a request we cannot repair by retrying.
  return { reason: "permanent", errorType: errorType || `http_${status}` }
}

const FALLBACK_TOKEN_LIFETIME_SECONDS = 3600
/** 30 days — far above any real Cognito access-token lifetime. */
const MAX_TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60

const isUsableLifetime = (value: number): boolean =>
  Number.isFinite(value) && value > 0 && value <= MAX_TOKEN_LIFETIME_SECONDS

/**
 * Access-token lifetime in seconds: Cognito's `ExpiresIn` when it is usable,
 * then the configured default, then a one-hour floor.
 *
 * Values are bounded at both ends. Zero/NaN would mark the fresh token as
 * already expired and spin the session in a refresh loop; an absurdly large
 * value would overflow the later `new Date(expiresAt).toISOString()` into a
 * `RangeError`, breaking this module's never-throws contract.
 */
function resolveLifetimeSeconds(expiresIn: number | undefined): number {
  if (typeof expiresIn === "number" && isUsableLifetime(expiresIn)) {
    return expiresIn
  }

  const configured = Number.parseInt(process.env.COGNITO_ACCESS_TOKEN_LIFETIME_SECONDS ?? "", 10)
  return isUsableLifetime(configured) ? configured : FALLBACK_TOKEN_LIFETIME_SECONDS
}

/**
 * `fetch` that is GUARANTEED to settle within `REFRESH_TIMEOUT_MS`.
 *
 * This is load-bearing, not defensive dressing: the caller registers its promise
 * in `activeRefreshPromises` and removes it in a `finally`. A request that never
 * settles would wedge that entry forever, and every subsequent refresh for the
 * user would join the dead promise and hang the JWT callback instead of failing
 * closed. `AbortSignal.timeout` does the job where it exists; where it does not,
 * a raced timer still settles the promise (the socket is left to finish on its
 * own, which is strictly better than deadlocking the session).
 */
async function fetchWithTimeout(endpoint: string, init: RequestInit): Promise<Response> {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return fetch(endpoint, { ...init, signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) })
  }

  const request = fetch(endpoint, init)
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Cognito refresh timed out")),
          REFRESH_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    // If the timer won the race, the request is still in flight; swallow its
    // eventual outcome so it cannot surface as an unhandled rejection.
    request.catch(() => {})
  }
}

export interface RefreshCognitoTokensParams {
  refreshToken: string
  tokenSub: string
  /** Long-running/polling requests get a larger rate-limit budget. */
  isPollingContext?: boolean
}

/**
 * Exchange a Cognito refresh token for fresh access + ID tokens.
 *
 * Concurrent calls for the same `tokenSub` share a single in-flight request.
 * Never throws: all failures are returned as data so the NextAuth JWT callback
 * can fail closed deliberately instead of unwinding through an exception.
 */
export async function refreshCognitoTokens(
  params: RefreshCognitoTokensParams,
): Promise<RefreshResult> {
  const { tokenSub } = params

  if (typeof tokenSub !== "string" || tokenSub.length === 0) {
    return { ok: false, reason: "invalid_input", message: "Token sub must be a non-empty string" }
  }

  if (typeof params.refreshToken !== "string" || params.refreshToken.length < 10) {
    return { ok: false, reason: "invalid_input", message: "Invalid refresh token" }
  }

  // Keyed on the refresh token as well as the user. One user can hold several
  // sessions (several devices), each with a DIFFERENT refresh token. Keying on
  // `tokenSub` alone let a session whose token had been revoked join an
  // in-flight refresh for a still-valid sibling session and receive working
  // tokens — surviving its own revocation. The key never leaves this Map and is
  // never logged.
  const dedupKey = `${tokenSub}\u0000${params.refreshToken}`

  const existing = activeRefreshPromises.get(dedupKey)
  if (existing) {
    log.info("Token refresh already in progress, joining existing request", { tokenSub })
    return existing.promise
  }

  const entry: RefreshEntry = { promise: performRefresh(params) }
  activeRefreshPromises.set(dedupKey, entry)

  try {
    return await entry.promise
  } finally {
    // Delete only the entry THIS call registered. `cleanupRateLimitingEntries()`
    // clears the whole map once it exceeds MAX_RATE_LIMIT_ENTRIES, after which a
    // later request can register a *new* entry under this same key while this
    // one is still in flight. An unconditional delete would evict that newer
    // entry, silently disabling dedup for it — every subsequent caller would
    // issue its own Cognito call and burn the user's refresh budget.
    if (activeRefreshPromises.get(dedupKey) === entry) {
      activeRefreshPromises.delete(dedupKey)
    }
  }
}

async function performRefresh(params: RefreshCognitoTokensParams): Promise<RefreshResult> {
  const { refreshToken, tokenSub, isPollingContext } = params
  // The retired action wrapped this in `startTimer()` from @/lib/logger, which
  // is winston-backed and cannot be used here. Emitting `status` + `durationMs`
  // on every outcome keeps CloudWatch metric filters possible.
  const startedAt = Date.now()
  const elapsedMs = () => Date.now() - startedAt

  if (isRateLimited(tokenSub, isPollingContext)) {
    log.warn("Token refresh blocked by rate limit", { tokenSub, isPollingContext: !!isPollingContext })
    return { ok: false, reason: "rate_limited", message: "Too many refresh attempts" }
  }

  const clientId = process.env.AUTH_COGNITO_CLIENT_ID
  if (!clientId) {
    log.error("AUTH_COGNITO_CLIENT_ID is not set — cannot refresh")
    return { ok: false, reason: "configuration", message: "Authentication configuration error" }
  }

  // This exchange is unsigned because the app client is public. If the client is
  // ever given a secret, Cognito requires a SECRET_HASH and answers every
  // refresh with NotAuthorizedException — which would otherwise be classified as
  // "permanent" and log as a revoked token while silently signing out the whole
  // user base. Name the real cause instead.
  if (process.env.AUTH_COGNITO_CLIENT_SECRET) {
    log.error(
      "AUTH_COGNITO_CLIENT_SECRET is set, but this refresh path only supports a public app client (no SECRET_HASH)",
    )
    return {
      ok: false,
      reason: "configuration",
      message: "Confidential Cognito app client is not supported by the Edge refresh path",
    }
  }

  const endpoint = resolveCognitoIdpEndpoint(
    process.env.AUTH_COGNITO_ISSUER,
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
  )
  if (!endpoint) {
    log.error("Unable to resolve a Cognito IDP endpoint from AUTH_COGNITO_ISSUER/AWS_REGION")
    return { ok: false, reason: "configuration", message: "AWS region configuration required" }
  }

  let response: Response
  try {
    response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
      },
      body: JSON.stringify({
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: clientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      }),
      cache: "no-store",
      // The refresh token travels in the request BODY, so a cross-origin
      // redirect would not strip it the way it strips an Authorization header.
      // Following a 307/308 would re-POST the credential to an arbitrary host
      // and make the endpoint allowlist above meaningless.
      redirect: "error",
    })
  } catch (error) {
    // Network failure / timeout. `error` is sanitized by the edge logger, which
    // redacts any long token-shaped substring.
    log.error("Cognito refresh request failed to complete", {
      tokenSub,
      status: "error",
      durationMs: elapsedMs(),
      error: error instanceof Error ? error.message : "Unknown error",
    })
    return { ok: false, reason: "transient", message: "Cognito request failed" }
  }

  // Read as text first: Cognito error bodies are JSON, but a proxy/5xx can
  // return HTML, and an unguarded response.json() would throw past our
  // fail-closed contract.
  let body: InitiateAuthResponse | null = null
  try {
    const text = await response.text()
    body = text ? (JSON.parse(text) as InitiateAuthResponse) : null
  } catch {
    body = null
  }

  if (!response.ok) {
    const { reason, errorType } = classifyInitiateAuthError(response.status, body)
    log.warn("Cognito refresh rejected", {
      tokenSub,
      status: "error",
      durationMs: elapsedMs(),
      httpStatus: response.status,
      errorType,
      classification: reason,
    })
    return { ok: false, reason, message: `Cognito refresh failed (${errorType})` }
  }

  const authResult = body?.AuthenticationResult
  // Type-check the tokens; do not merely test them for truthiness.
  // `InitiateAuthResponse` is an *assertion* over `JSON.parse` output, not a
  // guarantee. A 2xx body from Cognito or an intermediary can carry token fields
  // that are objects, numbers or arrays — all truthy. Those would flow into the
  // NextAuth JWT and be handed out as session tokens, leaving a session that
  // looks refreshed but carries a credential no downstream API can use. Fail
  // closed instead: a forced re-authentication is recoverable, a poisoned
  // session is not.
  const accessToken = nonEmptyString(authResult?.AccessToken)
  const idToken = nonEmptyString(authResult?.IdToken)
  // `authResult` is tested explicitly (rather than left to the token checks) so
  // it stays narrowed to non-undefined for the success path below.
  if (!authResult || !accessToken || !idToken) {
    log.warn("Cognito refresh returned an incomplete or malformed result", {
      tokenSub,
      status: "error",
      durationMs: elapsedMs(),
      hasAuthenticationResult: !!authResult,
      hasAccessToken: !!accessToken,
      hasIdToken: !!idToken,
      // Distinguishes "Cognito omitted a field" from "a field came back with the
      // wrong type", which are very different incidents to debug.
      accessTokenType: typeof authResult?.AccessToken,
      idTokenType: typeof authResult?.IdToken,
    })
    return { ok: false, reason: "transient", message: "Incomplete token refresh response" }
  }

  // Bind Cognito's response to the existing signed session before installing
  // either credential into that session. Without this check, a mismatched
  // refresh-token/session pairing would create a confused session whose local
  // identity belongs to one user while its Cognito credentials belong to
  // another. Malformed JWT payloads fail closed for the same reason.
  if (readJwtSubject(idToken) !== tokenSub) {
    log.warn("Refreshed token subject did not match requested session", {
      tokenSub,
      status: "error",
      durationMs: elapsedMs(),
    })
    return {
      ok: false,
      reason: "permanent",
      message: "Refreshed token subject mismatch",
    }
  }

  const lifetimeSeconds = resolveLifetimeSeconds(authResult.ExpiresIn)
  const expiresAt = Date.now() + lifetimeSeconds * 1000

  log.info("Cognito refresh successful", {
    tokenSub,
    status: "success",
    durationMs: elapsedMs(),
    newExpiresAt: new Date(expiresAt).toISOString(),
    hasRotatedRefreshToken: !!authResult.RefreshToken,
    expiresInSeconds: lifetimeSeconds,
  })

  return {
    ok: true,
    tokens: {
      accessToken,
      idToken,
      // REFRESH_TOKEN_AUTH normally does not rotate the refresh token; keep the
      // existing one so the session stays refreshable. A rotated value is only
      // accepted when it is actually a non-empty string — a malformed one here
      // would silently make the session unrefreshable on the *next* cycle.
      refreshToken: nonEmptyString(authResult.RefreshToken) ?? refreshToken,
      expiresAt,
    },
  }
}
