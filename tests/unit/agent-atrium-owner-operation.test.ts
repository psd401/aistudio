/** @jest-environment node */

const getUserByEmailMock = jest.fn()
const requesterForUserIdMock = jest.fn()
const assertContentAuthoringCapabilityMock = jest.fn()
const resolveCollectionIdMock = jest.fn()
const contentListMock = jest.fn()
const contentCreateMock = jest.fn()
const publishMock = jest.fn()
const auditMock = jest.fn()

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
  return {
    ApprovalRequiredError: MockApprovalRequiredError,
    ForbiddenError: MockForbiddenError,
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
