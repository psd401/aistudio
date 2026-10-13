/** @jest-environment node */

/**
 * Broker side of private Drive delivery (#1885).
 *
 * The invariants under test are the containment ones: a delivery is bounded to
 * the calling owner, a reservation staged for anything else cannot be redirected
 * into Drive, the staged bytes are proved against their reservation before they
 * leave S3, the staging object does not survive a successful delivery, and a
 * failed share never degrades into a public link.
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
const mintMock = jest.fn<AsyncUnknownMock>()

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
  withUnretriedDatabaseSession: (...args: unknown[]) => withSessionMock(...args),
}))
jest.mock("@/lib/resource-admission", () => ({
  acquireResourceAdmission: (...args: unknown[]) => acquireMock(...args),
  finishResourceAdmission: (...args: unknown[]) => finishMock(...args),
  releaseResourceAdmission: (...args: unknown[]) => releaseMock(...args),
  isCapacityDenial: (admission: { allowed: boolean; reason?: string }) =>
    !admission.allowed && admission.reason !== "duplicate",
}))
// The real mint client reaches for Lambda/WIF. The derivation guard it wraps is
// covered by tests/unit/dwd-token-broker.test.ts; here the token is a given.
jest.mock("@/lib/agent-workspace/mint-client", () => ({
  mintAgentWorkspaceTokenViaBoundary: (...args: unknown[]) => mintMock(...args),
}))

let broker: typeof import("@/lib/agent-workspace/storage-broker")

const OWNER = "jsmith@psd401.net"
const OTHER_OWNER = "someone.else@psd401.net"
const AGENT = "agnt_jsmith@psd401.net"
const CHECKSUM = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
const RESERVATION = "36bb0456-1c51-4fb8-97d1-4e87d02765ce"
const IDEMPOTENCY = "9f1a2b3c-4d5e-4f60-8718-2c3d4e5f6071"
const STAGING_KEY = `.upload-staging/private/ownerhash/${RESERVATION}`
const STAGING_VERSION = "staging-version-1"
const PPTX =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation"
const BODY = new Uint8Array([1, 2, 3, 4])

function reservationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RESERVATION,
    ownerKey: OWNER,
    contextKey: "session:nonce",
    idempotencyKey: IDEMPOTENCY,
    publicArtifact: false,
    stagingKey: STAGING_KEY,
    targetKey: broker.driveDeliveryTargetKey(OWNER, IDEMPOTENCY, "deck.pptx"),
    expectedBytes: BODY.byteLength,
    checksumSha256: CHECKSUM,
    contentType: PPTX,
    byteLeaseId: "byte-lease",
    objectLeaseId: "object-lease",
    status: "reserved",
    objectVersionId: null,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  }
}

/** executeQuery answers keyed by the broker's own query labels. */
function installQueries(answers: Record<string, unknown>): void {
  executeQueryMock.mockImplementation(async (...args: unknown[]) => {
    const label = String(args[1])
    if (label in answers) {
      const answer = answers[label]
      if (answer instanceof Error) throw answer
      return answer
    }
    return []
  })
}

function installS3(options: { stagedMatches?: boolean; deleteFails?: boolean } = {}) {
  const { stagedMatches = true, deleteFails = false } = options
  s3SendMock.mockImplementation(async (...args: unknown[]) => {
    const command = args[0] as {
      constructor: { name: string }
      input: Record<string, unknown>
    }
    switch (command.constructor.name) {
      case "HeadObjectCommand":
        return {
          VersionId: STAGING_VERSION,
          ContentLength: stagedMatches ? BODY.byteLength : BODY.byteLength + 1,
          ChecksumSHA256: CHECKSUM,
          ContentType: PPTX,
        }
      case "GetObjectCommand":
        return { Body: { transformToByteArray: async () => BODY } }
      case "DeleteObjectCommand":
        if (deleteFails) throw new Error("s3 delete refused")
        return {}
      default:
        throw new Error(`unexpected ${command.constructor.name}`)
    }
  })
}

