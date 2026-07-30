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
  readSkillMarkdown,
} from "@/lib/skills/skill-publish-pipeline"

const PREFIX = "skills/user/a@b.com/approved/my-skill/"

// Drive the mocked S3 client: a single ListObjectsV2 page returning `keys`,
// then a GetObject per key returning `bodyFor(key)`.
function wireS3(
  keys: string[],
  bodyFor: (key: string) => string | Uint8Array
) {
  sendMock.mockReset()
  sendMock.mockImplementation((command: { input: Record<string, unknown> }) => {
    if ("Prefix" in command.input) {
      return Promise.resolve({
        Contents: keys.map((Key) => ({ Key })),
        IsTruncated: false,
      })
    }
    const key = command.input.Key as string
    const content = bodyFor(key)
    const bytes =
      typeof content === "string" ? Buffer.from(content, "utf8") : content
    return Promise.resolve({
      Body: {
        transformToString: async () => Buffer.from(bytes).toString("utf8"),
        transformToByteArray: async () => bytes,
      },
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
    expect(Buffer.from(files[0].content).toString("utf8")).toBe(
      `content of ${PREFIX}SKILL.md`
    )
  })

  it("preserves binary object bytes exactly", async () => {
    const binary = Uint8Array.from([0, 255, 1, 128, 13, 10])
    wireS3([`${PREFIX}assets/logo.png`], () => binary)

    const files = await downloadSkillFolder(PREFIX)

    expect(files).toEqual([
      { path: "assets/logo.png", content: binary },
    ])
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

describe("readSkillMarkdown bundled references", () => {
  const bundledPrefix =
    "skills/bundled/agent-v1/psd-conversation-coach/"

  it("appends bundled Markdown references for catalog-only runtimes", async () => {
    wireS3(
      [
        `${bundledPrefix}references/coaching-guide.md`,
        `${bundledPrefix}references/framework.md`,
        `${bundledPrefix}references/scenarios.md`,
      ],
      (key) => {
        if (key.endsWith("SKILL.md")) return "# Coach instructions"
        return `content for ${key.slice(bundledPrefix.length)}`
      }
    )

    const skillMd = await readSkillMarkdown(bundledPrefix)

    expect(skillMd).toContain("# Coach instructions")
    expect(skillMd).toContain("## Catalog-loaded references")
    expect(skillMd).toContain("### references/coaching-guide.md")
    expect(skillMd).toContain("content for references/framework.md")
    expect(skillMd).toContain("content for references/scenarios.md")
  })

  it("does not inject sibling files for user-authored skills", async () => {
    wireS3([], () => "# User skill")

    await expect(readSkillMarkdown(PREFIX)).resolves.toBe("# User skill")
    expect(sendMock).toHaveBeenCalledTimes(1)
  })
})
