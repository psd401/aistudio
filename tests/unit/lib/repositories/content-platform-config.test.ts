/** @jest-environment node */

import {
  DEFAULT_CONTENT_PLATFORM_CONFIG,
  isCanonicalRepositoryUploadActive,
  isContentDualWriteActive,
  isContentReadV2Active,
  parseContentPlatformConfig,
} from "@/lib/repositories/content-platform/config";

describe("content platform configuration", () => {
  it("uses safe defaults when settings are absent", () => {
    expect(parseContentPlatformConfig({})).toEqual(
      DEFAULT_CONTENT_PLATFORM_CONFIG
    );
  });

  it("parses valid administrator settings", () => {
    expect(
      parseContentPlatformConfig({
        CONTENT_PLATFORM_ENABLED: "true",
        CONTENT_DUAL_WRITE_ENABLED: "true",
        CONTENT_READ_V2_ENABLED: "true",
        NEXUS_ATTACHMENT_RETENTION_DAYS: "45",
        CONTENT_DELETION_GRACE_DAYS: "14",
        CONTENT_MAX_FILE_SIZE_GB: "20",
        CONTENT_MAX_PDF_SIZE_MB: "250",
        CONTENT_MAX_OFFICE_SIZE_MB: "80",
        CONTENT_MAX_IMAGE_SIZE_MB: "40",
        CONTENT_MAX_MEDIA_HOURS: "8",
        CONTENT_MALWARE_SCAN_REQUIRED: "false",
        CONTENT_OCR_STRATEGY: "textract",
        CONTENT_IMAGE_CAPTION_MODEL_ID: "us.amazon.nova-pro-v1:0",
        CONTENT_VISUAL_INDEX_ENABLED: "true",
        GOOGLE_CONTENT_SYNC_ENABLED: "true",
        GOOGLE_CONTENT_SYNC_INTERVAL_MINUTES: "30",
      })
    ).toEqual({
      enabled: true,
      dualWriteEnabled: true,
      readV2Enabled: true,
      nexusAttachmentRetentionDays: 45,
      deletionGraceDays: 14,
      maxFileSizeGb: 20,
      maxPdfSizeMb: 250,
      maxOfficeSizeMb: 80,
      maxImageSizeMb: 40,
      maxMediaHours: 8,
      malwareScanRequired: false,
      ocrStrategy: "textract",
      imageCaptionModelId: "us.amazon.nova-pro-v1:0",
      visualIndexEnabled: true,
      googleSyncEnabled: true,
      googleSyncIntervalMinutes: 30,
    });
  });

  it("falls back for malformed and out-of-bounds values", () => {
    const parsed = parseContentPlatformConfig({
      CONTENT_PLATFORM_ENABLED: "yes",
      NEXUS_ATTACHMENT_RETENTION_DAYS: "0",
      CONTENT_DELETION_GRACE_DAYS: "366",
      CONTENT_MAX_FILE_SIZE_GB: "1.5",
      CONTENT_MAX_PDF_SIZE_MB: "501",
      CONTENT_MAX_OFFICE_SIZE_MB: "0",
      CONTENT_MAX_IMAGE_SIZE_MB: "501",
      CONTENT_MAX_MEDIA_HOURS: "25",
      CONTENT_OCR_STRATEGY: "unknown",
      CONTENT_IMAGE_CAPTION_MODEL_ID: "anthropic.claude-haiku",
      GOOGLE_CONTENT_SYNC_INTERVAL_MINUTES: "0",
    });

    expect(parsed).toEqual(DEFAULT_CONTENT_PLATFORM_CONFIG);
  });

  it("requires the master flag for read and dual-write rollout", () => {
    const childFlagsOnly = {
      ...DEFAULT_CONTENT_PLATFORM_CONFIG,
      enabled: false,
      dualWriteEnabled: true,
      readV2Enabled: true,
    };
    expect(isContentDualWriteActive(childFlagsOnly)).toBe(false);
    expect(isContentReadV2Active(childFlagsOnly)).toBe(false);
    expect(isCanonicalRepositoryUploadActive(childFlagsOnly)).toBe(false);

    const enabled = { ...childFlagsOnly, enabled: true };
    expect(isContentDualWriteActive(enabled)).toBe(true);
    expect(isContentReadV2Active(enabled)).toBe(true);
    expect(isCanonicalRepositoryUploadActive(enabled)).toBe(true);
  });
});
