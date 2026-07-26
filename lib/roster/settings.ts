/**
 * Database-first OneRoster settings shared by future admin surfaces.
 *
 * The isolated sync Lambda reads these same keys directly from PostgreSQL.
 * Credentials stay in Secrets Manager; only the secret ARN is stored here.
 */

import { getSetting } from "@/lib/settings-manager";
import { z } from "zod";

export const ONEROSTER_SETTING_KEYS = {
  enabled: "ROSTER_SYNC_ENABLED",
  baseUrl: "ONEROSTER_BASE_URL",
  authMode: "ONEROSTER_AUTH_MODE",
  credentialsSecretArn: "ONEROSTER_CREDENTIALS_SECRET_ARN",
  apiVersion: "ONEROSTER_API_VERSION",
  pageSize: "ONEROSTER_PAGE_SIZE",
  /** Lambda-owned revision checkpoint, exposed for key-parity checks only. */
  lastPermRev: "ONEROSTER_LAST_PERM_REV",
  /** Lambda-owned run status used by the administrator sync-status poll. */
  syncStatus: "ONEROSTER_SYNC_STATUS",
} as const;

export type OneRosterAuthMode = "oauth1" | "proxy";
export type OneRosterApiVersion = "v1p1" | "v1p2";

export interface OneRosterSettings {
  enabled: boolean;
  baseUrl: string | null;
  authMode: OneRosterAuthMode | null;
  credentialsSecretArn: string | null;
  apiVersion: OneRosterApiVersion;
  pageSize: number;
}

const secretArnPattern =
  /^arn:(?:aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:\d{12}:secret:aistudio-[a-z0-9-]+-oneroster-[a-z0-9/_+=.@-]+$/i;

export const oneRosterSettingsInputSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z
    .string()
    .trim()
    .min(1, "ClassLink base URL is required")
    .transform((value, context) => {
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== "https:") {
          context.addIssue({
            code: "custom",
            message: "ClassLink base URL must use HTTPS",
          });
          return z.NEVER;
        }
        if (parsed.username || parsed.password) {
          context.addIssue({
            code: "custom",
            message: "ClassLink base URL must not contain credentials",
          });
          return z.NEVER;
        }
        parsed.hash = "";
        parsed.search = "";
        return parsed.toString().replace(/\/+$/, "");
      } catch {
        context.addIssue({
          code: "custom",
          message: "ClassLink base URL must be a valid URL",
        });
        return z.NEVER;
      }
    }),
  authMode: z.enum(["oauth1", "proxy"]),
  credentialsSecretArn: z
    .string()
    .trim()
    .regex(
      secretArnPattern,
      "Secret ARN must match the aistudio-{environment}-oneroster-* family"
    ),
  apiVersion: z.enum(["v1p1", "v1p2"]),
  pageSize: z.coerce
    .number()
    .int("Page size must be a whole number")
    .min(1, "Page size must be at least 1")
    .max(10_000, "Page size must not exceed 10,000"),
}).strict();

export type OneRosterSettingsInput = z.input<
  typeof oneRosterSettingsInputSchema
>;
export type ParsedOneRosterSettingsInput = z.output<
  typeof oneRosterSettingsInputSchema
>;

export async function getOneRosterSettings(): Promise<OneRosterSettings> {
  const [enabled, baseUrl, authMode, secretArn, apiVersion, pageSize] =
    await Promise.all([
      getSetting(ONEROSTER_SETTING_KEYS.enabled),
      getSetting(ONEROSTER_SETTING_KEYS.baseUrl),
      getSetting(ONEROSTER_SETTING_KEYS.authMode),
      getSetting(ONEROSTER_SETTING_KEYS.credentialsSecretArn),
      getSetting(ONEROSTER_SETTING_KEYS.apiVersion),
      getSetting(ONEROSTER_SETTING_KEYS.pageSize),
    ]);
  const parsedPageSize = Number.parseInt(pageSize ?? "", 10);

  return {
    enabled: enabled?.trim().toLowerCase() === "true",
    baseUrl: baseUrl?.trim() || null,
    authMode: parseAuthMode(authMode),
    credentialsSecretArn: secretArn?.trim() || null,
    apiVersion: parseApiVersion(apiVersion),
    pageSize:
      Number.isInteger(parsedPageSize) &&
      parsedPageSize > 0 &&
      parsedPageSize <= 10_000
        ? parsedPageSize
        : 10_000,
  };
}

function parseAuthMode(value: string | null): OneRosterAuthMode | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "oauth1" || normalized === "proxy"
    ? normalized
    : null;
}

function parseApiVersion(value: string | null): OneRosterApiVersion {
  return value?.trim().toLowerCase() === "v1p2" ? "v1p2" : "v1p1";
}
