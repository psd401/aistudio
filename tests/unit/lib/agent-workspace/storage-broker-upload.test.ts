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
const withSessionMock = jest.fn<AsyncUnknownMock>()
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
  toPgRows: (value: unknown) => value,
  withUnretriedDatabaseSession: (...args: unknown[]) =>
    withSessionMock(...args),
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
let workspaceGenerationFromEntries:
  typeof import("@/lib/agent-workspace/storage-broker").workspaceGenerationFromEntries
let resetWorkspaceStorageClientForTests:
  typeof import("@/lib/agent-workspace/storage-broker").resetWorkspaceStorageClientForTests

const OWNER = "owner@example.com"
const CHECKSUM = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
const RESERVATION = "36bb0456-1c51-4fb8-97d1-4e87d02765ce"
const BYTE_LEASE = "byte-lease"
const OBJECT_LEASE = "object-lease"

function installCheckpointAwareS3(
  responses: unknown[],
  entries: Array<{ path: string; size: number; eTag: string }>,
): void {
  let responseIndex = 0
  let manifest = {
    version: 1,
    signedWorkspacePrefix: "users/owner",
    workspaceGeneration: workspaceGenerationFromEntries(entries),
    entries: entries.map((entry, index) => ({
      ...entry,
      source: "target",
      versionId: `checkpoint-target-${index}`,
      sourceETag: entry.eTag,
    })),
  }
  s3SendMock.mockImplementation(async (...args: unknown[]) => {
    const command = args[0] as {
      constructor: { name: string }
      input?: Record<string, unknown>
    }
    const input = command.input ?? {}
    const key = String(input.Key ?? "")
    if (
      command.constructor.name === "GetObjectCommand" &&
      key.endsWith("/manifest.json")
    ) {
      const body = JSON.stringify(manifest)
      return {
        ContentLength: Buffer.byteLength(body),
        Body: { transformToString: async () => body },
      }
    }
    if (
      command.constructor.name === "HeadObjectCommand" &&
      typeof input.VersionId === "string" &&
      key.startsWith("users/owner/")
    ) {
      const relative = key.slice("users/owner/".length)
      const entry = manifest.entries.find(
        (candidate) => candidate.path === relative,
      )
      if (!entry) throw new Error("missing checkpoint test entry")
      return {
        ContentLength: entry.size,
        ETag: entry.sourceETag,
        VersionId: entry.versionId,
      }
    }
    if (
      command.constructor.name === "CopyObjectCommand" &&
      key.includes("/anchors/")
    ) {
      return {
        VersionId: `anchor-${responseIndex}`,
        CopyObjectResult: { ETag: '"anchored"' },
      }
    }
    if (
      command.constructor.name === "PutObjectCommand" &&
      key.endsWith("/manifest.json")
    ) {
      manifest = JSON.parse(String(input.Body)) as typeof manifest
      return { VersionId: `manifest-${responseIndex}` }
    }
    if (responseIndex >= responses.length) {
      throw new Error(
        `unexpected ${command.constructor.name} after S3 test sequence`,
      )
    }
    const response = responses[responseIndex]
    responseIndex += 1
    if (response instanceof Error) throw response
    return response
  })
}

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
  workspaceGenerationFromEntries = broker.workspaceGenerationFromEntries
  resetWorkspaceStorageClientForTests = broker.resetWorkspaceStorageClientForTests
})

