/**
 * Database-first configuration for the isolated OneRoster sync Lambda.
 *
 * Keep key names synchronized with lib/roster/settings.ts. Credentials remain
 * in Secrets Manager; the settings table stores only the secret ARN.
 */

import type postgres from "postgres";
import { getSettingValue } from "./db";
import { isRecord } from "./normalize";

export const ONEROSTER_SETTING_KEYS = {
  enabled: "ROSTER_SYNC_ENABLED",
  baseUrl: "ONEROSTER_BASE_URL",
  authMode: "ONEROSTER_AUTH_MODE",
  credentialsSecretArn: "ONEROSTER_CREDENTIALS_SECRET_ARN",
  apiVersion: "ONEROSTER_API_VERSION",
  pageSize: "ONEROSTER_PAGE_SIZE",
  /** Internal sync checkpoint; not an administrator-entered credential/config. */
  lastPermRev: "ONEROSTER_LAST_PERM_REV",
  /** Internal run status consumed by the administrator dashboard poll. */
  syncStatus: "ONEROSTER_SYNC_STATUS",
} as const;

export type OneRosterAuthMode = "oauth1" | "proxy";
export type OneRosterApiVersion = "v1p1" | "v1p2";

export interface OneRosterConfig {
  enabled: boolean;
  baseUrl: string | null;
  authMode: OneRosterAuthMode | null;
  credentialsSecretArn: string | null;
  apiVersion: OneRosterApiVersion;
  pageSize: number;
}

export async function resolveConfig(sql: postgres.Sql): Promise<OneRosterConfig> {
  const [enabled, baseUrl, authMode, credentialsSecretArn, apiVersion, pageSize] =
    await Promise.all([
      getSettingValue(sql, ONEROSTER_SETTING_KEYS.enabled),
      getSettingValue(sql, ONEROSTER_SETTING_KEYS.baseUrl),
      getSettingValue(sql, ONEROSTER_SETTING_KEYS.authMode),
      getSettingValue(sql, ONEROSTER_SETTING_KEYS.credentialsSecretArn),
      getSettingValue(sql, ONEROSTER_SETTING_KEYS.apiVersion),
      getSettingValue(sql, ONEROSTER_SETTING_KEYS.pageSize),
    ]);

  const parsedMode = parseAuthMode(authMode);
  const parsedVersion = parseApiVersion(apiVersion);
  const parsedPageSize = Number.parseInt(pageSize ?? "", 10);

  return {
    enabled: enabled?.toLowerCase() === "true",
    baseUrl: baseUrl ? normalizeBaseUrl(baseUrl) : null,
    authMode: parsedMode,
    credentialsSecretArn: credentialsSecretArn || null,
    apiVersion: parsedVersion,
    pageSize:
      Number.isInteger(parsedPageSize) &&
      parsedPageSize > 0 &&
      parsedPageSize <= 10_000
        ? parsedPageSize
        : 10_000,
  };
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") {
    throw new Error("ONEROSTER_BASE_URL must use https");
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/+$/, "");
}

function parseAuthMode(value: string | null): OneRosterAuthMode | null {
  const normalized = value?.toLowerCase();
  if (!normalized) return null;
  if (normalized === "oauth1" || normalized === "proxy") return normalized;
  throw new Error("ONEROSTER_AUTH_MODE must be oauth1 or proxy");
}

function parseApiVersion(value: string | null): OneRosterApiVersion {
  const normalized = value?.toLowerCase();
  if (!normalized || normalized === "v1p1") return "v1p1";
  if (normalized === "v1p2") return "v1p2";
  throw new Error("ONEROSTER_API_VERSION must be v1p1 or v1p2");
}

export interface OAuth1Credentials {
  mode: "oauth1";
  consumerKey: string;
  consumerSecret: string;
}

export interface ProxyCredentials {
  mode: "proxy";
  bearerToken: string;
}

export type OneRosterCredentials = OAuth1Credentials | ProxyCredentials;

export function parseCredentials(
  raw: string,
  mode: OneRosterAuthMode
): OneRosterCredentials {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) {
    throw new Error("OneRoster credentials secret must contain a JSON object");
  }
  const parsed = value;
  if (mode === "oauth1") {
    const consumerKey = parsed.consumerKey;
    const consumerSecret = parsed.consumerSecret;
    if (typeof consumerKey !== "string" || !consumerKey) {
      throw new Error("OneRoster OAuth1 secret is missing consumerKey");
    }
    if (typeof consumerSecret !== "string" || !consumerSecret) {
      throw new Error("OneRoster OAuth1 secret is missing consumerSecret");
    }
    return { mode, consumerKey, consumerSecret };
  }
  const bearerToken = parsed.bearerToken;
  if (typeof bearerToken !== "string" || !bearerToken) {
    throw new Error("OneRoster proxy secret is missing bearerToken");
  }
  return { mode, bearerToken };
}
