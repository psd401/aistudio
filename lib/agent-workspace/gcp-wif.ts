/**
 * Shared Workload-Identity-Federation (WIF) impersonation for the DWD service
 * account (#1232, #1233).
 *
 * Both the DWD token broker (needs a cloud-platform token to call IAM
 * Credentials signJwt) and the agnt_ provisioning sheet writer (needs a
 * spreadsheets token to append to the OneSync sheet AS the service account)
 * obtain an impersonated SA access token the same keyless way: exchange the
 * app's AWS role credentials for a GCP STS token, then impersonate the service
 * account (google-auth-library ExternalAccountClient with AWS external-account
 * config). This module centralizes that leg so there is one WIF configuration.
 *
 * The impersonated client is cached per scope-set (its access token refreshes
 * internally). No per-user data is cached here.
 */

import type { DwdBrokerConfig } from "@/lib/agent-workspace/dwd-token-broker"

// Cache the WIF/ExternalAccount client per scope-set. `BaseExternalAccountClient`
// refreshes its own STS/impersonation token internally, so one client per scope
// list is safe to keep.
const _clientCache = new Map<string, import("google-auth-library").BaseExternalAccountClient>()

/** Test seam: replace the real WIF token acquisition. */
export interface WifDeps {
  getToken?: (cfg: DwdBrokerConfig, scopes: string[]) => Promise<string>
}

/**
 * Get an access token for the DWD service account, impersonated via WIF, scoped
 * to `scopes`. Never throws for a missing token silently — a failure surfaces as
 * a thrown Error the caller maps to a user-facing outcome.
 */
export async function getImpersonatedAccessToken(
  cfg: DwdBrokerConfig,
  scopes: string[],
  deps: WifDeps = {}
): Promise<string> {
  if (deps.getToken) return deps.getToken(cfg, scopes)

  const key = scopes.slice().sort().join(" ")
  let client = _clientCache.get(key)
  if (!client) {
    const { ExternalAccountClient } = await import("google-auth-library")
    const built = ExternalAccountClient.fromJSON({
      type: "external_account",
      audience: `//iam.googleapis.com/projects/${cfg.projectNumber}/locations/global/workloadIdentityPools/${cfg.poolId}/providers/${cfg.providerId}`,
      subject_token_type: "urn:ietf:params:aws:token-type:aws4_request",
      token_url: "https://sts.googleapis.com/v1/token",
      // AWS credential source. google-auth-library's AwsClient resolves the
      // app's AWS role credentials from the standard AWS credential chain (on
      // ECS Fargate this is AWS_CONTAINER_CREDENTIALS_RELATIVE_URI). The regional
      // GetCallerIdentity URL is required; {region} is filled from AWS_REGION.
      // NOTE: verify this credential_source against the real WIF trust once IT
      // (Reese) delivers the pool/provider — ECS container creds vs IMDS is the
      // one thing that can differ from this default and cannot be validated
      // until the Google side exists.
      credential_source: {
        environment_id: "aws1",
        regional_cred_verification_url:
          "https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15",
      },
      service_account_impersonation_url:
        `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${cfg.serviceAccountEmail}:generateAccessToken`,
    })
    if (!built) {
      throw new Error("ExternalAccountClient.fromJSON returned null — check WIF config")
    }
    built.scopes = scopes
    client = built
    _clientCache.set(key, built)
  }

  const at = await client.getAccessToken()
  if (!at?.token) {
    throw new Error("WIF impersonation returned no access token")
  }
  return at.token
}

/** Test-only: clear the per-scope client cache. */
export function __resetWifCacheForTests(): void {
  _clientCache.clear()
}
