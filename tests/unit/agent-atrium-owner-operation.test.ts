/** @jest-environment node */

const getUserByEmailMock = jest.fn()
const requesterForUserIdMock = jest.fn()
const assertContentAuthoringCapabilityMock = jest.fn()
const resolveCollectionIdMock = jest.fn()
const contentListMock = jest.fn()
const contentCreateMock = jest.fn()
const publishMock = jest.fn()
const auditMock = jest.fn()
const sourceReadMock = jest.fn()
const assetListMock = jest.fn()
const assetGetMock = jest.fn()
const assetReadBytesMock = jest.fn()
const assetInitiateMock = jest.fn()
const assetCompleteMock = jest.fn()

jest.mock("@/lib/db/drizzle/users", () => ({
  getUserByEmail: (...args: unknown[]) => getUserByEmailMock(...args),
}))
jest.mock("@/lib/content/requester-from-auth", () => ({
  requesterForUserId: (...args: unknown[]) => requesterForUserIdMock(...args),
}))
jest.mock("@/lib/content/surface-helpers", () => ({
  assertContentAuthoringCapability: (...args: unknown[]) =>
    assertContentAuthoringCapabilityMock(...args),
  contentDeepLink: (slug: string) => `/c/${slug}`,
  resolveCollectionId: (...args: unknown[]) => resolveCollectionIdMock(...args),
}))
jest.mock("@/lib/content", () => {
  class MockContentError extends Error {
    readonly code: string
    readonly status: number
    readonly details?: Record<string, unknown>

    constructor(
      message: string,
      code: string,
      status: number,
      details?: Record<string, unknown>
    ) {
      super(message)
      this.code = code
      this.status = status
      this.details = details
    }
  }
  class MockApprovalRequiredError extends MockContentError {
    constructor(message = "Approval required") {
      super(message, "CONTENT_APPROVAL_REQUIRED", 409)
    }
  }
  class MockForbiddenError extends MockContentError {
    constructor(message = "Forbidden") {
      super(message, "CONTENT_FORBIDDEN", 403)
    }
  }
  class MockValidationError extends MockContentError {
    constructor(message = "Invalid", details?: Record<string, unknown>) {
      super(message, "VALIDATION_ERROR", 400, details)
    }
  }
  return {
    ApprovalRequiredError: MockApprovalRequiredError,
    ForbiddenError: MockForbiddenError,
    ValidationError: MockValidationError,
    isContentError: (error: unknown) => error instanceof MockContentError,
    contentService: {
      list: (...args: unknown[]) => contentListMock(...args),
      create: (...args: unknown[]) => contentCreateMock(...args),
      get: jest.fn(),
      update: jest.fn(),
      createVersion: jest.fn(),
      loadForEdit: jest.fn(),
      delete: jest.fn(),
    },
    contentSourceService: {
      read: (...args: unknown[]) => sourceReadMock(...args),
    },
    contentAssetService: {
      list: (...args: unknown[]) => assetListMock(...args),
      get: (...args: unknown[]) => assetGetMock(...args),
      readBytes: (...args: unknown[]) => assetReadBytesMock(...args),
      initiate: (...args: unknown[]) => assetInitiateMock(...args),
      complete: (...args: unknown[]) => assetCompleteMock(...args),
    },
    visibilityService: { setLevel: jest.fn() },
    publishService: {
      publish: (...args: unknown[]) => publishMock(...args),
      unpublish: jest.fn(),
    },
    recordContentAudit: (...args: unknown[]) => auditMock(...args),
  }
})

import {
  ApprovalRequiredError,
  ForbiddenError,
} from "@/lib/content"
import { executeOwnerAtriumOperation } from "@/lib/agent-workspace/atrium-owner-operation"

const requester = {
  kind: "user" as const,
  userId: 42,
  roles: ["staff"],
  groups: [],
  isAdmin: false,
}

beforeEach(() => {
  jest.clearAllMocks()
  getUserByEmailMock.mockResolvedValue({
    id: 42,
    cognitoSub: "cognito-owner",
    email: "owner@psd401.net",
  })
  requesterForUserIdMock.mockResolvedValue(requester)
  assertContentAuthoringCapabilityMock.mockResolvedValue(undefined)
  resolveCollectionIdMock.mockImplementation(async (value: unknown) => value)
  auditMock.mockResolvedValue(undefined)
})

