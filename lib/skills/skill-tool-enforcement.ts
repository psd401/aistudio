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
import { parseToolRef } from "@/lib/tools/catalog/version-resolver";

/**
 * A single parsed `allowed-tools` pin (Issue #927). `name` is the version-
 * stripped tool identifier/wire name used for intersection matching; `version`
 * is the pinned `vN` (or `null` for "latest"). The raw entry is preserved for
 * logging / version resolution downstream.
 */
export interface SkillToolPin {
  /** Tool identifier or wire name without any `@version` suffix. */
  name: string;
  /** Pinned version (`v1`, ...) or `null` when the skill tracks latest. */
  version: string | null;
  /** The original `allowed-tools` entry as written in the frontmatter. */
  raw: string;
}

/**
 * Parse a skill's `allowed-tools` list, splitting each entry into its base name
 * and optional `@version` pin (Issue #927). Entries with a malformed `@version`
 * (e.g. `tool@2`, `tool@latest`) are treated as an UNPINNED reference to the
 * whole string as a name — so a typo'd pin fails closed (it simply will not match
 * any real tool) rather than silently widening access. Empty/blank entries are
 * dropped. Order is preserved; duplicates are NOT collapsed (callers that need a
 * set build one).
 *
 * Pure — no I/O.
 */
export function parseSkillAllowedTools(allowedTools: string[]): SkillToolPin[] {
  const pins: SkillToolPin[] = [];
  for (const raw of allowedTools) {
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (!trimmed) continue;
    const parsed = parseToolRef(trimmed);
    if (parsed) {
      pins.push({ name: parsed.identifier, version: parsed.version, raw: trimmed });
    } else {
      // Malformed (e.g. bad @version). Keep the literal as a name so it fails to
      // match a real tool rather than being dropped (fail-closed).
      pins.push({ name: trimmed, version: null, raw: trimmed });
    }
  }
  return pins;
}

/**
 * Intersect a session's available tool names with a skill's `allowed-tools`.
 *
 * - An EMPTY `allowedTools` means the skill pins nothing (the serializer omits
 *   the frontmatter key in that case), so the session keeps all of `available`.
 * - A NON-EMPTY `allowedTools` restricts the session to the overlap, preserving
 *   the order of `available`.
 *
 * Version pins (`@version`, Issue #927) are matched on the version-stripped base
 * name: the client-supplied `available` tool names carry no version, so a pin of
 * `documents.create@v1` gates the session to `documents.create`. The version
 * itself is consumed later when the catalog resolves which version to dispatch.
 *
 * Pure — no I/O. Callers are responsible for having already scope-filtered
 * `available`.
 */
export function intersectSkillAllowedTools(
  available: string[],
  allowedTools: string[]
): string[] {
  if (allowedTools.length === 0) return [...available];
  const pinned = new Set(
    parseSkillAllowedTools(allowedTools).map((p) => p.name)
  );
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
 *
 * NOTE: this runs one indexed primary-key lookup per chat request for the
 * lifetime of a skill-bound session. It is intentionally uncached so that an
 * admin un-approving a skill takes effect immediately (no stale TTL window). If
 * this lookup ever shows up in latency profiles, introduce a short-TTL cache
 * keyed by skillId here — not in the calling route.
 */
export async function getApprovedSkillAllowedTools(
  skillId: string
): Promise<string[] | null> {
  const session = await getApprovedSkillSession(skillId);
  return session ? session.allowedTools : null;
}

/** What a skill-bound chat session needs from an approved skill. */
export interface ApprovedSkillSession {
  /** Skill display/slug name (for the injected prompt header + logging). */
  name: string;
  /** The skill's `allowed-tools` pin (possibly empty = no pin). */
  allowedTools: string[];
  /** S3 prefix of the promoted skill folder (SKILL.md lives under it). */
  s3Key: string;
}

/**
 * Loose UUID shape check for skill ids. Prevents a malformed id (from any
 * caller that skipped schema validation) from reaching PostgreSQL, where it
 * would raise `invalid input syntax for type uuid` instead of resolving to
 * "unknown skill" (PR #1129 review). Exported for the skill tool executor.
 */
export function isSkillIdShaped(skillId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    skillId
  );
}

/**
 * Fetch everything a skill-bound session needs from an APPROVED skill
 * (scope=shared, scanStatus=clean) in one lookup: the `allowed-tools` pin plus
 * the S3 key for loading the SKILL.md instructions. Returns `null` for an
 * unknown/unapproved id — callers MUST treat that as "do not loosen, do not
 * inject" (epic #922 completion audit: the chat route now also injects the
 * skill's instructions, so the approval gate covers both).
 */
export async function getApprovedSkillSession(
  skillId: string
): Promise<ApprovedSkillSession | null> {
  // Malformed id = unknown skill (defense-in-depth under the route's zod
  // `.uuid()` validation; other callers may not validate).
  if (!isSkillIdShaped(skillId)) return null;
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          name: psdAgentSkills.name,
          allowedTools: psdAgentSkills.allowedTools,
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
    "skillEnforcement.allowedTools"
  );
  const row = rows[0];
  if (!row) return null;
  return {
    name: row.name,
    allowedTools: Array.isArray(row.allowedTools) ? row.allowedTools : [],
    s3Key: row.s3Key,
  };
}

/**
 * Apply a skill's `allowed-tools` pin to MCP connector tool sets (#925 AC#6 —
 * epic #922 completion audit). The built-in tool intersection alone left a hole:
 * connector tools were merged into the model's tool set unconditionally, so a
 * skill-bound session with connectors enabled could still call any external
 * tool. An EMPTY pin restricts nothing (matching
 * {@link intersectSkillAllowedTools}); a non-empty pin drops every connector
 * tool UNLESS the pin explicitly namespaces it as `connector:{name}` or
 * `connector:{serverId}:{name}`.
 *
 * Bare pin names deliberately do NOT match connector tools: pins are catalog
 * identifiers/wire names, and the chat route merges connector tools with
 * precedence on name collision — letting a bare pin admit a name-matching
 * external tool would allow a connector to SHADOW the pinned built-in
 * (PR #1129 review, Codex + Copilot).
 *
 * Returns new result objects with filtered `tools`; the originals (and their
 * `close` handles) are not mutated, so connection cleanup is unaffected.
 *
 * Pure — no I/O.
 */
export function filterConnectorToolsByPin<
  T extends { serverId?: string; tools: Record<string, unknown> },
>(results: T[], allowedTools: string[]): T[] {
  if (allowedTools.length === 0) return results;
  // Only `connector:`-namespaced pins can admit a connector tool.
  const connectorPins = new Set(
    parseSkillAllowedTools(allowedTools)
      .map((p) => p.name)
      .filter((name) => name.startsWith("connector:"))
  );
  return results.map((result) => ({
    ...result,
    tools: Object.fromEntries(
      Object.entries(result.tools).filter(
        ([name]) =>
          connectorPins.has(`connector:${name}`) ||
          (result.serverId !== undefined &&
            connectorPins.has(`connector:${result.serverId}:${name}`))
      )
    ),
  }));
}
