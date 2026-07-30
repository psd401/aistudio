import { bundledSkillRegistration } from "@/infra/lambdas/agent-skill-initializer/registration"

describe("bundled skill registration", () => {
  it("points the coach at deployed artifacts and persists its Read-only pin", () => {
    expect(
      bundledSkillRegistration(
        {
          name: "psd-conversation-coach",
          summary: "Practice a crucial conversation",
          description: "Conversation coaching",
          allowedTools: ["Read"],
          sourceHash: "source-hash",
          imageTag: "unknown",
        },
        "agent-v1"
      )
    ).toEqual({
      name: "psd-conversation-coach",
      summary: "Practice a crucial conversation",
      s3Key: "skills/bundled/agent-v1/psd-conversation-coach",
      allowedTools: ["Read"],
    })
  })

  it("normalizes absent and invalid runtime tool entries", () => {
    expect(
      bundledSkillRegistration(
        {
          name: "psd-test",
          summary: "Test",
          allowedTools: ["", "  ", " Read ", 42 as unknown as string],
          sourceHash: "source-hash",
          imageTag: "unknown",
        },
        "agent-v1"
      )?.allowedTools
    ).toEqual(["Read"])

    expect(
      bundledSkillRegistration(
        {
          name: "psd-test",
          summary: "Test",
          sourceHash: "source-hash",
          imageTag: "unknown",
        },
        "agent-v1"
      )?.allowedTools
    ).toEqual([])
  })

  it("skips incomplete manifest entries", () => {
    expect(
      bundledSkillRegistration(
        {
          name: "",
          summary: "Missing name",
          sourceHash: "source-hash",
          imageTag: "unknown",
        },
        "agent-v1"
      )
    ).toBeNull()

    expect(
      bundledSkillRegistration(
        {
          name: "../unsafe",
          summary: "Unsafe name",
          sourceHash: "source-hash",
          imageTag: "unknown",
        },
        "agent-v1"
      )
    ).toBeNull()

    expect(
      bundledSkillRegistration(
        {
          name: "psd-test",
          summary: "Unsafe tag",
          sourceHash: "source-hash",
          imageTag: "unknown",
        },
        "../unsafe"
      )
    ).toBeNull()
  })
})
