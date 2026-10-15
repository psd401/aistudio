/** @jest-environment node */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockUpdateRepositoryItemStatus =
  jest.fn<(...a: unknown[]) => Promise<void>>();
const mockDispatchContentProcessingJob =
  jest.fn<(...a: unknown[]) => Promise<void>>();

jest.mock("server-only", () => ({}));
jest.mock("@/lib/db/drizzle", () => ({
  getRepositoryItemById: jest.fn(),
  updateRepositoryItemStatus: mockUpdateRepositoryItemStatus,
}));
jest.mock("@/lib/db/drizzle-client", () => ({
  executeTransaction: jest.fn(),
  repositoryItemChunks: {},
  repositoryItems: {},
}));
jest.mock("@/lib/repositories/content-platform", () => ({
  dispatchContentProcessingJob: mockDispatchContentProcessingJob,
  registerCanonicalText: jest.fn(),
  registerCanonicalTextIfEnabled: jest.fn(),
}));
jest.mock("@/lib/repositories/content-platform/config", () => ({
  getContentPlatformConfig: jest.fn(),
  isCanonicalRepositoryUploadActive: jest.fn(),
}));
jest.mock("@/lib/logger", () => ({ createLogger: jest.fn() }));

import type { CanonicalShadowWriteRegistrars } from "@/lib/repositories/repository-write-service";
import type { createLogger } from "@/lib/logger";

type Log = ReturnType<typeof createLogger>;
type Registration = { version: { id: string }; inspectJob: { id: string }; created: boolean };

const registration: Registration = {
  version: { id: "version-1" },
  inspectJob: { id: "job-1" },
  created: true,
};

function makeLog() {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { log, asLog: log as unknown as Log };
}

function makeRegistrars() {
  const register = jest.fn<(input: { itemId: number }) => Promise<Registration>>();
  const registerIfEnabled =
    jest.fn<(input: { itemId: number }) => Promise<Registration | null>>();
  const registrars = {
    register,
    registerIfEnabled,
    logNoun: "widget",
  } as unknown as CanonicalShadowWriteRegistrars<{ itemId: number }>;
  return { register, registerIfEnabled, registrars };
}

async function shadowWriteCanonical(
  ...args: Parameters<
    typeof import("@/lib/repositories/repository-write-service").shadowWriteCanonical<{ itemId: number }>
  >
): Promise<void> {
  const service = await import("@/lib/repositories/repository-write-service");
  return service.shadowWriteCanonical(...args);
}

describe("shadowWriteCanonical", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateRepositoryItemStatus.mockResolvedValue(undefined);
    mockDispatchContentProcessingJob.mockResolvedValue(undefined);
  });

  it("uses the rollout-gated registrar before cutover and stops when it is disabled", async () => {
    const { register, registerIfEnabled, registrars } = makeRegistrars();
    registerIfEnabled.mockResolvedValue(null);
    const { asLog } = makeLog();

    await shadowWriteCanonical({ itemId: 5 }, registrars, asLog);

    expect(registerIfEnabled).toHaveBeenCalledWith({ itemId: 5 });
    expect(register).not.toHaveBeenCalled();
    expect(mockUpdateRepositoryItemStatus).not.toHaveBeenCalled();
    expect(mockDispatchContentProcessingJob).not.toHaveBeenCalled();
  });

  it("uses the unconditional registrar after cutover, resets to pending, and dispatches", async () => {
    const { register, registerIfEnabled, registrars } = makeRegistrars();
    register.mockResolvedValue(registration);
    const { log, asLog } = makeLog();

    await shadowWriteCanonical({ itemId: 5 }, registrars, asLog, true);

    expect(register).toHaveBeenCalledWith({ itemId: 5 });
    expect(registerIfEnabled).not.toHaveBeenCalled();
    expect(mockUpdateRepositoryItemStatus).toHaveBeenCalledWith(5, "pending", null);
    expect(mockDispatchContentProcessingJob).toHaveBeenCalledWith({
      jobId: "job-1",
      itemVersionId: "version-1",
    });
    expect(log.info).toHaveBeenCalledWith(
      "Canonical widget version registered",
      expect.objectContaining({ itemId: 5, versionId: "version-1" })
    );
  });

  it("only warns when dispatch fails, leaving the item pending for scheduled dispatch", async () => {
    const { register, registrars } = makeRegistrars();
    register.mockResolvedValue(registration);
    mockDispatchContentProcessingJob.mockRejectedValue(new Error("queue down"));
    const { log, asLog } = makeLog();

    await expect(
      shadowWriteCanonical({ itemId: 5 }, registrars, asLog, true)
    ).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      "Canonical widget processing is pending scheduled dispatch",
      { processingJobId: "job-1", error: "queue down" }
    );
    expect(mockUpdateRepositoryItemStatus).toHaveBeenCalledTimes(1);
    expect(mockUpdateRepositoryItemStatus).toHaveBeenCalledWith(5, "pending", null);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("marks the item failed when registration throws, without rethrowing", async () => {
    const { register, registrars } = makeRegistrars();
    register.mockRejectedValue(new Error("s3 down"));
    const { log, asLog } = makeLog();

    await expect(
      shadowWriteCanonical({ itemId: 5 }, registrars, asLog, true)
    ).resolves.toBeUndefined();

    expect(mockUpdateRepositoryItemStatus).toHaveBeenCalledWith(
      5,
      "failed",
      "Canonical content registration failed. Retry this item."
    );
    expect(mockDispatchContentProcessingJob).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith("Canonical widget shadow write failed", {
      itemId: 5,
      error: "s3 down",
    });
  });

  it("logs, not throws, when the failed-status write itself fails", async () => {
    const { register, registrars } = makeRegistrars();
    register.mockRejectedValue(new Error("s3 down"));
    mockUpdateRepositoryItemStatus.mockRejectedValue(new Error("db down"));
    const { log, asLog } = makeLog();

    await expect(
      shadowWriteCanonical({ itemId: 5 }, registrars, asLog, true)
    ).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledWith(
      "Failed to expose canonical widget registration failure",
      { itemId: 5, error: "db down" }
    );
    expect(log.error).toHaveBeenCalledWith("Canonical widget shadow write failed", {
      itemId: 5,
      error: "s3 down",
    });
  });
});
