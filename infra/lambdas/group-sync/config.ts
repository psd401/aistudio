/**
 * Group-sync configuration resolver for the Lambda (Epic #1202, Phase 0 / #1203).
 *
 * All config is database-first (the settings table), matching the app's
 * @/lib/settings-manager and lib/groups/settings.ts. Keep these key names in sync
 * with lib/groups/settings.ts GROUP_SYNC_SETTING_KEYS — the app and the Lambda
 * read the same rows.
 */

import type postgres from "postgres";
import { getSettingValue } from "./db";

/** Setting keys owned by group sync (must match lib/groups/settings.ts). */
export const GROUP_SYNC_SETTING_KEYS = {
  enabled: "GROUP_SYNC_ENABLED",
  customerId: "GOOGLE_DIRECTORY_CUSTOMER_ID",
} as const;

export interface GroupSyncConfig {
  /** Master switch — only the exact string 'true' enables the sync. */
  enabled: boolean;
  /**
   * Cloud Identity customer id (e.g. "C0xxxxxxx"). Required: without it the
   * sync is not configured and every run is skipped.
   */
  customerId: string | null;
}

/** Resolve group-sync config from the settings table. */
export async function resolveConfig(sql: postgres.Sql): Promise<GroupSyncConfig> {
  const [enabled, customerId] = await Promise.all([
    getSettingValue(sql, GROUP_SYNC_SETTING_KEYS.enabled),
    getSettingValue(sql, GROUP_SYNC_SETTING_KEYS.customerId),
  ]);

  return {
    enabled: (enabled ?? "").toLowerCase() === "true",
    customerId: customerId?.trim() || null,
  };
}

