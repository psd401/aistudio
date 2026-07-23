/**
 * Per-user Google Workspace OAuth token helper for AWS Lambdas.
 *
 * Mirrors the runtime semantics of the agent container's
 * `infra/agent-image/skills/psd-workspace/common.js` so a Lambda can mint a
 * fresh access token from the same Secrets Manager slot the skill reads
 * from. Keep the two byte-for-byte equivalent in behavior:
 *   - same secret naming (`psd-agent-creds/<env>/user/<email>/<slot>`)
 *   - same refresh-token grant flow against accounts.google.com
 *   - same `invalid_grant` surfacing so callers can mark a user as
 *     needing re-consent
 *
 * Why a parallel implementation rather than a literal shared file: the
 * container skill is JS running under Node 20 with a different bundling
 * boundary; the Lambdas bundle their own ESM/CJS. Going through a single
 * shared module would require a build-time copy step that's more pain
 * than maintaining two ~40-line implementations.
 *
 * Used by:
 *   infra/lambdas/agent-triage-poll/
 *   infra/lambdas/agent-triage-digest/
 *
 * NOT used by Next.js server actions today (those have their own
 * Drizzle-tangled OAuth callback flow). Could be in future if we want a
 * single source of truth for refresh; for now Phase 1 keeps them
 * separate to avoid a Next.js → Lambda refactor risk.
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-secrets-manager";

export type WorkspaceSlotKind = "agent_account" | "user_account";

export interface WorkspaceTokenRecord {
  refresh_token: string;
  granted_scopes: string[];
  obtained_at: string;
}

export interface OAuthClientCredentials {
  client_id: string;
  client_secret: string;
}

export interface FreshAccessToken {
  access_token: string;
  expires_in: number;
  scope?: string;
}

/**
 * Build the Secrets Manager id for a user's workspace token. Matches the
 * shape the OAuth callback writes (actions/agent-workspace.actions.ts) and
 * the shape the agent skill reads (psd-workspace/common.js).
 */
export function workspaceSecretId(
  userEmail: string,
  env: string,
  kind: WorkspaceSlotKind = "agent_account",
): string {
  const slot =
    kind === "user_account" ? "google-workspace-user" : "google-workspace";
  return `psd-agent-creds/${env}/user/${userEmail}/${slot}`;
}

/**
 * Build the Secrets Manager id for the shared OAuth client credentials.
 * One record per environment, shared across all users.
 */
export function oauthClientSecretId(env: string): string {
  return `psd-agent/${env}/google-oauth-client`;
}

let cachedClient: SecretsManagerClient | null = null;
function smClient(region: string): SecretsManagerClient {
  if (!cachedClient) cachedClient = new SecretsManagerClient({ region });
  return cachedClient;
}

async function getSecretJson<T>(
  secretId: string,
  region: string,
): Promise<T | null> {
  try {
    const r = await smClient(region).send(
      new GetSecretValueCommand({ SecretId: secretId }),
    );
    if (!r.SecretString) {
      throw new Error(`Secret ${secretId} has no SecretString value`);
    }
    return JSON.parse(r.SecretString) as T;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return null;
    throw err;
  }
}

/**
 * Read a user's workspace refresh-token record. Returns null when the user
 * hasn't completed the OAuth flow for the given slot yet.
 */
export async function getUserWorkspaceToken(
  userEmail: string,
  env: string,
  kind: WorkspaceSlotKind,
  region: string = "us-east-1",
): Promise<WorkspaceTokenRecord | null> {
  return getSecretJson<WorkspaceTokenRecord>(
    workspaceSecretId(userEmail, env, kind),
    region,
  );
}

/**
 * Read the shared OAuth client credentials. Throws if the secret is
 * missing — that's a misconfiguration the Lambda can't recover from.
 */
export async function getOAuthClient(
  env: string,
  region: string = "us-east-1",
): Promise<OAuthClientCredentials> {
  const r = await getSecretJson<OAuthClientCredentials>(
    oauthClientSecretId(env),
    region,
  );
  if (!r) {
    throw new Error(
      `OAuth client secret not found at ${oauthClientSecretId(env)} — ` +
        "this is a configuration error, not a per-user issue.",
    );
  }
  return r;
}

/**
 * Exchange a long-lived refresh token for a short-lived access token.
 * Throws with `(err as Error & {code: string}).code === "invalid_grant"` on
 * revocation so the caller can disable triage for the user and surface a
 * re-consent prompt the next time the user talks to the agent.
 */
export async function refreshAccessToken(
  refreshToken: string,
  client: OAuthClientCredentials,
): Promise<FreshAccessToken> {
  const body = new URLSearchParams({
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = (await resp.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
  };
  if (!resp.ok || !data.access_token) {
    const err = new Error(
      `Google token exchange failed: ${resp.status} ${data.error ?? ""}`,
    ) as Error & { code: string };
    err.code = data.error ?? `http_${resp.status}`;
    throw err;
  }
  return {
    access_token: data.access_token,
    expires_in: data.expires_in ?? 3600,
    scope: data.scope,
  };
}

/**
 * Convenience: fetch the user's refresh token, exchange it, return a
 * fresh access token. Returns null when the user hasn't consented yet
 * (caller should prompt re-consent). Throws on `invalid_grant` so the
 * caller can mark the user as needing re-consent.
 */
export async function getFreshAccessTokenForUser(
  userEmail: string,
  env: string,
  kind: WorkspaceSlotKind,
  region: string = "us-east-1",
): Promise<FreshAccessToken | null> {
  const tokenRecord = await getUserWorkspaceToken(userEmail, env, kind, region);
  if (!tokenRecord) return null;
  const client = await getOAuthClient(env, region);
  return refreshAccessToken(tokenRecord.refresh_token, client);
}
