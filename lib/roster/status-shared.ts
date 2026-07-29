/**
 * OneRoster sync status — the CLIENT-SAFE half.
 *
 * Split out of status.ts because the admin UI is a "use client" component and
 * needs `isOneRosterSyncStatusActive`. Importing that from status.ts pulls the
 * whole module into the browser bundle, and status.ts imports the Drizzle
 * client, which imports the logger, which imports winston — so `next build`
 * fails with "Can't resolve 'fs'", "Can't resolve 'net'", and unhandled
 * `node:` schemes. A VALUE import is what does it; the `import type` lines
 * beside it are erased and were never the problem.
 *
 * Everything here is pure: schemas, a constant, and two functions that touch
 * no I/O. Anything needing the database belongs in status.ts.
 *
 * The isolated Lambda duplicates this serialized contract deliberately because
 * its bundle cannot import Next.js application code. Keep the state names and
 * collection fields synchronized with infra/lambdas/oneroster-sync/index.ts.
 */

import { z } from "zod";

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

// CDK disables implicit async retries and caps queued event age at 30 minutes,
// so one hour covers dispatch plus the 15-minute execution timeout with margin
// while still recovering abandoned status rows.
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
