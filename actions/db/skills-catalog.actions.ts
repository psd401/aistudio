"use server"

import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { handleError, createSuccess, ErrorFactories } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { getServerSession } from "@/lib/auth/server-session"
import { executeQuery } from "@/lib/db/drizzle-client"
import { and, desc, eq } from "drizzle-orm"
import { psdAgentSkills } from "@/lib/db/schema/tables/agent-skills"
import { readSkillMarkdown } from "@/lib/skills/skill-publish-pipeline"

/**
 * User-facing skill catalog actions (Issue #925, AC#4).
 *
 * These expose only APPROVED skills (scope = 'shared', scanStatus = 'clean') to
 * any authenticated user — the admin review surface (Epic #910) handles drafts,
 * flagged, and rejected skills. Reads are intentionally narrow (no owner id, no
 * scan findings) so the catalog can't leak review-only metadata.
 */

export interface CatalogSkill {
  id: string
  name: string
  summary: string
  version: number
  allowedTools: string[]
  updatedAt: string
}

export interface CatalogSkillDetail extends CatalogSkill {
  /** Rendered SKILL.md text, or null if the artifact is not readable. */
  skillMd: string | null
}

/** List approved skills for the catalog (newest first). */
export async function getApprovedSkillsAction(): Promise<ActionState<CatalogSkill[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getApprovedSkills")
  const log = createLogger({ requestId, action: "getApprovedSkills" })

  try {
    const session = await getServerSession()
    if (!session) {
      throw ErrorFactories.authNoSession()
    }

    const rows = await executeQuery(
      (db) =>
        db
          .select({
            id: psdAgentSkills.id,
            name: psdAgentSkills.name,
            summary: psdAgentSkills.summary,
            version: psdAgentSkills.version,
            allowedTools: psdAgentSkills.allowedTools,
            updatedAt: psdAgentSkills.updatedAt,
          })
          .from(psdAgentSkills)
          .where(
            and(
              eq(psdAgentSkills.scope, "shared"),
              eq(psdAgentSkills.scanStatus, "clean")
            )
          )
          .orderBy(desc(psdAgentSkills.updatedAt))
          .limit(200),
      "skillsCatalog.listApproved"
    )

    timer({ status: "success" })
    log.info("Listed approved skills", { count: rows.length })

    return createSuccess(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        summary: r.summary,
        version: r.version,
        allowedTools: Array.isArray(r.allowedTools) ? r.allowedTools : [],
        updatedAt: r.updatedAt.toISOString(),
      }))
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load skills catalog", {
      context: "getApprovedSkills",
      requestId,
      operation: "getApprovedSkills",
    })
  }
}

/** Get one approved skill plus its rendered SKILL.md (for the detail page). */
export async function getApprovedSkillDetailAction(
  skillId: string
): Promise<ActionState<CatalogSkillDetail>> {
  const requestId = generateRequestId()
  const timer = startTimer("getApprovedSkillDetail")
  const log = createLogger({ requestId, action: "getApprovedSkillDetail" })

  try {
    const session = await getServerSession()
    if (!session) {
      throw ErrorFactories.authNoSession()
    }

    const [row] = await executeQuery(
      (db) =>
        db
          .select({
            id: psdAgentSkills.id,
            name: psdAgentSkills.name,
            summary: psdAgentSkills.summary,
            version: psdAgentSkills.version,
            allowedTools: psdAgentSkills.allowedTools,
            updatedAt: psdAgentSkills.updatedAt,
            s3Key: psdAgentSkills.s3Key,
          })
          .from(psdAgentSkills)
          .where(
            and(
              eq(psdAgentSkills.id, skillId),
              eq(psdAgentSkills.scope, "shared"),
              eq(psdAgentSkills.scanStatus, "clean")
            )
          )
          .limit(1),
      "skillsCatalog.detail"
    )

    if (!row) {
      throw ErrorFactories.dbRecordNotFound("psd_agent_skills", skillId)
    }

    // Best-effort read of the SKILL.md artifact for the preview. A missing
    // artifact is non-fatal — the metadata still renders.
    const skillMd = await readSkillMarkdown(row.s3Key)

    timer({ status: "success" })
    log.info("Loaded approved skill detail", { skillId, hasMarkdown: skillMd !== null })

    return createSuccess({
      id: row.id,
      name: row.name,
      summary: row.summary,
      version: row.version,
      allowedTools: Array.isArray(row.allowedTools) ? row.allowedTools : [],
      updatedAt: row.updatedAt.toISOString(),
      skillMd,
    })
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load skill detail", {
      context: "getApprovedSkillDetail",
      requestId,
      operation: "getApprovedSkillDetail",
    })
  }
}
