/**
 * Tool Catalog Manifest Sync
 *
 * Issue #924 (Epic #922, workstream #2) — reconciles the `tool_catalog` table to
 * the code manifest (`lib/tools/catalog/manifest.ts`) on app boot / deploy.
 * Direct parallel of the capability sync (`lib/capabilities/sync.ts`, #923).
 *
 * Behavior (idempotent):
 *   - INSERT code tools present in the manifest but not in the DB.
 *   - UPDATE name/description/schema/surfaces/required_scopes/agent_callable/
 *     handler_ref/source for code tools that exist in both, but ONLY when a value
 *     actually changed. The manifest never flips `is_active`: an admin who
 *     disables a code tool in the DB must stay disabled across restarts. Claiming
 *     ownership of a previously-released row (source != 'code') re-activates it.
 *   - DEACTIVATE code tools no longer in the manifest by setting
 *     `is_active = false` AND demoting `source = 'assistant'` (releases the row so
 *     a later manifest re-add re-claims ownership). Rows with
 *     `source != 'code'` (assistant/skill-derived) are never touched.
 *
 * Concurrency: wrapped in a transaction holding a session-scoped advisory lock
 * (`pg_advisory_xact_lock`) so multiple ECS replicas booting at once serialize
 * the sync rather than racing. The lock auto-releases at transaction end.
 *
 * A logical tool is keyed by `(identifier, version)`. The sync matches on that
 * composite key so multiple versions of the same identifier coexist.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { executeTransaction } from "@/lib/db/drizzle-client";
import { toolCatalog } from "@/lib/db/schema";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import {
  TOOL_MANIFEST,
  MANIFEST_TOOL_SOURCE,
} from "@/lib/tools/catalog/manifest";
import type { ToolManifestEntry } from "@/lib/tools/catalog/types";

/**
 * Advisory lock key for the tool catalog sync. Distinct from the capability sync
 * key (923_001) so the two boot syncs do not serialize against each other.
 */
const SYNC_ADVISORY_LOCK_KEY = 924_001;

/** Source a deactivated/released code row is demoted to. */
const RELEASED_SOURCE = "assistant" as const;

export interface ToolCatalogSyncResult {
  inserted: string[];
  updated: string[];
  deactivated: string[];
}

/** Composite key for a logical tool. */
function keyOf(identifier: string, version: string): string {
  return `${identifier}@${version}`;
}

/** Normalize an array for stable equality comparison (order-insensitive). */
function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/** Stable JSON comparison for schema objects (null/undefined collapse to null). */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Sync the tool catalog manifest into the database. Safe to call repeatedly.
 *
 * @param manifest - Override the manifest (used by tests). Defaults to
 *                    TOOL_MANIFEST.
 */
