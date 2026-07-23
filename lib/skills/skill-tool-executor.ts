/**
 * Skill tool execution (Issue #925, AC#5 — epic #922 completion audit).
 *
 * Approved skills register in the unified tool catalog with
 * `handlerRef: skill:{id}` (see `skill-catalog-registration.ts`). This module is
 * the dispatcher for that handlerRef: invoking a skill tool LOADS the skill —
 * it returns the full SKILL.md document (frontmatter + instructions) as the tool
 * result so the calling model can follow the skill's instructions from that
 * point on. This is the progressive-disclosure semantic Anthropic skills use:
 * a skill is an instruction folder, not a function, so "executing" it means
 * pulling its instructions into context.
 *
 * Fail-closed: only an APPROVED skill (scope=shared, scanStatus=clean) is
 * loadable. A rejected/deleted/unknown skill id returns an isError result — the
 * catalog row may lag (5-minute cache) behind an admin un-approval, so the
 * approval state is re-checked here on every invocation, uncached (mirroring
 * `getApprovedSkillAllowedTools`).
 */

import { and, eq } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { psdAgentSkills } from "@/lib/db/schema/tables/agent-skills";
import { readSkillMarkdown } from "@/lib/skills/skill-publish-pipeline";
import { isSkillIdShaped } from "@/lib/skills/skill-tool-enforcement";
import { createLogger } from "@/lib/logger";
import type { McpToolResult } from "@/lib/mcp/types";

const log = createLogger({ module: "skill-tool-executor" });

/** Build an MCP-style error result with a model-actionable message. */
function errorResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Execute a `skill:{id}` handlerRef: load the approved skill's SKILL.md and
 * return it as the tool result. The document includes the frontmatter
 * (`allowed-tools` pins and summary) plus the instruction body, so the model
 * receives the complete, scanned artifact — nothing is re-synthesized here.
 */
export async function executeSkillTool(skillId: string): Promise<McpToolResult> {
  // A malformed id would raise a PostgreSQL uuid syntax error instead of
  // resolving to "unknown skill" — guard before querying. handlerRefs are
  // written by us at registration, so this only trips on a corrupted ref.
  // (PR #1129 review.)
  if (!isSkillIdShaped(skillId)) {
    log.warn("Skill tool invoked with malformed skill id", { skillId });
    return errorResult(
      "This skill is not available. It may have been unpublished or is awaiting review."
    );
  }
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          name: psdAgentSkills.name,
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
    "skillToolExecutor.loadApproved"
  );
  const row = rows[0];
  if (!row) {
    // Unknown OR no-longer-approved: report the same way so a stale catalog row
    // cannot be used to distinguish "rejected" from "never existed".
    log.warn("Skill tool invoked for unknown/unapproved skill", { skillId });
    return errorResult(
      "This skill is not available. It may have been unpublished or is awaiting review."
    );
  }

  const skillMd = await readSkillMarkdown(row.s3Key);
  if (skillMd === null) {
    log.error("Approved skill has no readable SKILL.md", {
      skillId,
      s3Key: row.s3Key,
    });
    return errorResult(
      `The skill "${row.name}" could not be loaded (its instructions are unavailable). Report this to an administrator.`
    );
  }

  return {
    content: [
      {
        type: "text",
        text:
          `Skill "${row.name}" loaded. Follow these instructions for the current task. ` +
          `Only use the tools listed in its allowed-tools (if present).\n\n${skillMd}`,
      },
    ],
  };
}

/**
 * Parse a catalog `handlerRef` of the form `skill:{uuid}`. Returns the skill id
 * or null when the ref is not a skill ref. Exported for the catalog dispatcher
 * and unit tests.
 */
export function parseSkillHandlerRef(handlerRef: string | null | undefined): string | null {
  if (!handlerRef || !handlerRef.startsWith("skill:")) return null;
  const id = handlerRef.slice("skill:".length).trim();
  return id.length > 0 ? id : null;
}
