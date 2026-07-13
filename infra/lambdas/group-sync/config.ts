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
  saSecretArn: "GOOGLE_DIRECTORY_SA_SECRET_ARN",
  customerId: "GOOGLE_DIRECTORY_CUSTOMER_ID",
  dwdSubject: "GOOGLE_DIRECTORY_DWD_SUBJECT",
} as const;

export interface GroupSyncConfig {
  /** Master switch — only the exact string 'true' enables the sync. */
  enabled: boolean;
  /** Secrets Manager ARN of the Google service-account JSON key. */
  saSecretArn: string | null;
  /** Cloud Identity customer id (e.g. "C0xxxxxxx"); defaults to my_customer. */
  customerId: string | null;
  /**
   * Optional admin email to impersonate. When set the sync uses the Admin SDK
   * Directory API via domain-wide delegation; when null it uses the Cloud
   * Identity API with a Groups-Reader service account (no impersonation).
   */
  dwdSubject: string | null;
}

/** Resolve group-sync config from the settings table. */
export async function resolveConfig(sql: postgres.Sql): Promise<GroupSyncConfig> {
  const [enabled, saSecretArn, customerId, dwdSubject] = await Promise.all([
    getSettingValue(sql, GROUP_SYNC_SETTING_KEYS.enabled),
    getSettingValue(sql, GROUP_SYNC_SETTING_KEYS.saSecretArn),
    getSettingValue(sql, GROUP_SYNC_SETTING_KEYS.customerId),
    getSettingValue(sql, GROUP_SYNC_SETTING_KEYS.dwdSubject),
  ]);

  return {
    enabled: (enabled ?? "").toLowerCase() === "true",
    saSecretArn: saSecretArn || null,
    customerId: customerId || null,
    dwdSubject: dwdSubject || null,
  };
}

/** Parsed Google service-account JSON key (only the fields we use). */
export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/** Validate and narrow a parsed SA JSON key. */
export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const clientEmail = parsed.client_email;
  const privateKey = parsed.private_key;
  if (typeof clientEmail !== "string" || !clientEmail) {
    throw new Error("Service-account key JSON missing client_email");
  }
  if (typeof privateKey !== "string" || !privateKey) {
    throw new Error("Service-account key JSON missing private_key");
  }
  return { client_email: clientEmail, private_key: privateKey };
}
