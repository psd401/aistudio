/**
 * The workspace list operation must expose object metadata.
 *
 * The restore inside the agent container ranks session transcripts by recency
 * so a cold start pulls the ~20 that matter instead of all 812 (202 MB, 70.8s
 * of dead time on 2026-07-27). It can only do that if the broker returns
 * mtimes — ListObjectsV2 already includes them, they were simply dropped.
 *
 * `paths` MUST survive alongside `entries`: containers deploy independently of
 * the web tier, so an older image is always in flight during a rollout and
 * still reads that field. Removing it would break every running agent's
 * restore the moment this route deployed.
 */

const send = jest.fn()

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send })),
  ListObjectsV2Command: jest.fn().mockImplementation((input) => ({ input })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  PutObjectCommand: jest.fn(),
  HeadObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
  CreateMultipartUploadCommand: jest.fn(),
  CompleteMultipartUploadCommand: jest.fn(),
  AbortMultipartUploadCommand: jest.fn(),
  UploadPartCommand: jest.fn(),
}))

jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn().mockResolvedValue("https://signed.example/x"),
}))

import { listWorkspaceObjects } from "@/lib/agent-workspace/storage-broker"

const PREFIX = "hagelk-db0f32b5"
const RETIRED_SOURCE = `${JSON.stringify({
  version: 1,
  socket: {
    path: "/home/node/.openclaw/exec-approvals.sock",
    token: "AbCdEfGhIjKlMnOpQrStUvWxYz_12345",
  },
  defaults: {},
  agents: {},
})}\n`

beforeEach(() => {
  send.mockReset()
  process.env.AGENT_WORKSPACE_BUCKET = "psd-agents-dev-390844780692"
})

describe("listWorkspaceObjects", () => {
  it("returns size and mtime for every object", async () => {
    send.mockResolvedValue({
      Contents: [
        {
          Key: `${PREFIX}/agents/main/sessions/a.jsonl`,
          Size: 250_000,
          LastModified: new Date("2026-07-27T06:00:00Z"),
          ETag: '"generation-a"',
        },
        {
          Key: `${PREFIX}/memory/MEMORY.md`,
          Size: 13_683,
          LastModified: new Date("2026-07-20T00:00:00Z"),
          ETag: '"generation-memory"',
        },
      ],
    })

    const result = await listWorkspaceObjects(PREFIX)

    expect(result.entries).toEqual([
      {
        path: "agents/main/sessions/a.jsonl",
        size: 250_000,
        lastModified: Math.floor(Date.parse("2026-07-27T06:00:00Z") / 1000),
        eTag: '"generation-a"',
      },
      {
        path: "memory/MEMORY.md",
        size: 13_683,
        lastModified: Math.floor(Date.parse("2026-07-20T00:00:00Z") / 1000),
        eTag: '"generation-memory"',
      },
    ])
  })

  it("still returns paths for containers running an older image", async () => {
    send.mockResolvedValue({
      Contents: [
        { Key: `${PREFIX}/a.md`, Size: 1, LastModified: new Date() },
        { Key: `${PREFIX}/b.md`, Size: 2, LastModified: new Date() },
      ],
    })

    const result = await listWorkspaceObjects(PREFIX)

    expect(result.paths).toEqual(["a.md", "b.md"])
    expect(result.paths).toEqual(result.entries.map((e) => e.path))
  })

  it("makes exactly one S3 call for both fields", async () => {
    // The metadata must be free. Fetching it separately would turn one list
    // into an N+1 HeadObject storm across thousands of objects.
    send.mockResolvedValue({
      Contents: [{ Key: `${PREFIX}/a.md`, Size: 1, LastModified: new Date() }],
    })

    await listWorkspaceObjects(PREFIX)

    expect(send).toHaveBeenCalledTimes(1)
  })

  it("tolerates objects with no metadata rather than dropping them", async () => {
    // A missing mtime must not remove the file from the restore; the client
    // treats 0 as "cannot rank" and keeps everything.
    send.mockResolvedValue({
      Contents: [{ Key: `${PREFIX}/a.md` }],
    })

    const result = await listWorkspaceObjects(PREFIX)

    expect(result.entries).toEqual([
      { path: "a.md", size: 0, lastModified: 0, eTag: "" },
    ])
    expect(result.paths).toEqual(["a.md"])
  })

  it("excludes keys outside the signed prefix and the prefix itself", async () => {
    send.mockResolvedValue({
      Contents: [
        { Key: `${PREFIX}/`, Size: 0, LastModified: new Date() },
        { Key: "someone-else/secret.md", Size: 9, LastModified: new Date() },
        { Key: `${PREFIX}/ok.md`, Size: 9, LastModified: new Date() },
      ],
    })

    const result = await listWorkspaceObjects(PREFIX)

    expect(result.paths).toEqual(["ok.md"])
    expect(JSON.stringify(result)).not.toContain("secret.md")
  })
})

