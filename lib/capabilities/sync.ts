/**
 * Capability Manifest Sync
 *
 * Issue #923 (Epic #922) — reconciles the `capabilities` table to the code
 * manifest (lib/capabilities/manifest.ts) on app boot / deploy.
 *
 * Behavior (idempotent):
 *   - INSERT capabilities present in the manifest but not in the DB.
 *     On insert, grant the entry's `defaultRoles` (applied ONLY on first insert).
 *   - UPDATE name/description/source and re-activate capabilities that exist in
 *     both. (Flips backfilled `source = 'manual'` rows to `source = 'code'`.)
 *   - DEACTIVATE (`is_active = false`) capabilities with `source = 'code'` that are
 *     no longer in the manifest. Manual capabilities and rows owned by the
 *     assistant-architect lifecycle (identified by `prompt_chain_tool_id`) are
 *     never touched.
 *
 * Concurrency: wrapped in a transaction holding a session-scoped advisory lock
 * (`pg_advisory_xact_lock`) so multiple ECS replicas booting at once serialize
 * the sync rather than racing. The lock auto-releases at transaction end.
 */

import { eq, and, inArray, notInArray, sql } from "drizzle-orm";
import { executeTransaction } from "@/lib/db/drizzle-client";
import { capabilities, roleCapabilities, roles } from "@/lib/db/schema";
import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger";
import {
  CAPABILITY_MANIFEST,
  MANIFEST_SOURCE,
  type CapabilityManifestEntry,
} from "@/lib/capabilities/manifest";

/**
 * Advisory lock key for the capability sync. Arbitrary but stable 32-bit int;
 * shared by all replicas so they serialize on the same lock.
 */
const SYNC_ADVISORY_LOCK_KEY = 923_001;

export interface CapabilitySyncResult {
  inserted: string[];
  updated: string[];
  deactivated: string[];
  rolesGranted: number;
}

/**
 * Sync the capability manifest into the database. Safe to call repeatedly.
 *
 * @param manifest - Override the manifest (used by tests). Defaults to
 *                    CAPABILITY_MANIFEST.
 */
export async function syncCapabilityManifest(
  manifest: readonly CapabilityManifestEntry[] = CAPABILITY_MANIFEST
): Promise<CapabilitySyncResult> {
  const requestId = generateRequestId();
  const timer = startTimer("syncCapabilityManifest");
  const log = createLogger({ requestId, operation: "syncCapabilityManifest" });

  const manifestIdentifiers = manifest.map((e) => e.identifier);

  log.info("Starting capability manifest sync", {
    manifestCount: manifest.length,
  });

  try {
    const result = await executeTransaction<CapabilitySyncResult>(
      async (tx) => {
        // Serialize concurrent replica syncs. Auto-released at tx end.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${SYNC_ADVISORY_LOCK_KEY})`
        );

        const inserted: string[] = [];
        const updated: string[] = [];
        let rolesGranted = 0;

        // Snapshot existing rows for the manifest identifiers in one query.
        const existing =
          manifestIdentifiers.length > 0
            ? await tx
                .select({
                  id: capabilities.id,
                  identifier: capabilities.identifier,
                })
                .from(capabilities)
                .where(inArray(capabilities.identifier, manifestIdentifiers))
            : [];

        const existingByIdentifier = new Map(
          existing.map((row) => [row.identifier, row.id])
        );

        // Resolve role name -> id once (for defaultRoles on insert).
        const allRoles = await tx
          .select({ id: roles.id, name: roles.name })
          .from(roles);
        const roleIdByName = new Map(allRoles.map((r) => [r.name, r.id]));

        for (const entry of manifest) {
          const existingId = existingByIdentifier.get(entry.identifier);

          if (existingId === undefined) {
            // INSERT new capability.
            const [row] = await tx
              .insert(capabilities)
              .values({
                identifier: entry.identifier,
                name: entry.name,
                description: entry.description,
                isActive: true,
                source: MANIFEST_SOURCE,
              })
              .returning({ id: capabilities.id });
            inserted.push(entry.identifier);

            // Apply defaultRoles ONLY on first insert.
            if (row && entry.defaultRoles && entry.defaultRoles.length > 0) {
              for (const roleName of entry.defaultRoles) {
                const roleId = roleIdByName.get(roleName);
                if (roleId === undefined) {
                  log.warn("Manifest defaultRole not found; skipping grant", {
                    identifier: entry.identifier,
                    roleName,
                  });
                  continue;
                }
                await tx
                  .insert(roleCapabilities)
                  .values({ roleId, capabilityId: row.id })
                  .onConflictDoNothing();
                rolesGranted += 1;
              }
            }
          } else {
            // UPDATE name/description/source; re-activate (manifest re-add).
            // Role assignments are intentionally NOT touched here.
            await tx
              .update(capabilities)
              .set({
                name: entry.name,
                description: entry.description,
                source: MANIFEST_SOURCE,
                isActive: true,
                updatedAt: new Date(),
              })
              .where(eq(capabilities.id, existingId));
            updated.push(entry.identifier);
          }
        }

        // DEACTIVATE code-source capabilities no longer in the manifest.
        // Never touch manual capabilities or AA-lifecycle rows
        // (prompt_chain_tool_id IS NOT NULL).
        const deactivateConditions = [
          eq(capabilities.source, MANIFEST_SOURCE),
          eq(capabilities.isActive, true),
          sql`${capabilities.promptChainToolId} IS NULL`,
        ];
        if (manifestIdentifiers.length > 0) {
          deactivateConditions.push(
            notInArray(capabilities.identifier, manifestIdentifiers)
          );
        }

        const deactivatedRows = await tx
          .update(capabilities)
          .set({ isActive: false, updatedAt: new Date() })
          .where(and(...deactivateConditions))
          .returning({ identifier: capabilities.identifier });

        return {
          inserted,
          updated,
          deactivated: deactivatedRows.map((r) => r.identifier),
          rolesGranted,
        };
      },
      "syncCapabilityManifest"
    );

    timer({ status: "success" });
    log.info("Capability manifest sync complete", {
      inserted: result.inserted.length,
      updated: result.updated.length,
      deactivated: result.deactivated.length,
      rolesGranted: result.rolesGranted,
    });
    return result;
  } catch (error) {
    timer({ status: "error" });
    log.error("Capability manifest sync failed", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
}
