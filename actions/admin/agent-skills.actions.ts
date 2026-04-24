"use server"

import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, createSuccess } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { requireRole } from "@/lib/auth/role-helpers"
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client"
import { desc, eq, sql } from "drizzle-orm"
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
  skillId: string | null
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

const VALID_SKILL_SCOPES = ["shared", "user", "draft", "rejected"] as const
type ValidSkillScope = (typeof VALID_SKILL_SCOPES)[number]

function isValidScope(scope: string): scope is ValidSkillScope {
  return (VALID_SKILL_SCOPES as readonly string[]).includes(scope)
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

    // L2: Validate scope against enum values at runtime
    const validatedScope = scope && isValidScope(scope) ? scope : undefined

    const conditions = validatedScope
      ? eq(psdAgentSkills.scope, validatedScope)
      : undefined

    // Single query with window function to avoid a second round-trip for count
    const skillsWithCount = await executeQuery(
      (db) =>
        db
          .select({
            id: psdAgentSkills.id,
            name: psdAgentSkills.name,
            scope: psdAgentSkills.scope,
            ownerUserId: psdAgentSkills.ownerUserId,
            s3Key: psdAgentSkills.s3Key,
            version: psdAgentSkills.version,
            summary: psdAgentSkills.summary,
            scanStatus: psdAgentSkills.scanStatus,
            scanFindings: psdAgentSkills.scanFindings,
            approvedBy: psdAgentSkills.approvedBy,
            approvedAt: psdAgentSkills.approvedAt,
            createdAt: psdAgentSkills.createdAt,
            updatedAt: psdAgentSkills.updatedAt,
            totalCount: sql<number>`COUNT(*) OVER()`.as("total_count"),
          })
          .from(psdAgentSkills)
          .where(conditions)
          .orderBy(desc(psdAgentSkills.createdAt))
          .limit(safeLim),
      "agentSkills.list"
    )

    const total = skillsWithCount[0]?.totalCount ?? 0

    timer({ status: "success" })
    log.info("Listed skills", { scope, count: skillsWithCount.length })

    return createSuccess<SkillListResult>({
      skills: skillsWithCount.map((s) => ({
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
      total,
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
 * Admin identity is resolved from the authenticated session (C1 fix).
 *
 * NOTE: This currently only updates the DB (scope, approvedBy, scanStatus).
 * The skill's S3 artifacts remain at the user's approved prefix (s3_key is
 * unchanged). Other agents can load the shared skill via the DB-stored s3_key.
 * A future enhancement should invoke the Skill Builder Lambda to copy artifacts
 * to a shared S3 prefix (`skills/shared/{name}/`) for durability if the
 * original author is deleted. That requires adding Lambda invoke permission
 * to the ECS task role.
 */
export async function approveSkillToShared(
  skillId: string,
): Promise<ActionState<{ success: boolean }>> {
  const requestId = generateRequestId()
  const timer = startTimer("approveSkillToShared")
  const log = createLogger({ requestId, action: "approveSkillToShared" })

  try {
    const currentUser = await requireRole("administrator")
    const adminUserId = currentUser.user.id

    await executeTransaction(
      async (tx) => {
        await tx
          .update(psdAgentSkills)
          .set({
            scope: "shared",
            approvedBy: adminUserId,
            approvedAt: new Date(),
            scanStatus: "clean",
            updatedAt: new Date(),
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
    log.info("Skill approved to shared", sanitizeForLogging({ skillId, adminUserId }))

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
 * Admin identity is resolved from the authenticated session (C1 fix).
 * Reason is truncated to 1000 chars (H4 fix).
 */
export async function rejectSkill(
  skillId: string,
  reason: string
): Promise<ActionState<{ success: boolean }>> {
  const requestId = generateRequestId()
  const timer = startTimer("rejectSkill")
  const log = createLogger({ requestId, action: "rejectSkill" })

  try {
    const currentUser = await requireRole("administrator")
    const adminUserId = currentUser.user.id

    // H4: Truncate reason to prevent oversized JSONB payloads
    const sanitizedReason = reason.slice(0, 1000)

    await executeTransaction(
      async (tx) => {
        await tx
          .update(psdAgentSkills)
          .set({ scope: "rejected", updatedAt: new Date() })
          .where(eq(psdAgentSkills.id, skillId))

        await tx.insert(psdAgentSkillAudit).values({
          skillId,
          action: "rejected",
          actorUserId: adminUserId,
          details: { reason: sanitizedReason },
        })
      },
      "rejectSkill"
    )

    timer({ status: "success" })
    log.info("Skill rejected", sanitizeForLogging({ skillId, adminUserId }))

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
        details: e.details ?? null,
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
 * Admin identity is resolved from the authenticated session (C1 fix).
 * Audit log is written BEFORE the delete. With ON DELETE SET NULL on the
 * FK (C3 fix), the audit entry survives — its skill_id is set to NULL
 * when the skill row is removed, preserving the deletion record.
 */
export async function deleteSkill(
  skillId: string,
): Promise<ActionState<{ success: boolean }>> {
  const requestId = generateRequestId()
  const timer = startTimer("deleteSkill")
  const log = createLogger({ requestId, action: "deleteSkill" })

  try {
    const currentUser = await requireRole("administrator")
    const adminUserId = currentUser.user.id

    // Single atomic transaction: lookup → audit → delete. Wrapping these
    // together ensures the audit row is never written without the delete
    // (and vice versa) if the process crashes between statements.
    await executeTransaction(
      async (tx) => {
        const [skill] = await tx
          .select({ name: psdAgentSkills.name, scope: psdAgentSkills.scope })
          .from(psdAgentSkills)
          .where(eq(psdAgentSkills.id, skillId))
          .limit(1)

        // Write audit entry BEFORE deletion — ON DELETE SET NULL preserves
        // the row (skill_id becomes NULL after the delete).
        await tx.insert(psdAgentSkillAudit).values({
          skillId,
          action: "deleted",
          actorUserId: adminUserId,
          details: {
            skillName: skill?.name ?? "unknown",
            skillScope: skill?.scope ?? "unknown",
            deletedAt: new Date().toISOString(),
          },
        })

        await tx.delete(psdAgentSkills).where(eq(psdAgentSkills.id, skillId))
      },
      "deleteSkill"
    )

    timer({ status: "success" })
    log.info("Skill deleted", sanitizeForLogging({ skillId, adminUserId }))

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
