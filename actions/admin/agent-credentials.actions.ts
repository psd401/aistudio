"use server"

import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
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

    const conditions = statusFilter === "all"
      ? undefined
      : eq(psdAgentCredentialRequests.status, statusFilter)

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
 */
export async function resolveCredentialRequest(
  requestId: number,
  adminUserId: number,
  status: "fulfilled" | "rejected"
): Promise<ActionState<{ success: boolean }>> {
  const rid = generateRequestId()
  const timer = startTimer("resolveCredentialRequest")
  const log = createLogger({ requestId: rid, action: "resolveCredentialRequest" })

  try {
    await requireRole("administrator")

    await executeQuery(
      (db) =>
        db
          .update(psdAgentCredentialRequests)
          .set({
            status,
            resolvedBy: adminUserId,
            resolvedAt: new Date(),
          })
          .where(eq(psdAgentCredentialRequests.id, requestId)),
      "agentCredentials.resolveRequest"
    )

    timer({ status: "success" })
    log.info("Credential request resolved", { requestId, adminUserId, status })

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
        details: e.details as Record<string, unknown> | null,
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
 */
export async function logCredentialProvisioningAction(
  credentialName: string,
  scope: string,
  action: string,
  adminUserId: number,
  details?: Record<string, unknown>
): Promise<ActionState<{ success: boolean }>> {
  const requestId = generateRequestId()
  const timer = startTimer("logCredentialProvisioningAction")
  const log = createLogger({ requestId, action: "logCredentialProvisioningAction" })

  try {
    await requireRole("administrator")

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
    log.info("Credential provisioning logged", { credentialName, action })

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
