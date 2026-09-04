/** @jest-environment node */

const getUserByEmailMock = jest.fn()
const requesterForUserIdMock = jest.fn()
const assertContentAuthoringCapabilityMock = jest.fn()
const resolveCollectionIdMock = jest.fn()
const contentListMock = jest.fn()
const contentCreateMock = jest.fn()
const contentDeleteMock = jest.fn()
const publishMock = jest.fn()
const auditMock = jest.fn()
const sourceReadMock = jest.fn()
const assetListMock = jest.fn()
const assetGetMock = jest.fn()
const assetReadBytesMock = jest.fn()
const assetInitiateMock = jest.fn()
const assetCompleteMock = jest.fn()
const collectionVisibleListMock = jest.fn()
const collectionManageableListMock = jest.fn()
const collectionCreateMock = jest.fn()
const collectionUpdateMock = jest.fn()
const contentGetMock = jest.fn()

const dataLimitMock = jest.fn()
const dataOrderByMock = jest.fn(() => ({ limit: dataLimitMock }))
const dataWhereMock = jest.fn(() => ({ orderBy: dataOrderByMock }))
const dataLeftJoinMock = jest.fn(() => ({ where: dataWhereMock }))
const dataFromMock = jest.fn(() => ({ leftJoin: dataLeftJoinMock }))
const dataSelectMock = jest.fn(() => ({ from: dataFromMock }))

interface FakeDb {
  select: typeof dataSelectMock
}

