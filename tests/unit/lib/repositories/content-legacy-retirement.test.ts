/** @jest-environment node */

import { executeTransaction } from "@/lib/db/drizzle-client";
import {
  DEFAULT_CONTENT_PLATFORM_CONFIG,
  getContentPlatformConfig,
} from "@/lib/repositories/content-platform/config";
import { isLegacyContentRetirementActive } from "@/lib/repositories/content-platform/legacy-retirement";

jest.mock("@/lib/db/drizzle-client", () => ({
  executeTransaction: jest.fn(),
  toPgRows: (value: unknown) => value,
}));

jest.mock("@/lib/repositories/content-platform/config", () => {
  const actual = jest.requireActual(
    "@/lib/repositories/content-platform/config",
  ) as typeof import("@/lib/repositories/content-platform/config");
  return {
    ...actual,
    getContentPlatformConfig: jest.fn(),
  };
});

const mockExecuteTransaction = executeTransaction as jest.MockedFunction<
  typeof executeTransaction
>;
const mockGetContentPlatformConfig =
  getContentPlatformConfig as jest.MockedFunction<
    typeof getContentPlatformConfig
  >;

describe("legacy content retirement route gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not query migration relations while retirement is disabled", async () => {
    mockGetContentPlatformConfig.mockResolvedValue({
      ...DEFAULT_CONTENT_PLATFORM_CONFIG,
      enabled: true,
      readV2Enabled: true,
    });

    await expect(isLegacyContentRetirementActive()).resolves.toBe(false);
    expect(mockExecuteTransaction).not.toHaveBeenCalled();
  });

  it("fails closed when migration 155 relations are not present", async () => {
    mockGetContentPlatformConfig.mockResolvedValue({
      ...DEFAULT_CONTENT_PLATFORM_CONFIG,
      legacyRetirementEnabled: true,
    });
    const execute = jest
      .fn()
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([
        {
          document_chunks_present: true,
          documents_present: true,
          migration_items_present: false,
          migration_runs_present: false,
          retirement_events_present: false,
        },
      ]);
    mockExecuteTransaction.mockImplementation(async (callback) =>
      callback({ execute } as never),
    );

    await expect(isLegacyContentRetirementActive()).resolves.toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
