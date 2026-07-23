/**
 * Skill → tool catalog registration (Issue #925, AC#5).
 *
 * When an admin approves a skill (draft → shared), it must register as a tool in
 * the unified tool catalog (#924) with `source: 'skill'` so every surface (MCP,
 * AI SDK chat/Nexus, internal agent loops) can discover and invoke it. When a
 * skill is rejected or deleted, its catalog row is deactivated so it stops being
 * offered without losing the (identifier, version) slot.
 *
 * The catalog read path (`lib/tools/catalog/catalog.ts`) merges every
 * `source != 'code'` row into the runtime catalog, so an upsert here + a cache
 * `invalidate()` is all that's needed to make an approved skill live.
 *
 * Pure helpers (`buildSkillCatalogIdentifier`, `buildSkillCatalogToolValues`) are
 * exported separately so the identifier scheme and row shape stay unit-testable
 * without a DB.
 */

import { and, eq } from "drizzle-orm";
import { toolCatalog } from "@/lib/db/schema";
import type { NewToolCatalogRow } from "@/lib/db/schema/tables/tool-catalog";
import type { DbTransaction } from "@/lib/db/drizzle-client";

/** Catalog version used for skill-derived tools. */
export const SKILL_CATALOG_VERSION = "v1";

/**
 * Stable `domain.action` catalog identifier for a skill. Immutable once shipped —
 * derived from the skill slug (which is itself stable for a given skill name).
 */
export function buildSkillCatalogIdentifier(slug: string): string {
  return `skill.${slug}`;
}

/**
 * MCP/AI-SDK wire name for a skill tool. Skill slugs are `[a-z0-9-]`; tool wire
 * names allow `[a-zA-Z0-9_-]`, so the slug is used as-is.
 */
export function buildSkillCatalogToolName(slug: string): string {
  return slug;
}

export interface SkillCatalogToolInput {
  skillId: string;
  slug: string;
  summary: string;
}

/**
 * Build the `tool_catalog` row for an approved skill. Pure — no DB access.
 *
 * - `surfaces`: skills are invocable from the MCP server (`mcp`) and internal
 *   agent loops (`internal`), where `dispatch()` resolves the `skill:` handlerRef
 *   (`skill-tool-executor.ts`). Chat (`ai_sdk`) is deliberately NOT listed: the
 *   chat surface consumes a skill by SESSION BINDING (`skillId` pins the tool
 *   list and injects the SKILL.md instructions into the system prompt), not as a
 *   callable tool — the provider adapters have no executor for skill names, so
 *   advertising `ai_sdk` would be a dead listing.
 * - `requiredScopes`: empty — a published skill is open to any authenticated
 *   caller. Per-skill capability gating is handled separately by the skill's
 *   `requiredCapability` (check_capability.js at invocation), not by catalog scope.
 * - `handlerRef`: `skill:{id}` — the dispatcher resolves this to load the
 *   skill's SKILL.md from S3 as the tool result.
 */
export function buildSkillCatalogToolValues(
  input: SkillCatalogToolInput
): NewToolCatalogRow {
  return {
    identifier: buildSkillCatalogIdentifier(input.slug),
    version: SKILL_CATALOG_VERSION,
    name: buildSkillCatalogToolName(input.slug),
    description: input.summary,
    inputSchema: { type: "object", properties: {} },
    surfaces: ["mcp", "internal"],
    requiredScopes: [],
    agentCallable: true,
    source: "skill",
    handlerRef: `skill:${input.skillId}`,
    isActive: true,
  };
}

/**
 * Upsert the catalog row for an approved skill inside an existing transaction.
 * Idempotent on `(identifier, version)`: re-approving the same skill refreshes
 * its description/handler and re-activates it.
 *
 * NOTE: call `toolCatalogInstance.invalidate()` AFTER the transaction commits so
 * the 5-minute DB cache doesn't keep serving the pre-approval state.
 */
export async function registerSkillCatalogTool(
  tx: DbTransaction,
  input: SkillCatalogToolInput
): Promise<void> {
  const values = buildSkillCatalogToolValues(input);
  await tx
    .insert(toolCatalog)
    .values(values)
    .onConflictDoUpdate({
      target: [toolCatalog.identifier, toolCatalog.version],
      set: {
        name: values.name,
        description: values.description,
        surfaces: values.surfaces,
        requiredScopes: values.requiredScopes,
        agentCallable: values.agentCallable,
        source: values.source,
        handlerRef: values.handlerRef,
        isActive: true,
        updatedAt: new Date(),
      },
    });
}

/**
 * Deactivate the catalog row for a skill (on reject/delete) inside an existing
 * transaction. Soft-disable rather than delete so the (identifier, version) slot
 * is preserved and a later re-approval can re-claim it. No-op if no row exists.
 */
export async function deactivateSkillCatalogTool(
  tx: DbTransaction,
  slug: string
): Promise<void> {
  await tx
    .update(toolCatalog)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(toolCatalog.identifier, buildSkillCatalogIdentifier(slug)),
        eq(toolCatalog.version, SKILL_CATALOG_VERSION)
      )
    );
}