type QueryCallback = (db: FakeDb) => unknown
const executeQueryMock = jest.fn(
  async (query: QueryCallback, _operation: string) => query({ select: dataSelectMock })
)

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (query: QueryCallback, operation: string) =>
    executeQueryMock(query, operation),
}))

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
  // Mirrors the real builder: only PUBLISHED objects have a reader page, so a
  // draft is linked to its authoring surface instead of a `/c/` URL that 404s.
  contentSurfaceLink: (object: {
    id: string
    slug: string
    kind: "document" | "artifact"
    status: string
  }) =>
    object.status === "published"
      ? `/c/${object.slug}`
      : `/atrium/${object.id}/${object.kind === "artifact" ? "view" : "edit"}`,
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
  class MockNotFoundError extends MockContentError {
    constructor(message = "Not found") {
      super(message, "CONTENT_NOT_FOUND", 404)
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
    NotFoundError: MockNotFoundError,
    ValidationError: MockValidationError,
    isContentError: (error: unknown) => error instanceof MockContentError,
    contentService: {
      list: (...args: unknown[]) => contentListMock(...args),
      create: (...args: unknown[]) => contentCreateMock(...args),
      get: (...args: unknown[]) => contentGetMock(...args),
      update: jest.fn(),
      createVersion: jest.fn(),
      loadForEdit: jest.fn(),
      delete: (...args: unknown[]) => contentDeleteMock(...args),
    },
    collectionManagementService: {
      listManageable: (...args: unknown[]) =>
        collectionManageableListMock(...args),
      create: (...args: unknown[]) => collectionCreateMock(...args),
      update: (...args: unknown[]) => collectionUpdateMock(...args),
    },
    collectionService: {
      discover: (...args: unknown[]) => collectionVisibleListMock(...args),
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
  NotFoundError,
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
  resolveCollectionIdMock.mockImplementation(
    async (_requester: unknown, value: unknown) => value
  )
  auditMock.mockResolvedValue(undefined)
  contentGetMock.mockResolvedValue({
    id: "content-1",
    kind: "artifact",
  })
  dataLimitMock.mockResolvedValue([])
})

describe("signed-owner Atrium artifact data reads", () => {
  it("returns the #1517 record and display-name shape as the signed owner", async () => {
    dataLimitMock.mockResolvedValue([
      {
        id: "record-2",
        payload: { score: 84 },
        createdAt: new Date("2026-08-02T03:00:00.000Z"),
        userFirstName: " Ada ",
        userLastName: "Lovelace",
      },
      {
        id: "record-1",
        payload: { score: 42 },
        createdAt: new Date("2026-08-02T02:00:00.000Z"),
        userFirstName: null,
        userLastName: null,
      },
    ])

    await expect(
      executeOwnerAtriumOperation({
        ownerEmail: "owner@psd401.net",
        requestId: "request-data",
        method: "GET",
        path: "/content-1/data",
        query: { namespace: "leaderboard" },
      })
    ).resolves.toEqual({
      httpStatus: 200,
      payload: {
        data: {
          records: [
            {
              id: "record-2",
              displayName: "Ada Lovelace",
              payload: { score: 84 },
              createdAt: "2026-08-02T03:00:00.000Z",
            },
            {
              id: "record-1",
              displayName: "Unknown user",
              payload: { score: 42 },
              createdAt: "2026-08-02T02:00:00.000Z",
            },
          ],
        },
        meta: { requestId: "request-data" },
      },
    })
    expect(contentGetMock).toHaveBeenCalledWith(requester, "content-1")
    expect(dataLimitMock).toHaveBeenCalledWith(50)
    expect(executeQueryMock).toHaveBeenCalledWith(
      expect.any(Function),
      "agentAtrium.listArtifactRecords"
    )
    expect(assertContentAuthoringCapabilityMock).not.toHaveBeenCalled()
  })

  it("clamps a requested limit above 200", async () => {
    const result = await executeOwnerAtriumOperation({
      ownerEmail: "owner@psd401.net",
      requestId: "request-data-limit",
      method: "GET",
      path: "/content-1/data",
      query: { namespace: "leaderboard", limit: "1000" },
    })

    expect(result.httpStatus).toBe(200)
    expect(dataLimitMock).toHaveBeenCalledWith(200)
  })

  it.each([
    {
      query: {} as Record<string, string>,
      field: "namespace",
      constraint: "namespace",
    },
    {
      query: { namespace: "Leaderboard!" },
      field: "namespace",
      constraint: "namespace must be 1-64 lowercase",
    },
    {
      query: { namespace: "leaderboard", limit: "not-a-number" },
      field: "limit",
      constraint: "limit must be a positive base-10 integer",
    },
  ])(
    "rejects malformed data query %# with a structured constraint",
    async ({ query, field, constraint }) => {
      const result = await executeOwnerAtriumOperation({
        ownerEmail: "owner@psd401.net",
        requestId: "request-data-invalid",
        method: "GET",
        path: "/content-1/data",
        query,
      })

      expect(result.httpStatus).toBe(400)
      expect(result.payload).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({
            code: "VALIDATION_ERROR",
            details: expect.arrayContaining([
              expect.objectContaining({ path: [field] }),
            ]),
          }),
        })
      )
      expect(JSON.stringify(result.payload)).toContain(constraint)
      expect(contentGetMock).not.toHaveBeenCalled()
      expect(dataSelectMock).not.toHaveBeenCalled()
    }
  )

  it("masks a non-viewable artifact as not found before record or permission access", async () => {
    contentGetMock.mockRejectedValue(new NotFoundError("Content not found"))

    const result = await executeOwnerAtriumOperation({
      ownerEmail: "owner@psd401.net",
      requestId: "request-data-hidden",
      method: "GET",
      path: "/hidden-content/data",
      query: { namespace: "leaderboard" },
    })

    expect(result).toEqual({
      httpStatus: 404,
      payload: {
        error: {
          code: "CONTENT_NOT_FOUND",
          message: "Content not found",
        },
        requestId: "request-data-hidden",
      },
    })
    expect(dataSelectMock).not.toHaveBeenCalled()
    expect(assertContentAuthoringCapabilityMock).not.toHaveBeenCalled()
  })
})

describe("signed-owner Atrium artifact data content-kind guard", () => {
  it("rejects a visible non-artifact before record or authoring access", async () => {
    contentGetMock.mockResolvedValue({
      id: "document-1",
      kind: "document",
    })

    const result = await executeOwnerAtriumOperation({
      ownerEmail: "owner@psd401.net",
      requestId: "request-data-document",
      method: "GET",
      path: "/document-1/data",
      query: { namespace: "leaderboard" },
    })

    expect(result).toEqual({
      httpStatus: 400,
      payload: {
        error: {
          code: "VALIDATION_ERROR",
          message: "Content is not an artifact",
          details: { field: "contentId" },
        },
        requestId: "request-data-document",
      },
    })
    expect(contentGetMock).toHaveBeenCalledWith(requester, "document-1")
    expect(dataSelectMock).not.toHaveBeenCalled()
    expect(assertContentAuthoringCapabilityMock).not.toHaveBeenCalled()
  })
})