beforeEach(() => {
  jest.clearAllMocks()
  executeQueryMock.mockReset().mockResolvedValue([])
  executeTransactionMock.mockReset()
  withSessionMock.mockReset().mockImplementation(
    async (...args: unknown[]) => {
      const callback = args[0] as (session: {
        executeQuery: AsyncUnknownMock
        executeTransaction: AsyncUnknownMock
      }) => Promise<unknown>
      return callback({
        executeQuery: async (...queryArgs: unknown[]) => {
          if (
            queryArgs[1] === "tryFenceWorkspaceUploadCompletion"
          ) {
            return [{ acquired: true }]
          }
          if (
            queryArgs[1] ===
            "releaseWorkspaceUploadCompletionFence"
          ) {
            return [{ released: true }]
          }
          return executeQueryMock(...queryArgs)
        },
        executeTransaction: (...transactionArgs: unknown[]) =>
          executeTransactionMock(...transactionArgs),
      })
    },
  )
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

function defineVerifiedWorkspaceUploadReservationsSuite1Part1() {
  it("signs exact length/checksum and never exposes a public URL before verification", async () => {
    const prepared = await createPublicArtifactUpload({
                             ownerEmail: OWNER,
                             fileName: "report.pdf",
                             contentType: "application/pdf",
                             contentLength: 4,
                             contextKey: "session:nonce",
                             idempotencyKey: "idempotency-1",
                             checksumSha256: CHECKSUM,
                           })
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
      createPublicArtifactUpload({
        ownerEmail: OWNER,
        fileName: "report.png",
        contentType: "text/html",
        contentLength: 4,
        contextKey: "session:nonce",
        idempotencyKey: "idempotency-mime",
        checksumSha256: CHECKSUM,
      }),
    ).rejects.toThrow("content type")
    expect(executeQueryMock).not.toHaveBeenCalled()
    expect(acquireMock).not.toHaveBeenCalled()
  })

  it("accepts the UTF-8 HTML MIME used by the artifact publishers", async () => {
    const prepared = await createPublicArtifactUpload({
                             ownerEmail: OWNER,
                             fileName: "report.html",
                             contentType: "text/html; charset=utf-8",
                             contentLength: 4,
                             contextKey: "session:nonce",
                             idempotencyKey: "idempotency-html",
                             checksumSha256: CHECKSUM,
                           })
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

    await createPublicArtifactUpload({
            ownerEmail: OWNER,
            fileName: "report.pdf",
            contentType: "application/pdf",
            contentLength: 4,
            contextKey: "session:nonce",
            idempotencyKey: "idempotency-reconciled",
            checksumSha256: CHECKSUM,
          })

    expect(
      (s3SendMock.mock.calls[0]?.[0] as { input: Record<string, unknown> })
        .input,
    ).toMatchObject({
      Key: "public-images/owner/old.pdf",
      VersionId: "lifecycle-version",
    })
    expect(executeQueryMock).toHaveBeenCalledTimes(3)
  })

  }

function defineVerifiedWorkspaceUploadReservationsSuite1Part2() {it("keeps an old public commit charged on ambiguous S3 failure", async () => {
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

    await createPublicArtifactUpload({
            ownerEmail: OWNER,
            fileName: "report.pdf",
            contentType: "application/pdf",
            contentLength: 4,
            contextKey: "session:nonce",
            idempotencyKey: "idempotency-retained",
            checksumSha256: CHECKSUM,
          })

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
    const first = await createPublicArtifactUpload({
                          ownerEmail: OWNER,
                          fileName: "report.pdf",
                          contentType: "application/pdf",
                          contentLength: 4,
                          contextKey: "session:nonce",
                          idempotencyKey: "idempotency-retry",
                          checksumSha256: CHECKSUM,
                        })
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
    const prepared = await createWorkspaceUploadUrl({
                             ownerEmail: OWNER,
                             signedWorkspacePrefix: "users/owner",
                             relativePath: "note.txt",
                             contentLength: 4,
                             contextKey: "session:nonce",
                             idempotencyKey: "fresh-idempotency",
                             checksumSha256: CHECKSUM,
                           })
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
    const prepared = await createWorkspaceUploadUrl({
                             ownerEmail: OWNER,
                             signedWorkspacePrefix: "users/owner",
                             relativePath: "note.txt",
                             contentLength: 4,
                             contextKey: "session:nonce",
                             idempotencyKey: "fresh-idempotency",
                             checksumSha256: CHECKSUM,
                           })
    expect(prepared).toHaveProperty("uploadUrl")
    expect(acquireMock).toHaveBeenCalledTimes(2)
  })

  }

function defineVerifiedWorkspaceUploadReservationsSuite1Part3() {it("does not revive an expired reservation for resigning or completion", async () => {
    executeQueryMock.mockResolvedValueOnce([
      claimed({
        status: "reserved",
        targetKey:
          "public-images/c8cd3c6427301eaf6665bcca/report.pdf",
        expiresAt: new Date(Date.now() - 1),
      }),
    ])
    await expect(
      createPublicArtifactUpload({
        ownerEmail: OWNER,
        fileName: "report.pdf",
        contentType: "application/pdf",
        contentLength: 4,
        contextKey: "session:nonce",
        idempotencyKey: "expired-idempotency",
        checksumSha256: CHECKSUM,
      }),
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

  }

function defineVerifiedWorkspaceUploadReservationsSuite1Part4() {it("rolls back the exact promoted version when durable settlement fails", async () => {
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

  it("does not roll back a promoted version when read-after-error proves settlement committed", async () => {
    executeQueryMock
      .mockResolvedValueOnce([claimed()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          status: "committed",
          objectVersionId: "promoted-version",
        },
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
    executeTransactionMock.mockRejectedValueOnce(
      new Error("commit response lost"),
    )

    await expect(
      completeWorkspaceUpload(OWNER, RESERVATION),
    ).resolves.toEqual(
      expect.objectContaining({ key: claimed().targetKey }),
    )
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

  }

function defineVerifiedWorkspaceUploadReservationsSuite1Part5() {it("rejects duplicate reservation admission and owner-mismatched completion", async () => {
    executeQueryMock.mockResolvedValueOnce([])
    acquireMock.mockReset().mockResolvedValueOnce({
      allowed: false,
      reason: "duplicate",
    })
    await expect(
      createWorkspaceUploadUrl({
        ownerEmail: OWNER,
        signedWorkspacePrefix: "users/owner",
        relativePath: "note.txt",
        contentLength: 4,
        contextKey: "session:nonce",
        idempotencyKey: "idempotency-duplicate",
        checksumSha256: CHECKSUM,
      }),
    ).rejects.toThrow("duplicate")

    executeQueryMock.mockReset()
    executeQueryMock.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    await expect(
      completeWorkspaceUpload("attacker@example.com", RESERVATION),
    ).rejects.toThrow("unavailable")
    expect(s3SendMock).not.toHaveBeenCalled()
  })
}

// The private-CAS matrix shares stateful mock helpers across its race cases.
// eslint-disable-next-line max-lines-per-function
function defineVerifiedWorkspaceUploadReservationsSuite1Part6() {
  const privateClaimed = () =>
    claimed({
      publicArtifact: false,
      targetKey: "users/owner/state/openclaw.sqlite",
      stagingKey: `.upload-staging/private/owner/${RESERVATION}`,
      contentType: "application/octet-stream",
    })

  function enableFenceTransactions() {
    executeTransactionMock.mockImplementation(
      async (...args: unknown[]) => {
        const callback = args[0] as (tx: {
          execute: () => Promise<unknown>
        }) => Promise<unknown>
        const label = args[1]
        if (label === "fenceWorkspaceUploadCompletion") {
          return callback({ execute: async () => [] })
        }
        if (label === "settleWorkspaceUploadCompletion") {
          return { id: RESERVATION }
        }
        throw new Error(`unexpected transaction ${String(label)}`)
      },
    )
  }

  it("leaves a private reservation unclaimed when its generation fence is missing", async () => {
    executeQueryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { ...privateClaimed(), status: "reserved" },
      ])

    await expect(
      completeWorkspaceUpload(OWNER, RESERVATION),
    ).rejects.toThrow("requires an authoritative generation")

    expect(s3SendMock).not.toHaveBeenCalled()
    expect(withSessionMock).not.toHaveBeenCalled()
    expect(
      executeQueryMock.mock.calls.map((call) => call[1]),
    ).toEqual([
      "claimWorkspaceUploadCompletion",
      "getWorkspaceUploadCompletion",
    ])
  })

  it("returns a stale generation claim for deterministic retry without S3 mutation", async () => {
    enableFenceTransactions()
    executeQueryMock
      .mockResolvedValueOnce([privateClaimed()])
      .mockResolvedValueOnce([{ id: RESERVATION }])
      .mockResolvedValueOnce([privateClaimed()])
      .mockResolvedValueOnce([])
    installCheckpointAwareS3([
      {
        ContentLength: 4,
        ChecksumSHA256: CHECKSUM,
        ContentType: "application/octet-stream",
        VersionId: "staging-version",
      },
      {
        Contents: [
          {
            Key: "users/owner/state/openclaw.sqlite",
            Size: 4,
            ETag: '"remote-newer"',
          },
        ],
      },
      {
        ContentLength: 4,
        ChecksumSHA256: CHECKSUM,
        ContentType: "application/octet-stream",
        VersionId: "staging-version",
      },
      {
        Contents: [
          {
            Key: "users/owner/state/openclaw.sqlite",
            Size: 4,
            ETag: '"remote-newer"',
          },
        ],
      },
      {
        VersionId: "promoted-version",
        CopyObjectResult: { ETag: '"retried-write"' },
      },
      {},
    ], [{
      path: "state/openclaw.sqlite",
      size: 4,
      eTag: '"remote-newer"',
    }])

    await expect(
      completeWorkspaceUpload(
        OWNER,
        RESERVATION,
        "users/owner",
        "0".repeat(64),
      ),
    ).rejects.toThrow("generation changed")

    const failedAttemptCommands = s3SendMock.mock.calls.map(
      (call) => (call[0] as object).constructor.name,
    )
    expect(failedAttemptCommands).not.toContain("CopyObjectCommand")
    expect(failedAttemptCommands).not.toContain("DeleteObjectCommand")
    const currentGeneration = workspaceGenerationFromEntries([{
      path: "state/openclaw.sqlite",
      size: 4,
      eTag: '"remote-newer"',
    }])
    await expect(
      completeWorkspaceUpload(
        OWNER,
        RESERVATION,
        "users/owner",
        currentGeneration,
      ),
    ).resolves.toMatchObject({
      key: "users/owner/state/openclaw.sqlite",
      eTag: '"retried-write"',
    })
    expect(
      executeQueryMock.mock.calls.filter(
        (call) =>
          call[1] === "resetWorkspaceUploadCompletionClaim",
      ),
    ).toHaveLength(1)
  })

  it("serializes private CAS, returns the advanced generation, and retains prior versions", async () => {
    enableFenceTransactions()
    const before = [
      {
        path: "state/openclaw.sqlite",
        size: 4,
        eTag: '"remote-old"',
      },
      { path: "memory/MEMORY.md", size: 8, eTag: '"memory"' },
    ]
    const expectedGeneration = workspaceGenerationFromEntries(before)
    const expectedNextGeneration = workspaceGenerationFromEntries([
      { ...before[0], eTag: '"remote-new"' },
      before[1],
    ])
    executeQueryMock
      .mockResolvedValueOnce([privateClaimed()])
      .mockResolvedValueOnce([
        { id: "prior-reservation", objectVersionId: "prior-version" },
      ])
      .mockResolvedValueOnce([])
    installCheckpointAwareS3([
      {
        ContentLength: 4,
        ChecksumSHA256: CHECKSUM,
        ContentType: "application/octet-stream",
        VersionId: "staging-version",
      },
      {
        Contents: [
          {
            Key: "users/owner/state/openclaw.sqlite",
            Size: 4,
            ETag: '"remote-old"',
          },
          {
            Key: "users/owner/memory/MEMORY.md",
            Size: 8,
            ETag: '"memory"',
          },
        ],
      },
      {
        VersionId: "promoted-version",
        CopyObjectResult: { ETag: '"remote-new"' },
      },
      {},
    ], before)

    await expect(
      completeWorkspaceUpload(
        OWNER,
        RESERVATION,
        "users/owner",
        expectedGeneration,
      ),
    ).resolves.toEqual({
      key: "users/owner/state/openclaw.sqlite",
      eTag: '"remote-new"',
      workspaceGeneration: expectedNextGeneration,
    })

    const deletions = s3SendMock.mock.calls
      .map((call) => call[0] as { constructor: { name: string }; input?: {
        Key?: string
        VersionId?: string
      } })
      .filter((command) => command.constructor.name === "DeleteObjectCommand")
    expect(deletions).toHaveLength(1)
    expect(deletions[0]?.input).toMatchObject({
      Key: privateClaimed().stagingKey,
      VersionId: "staging-version",
    })
    expect(executeTransactionMock).toHaveBeenCalledWith(
      expect.any(Function),
      "settleWorkspaceUploadCompletion",
    )
  })

  it("atomically releases superseded private quota when the commit response is lost", async () => {
    const priorReservationId =
      "31d04355-4ae6-49e2-b3e8-83d3157dde78"
    let currentStatus = "verifying"
    let currentVersion: string | null = null
    let priorStatus = "committed"
    executeQueryMock.mockImplementation(
      async (...args: unknown[]) => {
        const label = args[1]
        if (label === "claimWorkspaceUploadCompletion") {
          return [privateClaimed()]
        }
        if (label === "getSupersededWorkspaceUploadVersions") {
          return [{
            id: priorReservationId,
            objectVersionId: "prior-version",
          }]
        }
        if (label === "confirmWorkspaceUploadSettlement") {
          return [{
            status: currentStatus,
            objectVersionId: currentVersion,
          }]
        }
        if (
          label === "confirmSupersededWorkspaceUploadSettlement"
        ) {
          return [{ id: priorReservationId, status: priorStatus }]
        }
        return []
      },
    )
    executeTransactionMock.mockImplementation(
      async (...args: unknown[]) => {
        const callback = args[0] as (
          tx: unknown,
        ) => Promise<unknown>
        const label = args[1]
        if (label === "fenceWorkspaceUploadCompletion") {
          return callback({
            execute: async () => [],
          })
        }
        if (label !== "settleWorkspaceUploadCompletion") {
          throw new Error(`unexpected transaction ${String(label)}`)
        }
        let updateIndex = 0
        const transaction = {
          update: () => {
            updateIndex += 1
            const builder = {
              set: () => builder,
              where: () => builder,
              returning: async () => {
                if (updateIndex === 1) {
                  currentStatus = "committed"
                  currentVersion = "promoted-version"
                  return [{ id: RESERVATION }]
                }
                priorStatus = "superseded"
                return [{ id: priorReservationId }]
              },
            }
            return builder
          },
        }
        await callback(transaction)
        throw new Error("transaction committed but response was lost")
      },
    )
    const before = [{
      path: "state/openclaw.sqlite",
      size: 4,
      eTag: '"remote-old"',
    }]
    installCheckpointAwareS3([
      {
        ContentLength: 4,
        ChecksumSHA256: CHECKSUM,
        ContentType: "application/octet-stream",
        VersionId: "staging-version",
      },
      {
        Contents: [{
          Key: "users/owner/state/openclaw.sqlite",
          Size: 4,
          ETag: '"remote-old"',
        }],
      },
      {
        VersionId: "promoted-version",
        CopyObjectResult: { ETag: '"remote-new"' },
      },
      {},
    ], before)

    await expect(
      completeWorkspaceUpload(
        OWNER,
        RESERVATION,
        "users/owner",
        workspaceGenerationFromEntries(before),
      ),
    ).resolves.toMatchObject({
      key: "users/owner/state/openclaw.sqlite",
      eTag: '"remote-new"',
    })

    expect(currentStatus).toBe("committed")
    expect(priorStatus).toBe("superseded")
    expect(executeTransactionMock).toHaveBeenCalledWith(
      expect.any(Function),
      "settleWorkspaceUploadCompletion",
    )
    expect(
      executeQueryMock.mock.calls.some(
        (call) =>
          call[1] === "markSupersededWorkspaceVersionsRetained",
      ),
    ).toBe(false)
    const targetDeletes = s3SendMock.mock.calls.filter((call) => {
      const command = call[0] as {
        constructor: { name: string }
        input?: { Key?: string }
      }
      return (
        command.constructor.name === "DeleteObjectCommand" &&
        command.input?.Key === privateClaimed().targetKey
      )
    })
    expect(targetDeletes).toHaveLength(0)
  })

  it("recovers a promoted target when settlement stayed verifying", async () => {
    let reservationStatus = "reserved"
    let settlementAttempts = 0
    executeQueryMock.mockImplementation(
      async (...args: unknown[]) => {
        const label = args[1]
        if (label === "claimWorkspaceUploadCompletion") {
          if (reservationStatus !== "reserved") return []
          reservationStatus = "verifying"
          return [{ ...privateClaimed(), status: "verifying" }]
        }
        if (label === "getWorkspaceUploadCompletion") {
          return [{
            ...privateClaimed(),
            status: reservationStatus,
            objectVersionId: null,
          }]
        }
        if (label === "getSupersededWorkspaceUploadVersions") {
          return []
        }
        if (label === "confirmWorkspaceUploadSettlement") {
          return [{
            status: reservationStatus,
            objectVersionId: null,
          }]
        }
        return []
      },
    )
    executeTransactionMock.mockImplementation(
      async (...args: unknown[]) => {
        const label = args[1]
        if (label !== "settleWorkspaceUploadCompletion") {
          throw new Error(`unexpected transaction ${String(label)}`)
        }
        settlementAttempts += 1
        if (settlementAttempts === 1) {
          throw new Error("commit outcome unavailable")
        }
        reservationStatus = "committed"
        return { id: RESERVATION }
      },
    )
    const checkpointEntries = [{
      path: "state/openclaw.sqlite",
      size: 4,
      eTag: '"remote-old"',
    }]
    installCheckpointAwareS3([
      {
        ContentLength: 4,
        ChecksumSHA256: CHECKSUM,
        ContentType: "application/octet-stream",
        VersionId: "staging-version",
      },
      {
        Contents: [{
          Key: "users/owner/state/openclaw.sqlite",
          Size: 4,
          ETag: '"remote-old"',
        }],
      },
      {
        VersionId: "promoted-version",
        CopyObjectResult: { ETag: '"remote-new"' },
      },
      {},
      {
        ContentLength: 4,
        ChecksumSHA256: CHECKSUM,
        ContentType: "application/octet-stream",
        VersionId: "promoted-version",
        ETag: '"remote-new"',
      },
      {
        Contents: [{
          Key: "users/owner/state/openclaw.sqlite",
          Size: 4,
          ETag: '"remote-new"',
        }],
      },
    ], checkpointEntries)
    const expectedGeneration = workspaceGenerationFromEntries(
      checkpointEntries,
    )

    await expect(
      completeWorkspaceUpload(
        OWNER,
        RESERVATION,
        "users/owner",
        expectedGeneration,
      ),
    ).rejects.toThrow("commit outcome unavailable")
    expect(reservationStatus).toBe("verifying")
    expect(
      s3SendMock.mock.calls.some((call) => {
        const command = call[0] as {
          constructor: { name: string }
          input?: { Key?: string }
        }
        return (
          command.constructor.name === "DeleteObjectCommand" &&
          command.input?.Key === privateClaimed().targetKey
        )
      }),
    ).toBe(false)

    await expect(
      completeWorkspaceUpload(
        OWNER,
        RESERVATION,
        "users/owner",
        expectedGeneration,
      ),
    ).resolves.toMatchObject({
      key: "users/owner/state/openclaw.sqlite",
      eTag: '"remote-new"',
    })
    expect(reservationStatus).toBe("committed")
    expect(settlementAttempts).toBe(2)
  })

  it("reconstructs generation metadata when a committed completion response was lost", async () => {
    enableFenceTransactions()
    const committed = {
      ...privateClaimed(),
      status: "committed",
      objectVersionId: "promoted-version",
    }
    executeQueryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([committed])
    s3SendMock
      .mockResolvedValueOnce({
        ContentLength: 4,
        ChecksumSHA256: CHECKSUM,
        ContentType: "application/octet-stream",
        VersionId: "promoted-version",
        ETag: '"remote-new"',
      })
      .mockResolvedValueOnce({
        Contents: [
          {
            Key: "users/owner/state/openclaw.sqlite",
            Size: 4,
            ETag: '"remote-new"',
          },
        ],
      })
    const expected = workspaceGenerationFromEntries([
      {
        path: "state/openclaw.sqlite",
        size: 4,
        eTag: '"remote-new"',
      },
    ])

    await expect(
      completeWorkspaceUpload(
        OWNER,
        RESERVATION,
        "users/owner",
        "0".repeat(64),
      ),
    ).resolves.toEqual({
      key: "users/owner/state/openclaw.sqlite",
      eTag: '"remote-new"',
      workspaceGeneration: expected,
    })
    expect(
      s3SendMock.mock.calls.some(
        (call) =>
          (call[0] as object).constructor.name === "CopyObjectCommand",
      ),
    ).toBe(false)
  })

  // This single concurrency witness must keep both callers in one test scope.
  // eslint-disable-next-line max-lines-per-function
  it("serializes a retry behind the first private claim and then reconstructs committed metadata", async () => {
    let reservationStatus = "reserved"
    let objectVersionId: string | null = null
    let signalClaimed!: () => void
    const firstClaimed = new Promise<void>((resolve) => {
      signalClaimed = resolve
    })
    let releaseStagedHead!: () => void
    const stagedHeadGate = new Promise<void>((resolve) => {
      releaseStagedHead = resolve
    })
    executeQueryMock.mockImplementation(
      async (...args: unknown[]) => {
        const label = args[1]
        if (label === "claimWorkspaceUploadCompletion") {
          if (reservationStatus !== "reserved") return []
          reservationStatus = "verifying"
          signalClaimed()
          return [{ ...privateClaimed(), status: "verifying" }]
        }
        if (label === "getWorkspaceUploadCompletion") {
          return [{
            ...privateClaimed(),
            status: reservationStatus,
            objectVersionId,
          }]
        }
        if (label === "getSupersededWorkspaceUploadVersions") return []
        return []
      },
    )
    let fenceHeld = false
    withSessionMock.mockImplementation(
      async (...args: unknown[]) => {
        const callback = args[0] as (session: {
          executeQuery: AsyncUnknownMock
          executeTransaction: AsyncUnknownMock
        }) => Promise<unknown>
        return callback({
          executeQuery: async (...queryArgs: unknown[]) => {
            if (
              queryArgs[1] === "tryFenceWorkspaceUploadCompletion"
            ) {
              if (fenceHeld) return [{ acquired: false }]
              fenceHeld = true
              return [{ acquired: true }]
            }
            if (
              queryArgs[1] ===
              "releaseWorkspaceUploadCompletionFence"
            ) {
              const released = fenceHeld
              fenceHeld = false
              return [{ released }]
            }
            return executeQueryMock(...queryArgs)
          },
          executeTransaction: (...transactionArgs: unknown[]) =>
            executeTransactionMock(...transactionArgs),
        })
      },
    )
    executeTransactionMock.mockImplementation(
      async (...args: unknown[]) => {
        const label = args[1]
        if (label === "settleWorkspaceUploadCompletion") {
          reservationStatus = "committed"
          objectVersionId = "promoted-version"
          return { id: RESERVATION }
        }
        throw new Error(`unexpected transaction ${String(label)}`)
      },
    )
    const expectedGeneration = workspaceGenerationFromEntries([{
      path: "state/openclaw.sqlite",
      size: 4,
      eTag: '"remote-old"',
    }])
    let checkpointManifest = {
      version: 1,
      signedWorkspacePrefix: "users/owner",
      workspaceGeneration: expectedGeneration,
      entries: [{
        path: "state/openclaw.sqlite",
        size: 4,
        eTag: '"remote-old"',
        source: "target",
        versionId: "checkpoint-target",
        sourceETag: '"remote-old"',
      }],
    }
    let headCount = 0
    s3SendMock.mockImplementation(
      async (...args: unknown[]) => {
        const command = args[0] as {
          constructor: { name: string }
          input?: Record<string, unknown>
        }
        const input = command.input ?? {}
        const key = String(input.Key ?? "")
        if (
          command.constructor.name === "GetObjectCommand" &&
          key.endsWith("/manifest.json")
        ) {
          const body = JSON.stringify(checkpointManifest)
          return {
            ContentLength: Buffer.byteLength(body),
            Body: { transformToString: async () => body },
          }
        }
        if (command.constructor.name === "HeadObjectCommand") {
          if (input.VersionId === "checkpoint-target") {
            return {
              ContentLength: 4,
              VersionId: "checkpoint-target",
              ETag: '"remote-old"',
            }
          }
          headCount += 1
          if (headCount === 1) {
            await stagedHeadGate
            return {
              ContentLength: 4,
              ChecksumSHA256: CHECKSUM,
              ContentType: "application/octet-stream",
              VersionId: "staging-version",
            }
          }
          return {
            ContentLength: 4,
            ChecksumSHA256: CHECKSUM,
            ContentType: "application/octet-stream",
            VersionId: "promoted-version",
            ETag: '"remote-new"',
          }
        }
        if (
          command.constructor.name === "PutObjectCommand" &&
          key.endsWith("/manifest.json")
        ) {
          checkpointManifest = JSON.parse(
            String(input.Body),
          ) as typeof checkpointManifest
          return { VersionId: "checkpoint-manifest" }
        }
        if (command.constructor.name === "ListObjectsV2Command") {
          return {
            Contents: [{
              Key: "users/owner/state/openclaw.sqlite",
              Size: 4,
              ETag:
                reservationStatus === "committed"
                  ? '"remote-new"'
                  : '"remote-old"',
            }],
          }
        }
        if (command.constructor.name === "CopyObjectCommand") {
          if (key.includes("/anchors/")) {
            return {
              VersionId: "anchor-version",
              CopyObjectResult: { ETag: '"anchor-old"' },
            }
          }
          return {
            VersionId: "promoted-version",
            CopyObjectResult: { ETag: '"remote-new"' },
          }
        }
        return {}
      },
    )
    const first = completeWorkspaceUpload(
      OWNER,
      RESERVATION,
      "users/owner",
      expectedGeneration,
    )
    await firstClaimed
    const retry = completeWorkspaceUpload(
      OWNER,
      RESERVATION,
      "users/owner",
      expectedGeneration,
    )
    releaseStagedHead()

    const [firstResult, retryResult] = await Promise.all([first, retry])
    expect(firstResult.workspaceGeneration).toBe(
      retryResult.workspaceGeneration,
    )
    expect(retryResult).toMatchObject({
      key: "users/owner/state/openclaw.sqlite",
      eTag: '"remote-new"',
    })
    expect(headCount).toBe(2)
    expect(
      executeTransactionMock.mock.calls.some(
        (call) => call[1] === "fenceWorkspaceUploadCompletion",
      ),
    ).toBe(false)
  })
}

const defineVerifiedWorkspaceUploadReservationsSuite1 = () => {
  defineVerifiedWorkspaceUploadReservationsSuite1Part1()
  defineVerifiedWorkspaceUploadReservationsSuite1Part2()
  defineVerifiedWorkspaceUploadReservationsSuite1Part3()
  defineVerifiedWorkspaceUploadReservationsSuite1Part4()
  defineVerifiedWorkspaceUploadReservationsSuite1Part5()
  defineVerifiedWorkspaceUploadReservationsSuite1Part6()
};

describe("verified workspace upload reservations", defineVerifiedWorkspaceUploadReservationsSuite1)
