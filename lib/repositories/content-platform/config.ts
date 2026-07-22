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
  maxImageSizeMb: "CONTENT_MAX_IMAGE_SIZE_MB",
  maxMediaHours: "CONTENT_MAX_MEDIA_HOURS",
  malwareScanRequired: "CONTENT_MALWARE_SCAN_REQUIRED",
  ocrStrategy: "CONTENT_OCR_STRATEGY",
  imageCaptionModelId: "CONTENT_IMAGE_CAPTION_MODEL_ID",
  visualIndexEnabled: "CONTENT_VISUAL_INDEX_ENABLED",
  retrievalRerankEnabled: "CONTENT_RETRIEVAL_RERANK_ENABLED",
  retrievalRerankModelId: "CONTENT_RETRIEVAL_RERANK_MODEL_ID",
  retrievalCandidateLimit: "CONTENT_RETRIEVAL_CANDIDATE_LIMIT",
  retrievalNeighborCount: "CONTENT_RETRIEVAL_NEIGHBOR_COUNT",
  retrievalContextTokens: "CONTENT_RETRIEVAL_CONTEXT_TOKENS",
  retrievalRrfK: "CONTENT_RETRIEVAL_RRF_K",
  retrievalMaxPerSource: "CONTENT_RETRIEVAL_MAX_PER_SOURCE",
  visualEmbeddingModelId: "CONTENT_VISUAL_EMBEDDING_MODEL_ID",
  visualEmbeddingDimensions: "CONTENT_VISUAL_EMBEDDING_DIMENSIONS",
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
  maxImageSizeMb: number;
  maxMediaHours: number;
  malwareScanRequired: boolean;
  ocrStrategy: ContentOcrStrategy;
  imageCaptionModelId: string;
  visualIndexEnabled: boolean;
  retrievalRerankEnabled: boolean;
  retrievalRerankModelId: string;
  retrievalCandidateLimit: number;
  retrievalNeighborCount: number;
  retrievalContextTokens: number;
  retrievalRrfK: number;
  retrievalMaxPerSource: number;
  visualEmbeddingModelId: string;
  visualEmbeddingDimensions: number;
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
  maxImageSizeMb: 50,
  maxMediaHours: 4,
  malwareScanRequired: true,
  ocrStrategy: "auto",
  imageCaptionModelId: "us.amazon.nova-2-lite-v1:0",
  visualIndexEnabled: false,
  retrievalRerankEnabled: true,
  retrievalRerankModelId: "cohere.rerank-v3-5:0",
  retrievalCandidateLimit: 40,
  retrievalNeighborCount: 1,
  retrievalContextTokens: 4000,
  retrievalRrfK: 60,
  retrievalMaxPerSource: 3,
  visualEmbeddingModelId: "cohere.embed-v4:0",
  visualEmbeddingDimensions: 1536,
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

function parseImageCaptionModelId(value: string | null | undefined): string {
  const candidate = value?.trim();
  if (!candidate) return DEFAULT_CONTENT_PLATFORM_CONFIG.imageCaptionModelId;
  // Keep image bytes inside the US geography and restrict this worker to
  // Amazon's multimodal Nova understanding family. IAM applies the same bound.
  if (
    /^(?:us\.)?amazon\.nova-(?:(?:2-)?lite|pro|premier)-v\d+:\d+$/.test(
      candidate
    )
  ) {
    return candidate;
  }
  return DEFAULT_CONTENT_PLATFORM_CONFIG.imageCaptionModelId;
}

function parseRerankModelId(value: string | null | undefined): string {
  return value?.trim() === "cohere.rerank-v3-5:0"
    ? value.trim()
    : DEFAULT_CONTENT_PLATFORM_CONFIG.retrievalRerankModelId;
}

function parseVisualEmbeddingModelId(value: string | null | undefined): string {
  return value?.trim() === "cohere.embed-v4:0"
    ? value.trim()
    : DEFAULT_CONTENT_PLATFORM_CONFIG.visualEmbeddingModelId;
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
    maxImageSizeMb: parseBoundedInteger(
      raw[keys.maxImageSizeMb],
      DEFAULT_CONTENT_PLATFORM_CONFIG.maxImageSizeMb,
      1,
      500
    ),
    maxMediaHours: parseBoundedInteger(
      raw[keys.maxMediaHours],
      DEFAULT_CONTENT_PLATFORM_CONFIG.maxMediaHours,
      1,
      4
    ),
    malwareScanRequired: parseBoolean(
      raw[keys.malwareScanRequired],
      DEFAULT_CONTENT_PLATFORM_CONFIG.malwareScanRequired
    ),
    ocrStrategy: parseOcrStrategy(raw[keys.ocrStrategy]),
    imageCaptionModelId: parseImageCaptionModelId(raw[keys.imageCaptionModelId]),
    visualIndexEnabled: parseBoolean(
      raw[keys.visualIndexEnabled],
      DEFAULT_CONTENT_PLATFORM_CONFIG.visualIndexEnabled
    ),
    retrievalRerankEnabled: parseBoolean(
      raw[keys.retrievalRerankEnabled],
      DEFAULT_CONTENT_PLATFORM_CONFIG.retrievalRerankEnabled
    ),
    retrievalRerankModelId: parseRerankModelId(
      raw[keys.retrievalRerankModelId]
    ),
    retrievalCandidateLimit: parseBoundedInteger(
      raw[keys.retrievalCandidateLimit],
      DEFAULT_CONTENT_PLATFORM_CONFIG.retrievalCandidateLimit,
      10,
      100
    ),
    retrievalNeighborCount: parseBoundedInteger(
      raw[keys.retrievalNeighborCount],
      DEFAULT_CONTENT_PLATFORM_CONFIG.retrievalNeighborCount,
      0,
      3
    ),
    retrievalContextTokens: parseBoundedInteger(
      raw[keys.retrievalContextTokens],
      DEFAULT_CONTENT_PLATFORM_CONFIG.retrievalContextTokens,
      500,
      32_000
    ),
    retrievalRrfK: parseBoundedInteger(
      raw[keys.retrievalRrfK],
      DEFAULT_CONTENT_PLATFORM_CONFIG.retrievalRrfK,
      1,
      200
    ),
    retrievalMaxPerSource: parseBoundedInteger(
      raw[keys.retrievalMaxPerSource],
      DEFAULT_CONTENT_PLATFORM_CONFIG.retrievalMaxPerSource,
      1,
      20
    ),
    visualEmbeddingModelId: parseVisualEmbeddingModelId(
      raw[keys.visualEmbeddingModelId]
    ),
    visualEmbeddingDimensions: parseBoundedInteger(
      raw[keys.visualEmbeddingDimensions],
      DEFAULT_CONTENT_PLATFORM_CONFIG.visualEmbeddingDimensions,
      1536,
      1536
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
