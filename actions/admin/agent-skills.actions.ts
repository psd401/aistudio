"use server"

import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { handleError, createSuccess } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { requireRole } from "@/lib/auth/role-helpers"
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client"
import { desc, eq, sql, and } from "drizzle-orm"
import { psdAgentSkills } from "@/lib/db/schema/tables/agent-skills"
import { psdAgentSkillAudit } from "@/lib/db/schema/tables/agent-skill-audit"
import type { SkillScanFindings } from "@/lib/db/schema/tables/agent-skills"

export interface SkillRow {
  id: string
  name: string
  scope: string
  ownerUserId: number | null
  s3Key: string
  version: number
  summary: string
  scanStatus: string
  scanFindings: SkillScanFindings | null
  approvedBy: number | null
  approvedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface SkillAuditRow {
  id: number
  skillId: string
  action: string
  actorUserId: number | null
  details: Record<string, unknown> | null
  createdAt: string
}

export interface SkillListResult {
  skills: SkillRow[]
  total: number
}

export interface SkillReviewItem {
  id: string
  name: string
  scope: string
  ownerUserId: number | null
  summary: string
  scanStatus: string
  scanFindings: SkillScanFindings | null
  createdAt: string
}

/**
 * List all skills with optional scope filter.
 */
export async function getAgentSkills(
  scope?: string,
  limit = 100
): Promise<ActionState<SkillListResult>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAgentSkills")
  const log = createLogger({ requestId, action: "getAgentSkills" })

  try {
    await requireRole("administrator")

    const safeLim = Math.min(Math.max(1, limit), 500)

    const conditions = scope
      ? eq(psdAgentSkills.scope, scope as "shared" | "user" | "draft" | "rejected")
      : undefined

    const skills = await executeQuery(
      (db) =>
        db
          .select()
          .from(psdAgentSkills)
          .where(conditions)
          .orderBy(desc(psdAgentSkills.createdAt))
          .limit(safeLim),
      "agentSkills.list"
    )

    const countResult = await executeQuery(
      (db) =>
        db
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(psdAgentSkills)
          .where(conditions),
      "agentSkills.count"
    )

    timer({ status: "success" })
    log.info("Listed skills", { scope, count: skills.length })

    return createSuccess<SkillListResult>({
      skills: skills.map((s) => ({
        id: s.id,
        name: s.name,
        scope: s.scope,
        ownerUserId: s.ownerUserId,
        s3Key: s.s3Key,
        version: s.version,
        summary: s.summary,
        scanStatus: s.scanStatus,
        scanFindings: s.scanFindings,
        approvedBy: s.approvedBy,
        approvedAt: s.approvedAt?.toISOString() ?? null,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      })),
      total: countResult[0]?.count ?? 0,
    })
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to list agent skills", {
      context: "getAgentSkills",
      requestId,
      operation: "getAgentSkills",
    })
  }
}

/**
 * Get items pending admin review (shared submissions + flagged drafts).
 */
export async function getSkillReviewQueue(): Promise<ActionState<SkillReviewItem[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getSkillReviewQueue")
  const log = createLogger({ requestId, action: "getSkillReviewQueue" })

  try {
    await requireRole("administrator")

    // Review queue: skills with scan_status = 'flagged' OR scope = 'draft' with pending scan
    const items = await executeQuery(
      (db) =>
        db
          .select({
            id: psdAgentSkills.id,
            name: psdAgentSkills.name,
            scope: psdAgentSkills.scope,
            ownerUserId: psdAgentSkills.ownerUserId,
            summary: psdAgentSkills.summary,
            scanStatus: psdAgentSkills.scanStatus,
            scanFindings: psdAgentSkills.scanFindings,
            createdAt: psdAgentSkills.createdAt,
          })
          .from(psdAgentSkills)
          .where(
            sql`${psdAgentSkills.scanStatus} = 'flagged' OR (${psdAgentSkills.scope} = 'draft' AND ${psdAgentSkills.scanStatus} = 'pending')`
          )
          .orderBy(desc(psdAgentSkills.createdAt))
          .limit(200),
      "agentSkills.reviewQueue"
    )

    timer({ status: "success" })
    log.info("Loaded review queue", { count: items.length })

    return createSuccess(
      items.map((s) => ({
        id: s.id,
        name: s.name,
        scope: s.scope,
        ownerUserId: s.ownerUserId,
        summary: s.summary,
        scanStatus: s.scanStatus,
        scanFindings: s.scanFindings,
        createdAt: s.createdAt.toISOString(),
      }))
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load review queue", {
      context: "getSkillReviewQueue",
      requestId,
      operation: "getSkillReviewQueue",
    })
  }
}

