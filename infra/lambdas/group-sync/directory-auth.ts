/**
 * Keyless Google Directory auth for the group-sync Lambda (#1989).
 *
 * The Lambda's execution role federates to the `directory-reader` provider of
 * the `aws-agent-broker` pool and impersonates the district's shared groups
 * reader (directory-groups-reader@psd-org-tooling) with the read-only Cloud
 * Identity groups scope. That account holds the Workspace Groups Reader admin
 * role and has no key and no domain-wide delegation. The Google side (account,
 * provider, and the role names it trusts) lives in psd401/psd-gcp-infra
 * (bootstrap/directory-reader.tf, directory-reader.tf).
 *
 * Uses google-auth-library's built-in AWS credential source, which reads the
 * Lambda runtime's AWS_* environment credentials — the same keyless pattern as
 * lib/repositories/google-drive/wif.ts.
 */

import { auth } from "@googleapis/cloudidentity";

export const CLOUD_IDENTITY_GROUPS_READONLY_SCOPE =
  "https://www.googleapis.com/auth/cloud-identity.groups.readonly";

export type DirectoryAuth = NonNullable<
  ReturnType<typeof auth.ExternalAccountClient.fromJSON>
>;

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not configured; Google Directory auth cannot start`);
  }
  return value;
}

export function createDirectoryAuth(env: NodeJS.ProcessEnv = process.env): DirectoryAuth {
  const audience = requireEnv(env, "GOOGLE_DIRECTORY_WIF_AUDIENCE");
  const serviceAccountEmail = requireEnv(env, "GOOGLE_DIRECTORY_SERVICE_ACCOUNT_EMAIL");

  const client = auth.ExternalAccountClient.fromJSON({
    type: "external_account",
    audience,
    subject_token_type: "urn:ietf:params:aws:token-type:aws4_request",
    token_url: "https://sts.googleapis.com/v1/token",
    credential_source: {
      environment_id: "aws1",
      regional_cred_verification_url:
        "https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15",
    },
    service_account_impersonation_url:
      "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" +
      `${serviceAccountEmail}:generateAccessToken`,
    scopes: [CLOUD_IDENTITY_GROUPS_READONLY_SCOPE],
  });
  if (!client) {
    throw new Error("Google Directory WIF client could not be created");
  }
  return client;
}
