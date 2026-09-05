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

const executeQueryMock = jest.fn<AsyncUnknownMock>()
const releaseMock = jest.fn<AsyncUnknownMock>()

jest.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  return {
    S3Client: class S3Client {
      send = jest.fn()
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
  getSignedUrl: jest.fn(),
}))
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
  executeTransaction: jest.fn(),
  toPgRows: (value: unknown) => value,
  withUnretriedDatabaseSession: jest.fn(),
}))
jest.mock("@/lib/resource-admission", () => ({
  acquireResourceAdmission: jest.fn(),
  finishResourceAdmission: jest.fn(),
  releaseResourceAdmission: (...args: unknown[]) => releaseMock(...args),
  isCapacityDenial: () => false,
}))

let releaseWorkspaceUploads:
  typeof import("@/lib/agent-workspace/storage-broker").releaseWorkspaceUploads

const OWNER = "Owner@Example.com"
const RESERVATION_A = "36bb0456-1c51-4fb8-97d1-4e87d02765ce"
const RESERVATION_B = "8f2c1c2a-9b21-4c0b-9a5d-1d1f4b6a7c31"

beforeAll(async () => {
  const broker = await import("@/lib/agent-workspace/storage-broker")
  releaseWorkspaceUploads = broker.releaseWorkspaceUploads
})

beforeEach(() => {
  jest.clearAllMocks()
  executeQueryMock.mockReset().mockResolvedValue([])
  releaseMock.mockReset().mockResolvedValue(undefined)
})

describe("releaseWorkspaceUploads", () => {
  it("does nothing at all for an empty batch", async () => {
    await expect(releaseWorkspaceUploads(OWNER, [])).resolves.toEqual({
      released: 0,
    })
    expect(executeQueryMock).not.toHaveBeenCalled()
  })

  it("expires the batch's reserved rows and gives their leases back", async () => {
    executeQueryMock.mockResolvedValueOnce([
      { byteLeaseId: "byte-a", objectLeaseId: "object-a" },
      // Since migration 154 an upload may be admitted with no lease at all.
      { byteLeaseId: null, objectLeaseId: null },
    ])

    await expect(
      releaseWorkspaceUploads(OWNER, [RESERVATION_A, RESERVATION_B]),
    ).resolves.toEqual({ released: 2 })

    expect(executeQueryMock).toHaveBeenCalledTimes(1)
    expect(executeQueryMock.mock.calls[0][1]).toBe(
      "releaseWorkspaceUploadReservations",
    )
    expect(releaseMock.mock.calls.map((call) => call[0])).toEqual([
      "byte-a",
      "object-a",
    ])
  })

  it("rejects a malformed reservation id before touching the database", async () => {
    await expect(
      releaseWorkspaceUploads(OWNER, [RESERVATION_A, "not-a-uuid"]),
    ).rejects.toThrow("Invalid upload reservation")
    expect(executeQueryMock).not.toHaveBeenCalled()
  })

  it("rejects a batch larger than one finalization can produce", async () => {
    await expect(
      releaseWorkspaceUploads(
        OWNER,
        Array.from({ length: 251 }, () => RESERVATION_A),
      ),
    ).rejects.toThrow("Invalid upload reservation release batch")
    expect(executeQueryMock).not.toHaveBeenCalled()
  })

  it("survives a lease store that is refusing releases", async () => {
    executeQueryMock.mockResolvedValueOnce([
      { byteLeaseId: "byte-a", objectLeaseId: "object-a" },
    ])
    releaseMock.mockRejectedValue(new Error("lease store down"))

    await expect(
      releaseWorkspaceUploads(OWNER, [RESERVATION_A]),
    ).resolves.toEqual({ released: 1 })
  })
})
