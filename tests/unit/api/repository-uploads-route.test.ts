/** @jest-environment node */

import { NextRequest } from "next/server";

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: jest.fn(),
}));
jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: jest.fn(),
}));
jest.mock("@/actions/repositories/repository-permissions", () => ({
  getUserIdFromSession: jest.fn(),
  canModifyRepository: jest.fn(),
}));
jest.mock("@/lib/repositories/repository-access-guard", () => ({
  assertNotSystemManagedRepository: jest.fn(),
}));
jest.mock("@/lib/repositories/content-platform", () => ({
  getContentPlatformConfig: jest.fn(),
  isCanonicalRepositoryUploadActive: jest.fn(),
  initiateRepositoryUpload: jest.fn(),
  completeRepositoryUpload: jest.fn(),
  dispatchContentProcessingJob: jest.fn(),
}));
jest.mock("@/lib/logger", () => ({
  createLogger: jest.fn(),
  generateRequestId: () => "request-1",
  startTimer: () => jest.fn(),
}));

import { getServerSession } from "@/lib/auth/server-session";
import { hasCapabilityAccess } from "@/utils/roles";
import {
  canModifyRepository,
  getUserIdFromSession,
} from "@/actions/repositories/repository-permissions";
import { assertNotSystemManagedRepository } from "@/lib/repositories/repository-access-guard";
import {
  completeRepositoryUpload,
  dispatchContentProcessingJob,
  getContentPlatformConfig,
  initiateRepositoryUpload,
  isCanonicalRepositoryUploadActive,
} from "@/lib/repositories/content-platform";
import { createLogger } from "@/lib/logger";
import { DEFAULT_CONTENT_PLATFORM_CONFIG } from "@/lib/repositories/content-platform/config";
import { POST as initiateUpload } from "@/app/api/repositories/[repositoryId]/uploads/route";
import { POST as completeUpload } from "@/app/api/repositories/[repositoryId]/uploads/[sessionId]/complete/route";

const sessionId = "11111111-2222-4333-8444-555555555555";
const mockGetServerSession = jest.mocked(getServerSession);
const mockHasCapabilityAccess = jest.mocked(hasCapabilityAccess);
const mockGetUserIdFromSession = jest.mocked(getUserIdFromSession);
const mockCanModifyRepository = jest.mocked(canModifyRepository);
const mockAssertNotSystemManagedRepository = jest.mocked(
  assertNotSystemManagedRepository
);
const mockGetContentPlatformConfig = jest.mocked(getContentPlatformConfig);
const mockIsCanonicalRepositoryUploadActive = jest.mocked(
  isCanonicalRepositoryUploadActive
);
const mockInitiateRepositoryUpload = jest.mocked(initiateRepositoryUpload);
const mockCompleteRepositoryUpload = jest.mocked(completeRepositoryUpload);
const mockDispatchContentProcessingJob = jest.mocked(
  dispatchContentProcessingJob
);
const mockCreateLogger = jest.mocked(createLogger);
const mockWarn = jest.fn();

