/**
 * Agent Token Sync — persist Cognito refresh tokens for the AgentCore agent.
 *
 * The agent (AgentCore runtime, OpenClaw container, Google Chat front door)
 * runs in dev today, while the user community logs into AI Studio prod.
 * The agent cannot read the user's NextAuth session cookie across
 * environments, so we mirror the refresh token into Secrets Manager at a
 * path the agent's IAM role can read.
 *
 * Two trigger points write here:
 *
 *   1. NextAuth JWT callback — on initial sign-in and on every silent
 *      refresh (`auth.ts`). Best-effort; failures must not break login.
 *   2. /agent-connect-data consent page — when the agent forces an auth
 *      because no token exists (or it's expired). Cross-environment path:
 *      a prod user clicks the consent URL, lands here in *dev*, and the
 *      page sends them through Cognito to mint a refresh token in dev.
 *
 * Storage path mirrors the `psd-credentials` / `psd-workspace` convention:
 *   psd-agent-creds/{environment}/user/{ownerEmail}/cognito-refresh
 *
 * Payload shape (JSON):
 *   {
 *     refresh_token: string,
 *     obtained_at: ISO timestamp,
 *     user_pool_id: string,
 *     client_id: string,
 *     region: string
 *   }
 *
 * IAM: the AgentCore role has `secretsmanager:GetSecretValue` on
 * `psd-agent-creds/{env}/*` (agent-platform-stack.ts:856–858). The Next.js
 * task role has `CreateSecret` / `PutSecretValue` on
 * `psd-agent-creds/{env}/user/*` (agent-platform-stack.ts:885–923) — the
 * same perms used by `lib/agent-workspace/secrets-manager.ts`.
 */

import { createLogger, sanitizeForLogging } from "@/lib/logger"
import { SAFE_EMAIL_RE } from "@/lib/agent-workspace/validation"

const log = createLogger({ module: "agent-token-sync" })

export interface CognitoRefreshTokenRecord {
  refresh_token: string
  obtained_at: string
  user_pool_id: string
  client_id: string
  region: string
}

export function cognitoRefreshSecretId(ownerEmail: string): string {
  if (!SAFE_EMAIL_RE.test(ownerEmail)) {
    throw new Error(`Invalid ownerEmail for Secrets Manager path: ${ownerEmail}`)
  }
  const environment =
    process.env.ENVIRONMENT ?? process.env.DEPLOY_ENVIRONMENT ?? "dev"
  return `psd-agent-creds/${environment}/user/${ownerEmail}/cognito-refresh`
}

let _smClient:
  | InstanceType<
      typeof import("@aws-sdk/client-secrets-manager").SecretsManagerClient
    >
  | null = null

async function getSecretsManagerClient() {
  if (_smClient) return _smClient
  const { SecretsManagerClient } = await import("@aws-sdk/client-secrets-manager")
  _smClient = new SecretsManagerClient({})
  return _smClient
}

/**
 * Persist (or refresh) the user's Cognito refresh token in Secrets Manager.
 *
 * This is intentionally **fire-and-forget** from the caller's perspective:
 * NextAuth callbacks invoke it without `await`, and a failure here must not
 * block sign-in. Errors are logged at WARN level.
 *
 * @returns the secret ARN on success, null in local dev (skipped) or if the
 *          required env vars aren't set.
 */
