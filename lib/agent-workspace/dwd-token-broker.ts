/**
 * Domain-wide-delegation (DWD) token broker (#1232).
 *
 * Mints short-lived (~1h) Google access tokens for `agnt_*@psd401.net` agent
 * accounts WITHOUT any human ever signing in as an agent account and without a
 * downloadable service-account key. This replaces the retired agent-slot OAuth
 * consent flow.
 *
 * Keyless flow (all three legs happen server-side, only in this module):
 *   1. Workload Identity Federation (WIF): exchange the app's AWS role
 *      credentials for a GCP STS token, then impersonate the DWD service account
 *      (google-auth-library ExternalAccountClient with AWS external-account
 *      config) to get a cloud-platform access token for the SA.
 *   2. IAM Credentials signJwt: sign a JWT assertion AS the service account with
 *      iss = SA email, sub = agnt_<user>@psd401.net, scope = the agent scope
 *      list, aud = https://oauth2.googleapis.com/token.
 *   3. Exchange the assertion at oauth2.googleapis.com/token
 *      (urn:ietf:params:oauth:grant-type:jwt-bearer) for the agent account's
 *      access token.
 *
 * HARD SECURITY INVARIANT: the target account is ALWAYS derived server-side as
 * `agnt_<owner-localpart>@psd401.net`. There is deliberately NO parameter for a
 * caller-supplied target address — that derivation is the containment that keeps
 * the domain-wide credential usable only for agnt_ accounts (never a human's
 * mailbox) and only for the calling owner.
 *
 * The WIF service account is provisioned by IT (Reese): GCP project number, WIF
 * pool + provider IDs, and the SA email are configuration (env/SSM), supplied
 * per environment. Until they are set, loadBrokerConfig() throws
 * BrokerNotConfiguredError and the broker fails closed.
 */

import { createLogger, sanitizeForLogging } from "@/lib/logger"
import { SAFE_EMAIL_RE } from "@/lib/agent-workspace/validation"
import { getImpersonatedAccessToken } from "@/lib/agent-workspace/gcp-wif"

const log = createLogger({ module: "dwd-token-broker" })

/**
 * The scopes the DWD grant covers — exactly SCOPES_BY_KIND.agent_account from
 * the (now retired) consent path MINUS `openid email profile` (OIDC sign-in
 * scopes, meaningless for domain-wide delegation). Kept here rather than
 * imported from the consent code because #1232 removes agent_account from the
 * OAuth flow, but the broker still needs this exact set.
 */
export const AGENT_DWD_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/meetings.space.created",
  "https://www.googleapis.com/auth/chat.messages",
  "https://www.googleapis.com/auth/chat.spaces",
  "https://www.googleapis.com/auth/directory.readonly",
] as const

/** Broker config is not set up in this environment (IT hasn't wired WIF yet). */
export class BrokerNotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BrokerNotConfiguredError"
  }
}

/** The agnt_ account doesn't exist yet (Google returned invalid_grant / no such user). */
export class AccountNotProvisionedError extends Error {
  agentEmail: string
  constructor(agentEmail: string) {
    super(`Agent account ${agentEmail} is not provisioned yet`)
    this.name = "AccountNotProvisionedError"
    this.agentEmail = agentEmail
  }
}

/** ownerEmail failed validation / the domain guard — never mint for it. */
export class InvalidOwnerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidOwnerError"
  }
}

export interface DwdBrokerConfig {
  projectNumber: string
  poolId: string
  providerId: string
  serviceAccountEmail: string
  /** The Workspace domain the DWD grant is scoped to (default psd401.net). */
  allowedDomain: string
}

/**
 * Load broker config from the environment. All four GCP identifiers are
 * required; a missing one means IT hasn't finished the Google-side setup, so
 * the broker fails closed with BrokerNotConfiguredError.
 */
