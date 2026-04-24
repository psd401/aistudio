/**
 * Agent Workspace Secrets Manager Integration
 *
 * Handles storing and retrieving Google Workspace OAuth refresh tokens
 * in AWS Secrets Manager at psd-agent-creds/{env}/user/{email}/google-workspace.
 *
 * Part of Epic #912 — Agent-Owned Google Workspace Integration
 */

import { createLogger } from "@/lib/logger"

const log = createLogger({ module: "agent-workspace-secrets" })

export interface WorkspaceTokenData {
  refresh_token: string
  granted_scopes: string[]
  obtained_at: string
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
  const environment = process.env.DEPLOY_ENVIRONMENT ?? "dev"
  const secretId = `psd-agent-creds/${environment}/user/${ownerEmail}/google-workspace`

  // Skip Secrets Manager in local development
  if (process.env.DATABASE_URL?.includes("localhost")) {
    log.info("Local dev mode — skipping Secrets Manager write", { secretId })
    return
  }

  const { SecretsManagerClient, PutSecretValueCommand, CreateSecretCommand, ResourceNotFoundException } =
    await import("@aws-sdk/client-secrets-manager")
  const client = new SecretsManagerClient({})

  try {
    await client.send(
      new PutSecretValueCommand({
        SecretId: secretId,
        SecretString: JSON.stringify(tokenData),
      })
    )
    log.info("Refresh token stored in Secrets Manager", { secretId })
  } catch (error) {
    // If the secret doesn't exist yet, create it
    if (error instanceof ResourceNotFoundException) {
      await client.send(
        new CreateSecretCommand({
          Name: secretId,
          SecretString: JSON.stringify(tokenData),
          Description: `Google Workspace refresh token for agent of ${ownerEmail}`,
          Tags: [
            { Key: "Environment", Value: environment },
            { Key: "ManagedBy", Value: "aistudio" },
            { Key: "OwnerEmail", Value: ownerEmail },
          ],
        })
      )
      log.info("Refresh token secret created in Secrets Manager", { secretId })
    } else {
      log.error("Failed to store refresh token in Secrets Manager", {
        secretId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
}
