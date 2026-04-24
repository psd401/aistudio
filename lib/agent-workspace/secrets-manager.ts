/**
 * Agent Workspace Secrets Manager Integration
 *
 * Handles storing and retrieving Google Workspace OAuth refresh tokens
 * in AWS Secrets Manager at psd-agent-creds/{env}/user/{email}/google-workspace.
 *
 * Part of Epic #912 — Agent-Owned Google Workspace Integration
 */

import { createLogger } from "@/lib/logger"
import { SAFE_EMAIL_RE } from "@/lib/agent-workspace/validation"

const log = createLogger({ module: "agent-workspace-secrets" })

export interface WorkspaceTokenData {
  refresh_token: string
  granted_scopes: string[]
  obtained_at: string
}

// Module-scoped client — reuses the HTTP connection pool across calls.
// Lazily initialized on first non-dev invocation.
let _smClient: InstanceType<typeof import("@aws-sdk/client-secrets-manager").SecretsManagerClient> | null = null

async function getSecretsManagerClient() {
  if (_smClient) return _smClient
  const { SecretsManagerClient } = await import("@aws-sdk/client-secrets-manager")
  _smClient = new SecretsManagerClient({})
  return _smClient
}

/**
 * Store the refresh token in AWS Secrets Manager.
 * In production, this writes to psd-agent-creds/{env}/user/{email}/google-workspace.
 * For local dev, this is a no-op (refresh tokens are not stored locally).
 */
export async function storeRefreshToken(
  ownerEmail: string,
  tokenData: WorkspaceTokenData
): Promise<void> {
  if (!SAFE_EMAIL_RE.test(ownerEmail)) {
    throw new Error(`Invalid ownerEmail for Secrets Manager path: ${ownerEmail}`)
  }

  // ENVIRONMENT is the canonical env var set by the ECS task definition;
  // DEPLOY_ENVIRONMENT is a legacy fallback.
  const environment = process.env.ENVIRONMENT ?? process.env.DEPLOY_ENVIRONMENT ?? "dev"
  const secretId = `psd-agent-creds/${environment}/user/${ownerEmail}/google-workspace`

  // Skip Secrets Manager in local development.
  if (process.env.NODE_ENV === "development") {
    log.info("Local dev mode — skipping Secrets Manager write", { secretId })
    return
  }

  const {
    PutSecretValueCommand,
    CreateSecretCommand,
    ResourceNotFoundException,
  } = await import("@aws-sdk/client-secrets-manager")
  const client = await getSecretsManagerClient()
  const secretString = JSON.stringify(tokenData)

  try {
    await client.send(
      new PutSecretValueCommand({
        SecretId: secretId,
        SecretString: secretString,
      })
    )
    log.info("Refresh token stored in Secrets Manager", { secretId })
  } catch (error) {
    // If the secret doesn't exist yet, create it. Handle the race condition
    // where two concurrent callbacks both see "not found" and both try to
    // create — the loser gets ResourceExistsException and retries with Put.
    if (error instanceof ResourceNotFoundException) {
      try {
        await client.send(
          new CreateSecretCommand({
            Name: secretId,
            SecretString: secretString,
            Description: `Google Workspace refresh token for agent of ${ownerEmail}`,
            Tags: [
              { Key: "Environment", Value: environment },
              { Key: "ManagedBy", Value: "aistudio" },
              { Key: "OwnerEmail", Value: ownerEmail },
            ],
          })
        )
        log.info("Refresh token secret created in Secrets Manager", { secretId })
      } catch (createError) {
        // Concurrent first-write race: another request created the secret
        // between our "not found" and our "create". Retry with PutSecretValue.
        if (
          createError instanceof Error &&
          createError.name === "ResourceExistsException"
        ) {
          await client.send(
            new PutSecretValueCommand({
              SecretId: secretId,
              SecretString: secretString,
            })
          )
          log.info("Refresh token stored after concurrent secret creation", { secretId })
        } else {
          log.error("Failed to create refresh token secret in Secrets Manager", {
            secretId,
            error: createError instanceof Error ? createError.message : String(createError),
          })
          throw createError
        }
      }
    } else {
      log.error("Failed to store refresh token in Secrets Manager", {
        secretId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
}
