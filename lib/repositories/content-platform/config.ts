import { getSettings } from "@/lib/settings-manager";

export const CONTENT_PLATFORM_SETTING_KEYS = {
  enabled: "CONTENT_PLATFORM_ENABLED",
  dualWriteEnabled: "CONTENT_DUAL_WRITE_ENABLED",
  readV2Enabled: "CONTENT_READ_V2_ENABLED",
  nexusAttachmentRetentionDays: "NEXUS_ATTACHMENT_RETENTION_DAYS",
  deletionGraceDays: "CONTENT_DELETION_GRACE_DAYS",
  maxFileSizeGb: "CONTENT_MAX_FILE_SIZE_GB",
  maxPdfSizeMb: "CONTENT_MAX_PDF_SIZE_MB",
  maxOfficeSizeMb: "CONTENT_MAX_OFFICE_SIZE_MB",
  maxMediaHours: "CONTENT_MAX_MEDIA_HOURS",
  malwareScanRequired: "CONTENT_MALWARE_SCAN_REQUIRED",
  ocrStrategy: "CONTENT_OCR_STRATEGY",
  visualIndexEnabled: "CONTENT_VISUAL_INDEX_ENABLED",
  googleSyncEnabled: "GOOGLE_CONTENT_SYNC_ENABLED",
  googleSyncIntervalMinutes: "GOOGLE_CONTENT_SYNC_INTERVAL_MINUTES",
} as const;

export type ContentOcrStrategy = "auto" | "textract" | "disabled";

export interface ContentPlatformConfig {
  enabled: boolean;
  dualWriteEnabled: boolean;
  readV2Enabled: boolean;
  nexusAttachmentRetentionDays: number;
  deletionGraceDays: number;
  maxFileSizeGb: number;
  maxPdfSizeMb: number;
  maxOfficeSizeMb: number;
  maxMediaHours: number;
  malwareScanRequired: boolean;
  ocrStrategy: ContentOcrStrategy;
  visualIndexEnabled: boolean;
  googleSyncEnabled: boolean;
  googleSyncIntervalMinutes: number;
}

export const DEFAULT_CONTENT_PLATFORM_CONFIG: Readonly<ContentPlatformConfig> = {
  enabled: false,
  dualWriteEnabled: false,
  readV2Enabled: false,
  nexusAttachmentRetentionDays: 30,
  deletionGraceDays: 7,
  maxFileSizeGb: 10,
  maxPdfSizeMb: 500,
  maxOfficeSizeMb: 100,
  maxMediaHours: 4,
  malwareScanRequired: true,
  ocrStrategy: "auto",
  visualIndexEnabled: false,
  googleSyncEnabled: false,
  googleSyncIntervalMinutes: 15,
};

type RawContentPlatformSettings = Record<string, string | null | undefined>;

function parseBoolean(value: string | null | undefined, fallback: boolean): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function parseBoundedInteger(
  value: string | null | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (value == null || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number.parseInt(value, 10);
  return parsed >= min && parsed <= max ? parsed : fallback;
}

function parseOcrStrategy(value: string | null | undefined): ContentOcrStrategy {
  return value === "auto" ||
    value === "textract" ||
    value === "disabled"
    ? value
    : DEFAULT_CONTENT_PLATFORM_CONFIG.ocrStrategy;
}

export function parseContentPlatformConfig(
  raw: RawContentPlatformSettings
): ContentPlatformConfig {
  const keys = CONTENT_PLATFORM_SETTING_KEYS;
  return {
    enabled: parseBoolean(raw[keys.enabled], DEFAULT_CONTENT_PLATFORM_CONFIG.enabled),
    dualWriteEnabled: parseBoolean(
      raw[keys.dualWriteEnabled],
      DEFAULT_CONTENT_PLATFORM_CONFIG.dualWriteEnabled
    ),
    readV2Enabled: parseBoolean(
      raw[keys.readV2Enabled],
      DEFAULT_CONTENT_PLATFORM_CONFIG.readV2Enabled
    ),
    nexusAttachmentRetentionDays: parseBoundedInteger(
      raw[keys.nexusAttachmentRetentionDays],
      DEFAULT_CONTENT_PLATFORM_CONFIG.nexusAttachmentRetentionDays,
      1,
      3650
    ),
    deletionGraceDays: parseBoundedInteger(
      raw[keys.deletionGraceDays],
      DEFAULT_CONTENT_PLATFORM_CONFIG.deletionGraceDays,
      1,
      365
    ),
    maxFileSizeGb: parseBoundedInteger(
      raw[keys.maxFileSizeGb],
      DEFAULT_CONTENT_PLATFORM_CONFIG.maxFileSizeGb,
      1,
      50
    ),
    maxPdfSizeMb: parseBoundedInteger(
      raw[keys.maxPdfSizeMb],
      DEFAULT_CONTENT_PLATFORM_CONFIG.maxPdfSizeMb,
      1,
      500
    ),
    maxOfficeSizeMb: parseBoundedInteger(
      raw[keys.maxOfficeSizeMb],
      DEFAULT_CONTENT_PLATFORM_CONFIG.maxOfficeSizeMb,
      1,
      500
    ),
    maxMediaHours: parseBoundedInteger(
      raw[keys.maxMediaHours],
      DEFAULT_CONTENT_PLATFORM_CONFIG.maxMediaHours,
      1,
      24
    ),
    malwareScanRequired: parseBoolean(
      raw[keys.malwareScanRequired],
      DEFAULT_CONTENT_PLATFORM_CONFIG.malwareScanRequired
    ),
    ocrStrategy: parseOcrStrategy(raw[keys.ocrStrategy]),
    visualIndexEnabled: parseBoolean(
      raw[keys.visualIndexEnabled],
      DEFAULT_CONTENT_PLATFORM_CONFIG.visualIndexEnabled
    ),
    googleSyncEnabled: parseBoolean(
      raw[keys.googleSyncEnabled],
      DEFAULT_CONTENT_PLATFORM_CONFIG.googleSyncEnabled
    ),
    googleSyncIntervalMinutes: parseBoundedInteger(
      raw[keys.googleSyncIntervalMinutes],
      DEFAULT_CONTENT_PLATFORM_CONFIG.googleSyncIntervalMinutes,
      1,
      1440
    ),
  };
}

export async function getContentPlatformConfig(): Promise<ContentPlatformConfig> {
  const keys = Object.values(CONTENT_PLATFORM_SETTING_KEYS);
  return parseContentPlatformConfig(await getSettings(keys));
}

/**
 * A rollout sub-flag is never sufficient by itself: the platform master switch
 * must also be on. This prevents a stale child flag from changing production
 * behavior when an administrator disables the platform globally.
 */
export function isContentDualWriteActive(config: ContentPlatformConfig): boolean {
  return config.enabled && config.dualWriteEnabled;
}

export function isContentReadV2Active(config: ContentPlatformConfig): boolean {
  return config.enabled && config.readV2Enabled;
}

/**
 * The new upload contract is the cutover boundary: do not return canonical-only
 * uploads until shadow writes and canonical reads have both been enabled.
 */
export function isCanonicalRepositoryUploadActive(
  config: ContentPlatformConfig
): boolean {
  return config.enabled && config.dualWriteEnabled && config.readV2Enabled;
}