describe("signed-owner Atrium operations", () => {
  it("resolves the signed email to the owner requester for reads", async () => {
    contentListMock.mockResolvedValue([{ id: "content-1" }])
    await expect(
      executeOwnerAtriumOperation({
        ownerEmail: "owner@psd401.net",
        requestId: "request-1",
        method: "GET",
        path: "",
        query: { collection: "handbook", status: "draft" },
      })
    ).resolves.toEqual({
      httpStatus: 200,
      payload: {
        data: [{ id: "content-1" }],
        meta: { requestId: "request-1" },
      },
    })
    expect(getUserByEmailMock).toHaveBeenCalledWith("owner@psd401.net")
    expect(requesterForUserIdMock).toHaveBeenCalledWith(42)
    expect(contentListMock).toHaveBeenCalledWith(requester, {
      kind: undefined,
      collectionId: "handbook",
      tag: undefined,
      status: "draft",
      query: undefined,
    })
    expect(assertContentAuthoringCapabilityMock).not.toHaveBeenCalled()
  })

  it("attributes writes to the signed owner requester", async () => {
    contentCreateMock.mockResolvedValue({
      id: "content-1",
      slug: "new-document",
    })
    await expect(
      executeOwnerAtriumOperation({
        ownerEmail: "owner@psd401.net",
        requestId: "request-2",
        method: "POST",
        path: "",
        body: {
          kind: "document",
          title: "New document",
          body: "Hello",
        },
      })
    ).resolves.toEqual({
      httpStatus: 201,
      payload: {
        data: {
          id: "content-1",
          slug: "new-document",
          url: "/c/new-document",
        },
        meta: { requestId: "request-2" },
      },
    })
    expect(assertContentAuthoringCapabilityMock).toHaveBeenCalledWith({
      authType: "session",
      cognitoSub: "cognito-owner",
    })
    expect(contentCreateMock).toHaveBeenCalledWith(
      requester,
      expect.objectContaining({
        kind: "document",
        title: "New document",
        body: "Hello",
      }),
      { hasPublishPublicCapability: false }
    )
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        req: requester,
        action: "create",
        objectId: "content-1",
        outcome: "ok",
      })
    )
  })

  it("maps the public publish approval gate without granting authority", async () => {
    publishMock.mockRejectedValue(
      new ApprovalRequiredError("Public publish requires approval")
    )
    await expect(
      executeOwnerAtriumOperation({
        ownerEmail: "owner@psd401.net",
        requestId: "request-3",
        method: "POST",
        path: "/content-1/publish",
        body: { destination: "public_web" },
      })
    ).resolves.toEqual({
      httpStatus: 202,
      payload: {
        data: {
          status: "approval_required",
          message: "Public publish requires approval",
        },
        meta: { requestId: "request-3" },
      },
    })
    expect(publishMock).toHaveBeenCalledWith(
      requester,
      "content-1",
      { destination: "public_web", visibility: undefined },
      { hasPublishPublicCapability: false }
    )
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "approval_required" })
    )
  })

  it("reads a document body through the source alias without authoring capability", async () => {
    sourceReadMock.mockResolvedValue({
      versionId: "version-1",
      bodyFormat: "markdown",
      body: "## Title\nA procedure",
    })
    await expect(
      executeOwnerAtriumOperation({
        ownerEmail: "owner@psd401.net",
        requestId: "request-source",
        method: "GET",
        path: "/content-1/source",
      })
    ).resolves.toEqual({
      httpStatus: 200,
      payload: {
        data: {
          versionId: "version-1",
          bodyFormat: "markdown",
          body: "## Title\nA procedure",
        },
        meta: { requestId: "request-source" },
      },
    })
    expect(sourceReadMock).toHaveBeenCalledWith(requester, "content-1")
    // Reading is not authoring: the capability gate must not run for a read.
    expect(assertContentAuthoringCapabilityMock).not.toHaveBeenCalled()
  })

  it("lists assets as a read and reserves an upload as a write", async () => {
    assetListMock.mockResolvedValue([{ id: "asset-1", state: "ready" }])
    await expect(
      executeOwnerAtriumOperation({
        ownerEmail: "owner@psd401.net",
        requestId: "request-list",
        method: "GET",
        path: "/content-1/assets",
      })
    ).resolves.toEqual({
      httpStatus: 200,
      payload: {
        data: [{ id: "asset-1", state: "ready" }],
        meta: { requestId: "request-list" },
      },
    })
    expect(assertContentAuthoringCapabilityMock).not.toHaveBeenCalled()

    assetInitiateMock.mockResolvedValue({
      asset: { id: "asset-2", upload: { method: "PUT", url: "https://s3" } },
      replayed: false,
    })
    const initiateBody = {
      filename: "screenshot.png",
      contentType: "image/png",
      byteLength: 1024,
      sha256: "A".repeat(43),
      purpose: "document_image",
    }
    await expect(
      executeOwnerAtriumOperation({
        ownerEmail: "owner@psd401.net",
        requestId: "request-initiate",
        method: "POST",
        path: "/content-1/assets",
        body: initiateBody,
      })
    ).resolves.toEqual({
      httpStatus: 201,
      payload: {
        data: { id: "asset-2", upload: { method: "PUT", url: "https://s3" } },
        meta: { requestId: "request-initiate" },
      },
    })
    expect(assertContentAuthoringCapabilityMock).toHaveBeenCalledWith({
      authType: "session",
      cognitoSub: "cognito-owner",
    })
    expect(assetInitiateMock).toHaveBeenCalledWith(
      requester,
      "content-1",
      initiateBody
    )
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "initiate_asset", outcome: "ok" })
    )
  })

  it("completes an asset upload and audits it", async () => {
    assetCompleteMock.mockResolvedValue({ id: "asset-2", state: "ready" })
    await expect(
      executeOwnerAtriumOperation({
        ownerEmail: "owner@psd401.net",
        requestId: "request-complete",
        method: "POST",
        path: "/content-1/assets/asset-2/complete",
        body: { sha256: "B".repeat(43) },
      })
    ).resolves.toEqual({
      httpStatus: 200,
      payload: {
        data: { id: "asset-2", state: "ready" },
        meta: { requestId: "request-complete" },
      },
    })
    expect(assetCompleteMock).toHaveBeenCalledWith(
      requester,
      "content-1",
      "asset-2",
      { sha256: "B".repeat(43) }
    )
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "complete_asset", outcome: "ok" })
    )
  })

  it("rejects an initiate body the v1 asset contract would refuse", async () => {
    const result = await executeOwnerAtriumOperation({
      ownerEmail: "owner@psd401.net",
      requestId: "request-bad",
      method: "POST",
      path: "/content-1/assets",
      body: {
        filename: "evil.svg",
        contentType: "image/svg+xml",
        byteLength: 1024,
        sha256: "A".repeat(43),
        purpose: "document_image",
      },
    })
    expect(result.httpStatus).toBe(400)
    expect(assetInitiateMock).not.toHaveBeenCalled()
  })

  it("serves asset bytes base64-encoded and refuses an oversized read", async () => {
    assetGetMock.mockResolvedValue({
      id: "asset-3",
      objectId: "content-1",
      filename: "diagram.png",
      byteLength: 3,
    })
    assetReadBytesMock.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
      etag: '"abc"',
    })
    await expect(
      executeOwnerAtriumOperation({
        ownerEmail: "owner@psd401.net",
        requestId: "request-bytes",
        method: "GET",
        path: "/content-1/assets/asset-3/bytes",
      })
    ).resolves.toEqual({
      httpStatus: 200,
      payload: {
        data: {
          id: "asset-3",
          objectId: "content-1",
          filename: "diagram.png",
          contentType: "image/png",
          byteLength: 3,
          encoding: "base64",
          data: Buffer.from([1, 2, 3]).toString("base64"),
        },
        meta: { requestId: "request-bytes" },
      },
    })
    // The asset is resolved through the OBJECT first, so an asset id belonging
    // to another object cannot be served under this object's path.
    expect(assetGetMock).toHaveBeenCalledWith(requester, "content-1", "asset-3")

    assetGetMock.mockResolvedValue({
      id: "asset-4",
      objectId: "content-1",
      filename: "huge.png",
      byteLength: 8 * 1024 * 1024,
    })
    assetReadBytesMock.mockClear()
    const oversized = await executeOwnerAtriumOperation({
      ownerEmail: "owner@psd401.net",
      requestId: "request-huge",
      method: "GET",
      path: "/content-1/assets/asset-4/bytes",
    })
    expect(oversized.httpStatus).toBe(400)
    expect(assetReadBytesMock).not.toHaveBeenCalled()
  })

  it("fails closed when the signed owner cannot become a requester", async () => {
    requesterForUserIdMock.mockResolvedValueOnce(null)
    await expect(
      executeOwnerAtriumOperation({
        ownerEmail: "deleted@psd401.net",
        requestId: "request-4",
        method: "GET",
        path: "",
      })
    ).rejects.toBeInstanceOf(ForbiddenError)
    expect(contentListMock).not.toHaveBeenCalled()
  })
})