describe("signed-owner Atrium operations", () => {
  it("keeps archived manageable collections discoverable without widening content access", async () => {
    const district = {
      id: "d9999999-9999-4999-8999-999999999999",
      scope: "district",
      slug: "staff-intranet",
      selectableForCreate: true,
    }
    const activePrivatePicker = {
      id: "a9999999-9999-4999-8999-999999999999",
      scope: "private",
      slug: "active-private",
      selectableForCreate: true,
    }
    const activePrivateManagement = {
      ...activePrivatePicker,
      archivedAt: null,
      directContentCount: 1,
      subtreeContentCount: 1,
      grants: [],
    }
    const archived = {
      id: "f9999999-9999-4999-8999-999999999999",
      scope: "private",
      archivedAt: "2026-07-29T07:00:00.000Z",
      directContentCount: 2,
      subtreeContentCount: 5,
      grants: [],
    }
    collectionVisibleListMock.mockResolvedValue([
      district,
      activePrivatePicker,
    ])
    collectionManageableListMock.mockResolvedValue([
      activePrivateManagement,
      archived,
    ])
    const result = await executeOwnerAtriumOperation({
      ownerEmail: "owner@psd401.net",
      requestId: "request-collections",
      method: "GET",
      path: "/collections",
    })
    expect(result.httpStatus).toBe(200)
    expect(result.payload).toEqual({
      data: [district, activePrivateManagement, archived],
      meta: { requestId: "request-collections" },
    })
    expect(collectionVisibleListMock).toHaveBeenCalledWith(requester, {
      shape: "flat",
      includeCreateSelection: true,
    })
    expect(collectionManageableListMock).toHaveBeenCalledWith(requester)
    expect(assertContentAuthoringCapabilityMock).not.toHaveBeenCalled()
  })

  it("creates and moves collections through the shared owner-bound service", async () => {
    const id = "f9999999-9999-4999-8999-999999999999"
    collectionCreateMock.mockResolvedValue({ id, name: "Projects" })
    collectionUpdateMock.mockResolvedValue({ id, name: "Projects", parentId: null })

    const created = await executeOwnerAtriumOperation({
      ownerEmail: "owner@psd401.net",
      requestId: "request-create-collection",
      method: "POST",
      path: "/collections",
      body: { name: "Projects", scope: "private" },
    })
    expect(created.httpStatus).toBe(201)
    expect(collectionCreateMock).toHaveBeenCalledWith(
      requester,
      { name: "Projects", scope: "private" },
      { surface: "rest", requestId: "request-create-collection" }
    )

    await executeOwnerAtriumOperation({
      ownerEmail: "owner@psd401.net",
      requestId: "request-move-collection",
      method: "PATCH",
      path: `/collections/${id}`,
      body: { parentId: null, position: 0 },
    })
    expect(collectionUpdateMock).toHaveBeenCalledWith(
      requester,
      id,
      { parentId: null, position: 0 },
      { surface: "rest", requestId: "request-move-collection" }
    )
    expect(assertContentAuthoringCapabilityMock).toHaveBeenCalledTimes(2)
  })

  it("resolves the signed email to the owner requester for reads", async () => {
    const draft = { kind: "document", status: "draft" }
    contentListMock.mockResolvedValue([
      { id: "content-1", slug: "staff-handbook", ...draft },
    ])
    await expect(
      executeOwnerAtriumOperation({
        ownerEmail: "owner@psd401.net",
        requestId: "request-1",
        method: "GET",
        path: "",
        query: {
          collection: "handbook",
          status: "draft",
          since: "2026-07-27T00:00:00Z",
        },
      })
    ).resolves.toEqual({
      httpStatus: 200,
      payload: {
        data: [
          {
            id: "content-1",
            slug: "staff-handbook",
            ...draft,
            // NOT `/c/staff-handbook`: that reader needs a live intranet
            // publication and 404s without one, for the owner too.
            url: "/atrium/content-1/edit",
          },
        ],
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
      since: "2026-07-27T00:00:00Z",
    })
    expect(assertContentAuthoringCapabilityMock).not.toHaveBeenCalled()
  })

  it("returns a 400 validation result for an invalid since value", async () => {
    const result = await executeOwnerAtriumOperation({
      ownerEmail: "owner@psd401.net",
      requestId: "request-invalid-since",
      method: "GET",
      path: "",
      query: { since: "yesterday-ish" },
    })

    expect(result.httpStatus).toBe(400)
    expect(result.payload).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "VALIDATION_ERROR" }),
      })
    )
    expect(contentListMock).not.toHaveBeenCalled()
  })
})

