/** @jest-environment node */

/**
 * The broker wiring for the public-link contents gate (#1886).
 *
 * public-artifact-personal-data.test.ts covers the RULE. This file covers what
 * the broker does with it: that the scan happens between staging verification
 * and promotion, that a refusal leaves no `public-images/` object behind, that
 * the staged version is deleted and the reservation marked rejected, and that
 * the error names the kinds and not the values.
 *
 * This is the issue's own acceptance test: stage a CSV with three 7-digit
 * student IDs, complete the upload, get `personal_data_detected` and no public
 * object.
 */

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
  isCapacityDenial: (admission: { allowed: boolean; reason?: string }) =>
    !admission.allowed && admission.reason !== "duplicate",
}))

let completeWorkspaceUpload:
  typeof import("@/lib/agent-workspace/storage-broker").completeWorkspaceUpload
let resetWorkspaceStorageClientForTests:
  typeof import("@/lib/agent-workspace/storage-broker").resetWorkspaceStorageClientForTests
let WorkspacePublicArtifactRefusedError:
  typeof import("@/lib/agent-workspace/storage-broker").WorkspacePublicArtifactRefusedError

const OWNER = "owner@example.com"
const CHECKSUM = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
const RESERVATION = "36bb0456-1c51-4fb8-97d1-4e87d02765ce"
const BYTE_LEASE = "byte-lease"
const OBJECT_LEASE = "object-lease"
const STAGING_KEY = `.upload-staging/public/owner/${RESERVATION}`

const ROSTER_CSV = [
  "student_id,last,first,grade",
  "2240393,Garcia,Maria,7",
  "2187654,Nguyen,Liam,7",
  "2203311,Okafor,Ada,8",
].join("\n")

function claimedCsv(body: string) {
  return {
    id: RESERVATION,
    ownerKey: OWNER,
    publicArtifact: true,
    stagingKey: STAGING_KEY,
    targetKey: "public-images/owner/roster.csv",
    expectedBytes: Buffer.byteLength(body),
    checksumSha256: CHECKSUM,
    contentType: "text/csv",
    byteLeaseId: BYTE_LEASE,
    objectLeaseId: OBJECT_LEASE,
    status: "verifying",
    expiresAt: new Date(Date.now() + 60_000),
  }
}

/**
 * Answer by command type rather than by a fixed sequence, so a test reads as
 * "staging verifies, the object is fetched, nothing is copied" instead of as
 * a list of positional responses.
 */
function installS3(body: string, options: { stagingVersion?: string } = {}) {
  const stagingVersion = options.stagingVersion ?? "staging-version"
  s3SendMock.mockImplementation(async (...args: unknown[]) => {
    const command = args[0] as {
      constructor: { name: string }
      input: Record<string, unknown>
    }
    switch (command.constructor.name) {
      case "HeadObjectCommand":
        return {
          ContentLength: Buffer.byteLength(body),
          ChecksumSHA256: CHECKSUM,
          ContentType: "text/csv",
          VersionId: stagingVersion,
        }
      case "GetObjectCommand":
        return {
          Body: {
            transformToByteArray: async () =>
              new Uint8Array(Buffer.from(body, "utf8")),
          },
        }
      case "DeleteObjectCommand":
        return {}
      case "CopyObjectCommand":
        return {
          VersionId: "promoted-version",
          CopyObjectResult: { ETag: '"promoted"' },
        }
      default:
        throw new Error(`unexpected ${command.constructor.name}`)
    }
  })
}

function s3Calls(name: string) {
  return s3SendMock.mock.calls
    .map((call) => call[0] as { constructor: { name: string }; input: Record<string, unknown> })
    .filter((command) => command.constructor.name === name)
}

beforeAll(async () => {
  const broker = await import("@/lib/agent-workspace/storage-broker")
  completeWorkspaceUpload = broker.completeWorkspaceUpload
  resetWorkspaceStorageClientForTests = broker.resetWorkspaceStorageClientForTests
  WorkspacePublicArtifactRefusedError = broker.WorkspacePublicArtifactRefusedError
})

beforeEach(() => {
  jest.clearAllMocks()
  executeQueryMock.mockReset().mockResolvedValue([])
  executeTransactionMock.mockReset().mockImplementation(
    async (...args: unknown[]) => {
      if (args[1] === "settleWorkspaceUploadCompletion") {
        return { id: RESERVATION }
      }
      throw new Error(`unexpected transaction ${String(args[1])}`)
    },
  )
  withSessionMock.mockReset()
  acquireMock.mockReset()
  finishMock.mockReset().mockResolvedValue(undefined)
  releaseMock.mockReset().mockResolvedValue(undefined)
  s3SendMock.mockReset()
  signedUrlMock.mockReset().mockResolvedValue("https://example.invalid/signed")
  process.env.AGENT_WORKSPACE_BUCKET = "workspace-bucket"
  resetWorkspaceStorageClientForTests()
})