export async function syncCognitoRefreshForAgent(
  ownerEmail: string,
  refreshToken: string,
): Promise<string | null> {
  if (!refreshToken || typeof refreshToken !== "string") {
    log.debug("Skipping cognito-refresh sync — no refresh token in payload", {
      ownerEmail: ownerEmail || "unknown",
    })
    return null
  }
  if (!SAFE_EMAIL_RE.test(ownerEmail)) {
    log.warn("Skipping cognito-refresh sync — invalid ownerEmail", {
      ownerEmail: ownerEmail || "unknown",
    })
    return null
  }

  // Local dev: nothing to sync to. The agent stack is not deployed locally.
  if (process.env.NODE_ENV === "development" && !process.env.FORCE_AGENT_TOKEN_SYNC) {
    log.info("Local dev — skipping Secrets Manager write for cognito-refresh", {
      ownerEmail,
    })
    return null
  }

  // The agent uses client_id + region to refresh the token. user_pool_id is
  // stored alongside for traceability but is not required for the refresh
  // flow — derive it from AUTH_COGNITO_ISSUER when AUTH_COGNITO_USER_POOL_ID
  // is absent (the web ECS task only sets the issuer).
  const clientId =
    process.env.AUTH_COGNITO_CLIENT_ID ?? process.env.COGNITO_CLIENT_ID ?? null
  if (!clientId) {
    log.warn(
      "Skipping cognito-refresh sync — AUTH_COGNITO_CLIENT_ID not set",
      sanitizeForLogging({ ownerEmail }),
    )
    return null
  }
  // Issuer format: https://cognito-idp.<region>.amazonaws.com/<pool-id>
  const issuer = process.env.AUTH_COGNITO_ISSUER ?? ""
  const issuerMatch = issuer.match(
    /^https:\/\/cognito-idp\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9-_]+)$/i,
  )
  const userPoolId =
    process.env.AUTH_COGNITO_USER_POOL_ID ??
    process.env.COGNITO_USER_POOL_ID ??
    (issuerMatch ? issuerMatch[2] : "unknown")
  const region =
    process.env.AUTH_COGNITO_REGION ??
    (issuerMatch ? issuerMatch[1] : undefined) ??
    process.env.AWS_REGION ??
    "us-east-1"

  const secretId = cognitoRefreshSecretId(ownerEmail)
  const payload: CognitoRefreshTokenRecord = {
    refresh_token: refreshToken,
    obtained_at: new Date().toISOString(),
    user_pool_id: userPoolId,
    client_id: clientId,
    region,
  }
  const secretString = JSON.stringify(payload)

  const {
    PutSecretValueCommand,
    CreateSecretCommand,
    ResourceNotFoundException,
  } = await import("@aws-sdk/client-secrets-manager")
  const client = await getSecretsManagerClient()
  const environment =
    process.env.ENVIRONMENT ?? process.env.DEPLOY_ENVIRONMENT ?? "dev"

  try {
    const resp = await client.send(
      new PutSecretValueCommand({
        SecretId: secretId,
        SecretString: secretString,
      }),
    )
    log.info("Cognito refresh token rotated in Secrets Manager", { secretId })
    return resp.ARN ?? null
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      try {
        const created = await client.send(
          new CreateSecretCommand({
            Name: secretId,
            SecretString: secretString,
            Description: `Cognito refresh token for ${ownerEmail} — captured for agent data-MCP access`,
            Tags: [
              { Key: "Environment", Value: environment },
              { Key: "ManagedBy", Value: "aistudio" },
              { Key: "OwnerEmail", Value: ownerEmail },
            ],
          }),
        )
        log.info("Cognito refresh token secret created in Secrets Manager", {
          secretId,
        })
        return created.ARN ?? null
      } catch (createError) {
        // Two concurrent first-writes can race. The loser sees
        // ResourceExistsException and falls through to PutSecretValue.
        if (
          createError instanceof Error &&
          createError.name === "ResourceExistsException"
        ) {
          try {
            const retry = await client.send(
              new PutSecretValueCommand({
                SecretId: secretId,
                SecretString: secretString,
              }),
            )
            log.info(
              "Cognito refresh token stored after concurrent secret creation",
              { secretId },
            )
            return retry.ARN ?? null
          } catch (retryError) {
            log.warn("Cognito refresh token sync retry failed", {
              secretId,
              error:
                retryError instanceof Error
                  ? retryError.message
                  : String(retryError),
            })
            return null
          }
        }
        log.warn("Cognito refresh token CreateSecret failed", {
          secretId,
          error:
            createError instanceof Error
              ? createError.message
              : String(createError),
        })
        return null
      }
    }
    log.warn("Cognito refresh token PutSecretValue failed", {
      secretId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
