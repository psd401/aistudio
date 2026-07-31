/** @jest-environment node */

import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals"
import { createHash } from "node:crypto"

type AsyncUnknownMock = (...args: unknown[]) => Promise<unknown>

const s3SendMock = jest.fn<AsyncUnknownMock>()
const executeQueryMock = jest.fn<AsyncUnknownMock>()
const executeTransactionMock = jest.fn<AsyncUnknownMock>()
const withSessionMock = jest.fn<AsyncUnknownMock>()

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
  getSignedUrl: jest.fn(),
}))
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
  executeTransaction: (...args: unknown[]) => executeTransactionMock(...args),
  toPgRows: (value: unknown) => value,
  withUnretriedDatabaseSession: (...args: unknown[]) =>
    withSessionMock(...args),
}))
jest.mock("@/lib/resource-admission", () => ({
  acquireResourceAdmission: jest.fn(),
  finishResourceAdmission: jest.fn(),
  isCapacityDenial: jest.fn(),
  releaseResourceAdmission: jest.fn(),
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
  }),
}))

type StoredVersion = {
  versionId: string
  size: number
  eTag: string
  body?: string
  checksum?: string
  contentType?: string
  deleteMarker?: boolean
  scope?: string
}

class VersionedS3 {
  readonly objects = new Map<string, StoredVersion[]>()
  readonly commands: Array<{
    name: string
    input: Record<string, unknown>
  }> = []
  sequence = 0
  failNextManifestPutAfterWrite = false
  beforeCommand?: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<void>

  add(
    key: string,
    version: Omit<StoredVersion, "versionId"> & {
      versionId?: string
    },
  ): StoredVersion {
    const stored: StoredVersion = {
      ...version,
      versionId: version.versionId ?? this.nextVersion(),
    }
    this.objects.set(key, [
      stored,
      ...(this.objects.get(key) ?? []),
    ])
    return stored
  }

  current(key: string): StoredVersion | undefined {
    const version = this.objects.get(key)?.[0]
    return version?.deleteMarker ? undefined : version
  }

  versions(key: string): StoredVersion[] {
    return this.objects.get(key) ?? []
  }

  private nextVersion(): string {
    this.sequence += 1
    return `version-${this.sequence}`
  }

  private version(key: string, versionId?: string): StoredVersion {
    const candidate = versionId
      ? this.versions(key).find(
          (version) => version.versionId === versionId,
        )
      : this.versions(key)[0]
    if (!candidate || candidate.deleteMarker) {
      throw Object.assign(new Error("not found"), {
        name: "NoSuchVersion",
        $metadata: { httpStatusCode: 404 },
      })
    }
    return candidate
  }

  private parseCopySource(value: unknown): {
    key: string
    versionId: string
  } {
    const source = String(value)
    const separator = source.indexOf("/")
    const parsed = new URL(`https://s3.invalid/${source.slice(separator + 1)}`)
    return {
      key: parsed.pathname
        .slice(1)
        .split("/")
        .map(decodeURIComponent)
        .join("/"),
      versionId: parsed.searchParams.get("versionId") ?? "",
    }
  }