describe("public link contents gate", () => {
  it("refuses a roster CSV and writes no public object", async () => {
    executeQueryMock.mockResolvedValueOnce([claimedCsv(ROSTER_CSV)])
    installS3(ROSTER_CSV)

    const refusal = await completeWorkspaceUpload(OWNER, RESERVATION).then(
      () => null,
      (error: unknown) => error,
    )

    expect(refusal).toBeInstanceOf(WorkspacePublicArtifactRefusedError)
    const typed = refusal as InstanceType<
      typeof WorkspacePublicArtifactRefusedError
    >
    expect(typed.code).toBe("personal_data_detected")
    expect(typed.kinds).toEqual(["psd-student-id"])
    // The kinds, never the values: the refusal must not carry the personal
    // data onwards into a log line or a response body.
    expect(typed.message).not.toContain("2240393")

    // Nothing was promoted into the unsigned prefix.
    expect(s3Calls("CopyObjectCommand")).toHaveLength(0)
  })

  it("deletes the exact staged version and marks the reservation rejected", async () => {
    executeQueryMock.mockResolvedValueOnce([claimedCsv(ROSTER_CSV)])
    installS3(ROSTER_CSV, { stagingVersion: "staging-v9" })

    await expect(
      completeWorkspaceUpload(OWNER, RESERVATION),
    ).rejects.toThrow("Public link refused")

    const deletions = s3Calls("DeleteObjectCommand")
    expect(deletions).toHaveLength(1)
    expect(deletions[0]!.input).toMatchObject({
      Key: STAGING_KEY,
      VersionId: "staging-v9",
    })
    expect(
      executeQueryMock.mock.calls.some(
        (call) => call[1] === "rejectWorkspaceUploadCompletion",
      ),
    ).toBe(true)
    // Capacity goes back: a refused upload must not keep the owner charged.
    expect(releaseMock).toHaveBeenCalledWith(BYTE_LEASE)
    expect(releaseMock).toHaveBeenCalledWith(OBJECT_LEASE)
  })

  it("reads the staged object by its verified version, range-capped", async () => {
    executeQueryMock.mockResolvedValueOnce([claimedCsv(ROSTER_CSV)])
    installS3(ROSTER_CSV, { stagingVersion: "staging-v9" })
    await expect(
      completeWorkspaceUpload(OWNER, RESERVATION),
    ).rejects.toThrow("Public link refused")

    const gets = s3Calls("GetObjectCommand")
    expect(gets).toHaveLength(1)
    // The verified version, not "whatever is at the key now".
    expect(gets[0]!.input).toMatchObject({
      Key: STAGING_KEY,
      VersionId: "staging-v9",
    })
    expect(String(gets[0]!.input.Range)).toMatch(/^bytes=0-\d+$/)
  })

  it("promotes a clean CSV exactly as before", async () => {
    const clean = "school,open_house\nHarbor Ridge,Thursday 6pm\n"
    executeQueryMock.mockResolvedValueOnce([claimedCsv(clean)])
    installS3(clean)

    await expect(
      completeWorkspaceUpload(OWNER, RESERVATION),
    ).resolves.toEqual({
      key: "public-images/owner/roster.csv",
      publicUrl: expect.stringContaining("public-images/owner/roster.csv"),
    })
    expect(s3Calls("CopyObjectCommand")).toHaveLength(1)
  })

  it("does not fetch a binary public upload at all", async () => {
    const png = "\x89PNG\r\n\x1A\n"
    executeQueryMock.mockResolvedValueOnce([
      {
        ...claimedCsv(png),
        targetKey: "public-images/owner/chart.png",
        contentType: "image/png",
      },
    ])
    s3SendMock.mockImplementation(async (...args: unknown[]) => {
      const command = args[0] as { constructor: { name: string } }
      switch (command.constructor.name) {
        case "HeadObjectCommand":
          return {
            ContentLength: Buffer.byteLength(png),
            ChecksumSHA256: CHECKSUM,
            ContentType: "image/png",
            VersionId: "staging-version",
          }
        case "CopyObjectCommand":
          return {
            VersionId: "promoted-version",
            CopyObjectResult: { ETag: '"promoted"' },
          }
        case "DeleteObjectCommand":
          return {}
        default:
          throw new Error(`unexpected ${command.constructor.name}`)
      }
    })

    await expect(
      completeWorkspaceUpload(OWNER, RESERVATION),
    ).resolves.toMatchObject({ key: "public-images/owner/chart.png" })
    expect(s3Calls("GetObjectCommand")).toHaveLength(0)
  })
})
