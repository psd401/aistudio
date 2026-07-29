/** @jest-environment node */

import type { NextRequest } from "next/server";

const mockRequireScope = jest.fn();
const mockParseRequestBody = jest.fn();
const mockCreateApiResponse = jest.fn();
const mockCreateErrorResponse = jest.fn();
const mockCanModifyUserManagedDurableRepository = jest.fn();
const mockGetContentPlatformConfig = jest.fn();
const mockIsCanonicalRepositoryUploadActive = jest.fn();
const mockValidateRepositoryUploadFile = jest.fn();
const mockInitiateRepositoryUpload = jest.fn();
const mockCompleteRepositoryUpload = jest.fn();
const mockDispatchContentProcessingJob = jest.fn();
const mockInfo = jest.fn();
const mockWarn = jest.fn();
const mockError = jest.fn();

jest.mock("@/lib/api", () => ({
  withApiAuth: (handler: unknown) => handler,
  requireScope: (...args: unknown[]) => mockRequireScope(...args),
  parseRequestBody: (...args: unknown[]) => mockParseRequestBody(...args),
  createApiResponse: (...args: unknown[]) => mockCreateApiResponse(...args),
  createErrorResponse: (...args: unknown[]) => mockCreateErrorResponse(...args),
}));

jest.mock("@/actions/repositories/repository-permissions", () => ({
  canModifyUserManagedDurableRepository: (...args: unknown[]) =>
    mockCanModifyUserManagedDurableRepository(...args),
}));

jest.mock("@/lib/repositories/content-platform", () => {
  class TestRepositoryUploadQuotaExceededError extends Error {
    readonly code = "REPOSITORY_UPLOAD_QUOTA_EXCEEDED";
    readonly httpStatus = 429;
  }

  class TestRepositoryUploadCompletionError extends Error {
    readonly code = "UPLOAD_COMPLETION_FAILED";
    readonly httpStatus = 400;

    constructor(
      readonly failure: string,
      message: string,
    ) {
      super(message);
    }
  }

  return {
    getContentPlatformConfig: (...args: unknown[]) =>
      mockGetContentPlatformConfig(...args),
    isCanonicalRepositoryUploadActive: (...args: unknown[]) =>
      mockIsCanonicalRepositoryUploadActive(...args),
    validateRepositoryUploadFile: (...args: unknown[]) =>
      mockValidateRepositoryUploadFile(...args),
    initiateRepositoryUpload: (...args: unknown[]) =>
      mockInitiateRepositoryUpload(...args),
    completeRepositoryUpload: (...args: unknown[]) =>
      mockCompleteRepositoryUpload(...args),
    dispatchContentProcessingJob: (...args: unknown[]) =>
      mockDispatchContentProcessingJob(...args),
    RepositoryUploadQuotaExceededError: TestRepositoryUploadQuotaExceededError,
    RepositoryUploadCompletionError: TestRepositoryUploadCompletionError,
  };
});

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: mockInfo,
    warn: mockWarn,
    error: mockError,
  }),
}));

import { POST as initiateUpload } from "@/app/api/v1/repositories/[id]/items/uploads/route";
import { POST as completeUpload } from "@/app/api/v1/repositories/[id]/items/uploads/[sessionId]/complete/route";
import {
  RepositoryUploadCompletionError,
  RepositoryUploadQuotaExceededError,
} from "@/lib/repositories/content-platform";
import { API_SCOPES, ROLE_SCOPES } from "@/lib/api-keys/scopes";

interface RouteAuth {
  userId: number;
  cognitoSub: string;
  scopes: string[];
}

interface RouteParams {
  id?: string;
  sessionId?: string;
}

type RouteHandler = (
  request: NextRequest,
  auth: RouteAuth,
  requestId: string,
  params: RouteParams,
) => Promise<unknown>;

const initiateHandler = initiateUpload as unknown as RouteHandler;
const completeHandler = completeUpload as unknown as RouteHandler;
const request = {} as NextRequest;
const auth: RouteAuth = {
  userId: 42,
  cognitoSub: "user-sub",
  scopes: ["repositories:write"],
};
const sessionId = "11111111-2222-4333-8444-555555555555";
const initiateInput = {
  itemName: "District policy",
  fileName: "district-policy.pdf",
  contentType: "application/pdf",
  byteSize: 1024,
};
const config = { enabled: true, maxFileSizeGb: 1 };