/**
 * Approve a skill to shared scope (admin action).
 */
export async function approveSkillToShared(
  skillId: string,
  adminUserId: number
): Promise<ActionState<{ success: boolean }>> {
  const requestId = generateRequestId()
  const timer = startTimer("approveSkillToShared")
  const log = createLogger({ requestId, action: "approveSkillToShared" })

  try {
    await requireRole("administrator")

    await executeTransaction(
      async (tx) => {
        await tx
          .update(psdAgentSkills)
          .set({
            scope: "shared",
            approvedBy: adminUserId,
            approvedAt: new Date(),
            scanStatus: "clean",
          })
          .where(eq(psdAgentSkills.id, skillId))

        await tx.insert(psdAgentSkillAudit).values({
          skillId,
          action: "approved_to_shared",
          actorUserId: adminUserId,
          details: { approvedAt: new Date().toISOString() },
        })
      },
      "approveSkillToShared"
    )

    timer({ status: "success" })
    log.info("Skill approved to shared", { skillId, adminUserId })

    return createSuccess({ success: true }, "Skill approved to shared scope")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to approve skill", {
      context: "approveSkillToShared",
      requestId,
      operation: "approveSkillToShared",
    })
  }
}

/**
 * Reject a skill with reason (admin action).
 */
export async function rejectSkill(
  skillId: string,
  adminUserId: number,
  reason: string
): Promise<ActionState<{ success: boolean }>> {
  const requestId = generateRequestId()
  const timer = startTimer("rejectSkill")
  const log = createLogger({ requestId, action: "rejectSkill" })

  try {
    await requireRole("administrator")

    await executeTransaction(
      async (tx) => {
        await tx
          .update(psdAgentSkills)
          .set({ scope: "rejected" })
          .where(eq(psdAgentSkills.id, skillId))

        await tx.insert(psdAgentSkillAudit).values({
          skillId,
          action: "rejected",
          actorUserId: adminUserId,
          details: { reason },
        })
      },
      "rejectSkill"
    )

    timer({ status: "success" })
    log.info("Skill rejected", { skillId, adminUserId, reason })

    return createSuccess({ success: true }, "Skill rejected")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to reject skill", {
      context: "rejectSkill",
      requestId,
      operation: "rejectSkill",
    })
  }
}

/**
 * Get audit log for a specific skill.
 */
export async function getSkillAuditLog(
  skillId: string,
  limit = 50
): Promise<ActionState<SkillAuditRow[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getSkillAuditLog")
  const log = createLogger({ requestId, action: "getSkillAuditLog" })

  try {
    await requireRole("administrator")

    const safeLim = Math.min(Math.max(1, limit), 200)

    const entries = await executeQuery(
      (db) =>
        db
          .select()
          .from(psdAgentSkillAudit)
          .where(eq(psdAgentSkillAudit.skillId, skillId))
          .orderBy(desc(psdAgentSkillAudit.createdAt))
          .limit(safeLim),
      "agentSkills.auditLog"
    )

    timer({ status: "success" })
    log.info("Loaded skill audit log", { skillId, count: entries.length })

    return createSuccess(
      entries.map((e) => ({
        id: e.id,
        skillId: e.skillId,
        action: e.action,
        actorUserId: e.actorUserId,
        details: e.details as Record<string, unknown> | null,
        createdAt: e.createdAt.toISOString(),
      }))
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load audit log", {
      context: "getSkillAuditLog",
      requestId,
      operation: "getSkillAuditLog",
    })
  }
}

/**
 * Delete a skill (admin action).
 */
export async function deleteSkill(
  skillId: string,
  adminUserId: number
): Promise<ActionState<{ success: boolean }>> {
  const requestId = generateRequestId()
  const timer = startTimer("deleteSkill")
  const log = createLogger({ requestId, action: "deleteSkill" })

  try {
    await requireRole("administrator")

    // Audit log entry is cascade-deleted with the skill. Write it first
    // so the log captures the deletion before the row is gone.
    await executeTransaction(
      async (tx) => {
        await tx.insert(psdAgentSkillAudit).values({
          skillId,
          action: "deleted",
          actorUserId: adminUserId,
          details: { deletedAt: new Date().toISOString() },
        })

        await tx
          .delete(psdAgentSkills)
          .where(eq(psdAgentSkills.id, skillId))
      },
      "deleteSkill"
    )

    timer({ status: "success" })
    log.info("Skill deleted", { skillId, adminUserId })

    return createSuccess({ success: true }, "Skill deleted")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to delete skill", {
      context: "deleteSkill",
      requestId,
      operation: "deleteSkill",
    })
  }
}
