"use server"

import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, createSuccess } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { requireRole } from "@/lib/auth/role-helpers"
import { executeQuery } from "@/lib/db/drizzle-client"
import { desc, eq } from "drizzle-orm"
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
    timer({ status: "error" })
    return handleError(error, "Failed to log credential provisioning", {
      context: "logCredentialProvisioningAction",
      requestId,
      operation: "logCredentialProvisioningAction",
    })
  }
}

/**
 * Credential name validation regex.
 * Only lowercase alphanumeric, hyphens, and underscores allowed.
 * Must start with a letter and be between 1-128 chars.
 */
const CREDENTIAL_NAME_RE = /^[a-z][\d_a-z-]{0,127}$/

/**
 * Provision (create or rotate) a shared secret in AWS Secrets Manager.
 *
 * Path: psd-agent-creds/{env}/shared/{name}
 *
 * Writes the secret value and logs an audit entry with scope=shared
 * and action=created or action=rotated depending on whether the secret
 * existed prior.
 *
 * The secret value is NEVER logged or returned — only success/failure status.
 * Admin identity is resolved from the authenticated session.
 */
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

    // Validate inputs
    if (!name || !CREDENTIAL_NAME_RE.test(name)) {
      return handleError(
        new Error("Invalid credential name"),
        "Credential name must start with a lowercase letter and contain only lowercase letters, numbers, hyphens, or underscores (1-128 chars).",
        { context: "provisionSharedSecret", requestId, operation: "provisionSharedSecret" }
      )
    }

    if (!value || value.length === 0) {
      return handleError(
        new Error("Empty secret value"),
        "Secret value cannot be empty.",
        { context: "provisionSharedSecret", requestId, operation: "provisionSharedSecret" }
      )
    }

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
            action: "created",
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
      ResourceNotFoundException,
    } = await import("@aws-sdk/client-secrets-manager")
    const { SecretsManagerClient } = await import("@aws-sdk/client-secrets-manager")
    const client = new SecretsManagerClient({})

    let auditAction: "created" | "rotated"

    try {
      // Try to update existing secret first (rotation case)
      await client.send(
        new PutSecretValueCommand({
          SecretId: secretId,
          SecretString: value,
        })
      )
      auditAction = "rotated"
      log.info("Shared secret rotated", { secretId })
    } catch (putError) {
      if (putError instanceof ResourceNotFoundException) {
        // Secret doesn't exist — create it
        await client.send(
          new CreateSecretCommand({
            Name: secretId,
            SecretString: value,
            Description: `Shared agent credential: ${name}`,
            Tags: [
              { Key: "Environment", Value: environment },
              { Key: "ManagedBy", Value: "aistudio" },
              { Key: "Scope", Value: "shared" },
            ],
          })
        )
        auditAction = "created"
        log.info("Shared secret created", { secretId })
      } else {
        throw putError
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
    timer({ status: "error" })
    return handleError(error, "Failed to provision shared secret", {
      context: "provisionSharedSecret",
      requestId,
      operation: "provisionSharedSecret",
    })
  }
}