function expectBoundedRequestBody(requestId: string): void {
  expect(mockParseRequestBody).toHaveBeenCalledWith(
    request,
    expect.anything(),
    requestId,
    { maximumBytes: 128 * 1024 },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireScope.mockReturnValue(null);
  mockParseRequestBody.mockResolvedValue({ data: initiateInput });
  mockCreateApiResponse.mockImplementation(
    (body: unknown, _requestId: string, status = 200) => ({
      body,
      status,
      headers: { set: jest.fn() },
    }),
  );
  mockCreateErrorResponse.mockImplementation(
    (requestId: string, status: number, code: string, message: string) => ({
      requestId,
      status,
      code,
      message,
    }),
  );
  mockCanModifyUserManagedDurableRepository.mockResolvedValue(true);
  mockGetContentPlatformConfig.mockResolvedValue(config);
  mockIsCanonicalRepositoryUploadActive.mockReturnValue(true);
  mockValidateRepositoryUploadFile.mockReturnValue(undefined);
  mockInitiateRepositoryUpload.mockResolvedValue({
    sessionId,
    objectKey: "repositories/7/source.pdf",
    uploadMethod: "single",
    uploadUrl: "https://upload.example/signed",
    expiresAt: "2026-07-29T01:00:00.000Z",
  });
  mockCompleteRepositoryUpload.mockResolvedValue({
    itemId: 91,
    itemVersionId: "22222222-3333-4444-8555-666666666666",
    processingJobId: "77777777-8888-4999-8aaa-bbbbbbbbbbbb",
    replayed: false,
  });
  mockDispatchContentProcessingJob.mockResolvedValue(undefined);
});

describe("repository write API scope", () => {
  it("is available to staff and administrators but not students", () => {
    expect(API_SCOPES["repositories:write"]).toBe(
      "Add items to repositories the API principal can modify",
    );
    expect(ROLE_SCOPES.staff).toContain("repositories:write");
    expect(ROLE_SCOPES.administrator).toContain("repositories:write");
    expect(ROLE_SCOPES.student).not.toContain("repositories:write");
  });
});