  // The emulator deliberately dispatches every S3 command in one state machine.
  // eslint-disable-next-line complexity
  async send(command: unknown): Promise<unknown> {
    const typed = command as {
      constructor: { name: string }
      input: Record<string, unknown>
    }
    const name = typed.constructor.name
    const input = typed.input
    this.commands.push({ name, input })
    await this.beforeCommand?.(name, input)
    const key = String(input.Key ?? "")

    if (name === "ListObjectsV2Command") {
      const prefix = String(input.Prefix ?? "")
      return {
        Contents: [...this.objects.entries()]
          .filter(([candidate, versions]) =>
            candidate.startsWith(prefix) &&
            !versions[0]?.deleteMarker
          )
          .map(([candidate, versions]) => ({
            Key: candidate,
            Size: versions[0]!.size,
            ETag: versions[0]!.eTag,
          })),
      }
    }
    if (name === "HeadObjectCommand") {
      const version = this.version(
        key,
        typeof input.VersionId === "string"
          ? input.VersionId
          : undefined,
      )
      return {
        ContentLength: version.size,
        ETag: version.eTag,
        VersionId: version.versionId,
        ChecksumSHA256: version.checksum,
        ContentType: version.contentType,
      }
    }
    if (name === "GetObjectCommand") {
      const version = this.version(
        key,
        typeof input.VersionId === "string"
          ? input.VersionId
          : undefined,
      )
      if (
        typeof input.IfMatch === "string" &&
        input.IfMatch !== version.eTag
      ) {
        throw Object.assign(new Error("precondition failed"), {
          name: "PreconditionFailed",
          $metadata: { httpStatusCode: 412 },
        })
      }
      const body = version.body ?? ""
      return {
        ContentLength: Buffer.byteLength(body),
        ETag: version.eTag,
        VersionId: version.versionId,
        Body: {
          transformToString: async () => body,
          transformToByteArray: async () => Buffer.from(body),
        },
      }
    }
    if (name === "PutObjectCommand") {
      const body = String(input.Body ?? "")
      const stored = this.add(key, {
        size: Buffer.byteLength(body),
        eTag: `"manifest-${this.sequence + 1}"`,
        body,
        scope: String(input.Tagging ?? ""),
      })
      if (
        key.endsWith("/manifest.json") &&
        this.failNextManifestPutAfterWrite
      ) {
        this.failNextManifestPutAfterWrite = false
        throw new Error("manifest response lost after durable put")
      }
      return { VersionId: stored.versionId, ETag: stored.eTag }
    }
    if (name === "CopyObjectCommand") {
      const source = this.parseCopySource(input.CopySource)
      const sourceVersion = this.version(
        source.key,
        source.versionId,
      )
      const isAnchor = key.includes("/anchors/")
      const eTag = isAnchor
        ? `"anchor-${sourceVersion.eTag.replaceAll('"', "")}"`
        : sourceVersion.eTag
      const stored = this.add(key, {
        size: sourceVersion.size,
        eTag,
        body: sourceVersion.body,
        checksum: sourceVersion.checksum,
        contentType: sourceVersion.contentType,
        scope: String(input.Tagging ?? ""),
      })
      return {
        VersionId: stored.versionId,
        CopyObjectResult: { ETag: stored.eTag },
      }
    }
    if (name === "DeleteObjectCommand") {
      if (input.VersionId) {
        if (!key.startsWith(".upload-staging/")) {
          throw new Error(
            "checkpoint recovery must not delete exact versions",
          )
        }
        const retained = this.versions(key).filter(
          (version) => version.versionId !== input.VersionId,
        )
        this.objects.set(key, retained)
        return { VersionId: input.VersionId }
      }
      const marker = this.add(key, {
        size: 0,
        eTag: '"delete-marker"',
        deleteMarker: true,
      })
      return {
        DeleteMarker: true,
        VersionId: marker.versionId,
      }
    }
    throw new Error(`unexpected S3 command ${name}`)
  }
}

let ensureWorkspaceCheckpoint:
  typeof import("@/lib/agent-workspace/storage-broker").ensureWorkspaceCheckpoint
let commitWorkspaceCheckpoint:
  typeof import("@/lib/agent-workspace/storage-broker").commitWorkspaceCheckpoint
let completeWorkspaceUpload:
  typeof import("@/lib/agent-workspace/storage-broker").completeWorkspaceUpload
let deleteWorkspacePath:
  typeof import("@/lib/agent-workspace/storage-broker").deleteWorkspacePath
let workspaceGenerationFromEntries:
  typeof import("@/lib/agent-workspace/storage-broker").workspaceGenerationFromEntries
let resetWorkspaceStorageClientForTests:
  typeof import("@/lib/agent-workspace/storage-broker").resetWorkspaceStorageClientForTests

const PREFIX = "users/owner"
const BUCKET = "workspace-bucket"
const CHECKSUM = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
const CONTENT_TYPE = "application/octet-stream"
const RESERVATION_ONE = "11111111-2222-4333-8444-555555555555"
const RESERVATION_TWO = "66666666-7777-4888-8999-000000000000"
const RETIRED_EXEC_APPROVALS = `${JSON.stringify({
  version: 1,
  socket: {
    path: "/home/node/.openclaw/exec-approvals.sock",
    token: "AbCdEfGhIjKlMnOpQrStUvWxYz_12345",
  },
  defaults: {},
  agents: {},
})}\n`

let store: VersionedS3
let activeReservation: Record<string, unknown> | undefined

function workspaceGeneration(
  paths: Array<{ path: string; size: number; eTag: string }>,
): string {
  return workspaceGenerationFromEntries(paths)
}

function legacyWorkspaceGenerationIncludingExcluded(
  entries: Array<{ path: string; size: number; eTag: string }>,
): string {
  const digest = createHash("sha256")
  for (const entry of [...entries].sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.path, "utf8"),
      Buffer.from(right.path, "utf8"),
    ),
  )) {
    const path = Buffer.from(entry.path, "utf8")
    const eTag = Buffer.from(entry.eTag, "utf8")
    const pathLength = Buffer.alloc(8)
    pathLength.writeBigUInt64BE(BigInt(path.length))
    const size = Buffer.alloc(8)
    size.writeBigUInt64BE(BigInt(entry.size))
    const eTagLength = Buffer.alloc(8)
    eTagLength.writeBigUInt64BE(BigInt(eTag.length))
    digest.update(pathLength)
    digest.update(path)
    digest.update(size)
    digest.update(eTagLength)
    digest.update(eTag)
  }
  return digest.digest("hex")
}

