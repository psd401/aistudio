/** @jest-environment node */

import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals"

type AsyncUnknownMock = (...args: unknown[]) => Promise<unknown>

const s3SendMock = jest.fn<AsyncUnknownMock>()
const signedUrlMock = jest.fn<AsyncUnknownMock>()
const executeQueryMock = jest.fn<AsyncUnknownMock>()
const executeTransactionMock = jest.fn<AsyncUnknownMock>()
const acquireMock = jest.fn<AsyncUnknownMock>()
const finishMock = jest.fn<AsyncUnknownMock>()
const releaseMock = jest.fn<AsyncUnknownMock>()

jest.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  return {
    S3Client: class S3Client {
      send = s3SendMock
    },
    CopyObjectCommand: class CopyObjectCommand extends Command {},
    DeleteObjectCommand: class DeleteObjectCommand extends Command {},
    GetObjectCommand: class GetObjectCommand extends Command {},
    HeadObjectCommand: class HeadObjectCommand extends Command {},
    ListObjectsV2Command: class ListObjectsV2Command extends Command {},
    PutObjectCommand: class PutObjectCommand extends Command {},
  }
})
jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: (...args: unknown[]) => signedUrlMock(...args),
}))
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
  executeTransaction: (...args: unknown[]) => executeTransactionMock(...args),
}))
jest.mock("@/lib/resource-admission", () => ({
  acquireResourceAdmission: (...args: unknown[]) => acquireMock(...args),
  finishResourceAdmission: (...args: unknown[]) => finishMock(...args),
  releaseResourceAdmission: (...args: unknown[]) => releaseMock(...args),
  // Real implementation, not a stub: the capacity-vs-replay distinction is the
  // behaviour under test here. `duplicate` must stay a hard failure while
  // capacity thresholds are observe-only.
  isCapacityDenial: (admission: { allowed: boolean; reason?: string }) =>
    !admission.allowed && admission.reason !== "duplicate",
}))

let completeWorkspaceUpload:
  typeof import("@/lib/agent-workspace/storage-broker").completeWorkspaceUpload
let createPublicArtifactUpload:
  typeof import("@/lib/agent-workspace/storage-broker").createPublicArtifactUpload
let createWorkspaceUploadUrl:
  typeof import("@/lib/agent-workspace/storage-broker").createWorkspaceUploadUrl
let resetWorkspaceStorageClientForTests:
  typeof import("@/lib/agent-workspace/storage-broker").resetWorkspaceStorageClientForTests

const OWNER = "owner@example.com"
const CHECKSUM = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
const RESERVATION = "36bb0456-1c51-4fb8-97d1-4e87d02765ce"
const BYTE_LEASE = "byte-lease"
const OBJECT_LEASE = "object-lease"

function claimed(overrides: Record<string, unknown> = {}) {
  return {
    id: RESERVATION,
    ownerKey: OWNER,
    publicArtifact: true,
    stagingKey: `.upload-staging/public/owner/${RESERVATION}`,
    targetKey: "public-images/owner/report.pdf",
    expectedBytes: 4,
    checksumSha256: CHECKSUM,
    contentType: "application/pdf",
    byteLeaseId: BYTE_LEASE,
    objectLeaseId: OBJECT_LEASE,
    status: "verifying",
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  }
}

beforeAll(async () => {
  const broker = await import("@/lib/agent-workspace/storage-broker")
  completeWorkspaceUpload = broker.completeWorkspaceUpload
  createPublicArtifactUpload = broker.createPublicArtifactUpload
  createWorkspaceUploadUrl = broker.createWorkspaceUploadUrl
  resetWorkspaceStorageClientForTests = broker.resetWorkspaceStorageClientForTests
})

beforeEach(() => {
  jest.clearAllMocks()
  executeQueryMock.mockReset().mockResolvedValue([])
  executeTransactionMock.mockReset()
  acquireMock.mockReset()
  finishMock.mockReset()
  releaseMock.mockReset()
  s3SendMock.mockReset()
  signedUrlMock.mockReset()
  process.env.AGENT_WORKSPACE_BUCKET = "workspace-bucket"
  resetWorkspaceStorageClientForTests()
  acquireMock
    .mockResolvedValueOnce({ allowed: true, leaseId: BYTE_LEASE })
    .mockResolvedValueOnce({ allowed: true, leaseId: OBJECT_LEASE })
  executeTransactionMock.mockImplementation(
    async (...args: unknown[]) => {
      const label = args[1]
      if (label === "createWorkspaceUploadReservation") {
        return {
          id: RESERVATION,
          stagingKey: `.upload-staging/public/owner/${RESERVATION}`,
        }
      }
      if (label === "settleWorkspaceUploadCompletion") {
        return { id: RESERVATION }
      }
      throw new Error(`unexpected transaction ${label}`)
    },
  )
  signedUrlMock.mockResolvedValue(
    "https://workspace-bucket.s3.amazonaws.com/staging" +
      "?X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256",
  )
  finishMock.mockResolvedValue(undefined)
  releaseMock.mockResolvedValue(undefined)
})

