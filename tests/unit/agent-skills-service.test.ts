const executeQueryMock = jest.fn()
const readSkillMarkdownMock = jest.fn()

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
  executeTransaction: jest.fn(),
}))

jest.mock("@/lib/skills/skill-publish-pipeline", () => ({
  invokeSkillScan: jest.fn(),
  readSkillMarkdown: (...args: unknown[]) => readSkillMarkdownMock(...args),
  uploadSkillDraft: jest.fn(),
}))

import { AgentSkillsService } from "@/lib/agent-skills/service"

function mockAccessibleSkill(skill: { name: string; s3Key: string } | null) {
  executeQueryMock
    .mockResolvedValueOnce([{ id: 42 }])
    .mockResolvedValueOnce(skill ? [skill] : [])
}

beforeEach(() => {
  executeQueryMock.mockReset()
  readSkillMarkdownMock.mockReset()
})

describe("AgentSkillsService.load", () => {
  it("returns a bundled marker only after the catalog access query succeeds", async () => {
    mockAccessibleSkill({
      name: "psd-conversation-coach",
      s3Key: "image:agent-v1:psd-conversation-coach",
    })

    await expect(
      new AgentSkillsService().load(
        "owner@psd401.net",
        "psd-conversation-coach"
      )
    ).resolves.toEqual({
      name: "psd-conversation-coach",
      source: "bundled",
    })
    expect(readSkillMarkdownMock).not.toHaveBeenCalled()
  })

  it("does not expose a bundled marker for an inaccessible catalog row", async () => {
    mockAccessibleSkill(null)

    await expect(
      new AgentSkillsService().load(
        "owner@psd401.net",
        "psd-conversation-coach"
      )
    ).resolves.toBeNull()
    expect(readSkillMarkdownMock).not.toHaveBeenCalled()
  })

  it("continues to load approved user-authored skills from S3", async () => {
    mockAccessibleSkill({
      name: "owner-conversation-notes",
      s3Key: "skills/user/owner/approved/owner-conversation-notes",
    })
    readSkillMarkdownMock.mockResolvedValue(
      "---\nname: owner-conversation-notes\n---"
    )

    await expect(
      new AgentSkillsService().load(
        "owner@psd401.net",
        "owner-conversation-notes"
      )
    ).resolves.toEqual({
      name: "owner-conversation-notes",
      skillMd: "---\nname: owner-conversation-notes\n---",
    })
  })
})
