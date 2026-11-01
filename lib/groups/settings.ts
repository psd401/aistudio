/**
 * Group-sync settings accessors (Epic #1202, Phase 0).
 *
 * All group-sync configuration is database-first via @/lib/settings-manager
 * (admin-editable, env fallback, 5-minute cache). The sync Lambda reads the same
 * keys directly from the settings table (it cannot import settings-manager) — keep
 * key names in sync with infra/lambdas/group-sync/config.ts.
 *
 * Google auth is not a setting: the Lambda reaches the directory keylessly
 * through workload identity federation (#1989), configured by CDK.
 */

import { getSetting } from "@/lib/settings-manager";

/** Setting keys owned by group sync (also read by the sync Lambda). */
export const GROUP_SYNC_SETTING_KEYS = {
  /** 'true' / 'false' — master switch for the hourly + manual sync. */
  enabled: "GROUP_SYNC_ENABLED",
  /** Cloud Identity customer id (e.g. "Cxxxxxxx") for groups.list. */
  customerId: "GOOGLE_DIRECTORY_CUSTOMER_ID",
} as const;

export interface GroupSyncSettings {
  enabled: boolean;
  customerId: string | null;
}

/**
 * Resolve the current group-sync settings. `enabled` is opt-in: only the exact
 * string 'true' turns it on (an unset / malformed flag stays disabled — sync
 * should never run against an unconfigured directory).
 */
export async function getGroupSyncSettings(): Promise<GroupSyncSettings> {
  const [enabled, customerId] = await Promise.all([
    getSetting(GROUP_SYNC_SETTING_KEYS.enabled),
    getSetting(GROUP_SYNC_SETTING_KEYS.customerId),
  ]);

  return {
    enabled: enabled?.trim().toLowerCase() === "true",
    customerId: customerId?.trim() || null,
  };
}