export function loadBrokerConfig(): DwdBrokerConfig {
  const projectNumber = process.env.GCP_PROJECT_NUMBER?.trim() ?? ""
  const poolId = process.env.GCP_WIF_POOL_ID?.trim() ?? ""
  const providerId = process.env.GCP_WIF_PROVIDER_ID?.trim() ?? ""
  const serviceAccountEmail = process.env.GCP_DWD_SERVICE_ACCOUNT_EMAIL?.trim() ?? ""
  const allowedDomain = (process.env.AGENT_WORKSPACE_ALLOWED_DOMAIN?.trim() || "psd401.net").toLowerCase()

  const missing = [
    ["GCP_PROJECT_NUMBER", projectNumber],
    ["GCP_WIF_POOL_ID", poolId],
    ["GCP_WIF_PROVIDER_ID", providerId],
    ["GCP_DWD_SERVICE_ACCOUNT_EMAIL", serviceAccountEmail],
  ].filter(([, v]) => !v).map(([k]) => k)

  if (missing.length > 0) {
    throw new BrokerNotConfiguredError(
      `DWD token broker is not configured — missing: ${missing.join(", ")}. IT provides these per environment.`
    )
  }
  return { projectNumber, poolId, providerId, serviceAccountEmail, allowedDomain }
}

/**
 * Derive the agent account for an owner: `agnt_<owner-localpart>@<allowedDomain>`.
 *
 * This is THE containment guard. Rejects malformed emails and owners outside the
 * allowed domain, and forces the agent domain to the allowed domain (so a
 * cross-domain owner can never map to an in-domain agnt_ target). Throws
 * InvalidOwnerError on any violation. Never accepts a target address.
 */
export function deriveAgentEmail(ownerEmail: string, allowedDomain: string): string {
  if (typeof ownerEmail !== "string" || !SAFE_EMAIL_RE.test(ownerEmail)) {
    throw new InvalidOwnerError("ownerEmail is not a valid email address")
  }
  const [localPart, domain] = ownerEmail.split("@")
  if (!localPart || !domain) {
    throw new InvalidOwnerError("ownerEmail is malformed")
  }
  if (domain.toLowerCase() !== allowedDomain.toLowerCase()) {
    throw new InvalidOwnerError(`ownerEmail domain must be ${allowedDomain}`)
  }
  // Never re-derive from an already-agent address (defense against agnt_agnt_…).
  if (localPart.toLowerCase().startsWith("agnt_")) {
    throw new InvalidOwnerError("ownerEmail is already an agent account")
  }
  return `agnt_${localPart}@${allowedDomain}`
}

export interface MintedToken {
  accessToken: string
  /** ISO-8601 expiry (~1h out). */
  expiresAt: string
  /** The derived agnt_ address the token is for. */
  agentEmail: string
}

/**
 * Injectable seams for testing. In production all default to the real WIF /
 * Google calls; tests supply fakes so the derivation guard, claim shape, and
 * error mapping are verified without touching GCP.
 */
export interface MintDeps {
  /** Returns a cloud-platform access token for the DWD service account (WIF leg). */
  getServiceAccountToken?: (cfg: DwdBrokerConfig) => Promise<string>
  fetchImpl?: typeof fetch
  now?: () => number
}

// cloud-platform is the scope needed to call IAM Credentials signJwt as the
// impersonated SA. The WIF client (and its STS/impersonation refresh) is cached
// inside gcp-wif per scope-set.
async function defaultGetServiceAccountToken(cfg: DwdBrokerConfig): Promise<string> {
  return getImpersonatedAccessToken(cfg, ["https://www.googleapis.com/auth/cloud-platform"])
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ""
  }
}

