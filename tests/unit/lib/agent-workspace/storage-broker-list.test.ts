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
  GetObjectCommand: jest.fn(),
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
        },
        {
          Key: `${PREFIX}/memory/MEMORY.md`,
          Size: 13_683,
          LastModified: new Date("2026-07-20T00:00:00Z"),
        },
      ],
    })

    const result = await listWorkspaceObjects(PREFIX)

    expect(result.entries).toEqual([
      {
        path: "agents/main/sessions/a.jsonl",
        size: 250_000,
        lastModified: Math.floor(Date.parse("2026-07-27T06:00:00Z") / 1000),
      },
      {
        path: "memory/MEMORY.md",
        size: 13_683,
        lastModified: Math.floor(Date.parse("2026-07-20T00:00:00Z") / 1000),
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

    expect(result.entries).toEqual([{ path: "a.md", size: 0, lastModified: 0 }])
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

  it("passes the continuation token through", async () => {
    send.mockResolvedValue({
      Contents: [{ Key: `${PREFIX}/a.md`, Size: 1, LastModified: new Date() }],
      NextContinuationToken: "next-page",
    })

    const result = await listWorkspaceObjects(PREFIX, "prev-page")

    expect(result.continuationToken).toBe("next-page")
    expect(send.mock.calls[0][0].input.ContinuationToken).toBe("prev-page")
  })
})
