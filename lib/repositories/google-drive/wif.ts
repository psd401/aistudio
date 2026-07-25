import { GOOGLE_DRIVE_SCOPE } from "./formats";

export const GOOGLE_CONTENT_WIF_CONFIG = Object.freeze({
  projectNumber: "1022506104054",
  poolId: "aws-agent-broker",
  providerId: "content-sync",
  serviceAccountEmail:
    "unified-content-sync@psd-aistudio-broker.iam.gserviceaccount.com",
});

let client: import("google-auth-library").BaseExternalAccountClient | null =
  null;

/**
 * Mint the Shared Drive worker's keyless, read-only token. The audience and
 * service account are deliberately fixed to the Google-side trust documented
 * by psd401/psd-gcp-infra#1; this path does not support domain-wide delegation.
 */
export async function getGoogleContentWifAccessToken(): Promise<string> {
  if (!client) {
    const { ExternalAccountClient } = await import("google-auth-library");
    const config = GOOGLE_CONTENT_WIF_CONFIG;
    const created = ExternalAccountClient.fromJSON({
      type: "external_account",
      audience:
        `//iam.googleapis.com/projects/${config.projectNumber}/locations/global/` +
        `workloadIdentityPools/${config.poolId}/providers/${config.providerId}`,
      subject_token_type: "urn:ietf:params:aws:token-type:aws4_request",
      token_url: "https://sts.googleapis.com/v1/token",
      credential_source: {
        environment_id: "aws1",
        regional_cred_verification_url:
          "https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15",
      },
      service_account_impersonation_url:
        "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" +
        `${config.serviceAccountEmail}:generateAccessToken`,
    });
    if (!created) {
      throw new Error("Google content WIF client could not be created");
    }
    created.scopes = [GOOGLE_DRIVE_SCOPE];
    client = created;
  }
  const token = await client.getAccessToken();
  if (!token?.token) {
    throw new Error("Google content WIF returned no access token");
  }
  return token.token;
}

export function __resetGoogleContentWifForTests(): void {
  client = null;
}