/** Sign a JWT assertion AS the service account via IAM Credentials signJwt. */
async function signAssertion(
  cfg: DwdBrokerConfig,
  saAccessToken: string,
  claims: Record<string, unknown>,
  fetchImpl: typeof fetch
): Promise<string> {
  const signUrl =
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(cfg.serviceAccountEmail)}:signJwt`
  const signResp = await fetchImpl(signUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${saAccessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ payload: JSON.stringify(claims) }),
  })
  if (!signResp.ok) {
    throw new Error(`IAM Credentials signJwt failed (HTTP ${signResp.status}): ${(await safeText(signResp)).slice(0, 300)}`)
  }
  const signBody = (await signResp.json()) as { signedJwt?: string }
  if (!signBody.signedJwt) {
    throw new Error("IAM Credentials signJwt returned no signedJwt")
  }
  return signBody.signedJwt
}

interface TokenExchangeResponse {
  access_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

/** True when Google's token error means the agnt_ account doesn't exist yet. */
function isNotProvisioned(data: TokenExchangeResponse | null): boolean {
  const err = data?.error ?? ""
  const desc = data?.error_description ?? ""
  return err === "invalid_grant" || /not\s*found|does not exist|unauthorized_client/i.test(`${err} ${desc}`)
}

/** Leg 3: exchange the signed assertion for the agnt_ account's access token. */
async function exchangeAssertion(
  signedJwt: string,
  agentEmail: string,
  ownerEmail: string,
  now: () => number,
  fetchImpl: typeof fetch
): Promise<MintedToken> {
  const tokenResp = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signedJwt,
    }),
  })
  const tokenData = (await tokenResp.json().catch(() => null)) as TokenExchangeResponse | null

  if (!tokenResp.ok || !tokenData?.access_token) {
    // invalid_grant / "account not found" means the agnt_ account hasn't been
    // created yet — a distinct, expected outcome (the provisioning flow uses
    // this as its existence probe).
    if (isNotProvisioned(tokenData)) {
      log.info("DWD token exchange: agent account not provisioned", sanitizeForLogging({ ownerEmail, agentEmail }))
      throw new AccountNotProvisionedError(agentEmail)
    }
    throw new Error(
      `DWD token exchange failed (HTTP ${tokenResp.status}): ${tokenData?.error || "unknown"} ${tokenData?.error_description || ""}`.trim()
    )
  }

  const expiresInSec = typeof tokenData.expires_in === "number" ? tokenData.expires_in : 3600
  const expiresAt = new Date(now() + expiresInSec * 1000).toISOString()
  return { accessToken: tokenData.access_token, expiresAt, agentEmail }
}

/**
 * Mint a ~1h access token for the owner's agnt_ account via DWD.
 *
 * @throws BrokerNotConfiguredError  WIF config missing.
 * @throws InvalidOwnerError          ownerEmail invalid / wrong domain.
 * @throws AccountNotProvisionedError the agnt_ account doesn't exist yet.
 * @throws Error                      any other WIF/signJwt/exchange failure.
 */
export async function mintAgentWorkspaceToken(ownerEmail: string, deps: MintDeps = {}): Promise<MintedToken> {
  const cfg = loadBrokerConfig()
  const agentEmail = deriveAgentEmail(ownerEmail, cfg.allowedDomain)

  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const getSaToken = deps.getServiceAccountToken ?? defaultGetServiceAccountToken

  // Leg 1: impersonated SA access token via WIF.
  const saAccessToken = await getSaToken(cfg)

  // Leg 2: sign a JWT assertion AS the SA, subject = the agnt_ account.
  const iat = Math.floor(now() / 1000)
  const signedJwt = await signAssertion(cfg, saAccessToken, {
    iss: cfg.serviceAccountEmail,
    sub: agentEmail,
    scope: AGENT_DWD_SCOPES.join(" "),
    aud: "https://oauth2.googleapis.com/token",
    iat,
    exp: iat + 3600,
  }, fetchImpl)

  // Leg 3: exchange the assertion for the agnt_ account's access token.
  const minted = await exchangeAssertion(signedJwt, agentEmail, ownerEmail, now, fetchImpl)

  log.info("Minted DWD workspace token", sanitizeForLogging({ ownerEmail, agentEmail, expiresAt: minted.expiresAt }))
  return minted
}

/** Test-only: reset the cached WIF client between tests. */
export async function __resetBrokerCacheForTests(): Promise<void> {
  const { __resetWifCacheForTests } = await import("@/lib/agent-workspace/gcp-wif")
  __resetWifCacheForTests()
}
