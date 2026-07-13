/**
 * Group-sync settings accessors (Epic #1202, Phase 0).
 *
 * All group-sync configuration is database-first via @/lib/settings-manager
 * (admin-editable, env fallback, 5-minute cache). The sync Lambda reads the same
 * keys directly from the settings table (it cannot import settings-manager) — keep
 * key names in sync with infra/lambdas/group-sync/settings.ts.
 */

import { getSetting } from "@/lib/settings-manager";

/** Setting keys owned by group sync (also read by the sync Lambda). */
export const GROUP_SYNC_SETTING_KEYS = {
  /** 'true' / 'false' — master switch for the hourly + manual sync. */
  enabled: "GROUP_SYNC_ENABLED",
  /** Secrets Manager ARN of the Google service-account JSON. */
  saSecretArn: "GOOGLE_DIRECTORY_SA_SECRET_ARN",
  /** Cloud Identity customer id (e.g. "Cxxxxxxx") for groups.list. */
  customerId: "GOOGLE_DIRECTORY_CUSTOMER_ID",
  /** Optional admin email to impersonate → Directory API + DWD fallback path. */
  dwdSubject: "GOOGLE_DIRECTORY_DWD_SUBJECT",
} as const;

export interface GroupSyncSettings {
  enabled: boolean;
  saSecretArn: string | null;
  customerId: string | null;
  dwdSubject: string | null;
}

/**
 * Resolve the current group-sync settings. `enabled` is opt-in: only the exact
 * string 'true' turns it on (an unset / malformed flag stays disabled — sync
 * should never run against an unconfigured directory).
 */
export async function getGroupSyncSettings(): Promise<GroupSyncSettings> {
  const [enabled, saSecretArn, customerId, dwdSubject] = await Promise.all([
    getSetting(GROUP_SYNC_SETTING_KEYS.enabled),
    getSetting(GROUP_SYNC_SETTING_KEYS.saSecretArn),
    getSetting(GROUP_SYNC_SETTING_KEYS.customerId),
    getSetting(GROUP_SYNC_SETTING_KEYS.dwdSubject),
  ]);

  return {
    enabled: enabled?.trim().toLowerCase() === "true",
    saSecretArn: saSecretArn?.trim() || null,
    customerId: customerId?.trim() || null,
    dwdSubject: dwdSubject?.trim() || null,
  };
}
