/**
 * Durable OneRoster sync status shared by the administrator UI.
 *
 * The isolated Lambda duplicates this serialized contract deliberately because
 * its bundle cannot import Next.js application code. Keep the state names and
 * collection fields synchronized with infra/lambdas/oneroster-sync/index.ts.
 */

import { z } from "zod";
import { executeQuery } from "@/lib/db/drizzle-client";
import { getSettingValue } from "@/lib/db/drizzle/settings";
import { settings } from "@/lib/db/schema";
import { ONEROSTER_SETTING_KEYS } from "./settings";

export const oneRosterCollectionNameSchema = z.enum([
  "orgs",
  "academicSessions",
  "courses",
  "classes",
  "users",
  "enrollments",
]);

export type OneRosterCollectionName = z.infer<
  typeof oneRosterCollectionNameSchema
>;

const collectionStatusSchema = z.object({
  name: oneRosterCollectionNameSchema,
  recordsTotal: z.number().int().nonnegative(),
  synced: z.number().int().nonnegative(),
  deactivated: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export const oneRosterSyncStatusSchema = z.object({
  runId: z.string().min(1).max(100),
  trigger: z.enum(["manual", "schedule"]),
  state: z.enum(["queued", "running", "succeeded", "failed", "skipped"]),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  unchanged: z.boolean(),
  collections: z.array(collectionStatusSchema),
  error: z.string().max(500).nullable(),
});

export type OneRosterSyncStatus = z.infer<typeof oneRosterSyncStatusSchema>;

// Lambda async invocation can make the initial attempt plus two retries. With
// the 15-minute function timeout and the default retry delays, one hour covers
// the complete execution window while still recovering abandoned status rows.
export const ONEROSTER_SYNC_ACTIVE_WINDOW_MS = 60 * 60 * 1000;

export function isOneRosterSyncStatusActive(
  status: OneRosterSyncStatus,
  now = Date.now()
): boolean {
  if (status.state !== "queued" && status.state !== "running") return false;
  const startedAt = Date.parse(status.startedAt);
  return (
    Number.isFinite(startedAt) &&
    startedAt <= now &&
    now - startedAt <= ONEROSTER_SYNC_ACTIVE_WINDOW_MS
  );
}

export function parseOneRosterSyncStatus(
  value: string | null
): OneRosterSyncStatus | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const result = oneRosterSyncStatusSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function getOneRosterSyncStatus(): Promise<OneRosterSyncStatus | null> {
  return parseOneRosterSyncStatus(
    // Bypass settings-manager's five-minute cache: the Lambda updates this row
    // out of process while the admin page polls every few seconds.
    await getSettingValue(ONEROSTER_SETTING_KEYS.syncStatus)
  );
}

export async function writeOneRosterSyncStatus(
  status: OneRosterSyncStatus
): Promise<void> {
  const parsed = oneRosterSyncStatusSchema.parse(status);
  const now = new Date();
  await executeQuery(
    (db) =>
      db
        .insert(settings)
        .values({
          key: ONEROSTER_SETTING_KEYS.syncStatus,
          value: JSON.stringify(parsed),
          description:
            "Internal OneRoster sync run status for the administrator dashboard",
          category: "integrations",
          isSecret: false,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: settings.key,
          set: {
            value: JSON.stringify(parsed),
            description:
              "Internal OneRoster sync run status for the administrator dashboard",
            category: "integrations",
            isSecret: false,
            updatedAt: now,
          },
        }),
    "writeOneRosterSyncStatus"
  );
}
