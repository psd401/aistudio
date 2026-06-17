"use server"

import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, createSuccess, ErrorFactories } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { getCurrentUserAction } from "@/actions/db/get-current-user-action"
import { hasToolAccess } from "@/utils/roles"
import { executeTransaction } from "@/lib/db/drizzle-client"
import { eq, and, sql } from "drizzle-orm"
import { psdAgentSkills } from "@/lib/db/schema/tables/agent-skills"
import { psdAgentSkillAudit } from "@/lib/db/schema/tables/agent-skill-audit"
import { getAssistantArchitectByIdAction } from "@/actions/db/assistant-architect-actions"
import {
  serializeAssistantToSkill,
  type SerializerPrompt,
} from "@/lib/skills/skill-serializer"
import {
  uploadSkillDraft,
  invokeSkillScan,
} from "@/lib/skills/skill-publish-pipeline"

export interface PublishSkillResult {
  skillId: string
  slug: string
  scanQueued: boolean
}

/**
 * Publish an Assistant Architect as a draft SKILL.md skill (Issue #925).
 *
 * Flow:
 *   1. Load the assistant (name, description, prompts, input fields).
 *   2. Serialize to SKILL.md (pure — see skill-serializer.ts).
 *   3. Upload the SKILL.md folder to the draft S3 prefix.
 *   4. Register a `psd_agent_skills` row (scope=draft, scanStatus=pending) +
 *      audit entry, inside a single transaction.
 *   5. Best-effort invoke the scan pipeline (non-fatal).
 *
 * The skill always lands as a reviewable draft even if the scan invoke is
 * skipped, satisfying the "lands in agent_skills with proper status" criterion.
 */
export async function publishAssistantArchitectAsSkillAction(
  assistantId: string
): Promise<ActionState<PublishSkillResult>> {
  const requestId = generateRequestId()
  const timer = startTimer("publishAssistantArchitectAsSkill")
  const log = createLogger({ requestId, action: "publishAssistantArchitectAsSkill" })

  try {
    log.info("Action started", { assistantId })

    // Auth: any user who can use the Assistant Architect tool may publish their
    // assistant as a draft skill. Drafts require admin approval before sharing.
    const currentUserResult = await getCurrentUserAction()
    if (!currentUserResult.isSuccess || !currentUserResult.data) {
      log.warn("Unauthorized publish attempt")
      throw ErrorFactories.authNoSession()
    }
    const ownerUserId = currentUserResult.data.user.id
    const ownerEmail = currentUserResult.data.user.email

    if (!ownerEmail) {
      throw ErrorFactories.invalidInput(
        "email",
        ownerEmail,
        "Current user has no email; cannot publish skill"
      )
    }

    const canUse = await hasToolAccess("assistant-architect")
    if (!canUse) {
      log.warn("User lacks assistant-architect access", { ownerUserId })
      throw ErrorFactories.authzToolAccessDenied("assistant-architect")
    }

    // 1. Load the assistant with relations.
    const architectResult = await getAssistantArchitectByIdAction(assistantId)
    if (!architectResult.isSuccess || !architectResult.data) {
      throw ErrorFactories.dbRecordNotFound("assistant_architects", assistantId)
    }
    const architect = architectResult.data

    // 2. Serialize to SKILL.md.
    const serialized = serializeAssistantToSkill({
      name: architect.name,
      description: architect.description ?? null,
      inputFields: (architect.inputFields ?? []).map((f) => ({
        name: f.name,
        label: f.label ?? null,
        fieldType: f.fieldType,
        options: f.options,
      })),
      prompts: (architect.prompts ?? []).map<SerializerPrompt>((p) => ({
        name: p.name,
        content: p.content,
        systemContext: p.systemContext ?? null,
        position: p.position ?? null,
        enabledTools: Array.isArray(p.enabledTools) ? p.enabledTools : [],
      })),
    })

    // 3. Upload the SKILL.md folder to S3 (draft prefix).
    const { draftPrefix, destinationPrefix } = await uploadSkillDraft({
      ownerEmail,
      slug: serialized.slug,
      files: [{ path: "SKILL.md", content: serialized.skillMd }],
    })

    // 4. Register the draft skill row + audit entry atomically. Upsert on the
    // (name, owner_user_id) partial unique index for draft scope so republishing
    // the same assistant bumps the version in place (matches the infra author
    // flow). updated_at must be set explicitly — no DB trigger.
    const skillId = await executeTransaction(async (tx) => {
      const [row] = await tx
        .insert(psdAgentSkills)
        .values({
          name: serialized.slug,
          scope: "draft",
          ownerUserId,
          s3Key: draftPrefix,
          summary: serialized.summary,
          scanStatus: "pending",
        })
        .onConflictDoUpdate({
          target: [psdAgentSkills.name, psdAgentSkills.ownerUserId],
          targetWhere: eq(psdAgentSkills.scope, "draft"),
          set: {
            s3Key: draftPrefix,
            summary: serialized.summary,
            scanStatus: "pending",
            version: sql`${psdAgentSkills.version} + 1`,
            updatedAt: new Date(),
          },
        })
        .returning({ id: psdAgentSkills.id })

      // Resolve id when ON CONFLICT did not return (defensive — returning() is
      // populated on both insert and update for postgres.js, but guard anyway).
      let resolvedId = row?.id
      if (!resolvedId) {
        const [existing] = await tx
          .select({ id: psdAgentSkills.id })
          .from(psdAgentSkills)
          .where(
            and(
              eq(psdAgentSkills.name, serialized.slug),
              eq(psdAgentSkills.ownerUserId, ownerUserId),
              eq(psdAgentSkills.scope, "draft")
            )
          )
          .limit(1)
        resolvedId = existing?.id
      }

      if (!resolvedId) {
        throw ErrorFactories.dbQueryFailed(
          "register published skill",
          new Error("No skill id returned after upsert")
        )
      }

      await tx.insert(psdAgentSkillAudit).values({
        skillId: resolvedId,
        action: "published_from_architect",
        actorUserId: ownerUserId,
        details: {
          assistantId,
          slug: serialized.slug,
          allowedTools: serialized.allowedTools,
          s3Key: draftPrefix,
        },
      })

      return resolvedId
    }, "publishAssistantArchitectAsSkill")

    // 5. Best-effort scan invoke (non-fatal). Outside the transaction.
    const scanQueued = await invokeSkillScan({
      skillId,
      draftPrefix,
      destinationPrefix,
    })

    timer({ status: "success" })
    log.info(
      "Assistant published as skill",
      sanitizeForLogging({ assistantId, skillId, slug: serialized.slug, scanQueued })
    )

    return createSuccess(
      { skillId, slug: serialized.slug, scanQueued },
      scanQueued
        ? "Published as a skill and queued for review."
        : "Published as a draft skill. An administrator will review it."
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to publish assistant as a skill", {
      context: "publishAssistantArchitectAsSkill",
      requestId,
      operation: "publishAssistantArchitectAsSkill",
    })
  }
}