describe("POST /api/v1/repositories/{id}/items/uploads", () => {
  it("requires repositories:write before parsing or calling upload services", async () => {
    const denied = { status: 403 };
    mockRequireScope.mockReturnValue(denied);

    const response = await initiateHandler(request, auth, "req-denied", {
      id: "7",
    });

    expect(response).toBe(denied);
    expect(mockRequireScope).toHaveBeenCalledWith(
      auth,
      "repositories:write",
      "req-denied",
    );
    expect(mockParseRequestBody).not.toHaveBeenCalled();
    expect(mockInitiateRepositoryUpload).not.toHaveBeenCalled();
  });

  it("uses the API key owner and canonical upload service", async () => {
    await initiateHandler(request, auth, "req-initiate", { id: "7" });

    expect(mockCanModifyUserManagedDurableRepository).toHaveBeenCalledWith(
      7,
      auth.userId,
    );
    expectBoundedRequestBody("req-initiate");
    expect(mockValidateRepositoryUploadFile).toHaveBeenCalledWith(
      initiateInput,
      config,
    );
    expect(mockInitiateRepositoryUpload).toHaveBeenCalledWith(
      {
        repositoryId: 7,
        userId: auth.userId,
        ...initiateInput,
      },
      config,
    );
    expect(mockCreateApiResponse).toHaveBeenCalledWith(
      {
        data: expect.objectContaining({ sessionId, uploadMethod: "single" }),
        meta: { requestId: "req-initiate" },
      },
      "req-initiate",
      201,
    );
  });

  it("rejects malformed repository ids before parsing the body", async () => {
    await initiateHandler(request, auth, "req-path", { id: "not-a-number" });

    expect(mockCreateErrorResponse).toHaveBeenCalledWith(
      "req-path",
      400,
      "VALIDATION_ERROR",
      "Invalid repository id",
    );
    expect(mockParseRequestBody).not.toHaveBeenCalled();
  });

  it("masks absent, foreign, ephemeral, inactive, and system repositories", async () => {
    mockCanModifyUserManagedDurableRepository.mockResolvedValue(false);

    await initiateHandler(request, auth, "req-hidden", { id: "7" });

    expect(mockCreateErrorResponse).toHaveBeenCalledWith(
      "req-hidden",
      404,
      "NOT_FOUND",
      "Repository not found",
    );
    expect(mockParseRequestBody).not.toHaveBeenCalled();
    expect(mockInitiateRepositoryUpload).not.toHaveBeenCalled();
  });

  it("reports repository lookup failures instead of silently returning 404", async () => {
    mockCanModifyUserManagedDurableRepository.mockRejectedValue(
      new Error("database unavailable"),
    );

    await initiateHandler(request, auth, "req-access-failure", { id: "7" });

    expect(mockCreateErrorResponse).toHaveBeenCalledWith(
      "req-access-failure",
      500,
      "INTERNAL_ERROR",
      "Failed to initiate repository upload",
    );
    expect(mockParseRequestBody).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledWith(
      "Failed to initiate repository upload via API",
      expect.objectContaining({ error: "database unavailable" }),
    );
  });

  it("returns canonical validation errors without creating a session", async () => {
    mockValidateRepositoryUploadFile.mockImplementation(() => {
      throw new Error("The canonical processor accepts supported files only");
    });

    await initiateHandler(request, auth, "req-invalid", { id: "7" });

    expect(mockCreateErrorResponse).toHaveBeenCalledWith(
      "req-invalid",
      400,
      "VALIDATION_ERROR",
      "The canonical processor accepts supported files only",
    );
    expect(mockInitiateRepositoryUpload).not.toHaveBeenCalled();
  });

  it("maps upload quota exhaustion to a stable 429 response", async () => {
    mockInitiateRepositoryUpload.mockRejectedValue(
      new RepositoryUploadQuotaExceededError("active-session-count"),
    );

    await initiateHandler(request, auth, "req-quota", { id: "7" });

    expect(mockCreateErrorResponse).toHaveBeenCalledWith(
      "req-quota",
      429,
      "REPOSITORY_UPLOAD_QUOTA_EXCEEDED",
      "Repository upload quota exceeded",
    );
  });

  it("returns 503 when canonical repository uploads are disabled", async () => {
    mockIsCanonicalRepositoryUploadActive.mockReturnValue(false);

    await initiateHandler(request, auth, "req-disabled", { id: "7" });

    expect(mockCreateErrorResponse).toHaveBeenCalledWith(
      "req-disabled",
      503,
      "UPLOAD_UNAVAILABLE",
      "Canonical repository uploads are not available",
    );
    expect(mockInitiateRepositoryUpload).not.toHaveBeenCalled();
  });

  it("maps unexpected storage failures to a non-disclosing 500", async () => {
    mockInitiateRepositoryUpload.mockRejectedValue("storage unavailable");

    await initiateHandler(request, auth, "req-storage", { id: "7" });

    expect(mockCreateErrorResponse).toHaveBeenCalledWith(
      "req-storage",
      500,
      "INTERNAL_ERROR",
      "Failed to initiate repository upload",
    );
    expect(mockError).toHaveBeenCalledWith(
      "Failed to initiate repository upload via API",
      expect.objectContaining({ error: "storage unavailable" }),
    );
  });
});

