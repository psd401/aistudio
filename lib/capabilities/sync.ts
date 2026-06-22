/**
 * Capability Manifest Sync
 *
 * Issue #923 (Epic #922) — reconciles the `capabilities` table to the code
 * manifest (lib/capabilities/manifest.ts) on app boot / deploy.
 *
 * Behavior (idempotent):
 *   - INSERT capabilities present in the manifest but not in the DB.
 *     On insert, grant the entry's `defaultRoles` (applied ONLY on first insert).
 *   - UPDATE name/description/source for capabilities that exist in both. The
 *     manifest owns name/description/source but NOT `is_active`: an admin who
 *     disables a code capability in the UI must stay disabled across restarts, so
 *     the sync never flips `is_active` back to true on an existing row. (Flips
 *     backfilled `source = 'manual'` rows to `source = 'code'`.)
 *   - DEACTIVATE capabilities with `source = 'code'` that are no longer in the
 *     manifest by setting `is_active = false` AND `source = 'manual'`. Demoting to
 *     `manual` "releases" the row: a later manifest re-add then takes the INSERT-
 *     equivalent claim-ownership path (source flips back to `code`, re-activated),
 *     while an admin's manual disable of a still-in-manifest code row is preserved.
 *     Manual capabilities and rows owned by the assistant-architect lifecycle
 *     (identified by `prompt_chain_tool_id`) are never touched.
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

/** Transaction handle type as provided by executeTransaction. */
type Tx = Parameters<Parameters<typeof executeTransaction>[0]>[0];

/** Logger type used inside the sync. */
type SyncLogger = ReturnType<typeof createLogger>;

/**
 * Grant a newly-inserted capability's manifest defaultRoles. Idempotent
 * (ON CONFLICT DO NOTHING). Unknown role names are logged and skipped.
 *
 * @returns the number of role grants performed.
 */
