const mockGetSettingValue = jest.fn();

jest.mock("@/lib/db/drizzle", () => ({
  getSettingValue: (...args: unknown[]) => mockGetSettingValue(...args),
}));

jest.mock("@/lib/logger", () => ({
  __esModule: true,
  default: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("@/lib/aws/s3-client", () => ({
  clearS3Cache: jest.fn(),
}));

import {
  getSetting,
  revalidateSettingsCache,
  Settings,
} from "@/lib/settings-manager";

describe("Settings.getS3", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockGetSettingValue.mockResolvedValue(null);
    delete process.env.S3_BUCKET;
    delete process.env.DOCUMENTS_BUCKET_NAME;
    delete process.env.AWS_REGION;
    delete process.env.NEXT_PUBLIC_AWS_REGION;
    await revalidateSettingsCache();
  });

  it("uses database-first storage settings", async () => {
    mockGetSettingValue.mockImplementation((key: string) =>
      Promise.resolve(
        {
          S3_BUCKET: "database-documents",
          AWS_REGION: "us-west-2",
        }[key] ?? null
      )
    );

    await expect(Settings.getS3()).resolves.toEqual({
      bucket: "database-documents",
      region: "us-west-2",
    });
    expect(mockGetSettingValue).not.toHaveBeenCalledWith("DOCUMENTS_BUCKET_NAME");
    expect(mockGetSettingValue).not.toHaveBeenCalledWith("NEXT_PUBLIC_AWS_REGION");
  });

  it("falls back to infrastructure environment values when database settings are empty", async () => {
    process.env.DOCUMENTS_BUCKET_NAME = "environment-documents";
    process.env.NEXT_PUBLIC_AWS_REGION = "us-east-2";

    await expect(Settings.getS3()).resolves.toEqual({
      bucket: "environment-documents",
      region: "us-east-2",
    });
  });

  it("does not let an invalidated background refresh overwrite a newer value", async () => {
    jest.useFakeTimers({ now: new Date("2026-08-02T00:00:00.000Z") });
    let resolveStaleRefresh: ((value: string | null) => void) | undefined;
    try {
      mockGetSettingValue.mockReset();
      mockGetSettingValue.mockResolvedValueOnce("false");
      await expect(getSetting("CONTENT_RETRIEVAL_SHADOW_ENABLED")).resolves.toBe(
        "false",
      );

      jest.advanceTimersByTime(5 * 60 * 1000 + 1);
      mockGetSettingValue.mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            resolveStaleRefresh = resolve;
          }),
      );
      await expect(getSetting("CONTENT_RETRIEVAL_SHADOW_ENABLED")).resolves.toBe(
        "false",
      );

      await revalidateSettingsCache("CONTENT_RETRIEVAL_SHADOW_ENABLED");
      mockGetSettingValue.mockResolvedValueOnce("true");
      await expect(getSetting("CONTENT_RETRIEVAL_SHADOW_ENABLED")).resolves.toBe(
        "true",
      );

      resolveStaleRefresh?.("false");
      await Promise.resolve();
      await Promise.resolve();
      await expect(getSetting("CONTENT_RETRIEVAL_SHADOW_ENABLED")).resolves.toBe(
        "true",
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
