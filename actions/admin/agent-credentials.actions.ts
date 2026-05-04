"use server"

import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, createSuccess } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { requireRole } from "@/lib/auth/role-helpers"
import { executeQuery } from "@/lib/db/drizzle-client"
import { desc, eq } from "drizzle-orm"
import { isRedirectError } from "next/dist/client/components/redirect-error"
import { psdAgentCredentialsAudit } from "@/lib/db/schema/tables/agent-credentials-audit"
import { psdAgentCredentialReads } from "@/lib/db/schema/tables/agent-credential-reads"
import { psdAgentCredentialRequests } from "@/lib/db/schema/tables/agent-credential-requests"

export interface CredentialAuditRow {
  id: number
  credentialName: string
  scope: string
  action: string
  actorUserId: number | null
  details: Record<string, unknown> | null
  createdAt: string
}

export interface CredentialReadRow {
  id: number
  credentialName: string
  userId: string
  sessionId: string | null
  createdAt: string
}

export interface CredentialRequestRow {
  id: number
  credentialName: string
  reason: string
  skillContext: string | null
  requestedBy: string
  freshserviceTicketId: string | null
  status: string
  resolvedBy: number | null
  resolvedAt: string | null
  createdAt: string
}

/**
 * Get credential usage telemetry (reads, never values).
 */
export async function getCredentialReads(
  limit = 100
): Promise<ActionState<CredentialReadRow[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getCredentialReads")
  const log = createLogger({ requestId, action: "getCredentialReads" })

  try {
    await requireRole("administrator")

    const safeLim = Math.min(Math.max(1, limit), 500)

    const reads = await executeQuery(
      (db) =>
        db
          .select()
          .from(psdAgentCredentialReads)
          .orderBy(desc(psdAgentCredentialReads.createdAt))
          .limit(safeLim),
      "agentCredentials.reads"
    )

    timer({ status: "success" })
    log.info("Loaded credential reads", { count: reads.length })

    return createSuccess(
      reads.map((r) => ({
        id: r.id,
        credentialName: r.credentialName,
        userId: r.userId,
        sessionId: r.sessionId,
        createdAt: r.createdAt.toISOString(),
      }))
    )
  } catch (error) {
    if (isRedirectError(error)) throw error
    timer({ status: "error" })
    return handleError(error, "Failed to load credential reads", {
      context: "getCredentialReads",
      requestId,
      operation: "getCredentialReads",
    })
  }
}

/**
 * Get pending credential requests.
 */
export async function getCredentialRequests(
  statusFilter = "pending"
): Promise<ActionState<CredentialRequestRow[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getCredentialRequests")
  const log = createLogger({ requestId, action: "getCredentialRequests" })

  try {
    await requireRole("administrator")

    // L1: Validate statusFilter against allowed values
    const validStatuses = ["pending", "fulfilled", "rejected", "all"]
    const safeFilter = validStatuses.includes(statusFilter) ? statusFilter : "pending"

    const conditions = safeFilter === "all"
      ? undefined
      : eq(psdAgentCredentialRequests.status, safeFilter)

    const requests = await executeQuery(
      (db) =>
        db
          .select()
          .from(psdAgentCredentialRequests)
          .where(conditions)
          .orderBy(desc(psdAgentCredentialRequests.createdAt))
          .limit(200),
      "agentCredentials.requests"
    )

    timer({ status: "success" })
    log.info("Loaded credential requests", { statusFilter, count: requests.length })

    return createSuccess(
      requests.map((r) => ({
        id: r.id,
        credentialName: r.credentialName,
        reason: r.reason,
        skillContext: r.skillContext,
        requestedBy: r.requestedBy,
        freshserviceTicketId: r.freshserviceTicketId,
        status: r.status,
        resolvedBy: r.resolvedBy,
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      }))
    )
  } catch (error) {
    if (isRedirectError(error)) throw error
    timer({ status: "error" })
    return handleError(error, "Failed to load credential requests", {
      context: "getCredentialRequests",
      requestId,
      operation: "getCredentialRequests",
    })
  }
}

/**
 * Resolve a credential request (mark as fulfilled or rejected).
 * Admin identity is resolved from the authenticated session (C1 fix).
 */
