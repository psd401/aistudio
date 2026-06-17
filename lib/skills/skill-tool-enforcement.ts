/**
 * Skill `allowed-tools` enforcement (Issue #925, AC#6).
 *
 * When a skill is loaded into a session, the tools the model may use are
 * intersected with the skill's `allowed-tools` frontmatter:
 *
 *     effective = scoped(catalog tools for caller) ∩ skill.allowedTools
 *
 * The scope intersection already happens in the tool catalog
 * (`filterAiSdkToolNames`). This module adds the skill-pin intersection and a
 * thin accessor the Nexus chat route uses to enforce server-side (the client is
 * untrusted — it can send any `enabledTools`, so the pin must be re-applied on
 * the server whenever a session is bound to a skill).
 *
 * The pure {@link intersectSkillAllowedTools} is exported separately so the
 * intersection semantics stay unit-testable without a DB.
 */

import { and, eq } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { psdAgentSkills } from "@/lib/db/schema/tables/agent-skills";

/**
 * Intersect a session's available tool names with a skill's `allowed-tools`.
 *
 * - An EMPTY `allowedTools` means the skill pins nothing (the serializer omits
 *   the frontmatter key in that case), so the session keeps all of `available`.
 * - A NON-EMPTY `allowedTools` restricts the session to the overlap, preserving
 *   the order of `available`.
 *
 * Pure — no I/O. Callers are responsible for having already scope-filtered
 * `available`.
 */
export function intersectSkillAllowedTools(
  available: string[],
  allowedTools: string[]
): string[] {
  if (allowedTools.length === 0) return [...available];
  const pinned = new Set(allowedTools);
  return available.filter((name) => pinned.has(name));
}

/**
 * Fetch the persisted `allowed-tools` for an APPROVED skill (scope=shared,
 * scanStatus=clean). Returns:
 *   - `string[]` — the skill's allowed-tools (possibly empty = no pin) when the
 *     skill exists and is approved.
 *   - `null` — the skill id is unknown or not approved; callers MUST treat this
 *     as "do not loosen" (leave the existing tool set unchanged) so a bogus id
 *     can never widen access.
 */
export async function getApprovedSkillAllowedTools(
  skillId: string
): Promise<string[] | null> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({ allowedTools: psdAgentSkills.allowedTools })
        .from(psdAgentSkills)
        .where(
          and(
            eq(psdAgentSkills.id, skillId),
            eq(psdAgentSkills.scope, "shared"),
            eq(psdAgentSkills.scanStatus, "clean")
          )
        )
        .limit(1),
    "skillEnforcement.allowedTools"
  );
  const row = rows[0];
  if (!row) return null;
  return Array.isArray(row.allowedTools) ? row.allowedTools : [];
}
