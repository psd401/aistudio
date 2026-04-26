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

/**
 * Two distinct OAuth identities can be stored per user (#912 Phase 1):
 *   'agent_account' — refresh token for agnt_<uniqname>@psd401.net.
 *                     Path: psd-agent-creds/{env}/user/{email}/google-workspace
 *   'user_account'  — refresh token for the user's own identity, narrow
 *                     scopes for the agent to read their Gmail/Tasks/Drive.
 *                     Path: psd-agent-creds/{env}/user/{email}/google-workspace-user
 *
 * The 'user_account' path is suffixed (-user) so revocation tools that
 * iterate by prefix can clearly distinguish the two slots.
 */
export type WorkspaceTokenKind = "agent_account" | "user_account"

export function workspaceSecretId(
  ownerEmail: string,
  kind: WorkspaceTokenKind = "agent_account"
): string {
  if (!SAFE_EMAIL_RE.test(ownerEmail)) {
    throw new Error(`Invalid ownerEmail for Secrets Manager path: ${ownerEmail}`)
  }
  const environment = process.env.ENVIRONMENT ?? process.env.DEPLOY_ENVIRONMENT ?? "dev"
  const suffix = kind === "user_account" ? "-user" : ""
  return `psd-agent-creds/${environment}/user/${ownerEmail}/google-workspace${suffix}`
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

// Runtime cache for low-traffic secrets fetched at request time.
// Keyed by secretId, value = { json, cachedAt }. TTL short enough that a
// real rotation surfaces within a few minutes without hammering SM.
const _secretCache = new Map<string, { value: string; cachedAt: number }>()
const SECRET_TTL_MS = 5 * 60 * 1000

/**
 * Fetch a secret string at request time. Caches for 5 minutes.
 * Used for workspace OAuth config and internal API key — both are low
 * traffic and should not gate ECS task start.
 *
 * Returns null if the secret does not exist or is empty. Caller is
 * responsible for surfacing a user-friendly "not configured" message.
 */
export async function getSecretString(secretId: string): Promise<string | null> {
  const cached = _secretCache.get(secretId)
  if (cached && Date.now() - cached.cachedAt < SECRET_TTL_MS) {
    return cached.value
  }

  const { GetSecretValueCommand, ResourceNotFoundException } = await import(
    "@aws-sdk/client-secrets-manager"
  )
  const client = await getSecretsManagerClient()

  try {
    const resp = await client.send(new GetSecretValueCommand({ SecretId: secretId }))
    const value = resp.SecretString ?? null
    if (value) {
      _secretCache.set(secretId, { value, cachedAt: Date.now() })
    }
    return value
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return null
    log.error("Failed to read secret", {
      secretId,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

/**
 * Fetch + parse a JSON secret at request time. Returns null if missing or
 * unparseable. Cached via getSecretString.
 */
export async function getSecretJson<T = Record<string, unknown>>(
  secretId: string
): Promise<T | null> {
  const raw = await getSecretString(secretId)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    log.warn("Secret is not valid JSON — treating as unconfigured", { secretId })
    return null
  }
}

/**
 * Store the refresh token in AWS Secrets Manager.
 *
 * In production, writes to psd-agent-creds/{env}/user/{email}/google-workspace.
 * In local dev, this is a no-op (refresh tokens are not stored locally).
 *
 * Returns the **real** Secrets Manager ARN as reported by AWS. ARNs always
 * end in a 6-char random suffix (e.g. `…:secret:name-AbCdEf`); we used to
 * construct one from `arn:aws:secretsmanager:<region>:<account>:secret:<name>`
 * which never resolved correctly in the AWS Console. Always use the value
 * returned from this function rather than building one yourself.
 *
 * Returns null only when running in local dev (no SM call made).
 */
export async function storeRefreshToken(
  ownerEmail: string,
  tokenData: WorkspaceTokenData,
  kind: WorkspaceTokenKind = "agent_account"
): Promise<string | null> {
  const secretId = workspaceSecretId(ownerEmail, kind)
  const environment = process.env.ENVIRONMENT ?? process.env.DEPLOY_ENVIRONMENT ?? "dev"

  // Skip Secrets Manager in local development.
  if (process.env.NODE_ENV === "development") {
    log.info("Local dev mode — skipping Secrets Manager write", { secretId })
    return null
  }

  const {
    PutSecretValueCommand,
    CreateSecretCommand,
    DescribeSecretCommand,
    ResourceNotFoundException,
  } = await import("@aws-sdk/client-secrets-manager")
  const client = await getSecretsManagerClient()
  const secretString = JSON.stringify(tokenData)

  try {
    const putResp = await client.send(
      new PutSecretValueCommand({
        SecretId: secretId,
        SecretString: secretString,
      })
    )
    log.info("Refresh token stored in Secrets Manager", { secretId })
    // PutSecretValue returns ARN. Falls back to DescribeSecret if (per
    // SDK v3 docs) the field is unexpectedly absent.
    return putResp.ARN ?? (await describeArn(secretId, DescribeSecretCommand))
  } catch (error) {
    // If the secret doesn't exist yet, create it. Handle the race condition
    // where two concurrent callbacks both see "not found" and both try to
    // create — the loser gets ResourceExistsException and retries with Put.
    if (error instanceof ResourceNotFoundException) {
      try {
        const createResp = await client.send(
          new CreateSecretCommand({
            Name: secretId,
            SecretString: secretString,
            Description: kind === "user_account"
              ? `Google Workspace refresh token (user account) for ${ownerEmail}`
              : `Google Workspace refresh token (agent account) for agent of ${ownerEmail}`,
            Tags: [
              { Key: "Environment", Value: environment },
              { Key: "ManagedBy", Value: "aistudio" },
              { Key: "OwnerEmail", Value: ownerEmail },
            ],
          })
        )
        log.info("Refresh token secret created in Secrets Manager", { secretId })
        return createResp.ARN ?? (await describeArn(secretId, DescribeSecretCommand))
      } catch (createError) {
        // Concurrent first-write race: another request created the secret
        // between our "not found" and our "create". Retry with PutSecretValue.
        if (
          createError instanceof Error &&
          createError.name === "ResourceExistsException"
        ) {
          const putResp = await client.send(
            new PutSecretValueCommand({
              SecretId: secretId,
              SecretString: secretString,
            })
          )
          log.info("Refresh token stored after concurrent secret creation", { secretId })
          return putResp.ARN ?? (await describeArn(secretId, DescribeSecretCommand))
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

/**
 * Defensive ARN lookup: falls back to DescribeSecret when the AWS SDK's
 * Put/Create response unexpectedly omits ARN. Empirically this hasn't
 * happened, but the SDK types mark ARN optional, so handle it.
 */
async function describeArn(
  secretId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  DescribeSecretCommand: any
): Promise<string | null> {
  const client = await getSecretsManagerClient()
  const resp = (await client.send(new DescribeSecretCommand({ SecretId: secretId }))) as {
    ARN?: string
  }
  return resp.ARN ?? null
}

/**
 * Delete the per-user Google Workspace refresh token secret. Called when a
 * user is removed from the system so AWS Secrets Manager doesn't accumulate
 * orphan entries containing stale OAuth refresh tokens.
 *
 * We use ForceDeleteWithoutRecovery: there is no scenario where we want a
 * deleted user's refresh token to remain recoverable for the standard 7-day
 * recovery window — the deletion is intentional and the token authorizes
 * access to a real Google account.
 *
 * Returns true if the secret was deleted, false if it didn't exist.
 * In local dev this is a no-op and always returns false.
 */
export async function deleteWorkspaceSecret(
  ownerEmail: string,
  kind: WorkspaceTokenKind = "agent_account"
): Promise<boolean> {
  const secretId = workspaceSecretId(ownerEmail, kind)

  if (process.env.NODE_ENV === "development") {
    return false
  }

  const { DeleteSecretCommand, ResourceNotFoundException } = await import(
    "@aws-sdk/client-secrets-manager"
  )
  const client = await getSecretsManagerClient()

  try {
    await client.send(
      new DeleteSecretCommand({
        SecretId: secretId,
        ForceDeleteWithoutRecovery: true,
      })
    )
    log.info("Workspace refresh token secret deleted", { secretId, kind })
    return true
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      // No secret to delete — user never connected this slot. Not an error.
      return false
    }
    log.error("Failed to delete workspace refresh token secret", {
      secretId,
      kind,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

/**
 * Delete BOTH refresh-token slots for a user — both the agent-account and the
 * user-account refresh tokens. Used by the user-deletion path so neither
 * slot lingers as an orphan secret. Each slot is deleted independently;
 * a failure on one doesn't block the other.
 */
export async function deleteAllWorkspaceSecrets(ownerEmail: string): Promise<{
  agent_account: boolean
  user_account: boolean
}> {
  const results = await Promise.allSettled([
    deleteWorkspaceSecret(ownerEmail, "agent_account"),
    deleteWorkspaceSecret(ownerEmail, "user_account"),
  ])
  return {
    agent_account: results[0].status === "fulfilled" ? results[0].value : false,
    user_account: results[1].status === "fulfilled" ? results[1].value : false,
  }
}