describe("verified workspace upload reservations", () => {
  it("signs exact length/checksum and never exposes a public URL before verification", async () => {
    const prepared = await createPublicArtifactUpload(
      OWNER,
      "report.pdf",
      "application/pdf",
      4,
      "session:nonce",
      "idempotency-1",
      CHECKSUM,
    )
    expect(prepared).toEqual({
      uploadUrl: expect.stringContaining("X-Amz-SignedHeaders"),
      reservationId: RESERVATION,
      requiredHeaders: {
        "Content-Length": "4",
        "Content-Type": "application/pdf",
        "x-amz-checksum-sha256": CHECKSUM,
      },
    })
    expect(prepared).not.toHaveProperty("publicUrl")
    const put = signedUrlMock.mock.calls[0]?.[1] as {
      input: Record<string, unknown>
    }
    expect(put.input).toMatchObject({
      ContentLength: 4,
      ChecksumSHA256: CHECKSUM,
      ContentType: "application/pdf",
    })
    expect(String(put.input.Key)).toMatch(/^\.upload-staging\/public\//)
  })

  it("rejects a public extension/MIME mismatch before reserving capacity", async () => {
    await expect(
      createPublicArtifactUpload(
        OWNER,
        "report.png",
        "text/html",
        4,
        "session:nonce",
        "idempotency-mime",
        CHECKSUM,
      ),
    ).rejects.toThrow("content type")
    expect(executeQueryMock).not.toHaveBeenCalled()
    expect(acquireMock).not.toHaveBeenCalled()
  })

  it("accepts the UTF-8 HTML MIME used by the artifact publishers", async () => {
    const prepared = await createPublicArtifactUpload(
      OWNER,
      "report.html",
      "text/html; charset=utf-8",
      4,
      "session:nonce",
      "idempotency-html",
      CHECKSUM,
    )
    expect(prepared.requiredHeaders["Content-Type"]).toBe(
      "text/html; charset=utf-8",
    )
    const put = signedUrlMock.mock.calls[0]?.[1] as {
      input: Record<string, unknown>
    }
    expect(put.input.ContentType).toBe("text/html; charset=utf-8")
  })

  it("uncharges an old public commit only after exact-version absence is proven", async () => {
    executeQueryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "old-public",
          targetKey: "public-images/owner/old.pdf",
          objectVersionId: "lifecycle-version",
        },
      ])
      .mockResolvedValueOnce([])
    s3SendMock.mockRejectedValueOnce(
      Object.assign(new Error("not found"), {
        name: "NoSuchVersion",
        $metadata: { httpStatusCode: 404 },
      }),
    )

    await createPublicArtifactUpload(
      OWNER,
      "report.pdf",
      "application/pdf",
      4,
      "session:nonce",
      "idempotency-reconciled",
      CHECKSUM,
    )

    expect(
      (s3SendMock.mock.calls[0]?.[0] as { input: Record<string, unknown> })
        .input,
    ).toMatchObject({
      Key: "public-images/owner/old.pdf",
      VersionId: "lifecycle-version",
    })
    expect(executeQueryMock).toHaveBeenCalledTimes(3)
  })

  it("keeps an old public commit charged on ambiguous S3 failure", async () => {
    executeQueryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "old-public",
          targetKey: "public-images/owner/old.pdf",
          objectVersionId: "retained-version",
        },
      ])
    s3SendMock.mockRejectedValueOnce(new Error("S3 unavailable"))

    await createPublicArtifactUpload(
      OWNER,
      "report.pdf",
      "application/pdf",
      4,
      "session:nonce",
      "idempotency-retained",
      CHECKSUM,
    )

    expect(executeQueryMock).toHaveBeenCalledTimes(2)
  })

  it("reuses a parameter-bound reservation retry without reacquiring leases", async () => {
    executeQueryMock.mockResolvedValueOnce([
      claimed({
        status: "reserved",
        targetKey:
          "public-images/c8cd3c6427301eaf6665bcca/report.pdf",
      }),
    ])
    const first = await createPublicArtifactUpload(
      OWNER,
      "report.pdf",
      "application/pdf",
      4,
      "session:nonce",
      "idempotency-retry",
      CHECKSUM,
    )
    expect(first.reservationId).toBe(RESERVATION)
    expect(acquireMock).not.toHaveBeenCalled()
    expect(executeTransactionMock).not.toHaveBeenCalled()
  })

  it("does not trust an unchanged ledger row when the exact S3 version is stale", async () => {
    executeQueryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "old",
          targetKey: "users/owner/note.txt",
          objectVersionId: "missing-version",
        },
      ])
    s3SendMock.mockRejectedValueOnce(new Error("NoSuchVersion"))
    const prepared = await createWorkspaceUploadUrl(
      OWNER,
      "users/owner",
      "note.txt",
      4,
      "session:nonce",
      "fresh-idempotency",
      CHECKSUM,
    )
    expect(prepared).toHaveProperty("uploadUrl")
    expect(acquireMock).toHaveBeenCalledTimes(2)
  })

  it("does not skip when an older verified version exists but is no longer current", async () => {
    executeQueryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "old",
          targetKey: "users/owner/note.txt",
          objectVersionId: "old-version",
        },
      ])
    s3SendMock.mockResolvedValueOnce({
      ContentLength: 4,
      ChecksumSHA256: CHECKSUM,
      ContentType: "application/octet-stream",
      VersionId: "newer-untracked-version",
    })
    const prepared = await createWorkspaceUploadUrl(
      OWNER,
      "users/owner",
      "note.txt",
      4,
      "session:nonce",
      "fresh-idempotency",
      CHECKSUM,
    )
    expect(prepared).toHaveProperty("uploadUrl")
    expect(acquireMock).toHaveBeenCalledTimes(2)
  })

  it("does not revive an expired reservation for resigning or completion", async () => {
    executeQueryMock.mockResolvedValueOnce([
      claimed({
        status: "reserved",
        targetKey:
          "public-images/c8cd3c6427301eaf6665bcca/report.pdf",
        expiresAt: new Date(Date.now() - 1),
      }),
    ])
    await expect(
      createPublicArtifactUpload(
        OWNER,
        "report.pdf",
        "application/pdf",
        4,
        "session:nonce",
        "expired-idempotency",
        CHECKSUM,
      ),
    ).rejects.toThrow("non-reusable")
    expect(acquireMock).not.toHaveBeenCalled()

    executeQueryMock.mockReset()
    executeQueryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        claimed({ status: "reserved", expiresAt: new Date(Date.now() - 1) }),
      ])
    await expect(
      completeWorkspaceUpload(OWNER, RESERVATION),
    ).rejects.toThrow("unavailable")
    expect(s3SendMock).not.toHaveBeenCalled()
  })

  it("settles one exact verified version and makes duplicate completion idempotent", async () => {
    executeQueryMock
      .mockResolvedValueOnce([claimed()])
      .mockResolvedValueOnce([])
    s3SendMock
      .mockResolvedValueOnce({
        ContentLength: 4,
        ChecksumSHA256: CHECKSUM,
        ContentType: "application/pdf",
        VersionId: "staging-version",
      })
      .mockResolvedValueOnce({ VersionId: "verified-version" })
      .mockResolvedValueOnce({})

    await expect(
      completeWorkspaceUpload(OWNER, RESERVATION),
    ).resolves.toEqual({
      key: "public-images/owner/report.pdf",
      publicUrl: expect.stringContaining("public-images/owner/report.pdf"),
    })
    expect(finishMock).toHaveBeenCalledWith(BYTE_LEASE, 4)
    expect(finishMock).toHaveBeenCalledWith(OBJECT_LEASE, 1)

    executeQueryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        claimed({ status: "committed", objectVersionId: "verified-version" }),
      ])
    s3SendMock.mockClear()
    await completeWorkspaceUpload(OWNER, RESERVATION)
    expect(s3SendMock).not.toHaveBeenCalled()
  })

  it("deletes the exact mismatched staging version and releases capacity", async () => {
    executeQueryMock.mockResolvedValueOnce([claimed()])
    s3SendMock
      .mockResolvedValueOnce({
        ContentLength: 5,
        ChecksumSHA256: CHECKSUM,
        ContentType: "application/pdf",
        VersionId: "wrong-version",
      })
      .mockResolvedValueOnce({})
    executeQueryMock.mockResolvedValueOnce([])

    await expect(
      completeWorkspaceUpload(OWNER, RESERVATION),
    ).rejects.toThrow("did not match")
    const deletion = s3SendMock.mock.calls[1]?.[0] as {
      input: Record<string, unknown>
    }
    expect(deletion.input).toMatchObject({
      Key: claimed().stagingKey,
      VersionId: "wrong-version",
    })
    expect(releaseMock).toHaveBeenCalledWith(BYTE_LEASE)
    expect(releaseMock).toHaveBeenCalledWith(OBJECT_LEASE)
  })

  it("keeps capacity charged when exact cleanup fails", async () => {
    executeQueryMock.mockResolvedValueOnce([claimed()])
    s3SendMock
      .mockResolvedValueOnce({
        ContentLength: 5,
        ChecksumSHA256: CHECKSUM,
        ContentType: "application/pdf",
        VersionId: "unclean-version",
      })
      .mockRejectedValueOnce(new Error("delete denied"))
    await expect(
      completeWorkspaceUpload(OWNER, RESERVATION),
    ).rejects.toThrow("cleanup is pending")
    expect(releaseMock).not.toHaveBeenCalled()
    expect(executeQueryMock).toHaveBeenCalledTimes(1)
  })

  it("rolls back the exact promoted version when durable settlement fails", async () => {
    executeQueryMock
      .mockResolvedValueOnce([claimed()])
      .mockResolvedValueOnce([])
    s3SendMock
      .mockResolvedValueOnce({
        ContentLength: 4,
        ChecksumSHA256: CHECKSUM,
        ContentType: "application/pdf",
        VersionId: "staging-version",
      })
      .mockResolvedValueOnce({ VersionId: "promoted-version" })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
    executeTransactionMock.mockResolvedValueOnce(undefined)

    await expect(
      completeWorkspaceUpload(OWNER, RESERVATION),
    ).rejects.toThrow("settlement was lost")
    expect(
      s3SendMock.mock.calls.some((call) => {
        const value = call[0] as { input?: Record<string, unknown> }
        return (
          value.input?.Key === claimed().targetKey &&
          value.input?.VersionId === "promoted-version"
        )
      }),
    ).toBe(true)
    expect(releaseMock).toHaveBeenCalledWith(BYTE_LEASE)
  })

  it("does not roll back or release after durable commit when lease finishing fails", async () => {
    executeQueryMock
      .mockResolvedValueOnce([claimed()])
      .mockResolvedValueOnce([])
    s3SendMock
      .mockResolvedValueOnce({
        ContentLength: 4,
        ChecksumSHA256: CHECKSUM,
        ContentType: "application/pdf",
        VersionId: "staging-version",
      })
      .mockResolvedValueOnce({ VersionId: "promoted-version" })
      .mockResolvedValueOnce({})
    finishMock.mockRejectedValue(new Error("ledger unavailable"))

    await expect(
      completeWorkspaceUpload(OWNER, RESERVATION),
    ).resolves.toEqual(expect.objectContaining({ key: claimed().targetKey }))
    expect(releaseMock).not.toHaveBeenCalled()
    expect(
      s3SendMock.mock.calls.some(
        (call) =>
          (call[0] as { input?: Record<string, unknown> }).input?.Key ===
            claimed().targetKey &&
          (call[0] as { input?: Record<string, unknown> }).input?.VersionId ===
            "promoted-version",
      ),
    ).toBe(false)
  })

  it("deletes and then uncharges only the exact superseded target version", async () => {
    executeQueryMock
      .mockResolvedValueOnce([claimed()])
      .mockResolvedValueOnce([
        { id: "old-reservation", objectVersionId: "old-version" },
      ])
    s3SendMock
      .mockResolvedValueOnce({
        ContentLength: 4,
        ChecksumSHA256: CHECKSUM,
        ContentType: "application/pdf",
        VersionId: "staging-version",
      })
      .mockResolvedValueOnce({ VersionId: "promoted-version" })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})

    await completeWorkspaceUpload(OWNER, RESERVATION)
    expect(
      s3SendMock.mock.calls.some(
        (call) =>
          (call[0] as { input?: Record<string, unknown> }).input?.Key ===
            claimed().targetKey &&
          (call[0] as { input?: Record<string, unknown> }).input?.VersionId ===
            "old-version",
      ),
    ).toBe(true)
    expect(executeQueryMock).toHaveBeenLastCalledWith(
      expect.any(Function),
      "settleSupersededWorkspaceUploadVersion",
    )
  })

  it("rejects duplicate reservation admission and owner-mismatched completion", async () => {
    executeQueryMock.mockResolvedValueOnce([])
    acquireMock.mockReset().mockResolvedValueOnce({
      allowed: false,
      reason: "duplicate",
    })
    await expect(
      createWorkspaceUploadUrl(
        OWNER,
        "users/owner",
        "note.txt",
        4,
        "session:nonce",
        "idempotency-duplicate",
        CHECKSUM,
      ),
    ).rejects.toThrow("duplicate")

    executeQueryMock.mockReset()
    executeQueryMock.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    await expect(
      completeWorkspaceUpload("attacker@example.com", RESERVATION),
    ).rejects.toThrow("unavailable")
    expect(s3SendMock).not.toHaveBeenCalled()
  })
})