function request(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("canonical repository upload routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateLogger.mockReturnValue(
      {
        info: jest.fn(),
        debug: jest.fn(),
        warn: mockWarn,
        error: jest.fn(),
      } as unknown as ReturnType<typeof createLogger>
    );
    mockGetServerSession.mockResolvedValue({ sub: "user-sub" });
    mockHasCapabilityAccess.mockResolvedValue(true);
    mockGetUserIdFromSession.mockResolvedValue(42);
    mockCanModifyRepository.mockResolvedValue(true);
    mockAssertNotSystemManagedRepository.mockResolvedValue(undefined);
    mockGetContentPlatformConfig.mockResolvedValue({
      ...DEFAULT_CONTENT_PLATFORM_CONFIG,
      enabled: true,
    });
    mockIsCanonicalRepositoryUploadActive.mockReturnValue(true);
    mockInitiateRepositoryUpload.mockResolvedValue({
      sessionId,
      objectKey: `repositories/7/${sessionId}/handbook.pdf`,
      uploadMethod: "single",
      uploadUrl: "https://upload.example.test",
      expiresAt: "2026-07-21T12:00:00.000Z",
    });
    mockCompleteRepositoryUpload.mockResolvedValue({
      itemId: 9,
      itemVersionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      processingJobId: "ffffffff-1111-4222-8333-444444444444",
      replayed: false,
    });
    mockDispatchContentProcessingJob.mockResolvedValue(undefined);
  });

  test("requires authentication and capability before initiating", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const response = await initiateUpload(
      request("http://localhost/api/repositories/7/uploads", {}),
      { params: Promise.resolve({ repositoryId: "7" }) }
    );
    expect(response.status).toBe(401);
    expect(mockInitiateRepositoryUpload).not.toHaveBeenCalled();

    mockGetServerSession.mockResolvedValue({ sub: "user-sub" });
    mockHasCapabilityAccess.mockResolvedValue(false);
    const forbidden = await initiateUpload(
      request("http://localhost/api/repositories/7/uploads", {}),
      { params: Promise.resolve({ repositoryId: "7" }) }
    );
    expect(forbidden.status).toBe(403);
    expect(mockInitiateRepositoryUpload).not.toHaveBeenCalled();
  });

  test("does not reveal repositories the caller cannot modify", async () => {
    mockCanModifyRepository.mockResolvedValue(false);
    const response = await initiateUpload(
      request("http://localhost/api/repositories/7/uploads", {
        itemName: "Handbook",
        fileName: "handbook.pdf",
        contentType: "application/pdf",
        byteSize: 1024,
      }),
      { params: Promise.resolve({ repositoryId: "7" }) }
    );
    expect(response.status).toBe(404);
    expect(mockInitiateRepositoryUpload).not.toHaveBeenCalled();
  });

  test("keeps legacy behavior behind rollout gates and for non-PDF files", async () => {
    mockIsCanonicalRepositoryUploadActive.mockReturnValue(false);
    const gated = await initiateUpload(
      request("http://localhost/api/repositories/7/uploads", {
        itemName: "Handbook",
        fileName: "handbook.pdf",
        contentType: "application/pdf",
        byteSize: 1024,
      }),
      { params: Promise.resolve({ repositoryId: "7" }) }
    );
    expect(await gated.json()).toMatchObject({ mode: "legacy" });

    mockIsCanonicalRepositoryUploadActive.mockReturnValue(true);
    const nonPdf = await initiateUpload(
      request("http://localhost/api/repositories/7/uploads", {
        itemName: "Notes",
        fileName: "notes.txt",
        contentType: "text/plain",
        byteSize: 12,
      }),
      { params: Promise.resolve({ repositoryId: "7" }) }
    );
    expect(await nonPdf.json()).toMatchObject({ mode: "legacy" });
    expect(mockInitiateRepositoryUpload).not.toHaveBeenCalled();
  });

  test("initiates a repository-scoped canonical PDF upload", async () => {
    const response = await initiateUpload(
      request("http://localhost/api/repositories/7/uploads", {
        itemName: "Handbook",
        fileName: "handbook.pdf",
        contentType: "application/pdf",
        byteSize: 1024,
      }),
      { params: Promise.resolve({ repositoryId: "7" }) }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      mode: "canonical",
      upload: { sessionId, uploadMethod: "single" },
    });
    expect(mockInitiateRepositoryUpload).toHaveBeenCalledWith(
      {
        repositoryId: 7,
        userId: 42,
        itemName: "Handbook",
        fileName: "handbook.pdf",
        contentType: "application/pdf",
        byteSize: 1024,
      },
      { ...DEFAULT_CONTENT_PLATFORM_CONFIG, enabled: true }
    );
  });

  test("completes and dispatches the durable processing job", async () => {
    const response = await completeUpload(
      request(
        `http://localhost/api/repositories/7/uploads/${sessionId}/complete`,
        { parts: [{ ETag: '"etag-1"', PartNumber: 1 }] }
      ),
      { params: Promise.resolve({ repositoryId: "7", sessionId }) }
    );
    expect(response.status).toBe(200);
    expect(mockCompleteRepositoryUpload).toHaveBeenCalledWith({
      repositoryId: 7,
      userId: 42,
      sessionId,
      parts: [{ ETag: '"etag-1"', PartNumber: 1 }],
    });
    expect(mockDispatchContentProcessingJob).toHaveBeenCalledWith({
      jobId: "ffffffff-1111-4222-8333-444444444444",
      itemVersionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
  });

  test("accepts completion when immediate dispatch fails because the DB job is durable", async () => {
    mockDispatchContentProcessingJob.mockRejectedValue(new Error("SQS unavailable"));
    const response = await completeUpload(
      request(
        `http://localhost/api/repositories/7/uploads/${sessionId}/complete`,
        {}
      ),
      { params: Promise.resolve({ repositoryId: "7", sessionId }) }
    );
    expect(response.status).toBe(200);
    expect(mockWarn).toHaveBeenCalledWith(
      "Canonical upload is pending scheduled dispatch",
      expect.objectContaining({ error: "SQS unavailable" })
    );
  });
});
