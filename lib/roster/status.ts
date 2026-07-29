/**
 * Durable OneRoster sync status — the SERVER half.
 *
 * The pure schema/predicate half lives in ./status-shared so the admin UI can
 * import it without dragging the Drizzle client (and therefore winston, fs and
 * net) into the browser bundle. Server callers can keep importing everything
 * from here; the shared surface is re-exported below.
 */

import { executeQuery } from "@/lib/db/drizzle-client";
import { getSettingValue } from "@/lib/db/drizzle/settings";
import { settings } from "@/lib/db/schema";
import { ONEROSTER_SETTING_KEYS } from "./settings";
import {
  oneRosterSyncStatusSchema,
  parseOneRosterSyncStatus,
  type OneRosterSyncStatus,
} from "./status-shared";

export {
  ONEROSTER_SYNC_ACTIVE_WINDOW_MS,
  isOneRosterSyncStatusActive,
  oneRosterCollectionNameSchema,
  oneRosterSyncStatusSchema,
  parseOneRosterSyncStatus,
} from "./status-shared";
export type {
  OneRosterCollectionName,
  OneRosterSyncStatus,
} from "./status-shared";

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