function manifestKey(): string {
  const prefixHash = createHash("sha256").update(PREFIX).digest("hex")
  return `.workspace-checkpoints/v2/${prefixHash}/manifest.json`
}

function legacyManifestKey(): string {
  const prefixHash = createHash("sha256").update(PREFIX).digest("hex")
  return `.workspace-checkpoints/v1/${prefixHash}/manifest.json`
}

function manifest(): Record<string, unknown> {
  return JSON.parse(store.current(manifestKey())!.body ?? "{}") as Record<
    string,
    unknown
  >
}

function stagedReservation(
  reservationId: string,
  relativePath: string,
): Record<string, unknown> {
  return {
    id: reservationId,
    ownerKey: "owner@example.com",
    publicArtifact: false,
    stagingKey: `.upload-staging/private/owner/${reservationId}`,
    targetKey: `${PREFIX}/${relativePath}`,
    expectedBytes: 4,
    checksumSha256: CHECKSUM,
    contentType: CONTENT_TYPE,
    byteLeaseId: null,
    objectLeaseId: null,
    status: "verifying",
    expiresAt: new Date(Date.now() + 60_000),
  }
}

beforeAll(async () => {
  const broker = await import("@/lib/agent-workspace/storage-broker")
  ensureWorkspaceCheckpoint = broker.ensureWorkspaceCheckpoint
  commitWorkspaceCheckpoint = broker.commitWorkspaceCheckpoint
  completeWorkspaceUpload = broker.completeWorkspaceUpload
  deleteWorkspacePath = broker.deleteWorkspacePath
  workspaceGenerationFromEntries = broker.workspaceGenerationFromEntries
  resetWorkspaceStorageClientForTests =
    broker.resetWorkspaceStorageClientForTests
})

beforeEach(() => {
  jest.clearAllMocks()
  process.env.AGENT_WORKSPACE_BUCKET = BUCKET
  resetWorkspaceStorageClientForTests()
  store = new VersionedS3()
  activeReservation = undefined
  s3SendMock.mockImplementation((command) => store.send(command))
  executeQueryMock.mockImplementation(async (...args: unknown[]) => {
    const label = args[1]
    if (label === "claimWorkspaceUploadCompletion") {
      return activeReservation ? [activeReservation] : []
    }
    if (label === "getSupersededWorkspaceUploadVersions") return []
    if (label === "confirmWorkspaceUploadSettlement") return []
    return []
  })
  executeTransactionMock.mockImplementation(
    async (...args: unknown[]) => {
      if (args[1] === "settleWorkspaceUploadCompletion") {
        return { id: activeReservation?.id }
      }
      throw new Error(`unexpected transaction ${String(args[1])}`)
    },
  )
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
          ) return [{ acquired: true }]
          if (
            queryArgs[1] ===
            "releaseWorkspaceUploadCompletionFence"
          ) return [{ released: true }]
          return executeQueryMock(...queryArgs)
        },
        executeTransaction: (...transactionArgs: unknown[]) =>
          executeTransactionMock(...transactionArgs),
      })
    },
  )
})