async function grantDefaultRoles(
  tx: Tx,
  entry: CapabilityManifestEntry,
  capabilityId: number,
  roleIdByName: Map<string, number>,
  log: SyncLogger
): Promise<number> {
  if (!entry.defaultRoles || entry.defaultRoles.length === 0) {
    return 0;
  }

  let granted = 0;
  for (const roleName of entry.defaultRoles) {
    const roleId = roleIdByName.get(roleName);
    if (roleId === undefined) {
      log.warn("Manifest defaultRole not found; skipping grant", {
        identifier: entry.identifier,
        roleName,
      });
      continue;
    }
    const insertedRows = await tx
      .insert(roleCapabilities)
      .values({ roleId, capabilityId })
      .onConflictDoNothing()
      .returning({ id: roleCapabilities.id });
    // Only count a grant that was actually inserted (a no-op conflict means the
    // role already had the capability — don't overcount on re-sync).
    granted += insertedRows.length;
  }
  return granted;
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

  // Fail fast on a malformed manifest. Duplicate identifiers would otherwise hit
  // the `capabilities.identifier` UNIQUE constraint mid-transaction (the second
  // duplicate is not in the pre-loop snapshot, so it takes the INSERT path),
  // rolling back the whole sync silently. A deterministic boot error is far
  // easier to diagnose than a single startup warning with no rows written.
  const duplicateIdentifiers = manifestIdentifiers.filter(
    (id, i) => manifestIdentifiers.indexOf(id) !== i
  );
  if (duplicateIdentifiers.length > 0) {
    throw new Error(
      `CAPABILITY_MANIFEST contains duplicate identifiers: ${[
        ...new Set(duplicateIdentifiers),
      ].join(", ")}`
    );
  }

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

        // SAFETY: an empty manifest must be a no-op, NOT a mass-deactivate. The
        // deactivation pass below would otherwise disable every code-source
        // capability (no notInArray guard when there are zero identifiers),
        // locking all users out of gated features. Bail early.
        if (manifestIdentifiers.length === 0) {
          log.warn(
            "Empty capability manifest — skipping sync to avoid mass deactivation"
          );
          return { inserted: [], updated: [], deactivated: [], rolesGranted: 0 };
        }

        const inserted: string[] = [];
        const updated: string[] = [];
        let rolesGranted = 0;

        // Snapshot existing rows for the manifest identifiers in one query.
        // (manifestIdentifiers is non-empty here — guarded above.)
        // Pull the comparable fields too so the UPDATE branch only writes (and
        // only reports in `updated`) when a value actually changed — re-running
        // the sync against an already-synced DB is then a true no-op (no
        // spurious updatedAt churn, no misleading "updated" log entries).
        const existing = await tx
          .select({
            id: capabilities.id,
            identifier: capabilities.identifier,
            name: capabilities.name,
            description: capabilities.description,
            source: capabilities.source,
            isActive: capabilities.isActive,
          })
          .from(capabilities)
          .where(inArray(capabilities.identifier, manifestIdentifiers));

        const existingByIdentifier = new Map(
          existing.map((row) => [row.identifier, row])
        );

        // Resolve role name -> id once (for defaultRoles on insert).
        const allRoles = await tx
          .select({ id: roles.id, name: roles.name })
          .from(roles);
        const roleIdByName = new Map(allRoles.map((r) => [r.name, r.id]));

        for (const entry of manifest) {
          const existingRow = existingByIdentifier.get(entry.identifier);

          if (existingRow === undefined) {
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
            if (row) {
              rolesGranted += await grantDefaultRoles(
                tx,
                entry,
                row.id,
                roleIdByName,
                log
              );
            }
          } else {
            // UPDATE name/description/source. The manifest owns these three
            // fields but deliberately does NOT touch `is_active`: an admin who
            // disabled this code capability in the UI must stay disabled across
            // restarts. Re-activation only happens when the manifest re-claims a
            // previously-released row — and a released row was demoted to
            // `source = 'manual'` by the deactivation pass, so it takes the claim-
            // ownership branch below (source != MANIFEST_SOURCE) and is reactivated
            // there. Role assignments are intentionally NOT touched here.
            //
            // Skip the write entirely when nothing changed so a re-sync against an
            // already-synced DB does not churn updatedAt or report phantom updates.
            const claimingOwnership = existingRow.source !== MANIFEST_SOURCE;
            const needsUpdate =
              existingRow.name !== entry.name ||
              (existingRow.description ?? null) !== (entry.description ?? null) ||
              claimingOwnership;

            if (needsUpdate) {
              await tx
                .update(capabilities)
                .set({
                  name: entry.name,
                  description: entry.description,
                  source: MANIFEST_SOURCE,
                  // Only (re)activate when the manifest is claiming a released or
                  // manual row. For a row already owned by the manifest, preserve
                  // the admin's is_active toggle.
                  ...(claimingOwnership ? { isActive: true } : {}),
                  updatedAt: new Date(),
                })
                .where(eq(capabilities.id, existingRow.id));
              updated.push(entry.identifier);
            }
          }
        }

        // DEACTIVATE code-source capabilities no longer in the manifest, AND
        // demote them to `source = 'manual'`. Demotion "releases" the row so that
        // (a) re-adding the manifest entry later re-claims ownership and
        // re-activates it (via the claimingOwnership branch above), while
        // (b) an admin disabling a still-in-manifest code row is NOT re-enabled on
        // the next boot (that row keeps source = 'code' and is skipped here).
        // Never touch manual capabilities or AA-lifecycle rows
        // (prompt_chain_tool_id IS NOT NULL). manifestIdentifiers is non-empty
        // here (empty manifest bailed above), so notInArray is always present.
        const deactivatedRows = await tx
          .update(capabilities)
          .set({ isActive: false, source: "manual", updatedAt: new Date() })
          .where(
            and(
              eq(capabilities.source, MANIFEST_SOURCE),
              eq(capabilities.isActive, true),
              sql`${capabilities.promptChainToolId} IS NULL`,
              notInArray(capabilities.identifier, manifestIdentifiers)
            )
          )
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