describe("POST /api/v1/repositories/{id}/items/uploads/{sessionId}/complete", () => {
  beforeEach(() => {
    mockParseRequestBody.mockResolvedValue({ data: {} });
  });

  it("requires repositories:write before session lookup", async () => {
    const denied = { status: 403 };
    mockRequireScope.mockReturnValue(denied);

    const response = await completeHandler(request, auth, "req-denied", {
      id: "7",
      sessionId,
    });

    expect(response).toBe(denied);
    expect(mockParseRequestBody).not.toHaveBeenCalled();
    expect(mockCompleteRepositoryUpload).not.toHaveBeenCalled();
  });

  it("completes an owner-bound session and dispatches its durable job", async () => {
    await completeHandler(request, auth, "req-complete", {
      id: "7",
      sessionId,
    });

    expect(mockRequireScope).toHaveBeenCalledWith(
      auth,
      "repositories:write",
      "req-complete",
    );
    expect(mockCanModifyUserManagedDurableRepository).toHaveBeenCalledWith(
      7,
      auth.userId,
    );
    expectBoundedRequestBody("req-complete");
    expect(mockCompleteRepositoryUpload).toHaveBeenCalledWith({
      repositoryId: 7,
      userId: auth.userId,
      sessionId,
      parts: undefined,
    });
    expect(mockDispatchContentProcessingJob).toHaveBeenCalledWith({
      jobId: "77777777-8888-4999-8aaa-bbbbbbbbbbbb",
      itemVersionId: "22222222-3333-4444-8555-666666666666",
    });
    expect(mockCreateApiResponse).toHaveBeenCalledWith(
      {
        data: expect.objectContaining({ itemId: 91, replayed: false }),
        meta: { requestId: "req-complete" },
      },
      "req-complete",
    );
  });

  it("keeps completion successful when immediate job dispatch fails", async () => {
    mockDispatchContentProcessingJob.mockRejectedValue(
      new Error("dispatcher unavailable"),
    );

    await completeHandler(request, auth, "req-outbox", {
      id: "7",
      sessionId,
    });

    expect(mockCreateApiResponse).toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      "Repository upload is pending scheduled dispatch",
      expect.objectContaining({
        processingJobId: "77777777-8888-4999-8aaa-bbbbbbbbbbbb",
      }),
    );
  });

  it("marks an idempotent completion replay", async () => {
    const setHeader = jest.fn();
    mockCompleteRepositoryUpload.mockResolvedValue({
      itemId: 91,
      itemVersionId: "22222222-3333-4444-8555-666666666666",
      processingJobId: "77777777-8888-4999-8aaa-bbbbbbbbbbbb",
      replayed: true,
    });
    mockCreateApiResponse.mockReturnValue({
      status: 200,
      headers: { set: setHeader },
    });

    await completeHandler(request, auth, "req-replay", {
      id: "7",
      sessionId,
    });

    expect(setHeader).toHaveBeenCalledWith("Idempotency-Replayed", "true");
  });

  it("rejects malformed paths before parsing or completing", async () => {
    await completeHandler(request, auth, "req-path", {
      id: "7",
      sessionId: "not-a-uuid",
    });

    expect(mockCreateErrorResponse).toHaveBeenCalledWith(
      "req-path",
      400,
      "VALIDATION_ERROR",
      "Invalid upload path",
    );
    expect(mockParseRequestBody).not.toHaveBeenCalled();
    expect(mockCompleteRepositoryUpload).not.toHaveBeenCalled();
  });

  it("masks repositories the caller cannot currently modify", async () => {
    mockCanModifyUserManagedDurableRepository.mockResolvedValue(false);

    await completeHandler(request, auth, "req-hidden", {
      id: "7",
      sessionId,
    });

    expect(mockCreateErrorResponse).toHaveBeenCalledWith(
      "req-hidden",
      404,
      "NOT_FOUND",
      "Repository not found",
    );
    expect(mockParseRequestBody).not.toHaveBeenCalled();
    expect(mockCompleteRepositoryUpload).not.toHaveBeenCalled();
  });

  it("returns a stable completion error without leaking session details", async () => {
    mockCompleteRepositoryUpload.mockRejectedValue(
      new RepositoryUploadCompletionError(
        "session-not-found",
        "Upload session was not found",
      ),
    );

    await completeHandler(request, auth, "req-failed", {
      id: "7",
      sessionId,
    });

    expect(mockCreateErrorResponse).toHaveBeenCalledWith(
      "req-failed",
      400,
      "UPLOAD_COMPLETION_FAILED",
      "Failed to complete repository upload",
    );
  });

  it("maps unexpected storage or database failures to a retryable 500", async () => {
    mockCompleteRepositoryUpload.mockRejectedValue(
      new Error("storage unavailable"),
    );

    await completeHandler(request, auth, "req-storage", {
      id: "7",
      sessionId,
    });

    expect(mockCreateErrorResponse).toHaveBeenCalledWith(
      "req-storage",
      500,
      "INTERNAL_ERROR",
      "Failed to complete repository upload",
    );
    expect(mockError).toHaveBeenCalledWith(
      "Failed to complete repository upload via API",
      expect.objectContaining({ error: "storage unavailable" }),
    );
  });
});