describe("retired exec approvals listing", () => {
  it("hides a verified generated source but preserves similarly named durable state", async () => {
    send.mockResolvedValueOnce({
      Contents: [
        {
          Key: `${PREFIX}/exec-approvals.json`,
          Size: Buffer.byteLength(RETIRED_SOURCE),
          ETag: '"retired"',
        },
        {
          Key: `${PREFIX}/exec-approvals.json.backup`,
          Size: 4,
          ETag: '"durable"',
        },
      ],
    }).mockResolvedValueOnce({
      ContentLength: Buffer.byteLength(RETIRED_SOURCE),
      ETag: '"retired"',
      Body: {
        transformToByteArray: async () => Buffer.from(RETIRED_SOURCE),
      },
    })

    const result = await listWorkspaceObjects(PREFIX)

    expect(result.paths).toEqual(["exec-approvals.json.backup"])
    expect(result.entries.map((entry) => entry.path)).toEqual(
      result.paths,
    )
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0].input).toMatchObject({
      Key: `${PREFIX}/exec-approvals.json`,
      IfMatch: '"retired"',
      Range: "bytes=0-4095",
    })
  })

  it("fails closed on an interrupted Doctor claim without reading its body", async () => {
    send.mockResolvedValue({
      Contents: [{
        Key: `${PREFIX}/exec-approvals.json.doctor-importing`,
        Size: Buffer.byteLength(RETIRED_SOURCE),
        ETag: '"claim"',
      }],
    })

    await expect(listWorkspaceObjects(PREFIX)).rejects.toThrow(
      "Retired workspace host state requires controlled migration",
    )
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("fails closed instead of hiding a legacy approvals policy", async () => {
    const unsafe = RETIRED_SOURCE.replace(
      '"defaults":{}',
      '"defaults":{"security":"deny"}',
    )
    send.mockResolvedValueOnce({
      Contents: [{
        Key: `${PREFIX}/exec-approvals.json`,
        Size: Buffer.byteLength(unsafe),
        ETag: '"unsafe"',
      }],
    }).mockResolvedValueOnce({
      ContentLength: Buffer.byteLength(unsafe),
      ETag: '"unsafe"',
      Body: {
        transformToByteArray: async () => Buffer.from(unsafe),
      },
    })

    await expect(listWorkspaceObjects(PREFIX)).rejects.toThrow(
      "Retired workspace host state requires controlled migration",
    )
  })

  it("fails closed when the source changes after the bounded list", async () => {
    send.mockResolvedValueOnce({
      Contents: [{
        Key: `${PREFIX}/exec-approvals.json`,
        Size: Buffer.byteLength(RETIRED_SOURCE),
        ETag: '"listed"',
      }],
    }).mockRejectedValueOnce(Object.assign(new Error("changed"), {
      name: "PreconditionFailed",
      $metadata: { httpStatusCode: 412 },
    }))

    await expect(listWorkspaceObjects(PREFIX)).rejects.toThrow(
      "Retired workspace host state requires controlled migration",
    )
    expect(send.mock.calls[1][0].input.IfMatch).toBe('"listed"')
  })
})

describe("listWorkspaceObjects continuation and path checks", () => {
  it("passes the continuation token through", async () => {
    send.mockResolvedValue({
      Contents: [{ Key: `${PREFIX}/a.md`, Size: 1, LastModified: new Date() }],
      NextContinuationToken: "next-page",
    })

    const result = await listWorkspaceObjects(PREFIX, "prev-page")

    expect(result.continuationToken).toBe("next-page")
    expect(send.mock.calls[0][0].input.ContinuationToken).toBe("prev-page")
  })

  it("returns ordinary punctuation from persisted user history", async () => {
    send.mockResolvedValue({
      Contents: [
        {
          Key: `${PREFIX}/memory/Review (draft), [v2].md`,
          Size: 4,
          LastModified: new Date(),
          ETag: '"punctuation"',
        },
      ],
    })

    const result = await listWorkspaceObjects(PREFIX)

    expect(result.paths).toEqual(["memory/Review (draft), [v2].md"])
  })

  it("fails closed before returning an incompatible durable path", async () => {
    send.mockResolvedValue({
      Contents: [
        {
          Key: `${PREFIX}/memory/bad\\name.md`,
          Size: 4,
          LastModified: new Date(),
          ETag: '"invalid"',
        },
      ],
    })

    await expect(listWorkspaceObjects(PREFIX)).rejects.toThrow(
      "Persisted workspace path is incompatible with the storage contract",
    )
  })
})