export async function resolveCredentialRequest(
  requestId: number,
  status: "fulfilled" | "rejected"
): Promise<ActionState<{ success: boolean }>> {
  const rid = generateRequestId()
  const timer = startTimer("resolveCredentialRequest")
  const log = createLogger({ requestId: rid, action: "resolveCredentialRequest" })

  try {
    const currentUser = await requireRole("administrator")
    const adminUserId = currentUser.user.id

    await executeQuery(
      (db) =>
        db
          .update(psdAgentCredentialRequests)
          .set({
            status,
            resolvedBy: adminUserId,
            resolvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(psdAgentCredentialRequests.id, requestId)),
      "agentCredentials.resolveRequest"
    )

    timer({ status: "success" })
    log.info("Credential request resolved", sanitizeForLogging({ requestId, adminUserId, status }))

    return createSuccess({ success: true }, `Request ${status}`)
  } catch (error) {
    if (isRedirectError(error)) throw error
    timer({ status: "error" })
    return handleError(error, "Failed to resolve credential request", {
      context: "resolveCredentialRequest",
      requestId: rid,
      operation: "resolveCredentialRequest",
    })
  }
}

/**
 * Get credential provisioning audit trail.
 */
export async function getCredentialAuditLog(
  limit = 100
): Promise<ActionState<CredentialAuditRow[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getCredentialAuditLog")
  const log = createLogger({ requestId, action: "getCredentialAuditLog" })

  try {
    await requireRole("administrator")

    const safeLim = Math.min(Math.max(1, limit), 500)

    const entries = await executeQuery(
      (db) =>
        db
          .select()
          .from(psdAgentCredentialsAudit)
          .orderBy(desc(psdAgentCredentialsAudit.createdAt))
          .limit(safeLim),
      "agentCredentials.auditLog"
    )

    timer({ status: "success" })
    log.info("Loaded credential audit log", { count: entries.length })

    return createSuccess(
      entries.map((e) => ({
        id: e.id,
        credentialName: e.credentialName,
        scope: e.scope,
        action: e.action,
        actorUserId: e.actorUserId,
        details: e.details ?? null,
        createdAt: e.createdAt.toISOString(),
      }))
    )
  } catch (error) {
    if (isRedirectError(error)) throw error
    timer({ status: "error" })
    return handleError(error, "Failed to load credential audit log", {
      context: "getCredentialAuditLog",
      requestId,
      operation: "getCredentialAuditLog",
    })
  }
}

/**
 * Write a credential provisioning audit entry (when admin creates/updates/deletes
 * a secret via the dashboard).
 * Admin identity is resolved from the authenticated session (C1 fix).
 */
export async function logCredentialProvisioningAction(
  credentialName: string,
  scope: string,
  action: string,
  details?: Record<string, unknown>
): Promise<ActionState<{ success: boolean }>> {
  const requestId = generateRequestId()
  const timer = startTimer("logCredentialProvisioningAction")
  const log = createLogger({ requestId, action: "logCredentialProvisioningAction" })

  try {
    const currentUser = await requireRole("administrator")
    const adminUserId = currentUser.user.id

    await executeQuery(
      (db) =>
        db.insert(psdAgentCredentialsAudit).values({
          credentialName,
          scope,
          action,
          actorUserId: adminUserId,
          details: details ?? null,
        }),
      "agentCredentials.logProvisioning"
    )

    timer({ status: "success" })
    log.info("Credential provisioning logged", sanitizeForLogging({ credentialName, action }))

    return createSuccess({ success: true })
  } catch (error) {
    if (isRedirectError(error)) throw error
    timer({ status: "error" })
    return handleError(error, "Failed to log credential provisioning", {
      context: "logCredentialProvisioningAction",
      requestId,
      operation: "logCredentialProvisioningAction",
    })
  }
}

// Lowercase alphanumeric, hyphens, and underscores; must start with a letter (1-128 chars)
const CREDENTIAL_NAME_RE = /^[a-z][\d_a-z-]{0,127}$/

// Module-scoped client — reuses the HTTP connection pool across calls
let _smClient: InstanceType<typeof import("@aws-sdk/client-secrets-manager").SecretsManagerClient> | null = null

async function getProvisionSecretsClient() {
  if (_smClient) return _smClient
  const { SecretsManagerClient } = await import("@aws-sdk/client-secrets-manager")
  _smClient = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION,
  })
  return _smClient
}

