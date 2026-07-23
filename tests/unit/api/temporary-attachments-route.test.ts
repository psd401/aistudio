/** @jest-environment node */

const mockGetServerSession = jest.fn();
const mockGetUserIdFromSession = jest.fn();
const mockGetContentPlatformConfig = jest.fn();
const mockIsCanonicalRepositoryUploadActive = jest.fn();
const mockIsCanonicalUploadContentType = jest.fn();
const mockValidateRepositoryUploadFile = jest.fn();
const mockInitiateRepositoryUpload = jest.fn();
const mockCompleteRepositoryUpload = jest.fn();
const mockDispatchContentProcessingJob = jest.fn();
const mockGetCanonicalRepositoryItemStatuses = jest.fn();
const mockGetOrCreate = jest.fn();
const mockBindConversation = jest.fn();
const mockConversationBelongsToOwner = jest.fn();
const mockDiscardRepository = jest.fn();
const mockResolveBinding = jest.fn();
const mockResolveReference = jest.fn();
const mockResolveForPromotion = jest.fn();
const mockPromoteRepository = jest.fn();
const mockHasCapabilityAccess = jest.fn();

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));
jest.mock("@/actions/repositories/repository-permissions", () => ({
  getUserIdFromSession: (...args: unknown[]) =>
    mockGetUserIdFromSession(...args),
}));
jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: (...args: unknown[]) =>
    mockHasCapabilityAccess(...args),
}));
jest.mock("@/lib/repositories/content-platform", () => ({
  getContentPlatformConfig: (...args: unknown[]) =>
    mockGetContentPlatformConfig(...args),
  isCanonicalRepositoryUploadActive: (...args: unknown[]) =>
    mockIsCanonicalRepositoryUploadActive(...args),
  isCanonicalUploadContentType: (...args: unknown[]) =>
    mockIsCanonicalUploadContentType(...args),
  validateRepositoryUploadFile: (...args: unknown[]) =>
    mockValidateRepositoryUploadFile(...args),
  initiateRepositoryUpload: (...args: unknown[]) =>
    mockInitiateRepositoryUpload(...args),
  completeRepositoryUpload: (...args: unknown[]) =>
    mockCompleteRepositoryUpload(...args),
  dispatchContentProcessingJob: (...args: unknown[]) =>
    mockDispatchContentProcessingJob(...args),
  RepositoryUploadQuotaExceededError: class extends Error {
    readonly code = "REPOSITORY_UPLOAD_QUOTA_EXCEEDED";
    readonly httpStatus = 429;
  },
  getCanonicalRepositoryItemStatuses: (...args: unknown[]) =>
    mockGetCanonicalRepositoryItemStatuses(...args),
}));
jest.mock("@/lib/nexus/ephemeral-repository-service", () => ({
  getOrCreateNexusEphemeralRepository: (...args: unknown[]) =>
    mockGetOrCreate(...args),
  bindNexusRepositoryToConversation: (...args: unknown[]) =>
    mockBindConversation(...args),
  nexusConversationBelongsToOwner: (...args: unknown[]) =>
    mockConversationBelongsToOwner(...args),
  discardNexusEphemeralRepository: (...args: unknown[]) =>
    mockDiscardRepository(...args),
  resolveNexusRepositoryBinding: (...args: unknown[]) =>
    mockResolveBinding(...args),
  resolveNexusAttachmentReference: (...args: unknown[]) =>
    mockResolveReference(...args),
  resolveNexusAttachmentForPromotion: (...args: unknown[]) =>
    mockResolveForPromotion(...args),
  promoteNexusRepository: (...args: unknown[]) =>
    mockPromoteRepository(...args),
}));
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  generateRequestId: () => "request-1",
  startTimer: () => jest.fn(),
}));
jest.mock("@/lib/rate-limit", () => ({
  apiRateLimit: {
    upload: (handler: (...args: unknown[]) => unknown) => handler,
  },
}));