export async function syncToolCatalogManifest(
  manifest: readonly ToolManifestEntry[] = TOOL_MANIFEST
): Promise<ToolCatalogSyncResult> {
  const requestId = generateRequestId();
  const timer = startTimer("syncToolCatalogManifest");
  const log = createLogger({ requestId, operation: "syncToolCatalogManifest" });

  // Normalize manifest entries to (identifier, version) with v1 default.
  const normalized = manifest.map((e) => ({
    ...e,
    version: e.version ?? "v1",
    agentCallable: e.agentCallable ?? true,
  }));

  const manifestKeys = normalized.map((e) => keyOf(e.identifier, e.version));

  // Fail fast on a malformed manifest. Duplicate (identifier, version) pairs
  // would otherwise hit the UNIQUE constraint mid-transaction and roll back the
  // whole sync silently. A deterministic boot error is far easier to diagnose.
  const duplicateKeys = manifestKeys.filter(
    (k, i) => manifestKeys.indexOf(k) !== i
  );
  if (duplicateKeys.length > 0) {
    throw new Error(
      `TOOL_MANIFEST contains duplicate (identifier, version) pairs: ${[
        ...new Set(duplicateKeys),
      ].join(", ")}`
    );
  }

  const manifestIdentifiers = normalized.map((e) => e.identifier);

  log.info("Starting tool catalog manifest sync", {
    manifestCount: normalized.length,
  });

  try {
    const result = await executeTransaction<ToolCatalogSyncResult>(
      async (tx) => {
        // Serialize concurrent replica syncs. Auto-released at tx end.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${SYNC_ADVISORY_LOCK_KEY})`
        );

        // SAFETY: an empty manifest must be a no-op, NOT a mass-deactivate.
        if (normalized.length === 0) {
          log.warn(
            "Empty tool catalog manifest — skipping sync to avoid mass deactivation"
          );
          return { inserted: [], updated: [], deactivated: [] };
        }

        const inserted: string[] = [];
        const updated: string[] = [];

        // Snapshot existing rows for the manifest identifiers in one query.
        const existing = await tx
          .select({
            id: toolCatalog.id,
            identifier: toolCatalog.identifier,
            version: toolCatalog.version,
            name: toolCatalog.name,
            description: toolCatalog.description,
            inputSchema: toolCatalog.inputSchema,
            outputSchema: toolCatalog.outputSchema,
            surfaces: toolCatalog.surfaces,
            requiredScopes: toolCatalog.requiredScopes,
            agentCallable: toolCatalog.agentCallable,
            handlerRef: toolCatalog.handlerRef,
            source: toolCatalog.source,
            isActive: toolCatalog.isActive,
          })
          .from(toolCatalog)
          .where(inArray(toolCatalog.identifier, manifestIdentifiers));

        const existingByKey = new Map(
          existing.map((row) => [keyOf(row.identifier, row.version), row])
        );

        for (const entry of normalized) {
          const key = keyOf(entry.identifier, entry.version);
          const existingRow = existingByKey.get(key);
          const handlerRef = entry.identifier; // manifest dispatches by identifier

          if (existingRow === undefined) {
            // INSERT new code tool.
            await tx.insert(toolCatalog).values({
              identifier: entry.identifier,
              version: entry.version,
              name: entry.name,
              description: entry.description,
              inputSchema: entry.inputSchema,
              outputSchema: entry.outputSchema ?? null,
              surfaces: entry.surfaces,
              requiredScopes: entry.requiredScopes,
              agentCallable: entry.agentCallable,
              source: MANIFEST_TOOL_SOURCE,
              handlerRef,
              isActive: true,
            });
            inserted.push(key);
          } else {
            // UPDATE manifest-owned fields, but only when something changed.
            // Claiming a released/foreign row (source != 'code') re-activates it.
            const claimingOwnership =
              existingRow.source !== MANIFEST_TOOL_SOURCE;
            const needsUpdate =
              existingRow.name !== entry.name ||
              existingRow.description !== entry.description ||
              !sameJson(existingRow.inputSchema, entry.inputSchema) ||
              !sameJson(
                existingRow.outputSchema,
                entry.outputSchema ?? null
              ) ||
              !sameStringArray(existingRow.surfaces ?? [], entry.surfaces) ||
              !sameStringArray(
                existingRow.requiredScopes ?? [],
                entry.requiredScopes
              ) ||
              existingRow.agentCallable !== entry.agentCallable ||
              (existingRow.handlerRef ?? null) !== handlerRef ||
              claimingOwnership;

            if (needsUpdate) {
              await tx
                .update(toolCatalog)
                .set({
                  name: entry.name,
                  description: entry.description,
                  inputSchema: entry.inputSchema,
                  outputSchema: entry.outputSchema ?? null,
                  surfaces: entry.surfaces,
                  requiredScopes: entry.requiredScopes,
                  agentCallable: entry.agentCallable,
                  handlerRef,
                  source: MANIFEST_TOOL_SOURCE,
                  // Only (re)activate when claiming a released/foreign row.
                  // Preserve an admin's is_active toggle on an owned row.
                  ...(claimingOwnership ? { isActive: true } : {}),
                  updatedAt: new Date(),
                })
                .where(eq(toolCatalog.id, existingRow.id));
              updated.push(key);
            }
          }
        }

        // DEACTIVATE code tools no longer in the manifest, AND demote them so a
        // later manifest re-add re-claims ownership (via the claimingOwnership
        // branch above). Only touches rows the manifest currently owns
        // (source = 'code'); assistant/skill rows are never affected. We diff in
        // app code (not notInArray on a composite key) so version-scoped removal
        // works correctly.
        const manifestKeySet = new Set(manifestKeys);
        const deactivated: string[] = [];
        const orphanCandidates = await tx
          .select({
            id: toolCatalog.id,
            identifier: toolCatalog.identifier,
            version: toolCatalog.version,
          })
          .from(toolCatalog)
          .where(
            and(
              eq(toolCatalog.source, MANIFEST_TOOL_SOURCE),
              eq(toolCatalog.isActive, true)
            )
          );

        for (const row of orphanCandidates) {
          const rowKey = keyOf(row.identifier, row.version);
          if (!manifestKeySet.has(rowKey)) {
            await tx
              .update(toolCatalog)
              .set({
                isActive: false,
                source: RELEASED_SOURCE,
                updatedAt: new Date(),
              })
              .where(eq(toolCatalog.id, row.id));
            deactivated.push(rowKey);
          }
        }

        return { inserted, updated, deactivated };
      },
      "syncToolCatalogManifest"
    );

    timer({ status: "success" });
    log.info("Tool catalog manifest sync complete", {
      inserted: result.inserted.length,
      updated: result.updated.length,
      deactivated: result.deactivated.length,
    });
    return result;
  } catch (error) {
    timer({ status: "error" });
    log.error("Tool catalog manifest sync failed", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
}