describe("signed-owner Atrium mutations", () => {
  it("attributes writes to the signed owner requester", async () => {
    contentCreateMock.mockResolvedValue({
      id: "content-1",
      slug: "new-document",
      kind: "document",
      status: "draft",
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
          kind: "document",
          status: "draft",
          // A just-created object is never published, so the link an agent
          // hands its user must be one that opens.
          url: "/atrium/content-1/edit",
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

  it("deletes an object and audits the success", async () => {
    contentDeleteMock.mockResolvedValue({ id: "content-1", deleted: true })
    await expect(
      executeOwnerAtriumOperation({
        ownerEmail: "owner@psd401.net",
        requestId: "request-del",
        method: "DELETE",
        path: "/content-1",
      })
    ).resolves.toEqual({
      httpStatus: 200,
      payload: {
        data: { id: "content-1", deleted: true },
        meta: { requestId: "request-del" },
      },
    })
    expect(contentDeleteMock).toHaveBeenCalledWith(requester, "content-1", {
      surface: "rest",
    })
    // A successful agent-initiated delete must leave an audit row, exactly
    // like every other mutation — not only the deletes that throw.
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "delete",
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

  it("passes the publish readerUrl through to the broker response", async () => {
    publishMock.mockResolvedValue({
      publishedVersionId: "version-7",
      // The service reports the destination it ACTUALLY wrote (#1726); the
      // broker response and the audit row both echo THAT, not the alias sent.
      destination: "intranet",
      readerUrl: "https://app.example/c/staff-handbook",
    })

    await expect(
      executeOwnerAtriumOperation({
        ownerEmail: "owner@psd401.net",
        requestId: "request-publish-reader",
        method: "POST",
        path: "/content-1/publish",
        body: { destination: "intranet" },
      })
    ).resolves.toEqual({
      httpStatus: 200,
      payload: {
        data: {
          id: "content-1",
          destination: "intranet",
          publishedVersionId: "version-7",
          readerUrl: "https://app.example/c/staff-handbook",
        },
        meta: { requestId: "request-publish-reader" },
      },
    })
  })
})

describe("signed-owner Atrium source reads and authored assets", () => {
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
})

describe("signed-owner Atrium asset bytes and authorization guards", () => {
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

  // The authoring-capability assert is the security-relevant line in this
  // module: reads run before it, every write must run after it. The refactor
  // that split the handler into read/content/metadata/asset/publish functions
  // makes it structurally possible for a new branch to land on the wrong side,
  // and nothing would fail loudly if it did — the operation would simply work
  // for a caller who should not be allowed to author. This pins it for EVERY
  // mutating route at once: if the capability check throws, no service call for
  // any of them may happen.
  it.each([
    ["POST", "", { kind: "document", title: "T" }],
    ["POST", "/content-1/versions", { body: "x" }],
    ["POST", "/content-1/assets", {
      filename: "a.png",
      contentType: "image/png",
      byteLength: 10,
      sha256: "A".repeat(43),
      purpose: "document_image",
    }],
    ["POST", "/content-1/assets/asset-1/complete", { sha256: "A".repeat(43) }],
    ["PATCH", "/content-1", { title: "T" }],
    ["PATCH", "/content-1/visibility", { level: "internal" }],
    ["DELETE", "/content-1", undefined],
    ["POST", "/content-1/publish", { destination: "intranet" }],
    ["DELETE", "/content-1/publish/intranet", undefined],
  ])(
    "refuses %s %s when the authoring capability is denied",
    async (method, path, body) => {
      assertContentAuthoringCapabilityMock.mockRejectedValueOnce(
        new ForbiddenError("Atrium authoring is not permitted")
      )
      const result = await executeOwnerAtriumOperation({
        ownerEmail: "owner@psd401.net",
        requestId: "request-denied",
        method: method as "POST" | "PATCH" | "DELETE",
        path,
        body,
      })
      expect(result.httpStatus).toBe(403)
      for (const serviceCall of [
        contentCreateMock,
        publishMock,
        assetInitiateMock,
        assetCompleteMock,
      ]) {
        expect(serviceCall).not.toHaveBeenCalled()
      }
    }
  )

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