// Keeping one versioned-S3 fixture makes cross-test history assertions explicit.
// eslint-disable-next-line max-lines-per-function
describe("durable workspace checkpoints", () => {
  it("bootstraps exact current VersionIds without copying the full workspace", async () => {
    const a = store.add(`${PREFIX}/state/a.sqlite`, {
      size: 4,
      eTag: '"a-old"',
      body: "aaaa",
      scope: "Scope=private",
    })
    const b = store.add(`${PREFIX}/memory/MEMORY.md`, {
      size: 4,
      eTag: '"b-old"',
      body: "bbbb",
      scope: "Scope=private",
    })
    store.add(`${PREFIX}/attachments/input.pdf`, {
      size: 4,
      eTag: '"attachment"',
      body: "pdf!",
    })

    const result = await ensureWorkspaceCheckpoint(PREFIX)

    expect(result).toEqual({
      checkpointReady: true,
      workspaceGeneration: workspaceGeneration([
        { path: "state/a.sqlite", size: 4, eTag: '"a-old"' },
        { path: "memory/MEMORY.md", size: 4, eTag: '"b-old"' },
      ]),
    })
    const committed = manifest()
    expect(committed.signedWorkspacePrefix).toBe(PREFIX)
    expect(committed.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "state/a.sqlite",
          source: "target",
          versionId: a.versionId,
        }),
        expect.objectContaining({
          path: "memory/MEMORY.md",
          source: "target",
          versionId: b.versionId,
        }),
      ]),
    )
    expect(JSON.stringify(committed)).not.toContain("attachments/")
    expect(manifestKey().startsWith(`${PREFIX}/`)).toBe(false)
    expect(
      store.commands.filter(
        (command) => command.name === "CopyObjectCommand",
      ),
    ).toHaveLength(0)
    expect(store.current(manifestKey())?.scope).toBe("Scope=checkpoint")
  })

  it("accepts legacy punctuation and excludes regenerable trees from the checkpoint", async () => {
    const durable = store.add(`${PREFIX}/memory/Review (draft), [v2].md`, {
      size: 4,
      eTag: '"durable"',
      body: "keep",
      scope: "Scope=private",
    })
    for (let index = 0; index < 5_500; index += 1) {
      store.add(
        `${PREFIX}/skills/example/.tts-venv/lib/python3.11/site-packages/pkg-${index}/script (dev).tmpl`,
        {
          size: 1,
          eTag: `"generated-${index}"`,
          body: "x",
        },
      )
    }

    const result = await ensureWorkspaceCheckpoint(PREFIX)

    expect(result.workspaceGeneration).toBe(
      workspaceGeneration([
        {
          path: "memory/Review (draft), [v2].md",
          size: 4,
          eTag: '"durable"',
        },
      ]),
    )
    expect(manifest().entries).toEqual([
      expect.objectContaining({
        path: "memory/Review (draft), [v2].md",
        versionId: durable.versionId,
      }),
    ])
    expect(
      store.commands.filter(
        (command) =>
          command.name === "HeadObjectCommand" &&
          String(command.input.Key).startsWith(`${PREFIX}/`),
      ),
    ).toHaveLength(1)
  })

  it("normalizes legacy exec approvals out of an existing v2 checkpoint without deleting owner state", async () => {
    const durableMemory = store.add(`${PREFIX}/memory/MEMORY.md`, {
      size: 4,
      eTag: '"memory"',
      body: "keep",
      scope: "Scope=private",
    })
    const durableDatabase = store.add(`${PREFIX}/state/openclaw.sqlite`, {
      size: 4,
      eTag: '"sqlite"',
      body: "data",
      scope: "Scope=private",
    })
    const legacyApprovals = store.add(`${PREFIX}/exec-approvals.json`, {
      size: Buffer.byteLength(RETIRED_EXEC_APPROVALS),
      eTag: '"legacy"',
      body: RETIRED_EXEC_APPROVALS,
      scope: "Scope=private",
    })
    const oldEntries = [
      {
        path: "memory/MEMORY.md",
        size: 4,
        eTag: '"memory"',
        source: "target",
        versionId: durableMemory.versionId,
        sourceETag: '"memory"',
      },
      {
        path: "state/openclaw.sqlite",
        size: 4,
        eTag: '"sqlite"',
        source: "target",
        versionId: durableDatabase.versionId,
        sourceETag: '"sqlite"',
      },
      {
        path: "exec-approvals.json",
        size: Buffer.byteLength(RETIRED_EXEC_APPROVALS),
        eTag: '"legacy"',
        source: "target",
        versionId: legacyApprovals.versionId,
        sourceETag: '"legacy"',
      },
    ]
    const oldManifest = JSON.stringify({
      version: 2,
      signedWorkspacePrefix: PREFIX,
      workspaceGeneration:
        legacyWorkspaceGenerationIncludingExcluded(oldEntries),
      entries: oldEntries,
    })
    store.add(manifestKey(), {
      size: Buffer.byteLength(oldManifest),
      eTag: '"old-manifest"',
      body: oldManifest,
      scope: "Scope=checkpoint",
    })
    const commandCount = store.commands.length

    const result = await ensureWorkspaceCheckpoint(PREFIX)

    const normalizedGeneration = workspaceGeneration([
      { path: "memory/MEMORY.md", size: 4, eTag: '"memory"' },
      { path: "state/openclaw.sqlite", size: 4, eTag: '"sqlite"' },
    ])
    expect(result).toEqual({
      checkpointReady: true,
      workspaceGeneration: normalizedGeneration,
    })
    expect(manifest()).toMatchObject({
      version: 2,
      signedWorkspacePrefix: PREFIX,
      workspaceGeneration: normalizedGeneration,
      entries: [
        expect.objectContaining({
          path: "memory/MEMORY.md",
          versionId: durableMemory.versionId,
        }),
        expect.objectContaining({
          path: "state/openclaw.sqlite",
          versionId: durableDatabase.versionId,
        }),
      ],
    })
    expect(store.current(`${PREFIX}/memory/MEMORY.md`)).toEqual(
      durableMemory,
    )
    expect(store.current(`${PREFIX}/state/openclaw.sqlite`)).toEqual(
      durableDatabase,
    )
    expect(store.current(`${PREFIX}/exec-approvals.json`)).toEqual(
      legacyApprovals,
    )
    expect(
      store.commands.slice(commandCount).filter(
        (command) =>
          command.name === "CopyObjectCommand" ||
          command.name === "DeleteObjectCommand",
      ),
    ).toHaveLength(0)
  })

  it("rejects an interrupted Doctor claim before normalizing its manifest entry", async () => {
    const claimKey = `${PREFIX}/exec-approvals.json.doctor-importing`
    const importingClaim = store.add(claimKey, {
      size: Buffer.byteLength(RETIRED_EXEC_APPROVALS),
      eTag: '"claim"',
      body: RETIRED_EXEC_APPROVALS,
      scope: "Scope=private",
    })
    // Simulate a current delete marker while the committed checkpoint still
    // references the recoverable claim version. This reaches manifest-level
    // validation rather than the current-list guard.
    store.add(claimKey, {
      size: 0,
      eTag: '"claim-deleted"',
      deleteMarker: true,
    })
    const entries = [{
      path: "exec-approvals.json.doctor-importing",
      size: Buffer.byteLength(RETIRED_EXEC_APPROVALS),
      eTag: '"claim"',
      source: "target",
      versionId: importingClaim.versionId,
      sourceETag: '"claim"',
    }]
    const oldManifest = JSON.stringify({
      version: 2,
      signedWorkspacePrefix: PREFIX,
      workspaceGeneration:
        legacyWorkspaceGenerationIncludingExcluded(entries),
      entries,
    })
    store.add(manifestKey(), {
      size: Buffer.byteLength(oldManifest),
      eTag: '"claim-manifest"',
      body: oldManifest,
      scope: "Scope=checkpoint",
    })
    const commandCount = store.commands.length

    await expect(ensureWorkspaceCheckpoint(PREFIX)).rejects.toThrow(
      "Retired workspace host state requires controlled migration",
    )
    expect(
      store.commands.slice(commandCount).some(
        (command) =>
          command.name === "PutObjectCommand" ||
          command.name === "CopyObjectCommand" ||
          command.name === "DeleteObjectCommand",
      ),
    ).toBe(false)
    expect(store.versions(claimKey)).toContainEqual(importingClaim)
  })

  it("rejects any other excluded path in a v2 checkpoint", async () => {
    const excluded = store.add(
      `${PREFIX}/node_modules/legacy/index.js`,
      {
        size: 4,
        eTag: '"excluded"',
        body: "code",
        scope: "Scope=private",
      },
    )
    const entries = [{
      path: "node_modules/legacy/index.js",
      size: 4,
      eTag: '"excluded"',
      source: "target",
      versionId: excluded.versionId,
      sourceETag: '"excluded"',
    }]
    const oldManifest = JSON.stringify({
      version: 2,
      signedWorkspacePrefix: PREFIX,
      workspaceGeneration:
        legacyWorkspaceGenerationIncludingExcluded(entries),
      entries,
    })
    store.add(manifestKey(), {
      size: Buffer.byteLength(oldManifest),
      eTag: '"invalid-manifest"',
      body: oldManifest,
      scope: "Scope=checkpoint",
    })
    const commandCount = store.commands.length

    await expect(ensureWorkspaceCheckpoint(PREFIX)).rejects.toThrow(
      "manifest is invalid",
    )
    expect(
      store.commands.slice(commandCount).some(
        (command) =>
          command.name === "PutObjectCommand" ||
          command.name === "CopyObjectCommand" ||
          command.name === "DeleteObjectCommand",
      ),
    ).toBe(false)
    expect(
      store.current(`${PREFIX}/node_modules/legacy/index.js`),
    ).toEqual(excluded)
  })

  it("rejects a retired-path manifest whose legacy generation is invalid", async () => {
    const legacyApprovals = store.add(
      `${PREFIX}/exec-approvals.json`,
      {
        size: Buffer.byteLength(RETIRED_EXEC_APPROVALS),
        eTag: '"legacy"',
        body: RETIRED_EXEC_APPROVALS,
        scope: "Scope=private",
      },
    )
    const oldManifest = JSON.stringify({
      version: 2,
      signedWorkspacePrefix: PREFIX,
      workspaceGeneration: "0".repeat(64),
      entries: [{
        path: "exec-approvals.json",
        size: Buffer.byteLength(RETIRED_EXEC_APPROVALS),
        eTag: '"legacy"',
        source: "target",
        versionId: legacyApprovals.versionId,
        sourceETag: '"legacy"',
      }],
    })
    store.add(manifestKey(), {
      size: Buffer.byteLength(oldManifest),
      eTag: '"invalid-generation"',
      body: oldManifest,
      scope: "Scope=checkpoint",
    })
    const commandCount = store.commands.length

    await expect(ensureWorkspaceCheckpoint(PREFIX)).rejects.toThrow(
      "generation is invalid",
    )
    expect(
      store.commands.slice(commandCount).some(
        (command) =>
          command.name === "PutObjectCommand" ||
          command.name === "CopyObjectCommand" ||
          command.name === "DeleteObjectCommand",
      ),
    ).toBe(false)
    expect(store.current(`${PREFIX}/exec-approvals.json`)).toEqual(
      legacyApprovals,
    )
  })

  it("refuses to bless current state while a legacy v1 boundary exists", async () => {
    const legacyBody = JSON.stringify({
      version: 1,
      entries: [{ path: "node_modules/legacy/index.js" }],
    })
    store.add(legacyManifestKey(), {
      size: Buffer.byteLength(legacyBody),
      eTag: '"legacy-manifest"',
      body: legacyBody,
      scope: "Scope=checkpoint",
    })
    store.add(`${PREFIX}/memory/durable.md`, {
      size: 4,
      eTag: '"durable"',
      body: "keep",
      scope: "Scope=private",
    })

    await expect(ensureWorkspaceCheckpoint(PREFIX)).rejects.toThrow(
      "Legacy workspace checkpoint must be recovered before v2 bootstrap",
    )

    expect(store.current(manifestKey())).toBeUndefined()
    expect(store.current(legacyManifestKey())?.body).toBe(legacyBody)
  })

  it("waits for every in-flight checkpoint worker before releasing the owner lock", async () => {
    store.add(`${PREFIX}/memory/a.md`, {
      size: 1,
      eTag: '"a"',
      body: "a",
    })
    store.add(`${PREFIX}/memory/b.md`, {
      size: 1,
      eTag: '"b"',
      body: "b",
    })
    let finishSlow: (() => void) | undefined
    const slow = new Promise<void>((resolve) => {
      finishSlow = resolve
    })
    let slowSettled = false
    let lockReleased = false
    store.beforeCommand = async (name, input) => {
      if (name !== "HeadObjectCommand") return
      const key = String(input.Key)
      if (key.endsWith("/memory/a.md")) {
        throw new Error("checkpoint metadata failed")
      }
      if (key.endsWith("/memory/b.md")) {
        await slow
        slowSettled = true
      }
    }
    withSessionMock.mockImplementation(
      async (...args: unknown[]) => {
        const callback = args[0] as (session: {
          executeQuery: AsyncUnknownMock
          executeTransaction: AsyncUnknownMock
        }) => Promise<unknown>
        return callback({
          executeQuery: async (...queryArgs: unknown[]) => {
            if (queryArgs[1] === "tryFenceWorkspaceUploadCompletion") {
              return [{ acquired: true }]
            }
            if (queryArgs[1] === "releaseWorkspaceUploadCompletionFence") {
              lockReleased = true
              expect(slowSettled).toBe(true)
              return [{ released: true }]
            }
            return executeQueryMock(...queryArgs)
          },
          executeTransaction: (...transactionArgs: unknown[]) =>
            executeTransactionMock(...transactionArgs),
        })
      },
    )

    const checkpoint = ensureWorkspaceCheckpoint(PREFIX)
    await new Promise((resolve) => setImmediate(resolve))
    expect(lockReleased).toBe(false)
    finishSlow?.()

    await expect(checkpoint).rejects.toThrow("checkpoint metadata failed")
    expect(lockReleased).toBe(true)
  })

  it("recovers a crash-partial batch, preserves history, and idempotently commits the retry", async () => {
    const originalA = store.add(`${PREFIX}/state/a.sqlite`, {
      size: 4,
      eTag: '"a-old"',
      body: "aaaa",
      scope: "Scope=private",
    })
    const originalB = store.add(`${PREFIX}/memory/MEMORY.md`, {
      size: 4,
      eTag: '"b-old"',
      body: "bbbb",
      scope: "Scope=private",
    })
    const attachment = store.add(`${PREFIX}/attachments/input.pdf`, {
      size: 4,
      eTag: '"attachment"',
      body: "pdf!",
    })
    const base = (await ensureWorkspaceCheckpoint(PREFIX))
      .workspaceGeneration

    activeReservation = stagedReservation(
      RESERVATION_ONE,
      "state/a.sqlite",
    )
    store.add(String(activeReservation.stagingKey), {
      size: 4,
      eTag: '"staged-new"',
      body: "nnnn",
      checksum: CHECKSUM,
      contentType: CONTENT_TYPE,
    })
    const partial = await completeWorkspaceUpload(
      "owner@example.com",
      RESERVATION_ONE,
      PREFIX,
      base,
    )
    const promotedA = store.current(`${PREFIX}/state/a.sqlite`)!
    expect(partial.workspaceGeneration).not.toBe(base)
    expect(
      store.current(
        String(
          (
            manifest().entries as Array<Record<string, unknown>>
          ).find((entry) => entry.path === "state/a.sqlite")
            ?.source === "anchor"
              ? store.commands.find(
                  (command) =>
                    command.name === "CopyObjectCommand" &&
                    String(command.input.Key).includes("/anchors/"),
                )?.input.Key
              : "",
        ),
      )?.scope,
    ).toBe("Scope=checkpoint")

    const removedBMarker = store.add(`${PREFIX}/memory/MEMORY.md`, {
      size: 0,
      eTag: '"external-delete"',
      deleteMarker: true,
    })
    const uncommittedExtra = store.add(`${PREFIX}/memory/new.md`, {
      size: 4,
      eTag: '"extra"',
      body: "xxxx",
      scope: "Scope=private",
    })

    const recovered = await ensureWorkspaceCheckpoint(PREFIX)
    expect(store.current(`${PREFIX}/state/a.sqlite`)?.body).toBe("aaaa")
    expect(store.current(`${PREFIX}/memory/MEMORY.md`)?.body).toBe("bbbb")
    expect(store.current(`${PREFIX}/memory/new.md`)).toBeUndefined()
    expect(store.current(`${PREFIX}/attachments/input.pdf`)).toEqual(
      attachment,
    )
    expect(store.versions(`${PREFIX}/state/a.sqlite`)).toEqual(
      expect.arrayContaining([originalA, promotedA]),
    )
    expect(store.versions(`${PREFIX}/memory/MEMORY.md`)).toEqual(
      expect.arrayContaining([originalB, removedBMarker]),
    )
    expect(store.versions(`${PREFIX}/memory/new.md`)).toEqual(
      expect.arrayContaining([uncommittedExtra]),
    )
    const recoveryDelete = store.commands.find(
      (command) =>
        command.name === "DeleteObjectCommand" &&
        command.input.Key === `${PREFIX}/memory/new.md`,
    )
    expect(recoveryDelete?.input).not.toHaveProperty("VersionId")
    expect(
      (manifest().entries as Array<Record<string, unknown>>).find(
        (entry) => entry.path === "state/a.sqlite",
      ),
    ).toMatchObject({
      source: "anchor",
      eTag: '"anchor-a-old"',
    })

    activeReservation = stagedReservation(
      RESERVATION_TWO,
      "state/a.sqlite",
    )
    store.add(String(activeReservation.stagingKey), {
      size: 4,
      eTag: '"staged-final"',
      body: "ffff",
      checksum: CHECKSUM,
      contentType: CONTENT_TYPE,
    })
    const finalPromotion = await completeWorkspaceUpload(
      "owner@example.com",
      RESERVATION_TWO,
      PREFIX,
      recovered.workspaceGeneration,
    )
    store.failNextManifestPutAfterWrite = true
    await expect(
      commitWorkspaceCheckpoint(
        PREFIX,
        recovered.workspaceGeneration,
        finalPromotion.workspaceGeneration!,
      ),
    ).rejects.toThrow("response lost")
    await expect(
      commitWorkspaceCheckpoint(
        PREFIX,
        recovered.workspaceGeneration,
        finalPromotion.workspaceGeneration!,
      ),
    ).resolves.toEqual({
      checkpointCommitted: true,
      workspaceGeneration: finalPromotion.workspaceGeneration,
    })
    expect(
      (manifest().entries as Array<Record<string, unknown>>).find(
        (entry) => entry.path === "state/a.sqlite",
      ),
    ).toMatchObject({
      source: "target",
      versionId: store.current(`${PREFIX}/state/a.sqlite`)?.versionId,
    })
  })

  it("fails closed on a corrupt committed manifest before mutating workspace targets", async () => {
    store.add(`${PREFIX}/state/a.sqlite`, {
      size: 4,
      eTag: '"a-old"',
      body: "aaaa",
    })
    await ensureWorkspaceCheckpoint(PREFIX)
    store.add(manifestKey(), {
      size: 9,
      eTag: '"corrupt"',
      body: "{not-json",
      scope: "Scope=checkpoint",
    })
    store.add(`${PREFIX}/state/a.sqlite`, {
      size: 4,
      eTag: '"a-new"',
      body: "nnnn",
    })
    const before = store.commands.length

    await expect(ensureWorkspaceCheckpoint(PREFIX)).rejects.toThrow(
      "manifest is invalid",
    )

    expect(
      store.commands.slice(before).some(
        (command) =>
          command.name === "CopyObjectCommand" ||
          command.name === "DeleteObjectCommand",
      ),
    ).toBe(false)
    expect(store.current(`${PREFIX}/state/a.sqlite`)?.body).toBe("nnnn")
  })

  it("version-preservingly deletes, replays a lost response, and rolls back an uncommitted delete", async () => {
    const retained = store.add(`${PREFIX}/memory/remove.md`, {
      size: 4,
      eTag: '"remove-old"',
      body: "old!",
      scope: "Scope=private",
    })
    store.add(`${PREFIX}/memory/keep.md`, {
      size: 4,
      eTag: '"keep"',
      body: "keep",
      scope: "Scope=private",
    })
    const base = (await ensureWorkspaceCheckpoint(PREFIX))
      .workspaceGeneration
    const commandsBeforeDelete = store.commands.length

    const deleted = await deleteWorkspacePath(
      PREFIX,
      "memory/remove.md",
      base,
    )
    const firstDeleteCommands = store.commands.slice(commandsBeforeDelete)
    expect(
      firstDeleteCommands.filter(
        (command) => command.name === "ListObjectsV2Command",
      ),
    ).toHaveLength(1)
    expect(deleted.workspaceGeneration).toBe(
      workspaceGeneration([
        { path: "memory/keep.md", size: 4, eTag: '"keep"' },
      ]),
    )
    await expect(
      deleteWorkspacePath(PREFIX, "memory/remove.md", base),
    ).resolves.toEqual(deleted)
    expect(
      store.commands
        .slice(commandsBeforeDelete)
        .filter(
          (command) => command.name === "ListObjectsV2Command",
        ),
    ).toHaveLength(2)
    expect(store.current(`${PREFIX}/memory/remove.md`)).toBeUndefined()
    expect(store.versions(`${PREFIX}/memory/remove.md`)).toEqual(
      expect.arrayContaining([retained]),
    )
    expect(
      store.versions(`${PREFIX}/memory/remove.md`)[0]?.deleteMarker,
    ).toBe(true)

    const recovered = await ensureWorkspaceCheckpoint(PREFIX)
    expect(recovered.workspaceGeneration).toBe(
      manifest().workspaceGeneration,
    )
    expect(store.current(`${PREFIX}/memory/remove.md`)?.body).toBe("old!")
  })

  it("commits prefix-free file-to-directory and directory-to-file transitions", async () => {
    store.add(`${PREFIX}/a`, {
      size: 4,
      eTag: '"file-a"',
      body: "file",
      scope: "Scope=private",
    })
    const fileGeneration = (await ensureWorkspaceCheckpoint(PREFIX))
      .workspaceGeneration
    const deletedFile = await deleteWorkspacePath(
      PREFIX,
      "a",
      fileGeneration,
    )
    store.add(`${PREFIX}/a/b`, {
      size: 5,
      eTag: '"child-b"',
      body: "child",
      scope: "Scope=private",
    })
    const directoryGeneration = workspaceGeneration([
      { path: "a/b", size: 5, eTag: '"child-b"' },
    ])
    await commitWorkspaceCheckpoint(
      PREFIX,
      fileGeneration,
      directoryGeneration,
    )
    expect(deletedFile.workspaceGeneration).not.toBe(
      directoryGeneration,
    )
    expect(
      (manifest().entries as Array<Record<string, unknown>>).map(
        (entry) => entry.path,
      ),
    ).toEqual(["a/b"])

    const deletedChild = await deleteWorkspacePath(
      PREFIX,
      "a/b",
      directoryGeneration,
    )
    store.add(`${PREFIX}/a`, {
      size: 4,
      eTag: '"file-new"',
      body: "new!",
      scope: "Scope=private",
    })
    const finalGeneration = workspaceGeneration([
      { path: "a", size: 4, eTag: '"file-new"' },
    ])
    await commitWorkspaceCheckpoint(
      PREFIX,
      directoryGeneration,
      finalGeneration,
    )
    expect(deletedChild.workspaceGeneration).not.toBe(finalGeneration)
    expect(
      (manifest().entries as Array<Record<string, unknown>>).map(
        (entry) => entry.path,
      ),
    ).toEqual(["a"])
  })

  it.each([
    ["ordinary", "a", "a/b"],
    ["router attachment root", "attachments", "attachments/input.pdf"],
  ])(
    "fails closed on an initial %s file/descendant conflict",
    async (_label, parent, child) => {
      store.add(`${PREFIX}/${parent}`, {
        size: 4,
        eTag: '"parent"',
        body: "file",
      })
      store.add(`${PREFIX}/${child}`, {
        size: 5,
        eTag: '"child"',
        body: "child",
      })
      const before = store.commands.length

      await expect(ensureWorkspaceCheckpoint(PREFIX)).rejects.toThrow(
        "conflicting file and descendant paths",
      )

      expect(store.current(manifestKey())).toBeUndefined()
      expect(
        store.commands.slice(before).some(
          (command) =>
            command.name === "CopyObjectCommand" ||
            command.name === "DeleteObjectCommand" ||
            command.name === "PutObjectCommand",
        ),
      ).toBe(false)
    },
  )
})