function validateSecretInputs(name: string, value: string, requestId: string): ActionState<never> | null {
  if (!name || !CREDENTIAL_NAME_RE.test(name)) {
    return handleError(
      new Error("Invalid credential name"),
      "Credential name must start with a lowercase letter and contain only lowercase letters, numbers, hyphens, or underscores (1-128 chars).",
      { context: "provisionSharedSecret", requestId, operation: "provisionSharedSecret" }
    )
  }
  if (!value.trim()) {
    return handleError(
      new Error("Empty secret value"),
      "Secret value cannot be empty or whitespace-only.",
      { context: "provisionSharedSecret", requestId, operation: "provisionSharedSecret" }
    )
  }
  if (value.length > 65536) {
    return handleError(
      new Error("Secret value too large"),
      "Secret value must be 65,536 characters or fewer (AWS Secrets Manager limit).",
      { context: "provisionSharedSecret", requestId, operation: "provisionSharedSecret" }
    )
  }
  return null
}

/** Provision (create or rotate) a shared secret in AWS Secrets Manager. */
export async function provisionSharedSecret(
  name: string,
  value: string
): Promise<ActionState<{ action: "created" | "rotated" }>> {
  const requestId = generateRequestId()
  const timer = startTimer("provisionSharedSecret")
  const log = createLogger({ requestId, action: "provisionSharedSecret" })

  try {
    const currentUser = await requireRole("administrator")
    const adminUserId = currentUser.user.id

    const validationError = validateSecretInputs(name, value, requestId)
    if (validationError) return validationError

    const environment = process.env.ENVIRONMENT ?? process.env.DEPLOY_ENVIRONMENT ?? "dev"
    const secretId = `psd-agent-creds/${environment}/shared/${name}`

    log.info("Provisioning shared secret", { secretId, adminUserId })

    // In local development, skip Secrets Manager but still log audit
    if (process.env.NODE_ENV === "development") {
      log.info("Local dev mode — skipping Secrets Manager write", { secretId })

      await executeQuery(
        (db) =>
          db.insert(psdAgentCredentialsAudit).values({
            credentialName: name,
            scope: "shared",
            action: "provisioned",
            actorUserId: adminUserId,
            details: { secretId, environment, localDevSkipped: true },
          }),
        "agentCredentials.provisionAudit"
      )

      timer({ status: "success" })
      return createSuccess({ action: "created" as const }, "Secret provisioned (local dev — Secrets Manager write skipped)")
    }

    // Write to AWS Secrets Manager
    const {
      PutSecretValueCommand,
      CreateSecretCommand,
      TagResourceCommand,
      ResourceNotFoundException,
    } = await import("@aws-sdk/client-secrets-manager")
    const client = await getProvisionSecretsClient()

    const tags = [
      { Key: "Environment", Value: environment },
      { Key: "ManagedBy", Value: "aistudio" },
    ]

    let auditAction: "created" | "rotated"

    try {
      // Try to update existing secret first (rotation case)
      await client.send(
        new PutSecretValueCommand({ SecretId: secretId, SecretString: value })
      )
      // Ensure tags are consistent on rotation (secret may have been created manually)
      await client.send(new TagResourceCommand({ SecretId: secretId, Tags: tags }))
      auditAction = "rotated"
      log.info("Shared secret rotated", { secretId })
    } catch (putError) {
      if (!(putError instanceof ResourceNotFoundException)) throw putError

      // Secret doesn't exist — create it (handle race with ResourceExistsException)
      try {
        await client.send(
          new CreateSecretCommand({
            Name: secretId,
            SecretString: value,
            Description: `Shared agent credential: ${name}`,
            Tags: tags,
          })
        )
        auditAction = "created"
        log.info("Shared secret created", { secretId })
      } catch (createError: unknown) {
        if (!(createError instanceof Error) || createError.name !== "ResourceExistsException") {
          throw createError
        }
        // Race: another admin created between our PutSecretValue and CreateSecret
        await client.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: value }))
        await client.send(new TagResourceCommand({ SecretId: secretId, Tags: tags }))
        auditAction = "rotated"
        log.info("Shared secret rotated (race recovery)", { secretId })
      }
    }

    // Write audit entry
    await executeQuery(
      (db) =>
        db.insert(psdAgentCredentialsAudit).values({
          credentialName: name,
          scope: "shared",
          action: auditAction,
          actorUserId: adminUserId,
          details: { secretId, environment },
        }),
      "agentCredentials.provisionAudit"
    )

    timer({ status: "success" })
    const message = auditAction === "created"
      ? `Shared secret "${name}" created at ${secretId}`
      : `Shared secret "${name}" rotated at ${secretId}`
    return createSuccess({ action: auditAction }, message)
  } catch (error) {
    if (isRedirectError(error)) throw error
    timer({ status: "error" })
    return handleError(error, "Failed to provision shared secret", {
      context: "provisionSharedSecret",
      requestId,
      operation: "provisionSharedSecret",
    })
  }
}
