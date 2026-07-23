/**
 * Internal contract between the frontend `/api/agent/*` routes and the isolated
 * mint Lambda (`psd-agent-mint-{env}`) — confused-deputy isolation for the GCP
 * Workload-Identity-Federation (WIF) credential (#1232 hardening).
 *
 * WHY THIS BOUNDARY EXISTS: the WIF provider trusts an AWS role, and whoever
 * holds that role's ambient credentials can impersonate the DWD service account
 * and `signJwt(sub=<any user>)` — i.e. mint a Google token for ANY psd401.net
 * mailbox (gmail.modify + drive included). Running the broker in the Next.js
 * frontend meant a frontend RCE/SSRF reaching the task-role creds could do
 * exactly that. Moving both WIF consumers into a dedicated Lambda with its OWN
 * role — the SOLE principal the WIF provider trusts — shrinks the blast radius
 * of a frontend compromise from "any mailbox" to "InvokeFunction the mint
 * Lambda", which ALWAYS derives `agnt_<owner>` server-side and can never target
 * an arbitrary sub. The frontend passes only `ownerEmail` / `username` across
 * this boundary — never a target agent address.
 *
 * These are plain data types (no runtime deps) so BOTH the Lambda handler and
 * the frontend invoker can import them without dragging WIF code into the app
 * bundle.
 */

/** Ops the mint Lambda accepts. */
export interface MintTokenRequest {
  op: "mint-token"
  /** The signed-in owner's email; the Lambda derives `agnt_<localpart>` itself. */
  ownerEmail: string
}
export interface ProvisionAccountRequest {
  op: "provision-account"
  /** The owner's bare username (localpart) to queue in the OneSync sheet. */
  username: string
}
export type MintLambdaRequest = MintTokenRequest | ProvisionAccountRequest

/**
 * Structured error codes carried across the Lambda boundary. Typed Error
 * classes don't survive JSON serialization, so the Lambda returns a `code` and
 * the invoker reconstructs the matching broker error class — keeping the routes'
 * existing `instanceof` → HTTP mapping byte-identical in both Lambda and
 * in-process (local-dev) modes.
 */
export type MintErrorCode =
  | "INVALID_OWNER"
  | "BROKER_NOT_CONFIGURED"
  | "PROVISIONING_NOT_CONFIGURED"
  | "INTERNAL"

export interface MintErrorResponse {
  error: string
  code: MintErrorCode
}

/** mint-token success | not-provisioned | structured error. */
export type MintTokenSuccess = { accessToken: string; expiresAt: string; agentEmail: string }
export type MintTokenNotProvisioned = { status: "account-not-provisioned"; agentEmail?: string }
export type MintTokenResponse = MintTokenSuccess | MintTokenNotProvisioned | MintErrorResponse

/** provision-account success | structured error. */
export type ProvisionAccountSuccess = { written: boolean }
export type ProvisionAccountResponse = ProvisionAccountSuccess | MintErrorResponse

/** Narrowing helpers (shared by handler + invoker so the shape checks match). */
export function isMintTokenSuccess(r: MintTokenResponse): r is MintTokenSuccess {
  return typeof (r as MintTokenSuccess).accessToken === "string"
}
export function isMintTokenNotProvisioned(r: MintTokenResponse): r is MintTokenNotProvisioned {
  return (r as MintTokenNotProvisioned).status === "account-not-provisioned"
}
export function isProvisionSuccess(r: ProvisionAccountResponse): r is ProvisionAccountSuccess {
  return typeof (r as ProvisionAccountSuccess).written === "boolean"
}
export function isMintError(r: MintTokenResponse | ProvisionAccountResponse): r is MintErrorResponse {
  return typeof (r as MintErrorResponse).code === "string" && typeof (r as MintErrorResponse).error === "string"
}
