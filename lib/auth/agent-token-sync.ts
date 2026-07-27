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

type SecretsManagerClientInstance = Awaited<
  ReturnType<typeof getSecretsManagerClient>
>
type SecretsManagerSdk = typeof import("@aws-sdk/client-secrets-manager")

interface CreateRefreshSecretContext {
  client: SecretsManagerClientInstance
  sdk: Pick<SecretsManagerSdk, "CreateSecretCommand" | "PutSecretValueCommand">
  secretId: string
  secretString: string
  ownerEmail: string
  environment: string
}

async function retryRefreshSecretPut(
  context: CreateRefreshSecretContext,
): Promise<string | null> {
  try {
    const response = await context.client.send(
      new context.sdk.PutSecretValueCommand({
        SecretId: context.secretId,
        SecretString: context.secretString,
      }),
    )
    log.info("Cognito refresh token stored after concurrent secret creation", {
      secretId: context.secretId,
    })
    return response.ARN ?? null
  } catch (error) {
    log.warn("Cognito refresh token sync retry failed", {
      secretId: context.secretId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

async function createRefreshSecret(
  context: CreateRefreshSecretContext,
): Promise<string | null> {
  try {
    const created = await context.client.send(
      new context.sdk.CreateSecretCommand({
        Name: context.secretId,
        SecretString: context.secretString,
        Description: `Cognito refresh token for ${context.ownerEmail} — captured for agent data-MCP access`,
        Tags: [
          { Key: "Environment", Value: context.environment },
          { Key: "ManagedBy", Value: "aistudio" },
          { Key: "OwnerEmail", Value: context.ownerEmail },
        ],
      }),
    )
    log.info("Cognito refresh token secret created in Secrets Manager", {
      secretId: context.secretId,
    })
    return created.ARN ?? null
  } catch (error) {
    if (error instanceof Error && error.name === "ResourceExistsException") {
      return retryRefreshSecretPut(context)
    }
    log.warn("Cognito refresh token CreateSecret failed", {
      secretId: context.secretId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

function shouldSkipRefreshSync(
  ownerEmail: string,
  refreshToken: string
): boolean {
  if (!refreshToken || typeof refreshToken !== "string") {
    log.debug("Skipping cognito-refresh sync — no refresh token in payload", {
      ownerEmail: ownerEmail || "unknown",
    })
    return true
  }
  if (!SAFE_EMAIL_RE.test(ownerEmail)) {
    log.warn("Skipping cognito-refresh sync — invalid ownerEmail", {
      ownerEmail: ownerEmail || "unknown",
    })
    return true
  }
  if (
    process.env.NODE_ENV === "development" &&
    !process.env.FORCE_AGENT_TOKEN_SYNC
  ) {
    log.info("Local dev — skipping Secrets Manager write for cognito-refresh", {
      ownerEmail,
    })
    return true
  }
  return false
}

function cognitoRefreshConfiguration(ownerEmail: string): {
  clientId: string
  userPoolId: string
  region: string
} | null {
  const clientId =
    process.env.AUTH_COGNITO_CLIENT_ID ?? process.env.COGNITO_CLIENT_ID ?? null
  if (!clientId) {
    log.warn(
      "Skipping cognito-refresh sync — AUTH_COGNITO_CLIENT_ID not set",
      sanitizeForLogging({ ownerEmail }),
    )
    return null
  }
  const issuer = process.env.AUTH_COGNITO_ISSUER ?? ""
  const issuerMatch = issuer.match(
    /^https:\/\/cognito-idp\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9-_]+)$/i,
  )
  return {
    clientId,
    userPoolId:
      process.env.AUTH_COGNITO_USER_POOL_ID ??
      process.env.COGNITO_USER_POOL_ID ??
      issuerMatch?.[2] ??
      "unknown",
    region:
      process.env.AUTH_COGNITO_REGION ??
      issuerMatch?.[1] ??
      process.env.AWS_REGION ??
      "us-east-1",
  }
}

async function persistCognitoRefreshSecret(options: {
  secretId: string
  secretString: string
  ownerEmail: string
  environment: string
}): Promise<string | null> {
  const {
    PutSecretValueCommand,
    CreateSecretCommand,
    ResourceNotFoundException,
  } = await import("@aws-sdk/client-secrets-manager")
  const client = await getSecretsManagerClient()
  try {
    const response = await client.send(
      new PutSecretValueCommand({
        SecretId: options.secretId,
        SecretString: options.secretString,
      }),
    )
    log.info("Cognito refresh token rotated in Secrets Manager", {
      secretId: options.secretId,
    })
    return response.ARN ?? null
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      return createRefreshSecret({
        client,
        sdk: { CreateSecretCommand, PutSecretValueCommand },
        ...options,
      })
    }
    log.warn("Cognito refresh token PutSecretValue failed", {
      secretId: options.secretId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
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
  if (shouldSkipRefreshSync(ownerEmail, refreshToken)) return null
  const configuration = cognitoRefreshConfiguration(ownerEmail)
  if (!configuration) return null

  const secretId = cognitoRefreshSecretId(ownerEmail)
  const payload: CognitoRefreshTokenRecord = {
    refresh_token: refreshToken,
    obtained_at: new Date().toISOString(),
    user_pool_id: configuration.userPoolId,
    client_id: configuration.clientId,
    region: configuration.region,
  }
  const secretString = JSON.stringify(payload)
  const environment =
    process.env.ENVIRONMENT ?? process.env.DEPLOY_ENVIRONMENT ?? "dev"
  return persistCognitoRefreshSecret({
    secretId,
    secretString,
    ownerEmail,
    environment,
  })
}