import { POST } from "@/app/api/repositories/temporary-attachments/route";
import { RepositoryUploadQuotaExceededError } from "@/lib/repositories/content-platform";
import { POST as complete } from "@/app/api/repositories/temporary-attachments/[bindingId]/complete/route";
import { GET } from "@/app/api/repositories/temporary-attachments/[bindingId]/[itemId]/route";
import { POST as promote } from "@/app/api/repositories/temporary-attachments/[bindingId]/[itemId]/promote/route";

const draftKey = "123e4567-e89b-42d3-a456-426614174000";
const bindingId = "123e4567-e89b-42d3-a456-426614174001";
const conversationId = "123e4567-e89b-42d3-a456-426614174002";

function uploadRequest(options: { includeConversation?: boolean } = {}): Request {
  return new Request("http://localhost/api/repositories/temporary-attachments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      draftKey,
      purpose: "nexus",
      conversationId: options.includeConversation
        ? conversationId
        : undefined,
      fileName: "notes.txt",
      contentType: "text/plain",
      byteSize: 6,
    }),
  });
}

describe("temporary repository attachment routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    [
      mockGetServerSession,
      mockGetUserIdFromSession,
      mockGetContentPlatformConfig,
      mockIsCanonicalRepositoryUploadActive,
      mockIsCanonicalUploadContentType,
      mockValidateRepositoryUploadFile,
      mockInitiateRepositoryUpload,
      mockCompleteRepositoryUpload,
      mockDispatchContentProcessingJob,
      mockGetCanonicalRepositoryItemStatuses,
      mockGetOrCreate,
      mockBindConversation,
      mockConversationBelongsToOwner,
      mockDiscardRepository,
      mockResolveBinding,
      mockResolveReference,
      mockResolveForPromotion,
      mockPromoteRepository,
      mockHasCapabilityAccess,
    ].forEach((mock) => mock.mockReset());
    mockGetServerSession.mockResolvedValue({ sub: "user-sub" });
    mockGetUserIdFromSession.mockResolvedValue(7);
    mockGetContentPlatformConfig.mockResolvedValue({
      enabled: true,
      dualWriteEnabled: true,
      readV2Enabled: true,
      nexusAttachmentRetentionDays: 30,
      deletionGraceDays: 7,
      maxFileSizeGb: 10,
    });
    mockIsCanonicalRepositoryUploadActive.mockReturnValue(true);
    mockIsCanonicalUploadContentType.mockReturnValue(true);
    mockGetOrCreate.mockResolvedValue({
      bindingId,
      repositoryId: 11,
      created: true,
    });
    mockBindConversation.mockResolvedValue({});
    mockConversationBelongsToOwner.mockResolvedValue(true);
    mockDiscardRepository.mockResolvedValue(true);
    mockInitiateRepositoryUpload.mockResolvedValue({
      sessionId: "123e4567-e89b-42d3-a456-426614174003",
      uploadMethod: "single",
      uploadUrl: "https://storage.example/upload",
      expiresAt: "2026-07-23T10:00:00.000Z",
    });
    mockCompleteRepositoryUpload.mockResolvedValue({
      itemId: 31,
      itemVersionId: "version-1",
      processingJobId: "job-1",
      replayed: false,
    });
    mockDispatchContentProcessingJob.mockResolvedValue(undefined);
    mockGetCanonicalRepositoryItemStatuses.mockResolvedValue(
      new Map([
        [
          31,
          {
            itemId: 31,
            processingStatus: "embedded",
            processingError: null,
            canRetry: false,
          },
        ],
      ])
    );
    mockResolveReference.mockResolvedValue({
      itemId: 31,
      processingStatus: "completed",
      repositoryId: 11,
      itemName: "notes.txt",
    });
    mockResolveForPromotion.mockResolvedValue({
      processingStatus: "completed",
      repositoryId: 11,
    });
    mockResolveBinding.mockResolvedValue({
      bindingId,
      repositoryId: 11,
    });
    mockPromoteRepository.mockResolvedValue({ repositoryId: 11 });
    mockHasCapabilityAccess.mockResolvedValue(true);
  });

  it("requires authentication without requiring the Repository Manager capability", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const response = await POST(uploadRequest());

    expect(response.status).toBe(401);
    expect(mockGetOrCreate).not.toHaveBeenCalled();
  });

  it("returns the flag-off legacy mode before creating an ephemeral repository", async () => {
    mockIsCanonicalRepositoryUploadActive.mockReturnValue(false);
    const response = await POST(uploadRequest());

    expect(await response.json()).toMatchObject({ mode: "legacy" });
    expect(mockGetOrCreate).not.toHaveBeenCalled();
  });

  it("creates, optionally binds, and initiates direct canonical storage upload", async () => {
    const response = await POST(uploadRequest({ includeConversation: true }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      mode: "canonical",
      bindingId,
      repositoryId: 11,
      upload: {
        uploadMethod: "single",
        uploadUrl: "https://storage.example/upload",
      },
    });
    expect(mockGetOrCreate).toHaveBeenCalledWith({
      ownerId: 7,
      draftKey,
      policy: {
        nexusAttachmentRetentionDays: 30,
        deletionGraceDays: 7,
      },
    });
    expect(mockValidateRepositoryUploadFile).toHaveBeenCalledWith(
      {
        itemName: "notes.txt",
        fileName: "notes.txt",
        contentType: "text/plain",
        byteSize: 6,
      },
      expect.objectContaining({ enabled: true })
    );
    expect(mockConversationBelongsToOwner).toHaveBeenCalledWith({
      ownerId: 7,
      conversationId,
    });
    expect(
      mockValidateRepositoryUploadFile.mock.invocationCallOrder[0]
    ).toBeLessThan(mockGetOrCreate.mock.invocationCallOrder[0]!);
    expect(
      mockConversationBelongsToOwner.mock.invocationCallOrder[0]
    ).toBeLessThan(mockGetOrCreate.mock.invocationCallOrder[0]!);
    expect(mockBindConversation).toHaveBeenCalledWith({
      ownerId: 7,
      draftKey,
      conversationId,
    });
    expect(mockInitiateRepositoryUpload).toHaveBeenCalledWith(
      {
        repositoryId: 11,
        userId: 7,
        itemName: "notes.txt",
        fileName: "notes.txt",
        contentType: "text/plain",
        byteSize: 6,
      },
      expect.objectContaining({ enabled: true })
    );
    expect(mockDispatchContentProcessingJob).not.toHaveBeenCalled();
    expect(mockDiscardRepository).not.toHaveBeenCalled();
  });

  it("validates size and processor limits before creating repository state", async () => {
    mockValidateRepositoryUploadFile.mockImplementation(() => {
      throw new Error("internal processor detail");
    });

    const response = await POST(uploadRequest());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Temporary attachment upload failed",
    });
    expect(mockGetOrCreate).not.toHaveBeenCalled();
    expect(mockInitiateRepositoryUpload).not.toHaveBeenCalled();
  });

  it("prevalidates supplied conversation ownership before creating repository state", async () => {
    mockConversationBelongsToOwner.mockResolvedValue(false);

    const response = await POST(uploadRequest({ includeConversation: true }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Temporary attachment upload failed",
    });
    expect(mockGetOrCreate).not.toHaveBeenCalled();
    expect(mockBindConversation).not.toHaveBeenCalled();
  });

  it("compensates a newly created empty repository when initiation fails", async () => {
    mockInitiateRepositoryUpload.mockRejectedValue(
      new Error("sensitive infrastructure detail")
    );

    const response = await POST(uploadRequest());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Temporary attachment upload failed",
    });
    expect(mockDiscardRepository).toHaveBeenCalledWith({
      ownerId: 7,
      bindingId,
      repositoryId: 11,
    });
  });

  it("returns 429 and compensates when the owner storage quota is full", async () => {
    mockInitiateRepositoryUpload.mockRejectedValue(
      new RepositoryUploadQuotaExceededError("ephemeral-storage-bytes")
    );

    const response = await POST(uploadRequest());

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      error: "Temporary attachment upload quota exceeded",
      code: "REPOSITORY_UPLOAD_QUOTA_EXCEEDED",
    });
    expect(mockDiscardRepository).toHaveBeenCalledWith({
      ownerId: 7,
      bindingId,
      repositoryId: 11,
    });
  });

  it("does not discard a reused repository when initiation fails", async () => {
    mockGetOrCreate.mockResolvedValue({
      bindingId,
      repositoryId: 11,
      created: false,
    });
    mockInitiateRepositoryUpload.mockRejectedValue(new Error("upload failed"));

    const response = await POST(uploadRequest());

    expect(response.status).toBe(400);
    expect(mockDiscardRepository).not.toHaveBeenCalled();
  });

  it("completes only an owner-bound upload and dispatches processing", async () => {
    const sessionId = "123e4567-e89b-42d3-a456-426614174003";
    const response = await complete(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({
          sessionId,
          name: "caller-forged-name.txt",
        }),
      }),
      { params: Promise.resolve({ bindingId }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      mode: "canonical",
      reference: { bindingId, itemId: 31, name: "notes.txt" },
      repositoryId: 11,
      itemVersionId: "version-1",
    });
    expect(mockResolveBinding).toHaveBeenCalledWith({
      ownerId: 7,
      bindingId,
    });
    expect(mockCompleteRepositoryUpload).toHaveBeenCalledWith({
      repositoryId: 11,
      userId: 7,
      sessionId,
    });
    expect(mockDispatchContentProcessingJob).toHaveBeenCalledWith({
      jobId: "job-1",
      itemVersionId: "version-1",
    });
    expect(mockResolveReference).toHaveBeenCalledWith({
      ownerId: 7,
      bindingId,
      itemId: 31,
    });
  });

  it("masks a foreign binding before completing an upload", async () => {
    mockResolveBinding.mockResolvedValue(null);
    const response = await complete(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({
          sessionId: "123e4567-e89b-42d3-a456-426614174003",
          name: "notes.txt",
        }),
      }),
      { params: Promise.resolve({ bindingId }) }
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "Attachment not found" });
    expect(mockCompleteRepositoryUpload).not.toHaveBeenCalled();
  });

  it("masks a foreign or expired status reference", async () => {
    mockResolveReference.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ bindingId, itemId: "31" }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "Attachment not found" });
  });

  it("returns only bounded processing state for an owned reference", async () => {
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ bindingId, itemId: "31" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "embedded",
      error: null,
    });
    expect(mockResolveReference).toHaveBeenCalledWith({
      ownerId: 7,
      bindingId,
      itemId: 31,
    });
    expect(mockGetCanonicalRepositoryItemStatuses).toHaveBeenCalledWith(11);
  });

  it("does not report ready while extraction waits for active generation", async () => {
    mockGetCanonicalRepositoryItemStatuses.mockResolvedValue(
      new Map([
        [
          31,
          {
            itemId: 31,
            processingStatus: "processing_embeddings",
            processingError: null,
            canRetry: false,
          },
        ],
      ])
    );

    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ bindingId, itemId: "31" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "processing_embeddings",
      error: null,
    });
  });

  it("promotes an owned temporary repository in place", async () => {
    const response = await promote(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ name: "Permanent handbook" }),
      }),
      {
        params: Promise.resolve({ bindingId, itemId: "31" }),
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      repositoryId: 11,
      name: "Permanent handbook",
    });
    expect(mockPromoteRepository).toHaveBeenCalledWith({
      ownerId: 7,
      repositoryId: 11,
      name: "Permanent handbook",
    });
    expect(mockResolveForPromotion).toHaveBeenCalledWith({
      ownerId: 7,
      bindingId,
      itemId: 31,
    });
    expect(mockHasCapabilityAccess).toHaveBeenCalledWith(
      "knowledge-repositories",
      "user-sub"
    );
  });

  it("rejects promotion without Repository Manager capability before resolving the attachment", async () => {
    mockHasCapabilityAccess.mockResolvedValue(false);

    const response = await promote(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ name: "Permanent handbook" }),
      }),
      {
        params: Promise.resolve({ bindingId, itemId: "31" }),
      }
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "Forbidden" });
    expect(mockResolveForPromotion).not.toHaveBeenCalled();
    expect(mockPromoteRepository).not.toHaveBeenCalled();
  });
});