type DriveState = {
  created: Array<{ name: string; mimeType: string; bytes: number }>
  permissions: Array<{ type: string; role: string; emailAddress: string }>
  deleted: string[]
}

function fakeDrive(options: { failShareWith?: number } = {}): {
  state: DriveState
  deps: { fetchImpl: typeof fetch }
} {
  const state: DriveState = { created: [], permissions: [], deleted: [] }
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input)
    if (url.includes("/upload/drive/v3/files") && init?.method === "POST") {
      const metadata = JSON.parse(String(init.body)) as {
        name: string
        mimeType: string
      }
      state.created.push({ ...metadata, bytes: 0 })
      return new Response("{}", {
        status: 200,
        headers: { location: "https://upload.example/session" },
      })
    }
    if (url.startsWith("https://upload.example/session")) {
      const last = state.created.at(-1)
      if (last) last.bytes = Number(init?.headers?.["Content-Length" as never])
      return new Response(
        JSON.stringify({
          id: "drive-file-1",
          webViewLink: "https://drive.google.com/file/d/drive-file-1/view",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }
    if (url.includes("/permissions")) {
      if (options.failShareWith) {
        return new Response("sharing quota exceeded", {
          status: options.failShareWith,
        })
      }
      state.permissions.push(
        JSON.parse(String(init?.body)) as DriveState["permissions"][number],
      )
      return new Response(JSON.stringify({ id: "perm-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    if (init?.method === "DELETE") {
      state.deleted.push(url)
      return new Response("", { status: 204 })
    }
    throw new Error(`unexpected Drive call ${init?.method} ${url}`)
  }) as unknown as typeof fetch
  return { state, deps: { fetchImpl } }
}

beforeAll(async () => {
  broker = await import("@/lib/agent-workspace/storage-broker")
})

beforeEach(() => {
  jest.clearAllMocks()
  executeQueryMock.mockReset().mockResolvedValue([])
  executeTransactionMock.mockReset().mockImplementation(async (...args) => {
    const label = args[1]
    if (label === "createWorkspaceUploadReservation") {
      return { id: RESERVATION, stagingKey: STAGING_KEY }
    }
    if (label === "settleWorkspaceUploadCompletion") return { id: RESERVATION }
    throw new Error(`unexpected transaction ${String(label)}`)
  })
  withSessionMock.mockReset()
  acquireMock
    .mockReset()
    .mockResolvedValueOnce({ allowed: true, leaseId: "byte-lease" })
    .mockResolvedValueOnce({ allowed: true, leaseId: "object-lease" })
  finishMock.mockReset().mockResolvedValue(undefined)
  releaseMock.mockReset().mockResolvedValue(undefined)
  s3SendMock.mockReset()
  signedUrlMock
    .mockReset()
    .mockResolvedValue(
      "https://workspace-bucket.s3.amazonaws.com/staging" +
        "?X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256",
    )
  mintMock
    .mockReset()
    .mockResolvedValue({ accessToken: "agent-token", agentEmail: AGENT })
  process.env.AGENT_WORKSPACE_BUCKET = "workspace-bucket"
  broker.resetWorkspaceStorageClientForTests()
})

describe("driveDeliveryTargetKey / driveDeliveryFileName", () => {
  it("round-trips a deliverable name under the owner's own prefix", () => {
    const key = broker.driveDeliveryTargetKey(OWNER, IDEMPOTENCY, "deck.pptx")
    expect(key).toMatch(/^\.drive-delivery\/[0-9a-f]{24}\/[0-9a-f]{24}\/deck\.pptx$/)
    expect(broker.driveDeliveryFileName(OWNER, key)).toBe("deck.pptx")
  })

  it("is stable for one idempotency key and distinct across attempts", () => {
    const first = broker.driveDeliveryTargetKey(OWNER, IDEMPOTENCY, "deck.pptx")
    expect(broker.driveDeliveryTargetKey(OWNER, IDEMPOTENCY, "deck.pptx")).toBe(
      first,
    )
    // A retry carries a new idempotency key, so it cannot collide with the
    // first attempt's row in uq_workspace_upload_target_active.
    expect(
      broker.driveDeliveryTargetKey(
        OWNER,
        "11111111-2222-4333-8444-555555555555",
        "deck.pptx",
      ),
    ).not.toBe(first)
  })

  it("refuses another owner's Drive-delivery key", () => {
    const foreign = broker.driveDeliveryTargetKey(
      OTHER_OWNER,
      IDEMPOTENCY,
      "deck.pptx",
    )
    expect(() => broker.driveDeliveryFileName(OWNER, foreign)).toThrow(
      "Invalid owner Drive delivery key",
    )
  })

  it.each([
    "public-images/ownerhash/deck.pptx",
    "users/jsmith/deck.pptx",
    ".drive-delivery/ownerhash/deck.pptx",
  ])("refuses the non-delivery key %s", (key) => {
    expect(() => broker.driveDeliveryFileName(OWNER, key)).toThrow(
      "Invalid owner Drive delivery key",
    )
  })

  it("refuses a key naming a type that cannot be delivered", () => {
    const key = broker.driveDeliveryTargetKey(OWNER, IDEMPOTENCY, "deck.pptx")
    expect(() =>
      broker.driveDeliveryFileName(OWNER, key.replace(".pptx", ".svg")),
    ).toThrow("Invalid owner Drive delivery key")
  })

  it.each(["page.html", "icon.svg", "archive.zip", "clip.mp4"])(
    "refuses %s outright",
    (fileName) => {
      expect(() =>
        broker.driveDeliveryTargetKey(OWNER, IDEMPOTENCY, fileName),
      ).toThrow("Drive delivery type is not allowed")
    },
  )
})

describe("createDriveDeliveryUpload", () => {
  const base = {
    ownerEmail: OWNER,
    contextKey: "session:nonce",
    idempotencyKey: IDEMPOTENCY,
    checksumSha256: CHECKSUM,
    contentLength: 4,
  }

  it("signs a staging PUT and never returns a public URL", async () => {
    const prepared = await broker.createDriveDeliveryUpload({
      ...base,
      fileName: "deck.pptx",
      contentType: PPTX,
    })
    expect(prepared).toEqual({
      uploadUrl: expect.stringContaining("X-Amz-SignedHeaders"),
      reservationId: RESERVATION,
      requiredHeaders: {
        "Content-Length": "4",
        "Content-Type": PPTX,
        "x-amz-checksum-sha256": CHECKSUM,
      },
    })
    expect(prepared).not.toHaveProperty("publicUrl")
    const put = signedUrlMock.mock.calls[0]?.[1] as {
      input: Record<string, unknown>
    }
    expect(String(put.input.Key)).toMatch(/^\.upload-staging\/private\//)
    // `public_artifact` must be FALSE: a Drive delivery is not in the public
    // ledger and must not inherit the 30-day public lifecycle rule.
    const inserted = executeTransactionMock.mock.calls[0]
    expect(inserted?.[1]).toBe("createWorkspaceUploadReservation")
  })

  it.each([
    ["letter.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["deck.pptx", PPTX],
    ["report.pdf", "application/pdf"],
    ["roster.csv", "text/csv"],
    ["notes.txt", "text/plain"],
    ["notes.md", "text/markdown"],
    ["chart.png", "image/png"],
    ["photo.jpg", "image/jpeg"],
    ["photo.jpeg", "image/jpeg"],
    ["hero.webp", "image/webp"],
  ])("accepts %s declared as its own type", async (fileName, contentType) => {
    const prepared = await broker.createDriveDeliveryUpload({
      ...base,
      fileName,
      contentType,
    })
    expect(prepared.requiredHeaders["Content-Type"]).toBe(contentType)
  })

  it("refuses an extension/MIME mismatch before reserving capacity", async () => {
    await expect(
      broker.createDriveDeliveryUpload({
        ...base,
        fileName: "budget.xlsx",
        contentType: "application/pdf",
      }),
    ).rejects.toMatchObject({ code: "content_type_mismatch" })
    expect(executeQueryMock).not.toHaveBeenCalled()
    expect(acquireMock).not.toHaveBeenCalled()
  })

  it("refuses a type that is publish-only", async () => {
    await expect(
      broker.createDriveDeliveryUpload({
        ...base,
        fileName: "icon.svg",
        contentType: "image/svg+xml",
      }),
    ).rejects.toThrow("Drive delivery type is not allowed")
    expect(acquireMock).not.toHaveBeenCalled()
  })

  it("refuses a file over the delivery size cap", async () => {
    await expect(
      broker.createDriveDeliveryUpload({
        ...base,
        fileName: "deck.pptx",
        contentType: PPTX,
        contentLength: 100 * 1024 * 1024 + 1,
      }),
    ).rejects.toThrow("maximum is 104857600 bytes")
    expect(acquireMock).not.toHaveBeenCalled()
  })
})

describe("deliverStagedUploadToDrive", () => {
  it("creates the file as the agent, shares it with the caller alone, and clears staging", async () => {
    const row = reservationRow()
    installQueries({
      getOwnedWorkspaceUploadReservation: [row],
      claimWorkspaceUploadCompletion: [{ ...row, status: "verifying" }],
    })
    installS3()
    const drive = fakeDrive()
    const result = await broker.deliverStagedUploadToDrive(
      OWNER,
      RESERVATION,
      { drive: drive.deps },
    )

    expect(result).toEqual({
      fileId: "drive-file-1",
      webViewLink: "https://drive.google.com/file/d/drive-file-1/view",
      fileName: "deck.pptx",
      sharedWith: OWNER,
      ownedBy: AGENT,
    })
    // No public link, anywhere in the result.
    expect(JSON.stringify(result)).not.toMatch(/s3|public/i)
    // The token is minted for the CALLER, server-side; no address is passed in.
    expect(mintMock).toHaveBeenCalledWith(OWNER)
    expect(drive.state.created).toEqual([
      { name: "deck.pptx", mimeType: PPTX, bytes: BODY.byteLength },
    ])
    expect(drive.state.permissions).toEqual([
      { type: "user", role: "writer", emailAddress: OWNER },
    ])
    expect(drive.state.deleted).toEqual([])

    // The staging object version is deleted once the bytes are in Drive.
    const deletes = s3SendMock.mock.calls
      .map((call) => call[0] as { constructor: { name: string }; input: Record<string, unknown> })
      .filter((command) => command.constructor.name === "DeleteObjectCommand")
    expect(deletes).toHaveLength(1)
    expect(deletes[0].input).toMatchObject({
      Key: STAGING_KEY,
      VersionId: STAGING_VERSION,
    })
    // No S3 target object is ever written on this path.
    expect(
      s3SendMock.mock.calls.filter(
        (call) =>
          (call[0] as { constructor: { name: string } }).constructor.name ===
          "CopyObjectCommand",
      ),
    ).toHaveLength(0)
    // The delivered object's identity recorded on the reservation is the Drive
    // file id, and the admission leases are settled, not dropped.
    expect(executeTransactionMock).toHaveBeenCalledWith(
      expect.any(Function),
      "settleWorkspaceUploadCompletion",
    )
    expect(finishMock).toHaveBeenCalledTimes(2)
    expect(releaseMock).not.toHaveBeenCalled()
  })

  it("reads the Drive file name from the reservation, not from a parameter", async () => {
    const row = reservationRow({
      targetKey: broker.driveDeliveryTargetKey(
        OWNER,
        IDEMPOTENCY,
        "Q3 budget.xlsx",
      ),
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })
    installQueries({
      getOwnedWorkspaceUploadReservation: [row],
      claimWorkspaceUploadCompletion: [{ ...row, status: "verifying" }],
    })
    s3SendMock.mockImplementation(async (...args: unknown[]) => {
      const command = args[0] as { constructor: { name: string } }
      if (command.constructor.name === "HeadObjectCommand") {
        return {
          VersionId: STAGING_VERSION,
          ContentLength: BODY.byteLength,
          ChecksumSHA256: CHECKSUM,
          ContentType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }
      }
      if (command.constructor.name === "GetObjectCommand") {
        return { Body: { transformToByteArray: async () => BODY } }
      }
      return {}
    })
    const drive = fakeDrive()
    const result = await broker.deliverStagedUploadToDrive(OWNER, RESERVATION, {
      drive: drive.deps,
    })
    expect(result.fileName).toBe("Q3 budget.xlsx")
    expect(drive.state.created[0].name).toBe("Q3 budget.xlsx")
  })

})

describe("deliverStagedUploadToDrive containment", () => {
  it("refuses a reservation that belongs to someone else", async () => {
    // The lookup is scoped by owner_key, so another person's reservation id
    // simply resolves to nothing.
    installQueries({ getOwnedWorkspaceUploadReservation: [] })
    await expect(
      broker.deliverStagedUploadToDrive(OWNER, RESERVATION),
    ).rejects.toThrow("Upload reservation is unavailable")
    expect(mintMock).not.toHaveBeenCalled()
    expect(s3SendMock).not.toHaveBeenCalled()
  })

  it("refuses a staging reservation whose target is under another owner's hash", async () => {
    installQueries({
      getOwnedWorkspaceUploadReservation: [
        reservationRow({
          targetKey: broker.driveDeliveryTargetKey(
            OTHER_OWNER,
            IDEMPOTENCY,
            "deck.pptx",
          ),
        }),
      ],
    })
    await expect(
      broker.deliverStagedUploadToDrive(OWNER, RESERVATION),
    ).rejects.toThrow("Invalid owner Drive delivery key")
    // Refused BEFORE the claim, so no reservation is left stuck in `verifying`.
    expect(executeQueryMock).not.toHaveBeenCalledWith(
      expect.any(Function),
      "claimWorkspaceUploadCompletion",
    )
    expect(mintMock).not.toHaveBeenCalled()
  })

  it("reports an unprovisioned agent account instead of an opaque failure", async () => {
    const row = reservationRow()
    installQueries({
      getOwnedWorkspaceUploadReservation: [row],
      claimWorkspaceUploadCompletion: [{ ...row, status: "verifying" }],
      resetWorkspaceUploadCompletionClaim: [{ id: RESERVATION }],
    })
    installS3()
    mintMock.mockRejectedValue(
      new Error("Agent account agnt_jsmith@psd401.net is not provisioned yet"),
    )
    const error = await broker
      .deliverStagedUploadToDrive(OWNER, RESERVATION, {
        drive: fakeDrive().deps,
      })
      .then(
        () => {
          throw new Error("expected the delivery to be refused")
        },
        (caught: unknown) => caught as Error & { code?: string },
      )
    expect(error.code).toBe("create_failed")
    expect(error.message).toContain("not provisioned")
    // Nothing was created, and the staged bytes are handed back for a retry.
    expect(executeQueryMock).toHaveBeenCalledWith(
      expect.any(Function),
      "resetWorkspaceUploadCompletionClaim",
    )
  })

  it("refuses a public-artifact reservation", async () => {
    installQueries({
      getOwnedWorkspaceUploadReservation: [
        reservationRow({
          publicArtifact: true,
          targetKey: "public-images/ownerhash/deck.pdf",
        }),
      ],
    })
    await expect(
      broker.deliverStagedUploadToDrive(OWNER, RESERVATION),
    ).rejects.toThrow("not a Drive delivery")
    expect(mintMock).not.toHaveBeenCalled()
  })

})

describe("deliverStagedUploadToDrive failure handling", () => {
  it("refuses a reservation over the delivery size cap", async () => {
    installQueries({
      getOwnedWorkspaceUploadReservation: [
        reservationRow({ expectedBytes: 100 * 1024 * 1024 + 1 }),
      ],
    })
    await expect(
      broker.deliverStagedUploadToDrive(OWNER, RESERVATION),
    ).rejects.toThrow("maximum is 104857600 bytes")
    expect(mintMock).not.toHaveBeenCalled()
    expect(s3SendMock).not.toHaveBeenCalled()
  })

  it("rejects staged bytes that do not match their reservation", async () => {
    const row = reservationRow()
    installQueries({
      getOwnedWorkspaceUploadReservation: [row],
      claimWorkspaceUploadCompletion: [{ ...row, status: "verifying" }],
    })
    installS3({ stagedMatches: false })
    await expect(
      broker.deliverStagedUploadToDrive(OWNER, RESERVATION, {
        drive: fakeDrive().deps,
      }),
    ).rejects.toThrow("did not match its reservation")
    expect(mintMock).not.toHaveBeenCalled()
  })

  it("reports share_failed, removes the unshared file, and hands the reservation back", async () => {
    const row = reservationRow()
    installQueries({
      getOwnedWorkspaceUploadReservation: [row],
      claimWorkspaceUploadCompletion: [{ ...row, status: "verifying" }],
      resetWorkspaceUploadCompletionClaim: [{ id: RESERVATION }],
    })
    installS3()
    const drive = fakeDrive({ failShareWith: 403 })
    const error = await broker
      .deliverStagedUploadToDrive(OWNER, RESERVATION, { drive: drive.deps })
      .then(
        () => {
          throw new Error("expected the delivery to be refused")
        },
        (caught: unknown) => caught as Error & { code?: string },
      )

    expect(error.code).toBe("share_failed")
    expect(error.message).toContain("retry")
    // Never a public link.
    expect(error.message).not.toMatch(/public/i)
    // The file nobody can open is removed, so the retry does not pile up copies.
    expect(drive.state.deleted).toHaveLength(1)
    // The reservation goes back to `reserved` with its staged bytes intact.
    expect(executeQueryMock).toHaveBeenCalledWith(
      expect.any(Function),
      "resetWorkspaceUploadCompletionClaim",
    )
    expect(
      s3SendMock.mock.calls.filter(
        (call) =>
          (call[0] as { constructor: { name: string } }).constructor.name ===
          "DeleteObjectCommand",
      ),
    ).toHaveLength(0)
    expect(executeTransactionMock).not.toHaveBeenCalledWith(
      expect.any(Function),
      "settleWorkspaceUploadCompletion",
    )
  })

  it("returns the recorded file instead of delivering a second copy on replay", async () => {
    installQueries({
      getOwnedWorkspaceUploadReservation: [
        reservationRow({ status: "committed", objectVersionId: "drive-file-1" }),
      ],
    })
    const result = await broker.deliverStagedUploadToDrive(OWNER, RESERVATION)
    expect(result).toEqual({
      fileId: "drive-file-1",
      webViewLink: "https://drive.google.com/file/d/drive-file-1/view",
      fileName: "deck.pptx",
      sharedWith: OWNER,
      reused: true,
    })
    expect(mintMock).not.toHaveBeenCalled()
    expect(s3SendMock).not.toHaveBeenCalled()
  })

  it("succeeds even if the staging object cannot be removed afterwards", async () => {
    const row = reservationRow()
    installQueries({
      getOwnedWorkspaceUploadReservation: [row],
      claimWorkspaceUploadCompletion: [{ ...row, status: "verifying" }],
    })
    installS3({ deleteFails: true })
    const result = await broker.deliverStagedUploadToDrive(
      OWNER,
      RESERVATION,
      { drive: fakeDrive().deps },
    )
    expect(result.fileId).toBe("drive-file-1")
  })

  it("refuses a malformed reservation id without touching the database", async () => {
    await expect(
      broker.deliverStagedUploadToDrive(OWNER, "not-a-uuid"),
    ).rejects.toThrow("Invalid upload reservation")
    expect(executeQueryMock).not.toHaveBeenCalled()
  })
})
