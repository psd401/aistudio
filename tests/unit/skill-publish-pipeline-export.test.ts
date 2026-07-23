/**
 * Unit tests for the zip-export bounds in downloadSkillFolder (Issue #925, AC#7).
 *
 * Only clean-scanned approved skills reach the export, so the file-count and
 * total-size caps are guardrails against a pathological/corrupted folder
 * spiking ECS task memory — these tests pin that behaviour.
 */

const sendMock = jest.fn()

jest.mock("@aws-sdk/client-s3", () => {
  class ListObjectsV2Command {
    constructor(public input: unknown) {}
  }
  class GetObjectCommand {
    constructor(public input: { Key: string }) {}
  }
  class PutObjectCommand {
    constructor(public input: unknown) {}
  }
  class S3Client {
    send = sendMock
  }
  return { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand }
})

jest.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    send = jest.fn()
  },
  InvokeCommand: class {
    constructor(public input: unknown) {}
  },
}))

jest.mock("@/lib/settings-manager", () => ({
  getSetting: jest.fn(async (key: string) =>
    key === "AGENT_WORKSPACE_BUCKET" ? "test-bucket" : null
  ),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}))

import {
  downloadSkillFolder,
  MAX_EXPORT_FILES,
  MAX_EXPORT_TOTAL_BYTES,
} from "@/lib/skills/skill-publish-pipeline"

const PREFIX = "skills/user/a@b.com/approved/my-skill/"

// Drive the mocked S3 client: a single ListObjectsV2 page returning `keys`,
// then a GetObject per key returning `bodyFor(key)`.
function wireS3(keys: string[], bodyFor: (key: string) => string) {
  sendMock.mockReset()
  sendMock.mockImplementation((command: { input: Record<string, unknown> }) => {
    if ("Prefix" in command.input) {
      return Promise.resolve({
        Contents: keys.map((Key) => ({ Key })),
        IsTruncated: false,
      })
    }
    const key = command.input.Key as string
    return Promise.resolve({
      Body: { transformToString: async () => bodyFor(key) },
    })
  })
}

describe("downloadSkillFolder export bounds", () => {
  it("returns files for a normal folder", async () => {
    wireS3(
      [`${PREFIX}SKILL.md`, `${PREFIX}helpers/util.md`],
      (key) => `content of ${key}`
    )

    const files = await downloadSkillFolder(PREFIX)

    expect(files).toHaveLength(2)
    expect(files[0].path).toBe("SKILL.md")
    expect(files[1].path).toBe("helpers/util.md")
  })

  it("rejects folders exceeding the file-count cap", async () => {
    const keys = Array.from(
      { length: MAX_EXPORT_FILES + 1 },
      (_, i) => `${PREFIX}file-${i}.md`
    )
    wireS3(keys, () => "x")

    await expect(downloadSkillFolder(PREFIX)).rejects.toThrow(
      /exceeding the export limit of 50/
    )
  })

  it("does not issue downloads when the file-count cap is exceeded", async () => {
    const keys = Array.from(
      { length: MAX_EXPORT_FILES + 1 },
      (_, i) => `${PREFIX}file-${i}.md`
    )
    wireS3(keys, () => "x")

    await expect(downloadSkillFolder(PREFIX)).rejects.toThrow()

    // Only the ListObjectsV2 call should have fired — no GetObject fan-out.
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it("rejects folders exceeding the total-size cap", async () => {
    // Two files whose combined size crosses the byte cap.
    const half = "a".repeat(Math.floor(MAX_EXPORT_TOTAL_BYTES / 2) + 1)
    wireS3([`${PREFIX}a.md`, `${PREFIX}b.md`], () => half)

    await expect(downloadSkillFolder(PREFIX)).rejects.toThrow(
      /exceeding the export limit of .* bytes/
    )
  })
})
