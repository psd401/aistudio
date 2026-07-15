/**
 * Frontend → mint Lambda invoker (#1232 confused-deputy hardening).
 *
 * The `/api/agent/workspace-token` and `/api/agent/account-request` routes call
 * these helpers instead of the DWD broker / provisioning-sheet directly. In
 * EVERY deployed environment `AGENT_MINT_LAMBDA_NAME` is set, so the WIF-backed
 * work runs in the isolated `psd-agent-mint-{env}` Lambda (IAM-authed
 * InvokeFunction) — the frontend never touches the WIF credential and cannot
 * `signJwt` an arbitrary sub.
 *
 * LOCAL-DEV / TEST FALLBACK: when `AGENT_MINT_LAMBDA_NAME` is UNSET (local dev,
 * unit tests) the helpers run the shared broker/sheet modules IN-PROCESS exactly
 * as the routes did before this change. There is no real WIF locally, so no
 * isolation is lost — and the isolation holds in every deployed env, where the
 * env var is always set. The typed error classes thrown here are the SAME broker
 * classes the routes already `instanceof`-match, so the routes' error → HTTP
 * mapping is byte-identical in both modes.
 */

import {
  mintAgentWorkspaceToken,
  AccountNotProvisionedError,
  BrokerNotConfiguredError,
  InvalidOwnerError,
  type MintedToken,
} from "@/lib/agent-workspace/dwd-token-broker"
import {
  createSheetsGateway,
  ensureAgentUsernameRow,
  ProvisioningNotConfiguredError,
} from "@/lib/agent-workspace/agent-provisioning-sheet"
import {
  isMintTokenSuccess,
  isMintTokenNotProvisioned,
  isProvisionSuccess,
  isMintError,
  type MintLambdaRequest,
  type MintTokenResponse,
  type ProvisionAccountResponse,
  type MintErrorResponse,
} from "@/lib/agent-workspace/mint-contract"

/** The mint Lambda function name, or undefined when running in-process (local dev/tests). */
export function getMintLambdaName(): string | undefined {
  const name = process.env.AGENT_MINT_LAMBDA_NAME?.trim()
  return name ? name : undefined
}

// Cache the Lambda client across invocations (module singleton), mirroring the
// secrets-manager client caching. Imported lazily so the AWS SDK never loads in
// the in-process path (local dev / tests that never set AGENT_MINT_LAMBDA_NAME).
let _lambdaClient: InstanceType<typeof import("@aws-sdk/client-lambda").LambdaClient> | null = null

async function invokeMintLambda(functionName: string, payload: MintLambdaRequest): Promise<unknown> {
  const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda")
  if (!_lambdaClient) _lambdaClient = new LambdaClient({})
  const res = await _lambdaClient.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify(payload)),
    })
  )
  // An unhandled Lambda exception surfaces as FunctionError (infra failure) — the
  // handler is designed never to throw, so this means the Lambda itself broke.
  if (res.FunctionError) {
    const detail = res.Payload ? Buffer.from(res.Payload).toString("utf8").slice(0, 300) : ""
    throw new Error(`mint lambda FunctionError (${res.FunctionError}): ${detail}`)
  }
  const text = res.Payload ? Buffer.from(res.Payload).toString("utf8") : ""
  if (!text) throw new Error("mint lambda returned an empty payload")
  return JSON.parse(text) as unknown
}

/**
 * Reconstruct the broker's typed Error from the boundary's structured code, so
 * the routes' existing `instanceof` mapping produces identical HTTP responses.
 */
function reconstructError(res: MintErrorResponse): Error {
  const msg = res.error || "mint boundary error"
  switch (res.code) {
    case "INVALID_OWNER":
      return new InvalidOwnerError(msg)
    case "BROKER_NOT_CONFIGURED":
      return new BrokerNotConfiguredError(msg)
    case "PROVISIONING_NOT_CONFIGURED":
      return new ProvisioningNotConfiguredError(msg)
    default:
      return new Error(msg)
  }
}

/**
 * Mint a ~1h DWD token for the owner's `agnt_` account through the isolation
 * boundary. Throws the SAME typed errors as the in-process broker
 * (AccountNotProvisionedError / InvalidOwnerError / BrokerNotConfiguredError /
 * generic Error) so callers are agnostic to which mode ran.
 */
export async function mintAgentWorkspaceTokenViaBoundary(ownerEmail: string): Promise<MintedToken> {
  const functionName = getMintLambdaName()
  if (!functionName) {
    // In-process fallback — the shared broker derives agnt_ and performs WIF.
    return mintAgentWorkspaceToken(ownerEmail)
  }
  const res = (await invokeMintLambda(functionName, { op: "mint-token", ownerEmail })) as MintTokenResponse
  if (isMintTokenSuccess(res)) {
    return { accessToken: res.accessToken, expiresAt: res.expiresAt, agentEmail: res.agentEmail }
  }
  if (isMintTokenNotProvisioned(res)) {
    throw new AccountNotProvisionedError(res.agentEmail ?? "")
  }
  if (isMintError(res)) {
    throw reconstructError(res)
  }
  throw new Error("mint lambda returned an unrecognized mint-token response")
}

/**
 * Queue the owner's bare username in the OneSync provisioning sheet through the
 * isolation boundary. Throws the SAME typed errors as the in-process sheet
 * writer (ProvisioningNotConfiguredError / BrokerNotConfiguredError / generic).
 */
export async function provisionAgentAccountViaBoundary(username: string): Promise<{ written: boolean }> {
  const functionName = getMintLambdaName()
  if (!functionName) {
    // In-process fallback — the shared sheet writer performs WIF (spreadsheets scope).
    return ensureAgentUsernameRow(username, createSheetsGateway())
  }
  const res = (await invokeMintLambda(functionName, { op: "provision-account", username })) as ProvisionAccountResponse
  if (isProvisionSuccess(res)) {
    return { written: res.written }
  }
  if (isMintError(res)) {
    throw reconstructError(res)
  }
  throw new Error("mint lambda returned an unrecognized provision-account response")
}

/** Test-only: reset the cached Lambda client between tests. */
export function __resetMintClientForTests(): void {
  _lambdaClient = null
}
