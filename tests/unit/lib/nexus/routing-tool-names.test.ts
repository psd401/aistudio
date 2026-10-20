/**
 * #1900 follow-up — which routing tools are present only because of a
 * Project/Skill/Assistant binding. The router drops exactly these for an image
 * request, so getting the split wrong either sends bound-conversation image
 * requests to a text model again, or lets a user-chosen repository be ignored.
 */
import { splitRoutingToolNames } from "@/lib/nexus/routing-tool-names"

const none = {
  enabledTools: [] as string[],
  requiresAttachmentTools: false,
  hasDurableRepositoryBinding: false,
  hasUserChosenRepository: false,
  hasProjectBinding: false,
  hasSkillBinding: false,
}

describe("splitRoutingToolNames", () => {
  it("marks every repository tool of a Project-bound conversation as binding-only", () => {
    const result = splitRoutingToolNames({
      ...none,
      hasDurableRepositoryBinding: true,
      hasProjectBinding: true,
    })

    expect(result.tools).toEqual(["searchConversationRepositories", "searchProjectRepositories"])
    expect(result.bindingTools).toEqual(result.tools)
  })

  it("marks Skill-bound repository tools as binding-only", () => {
    const result = splitRoutingToolNames({
      ...none,
      hasDurableRepositoryBinding: true,
      hasSkillBinding: true,
    })

    expect(result.bindingTools).toEqual([
      "searchConversationRepositories",
      "searchSkillRepositories",
    ])
  })

  it("keeps conversation search required when the user chose a repository", () => {
    const result = splitRoutingToolNames({
      ...none,
      hasDurableRepositoryBinding: true,
      hasUserChosenRepository: true,
      hasProjectBinding: true,
    })

    expect(result.tools).toContain("searchConversationRepositories")
    expect(result.bindingTools).toEqual(["searchProjectRepositories"])
  })

  it("never treats a hand-enabled tool or an attachment as binding-only", () => {
    const result = splitRoutingToolNames({
      ...none,
      enabledTools: ["webSearch", "searchProjectRepositories"],
      requiresAttachmentTools: true,
      hasDurableRepositoryBinding: true,
      hasProjectBinding: true,
    })

    expect(result.tools).toEqual([
      "webSearch",
      "searchProjectRepositories",
      "searchNexusAttachments",
      "searchConversationRepositories",
    ])
    expect(result.bindingTools).toEqual(["searchConversationRepositories"])
  })

  it("adds nothing for an unbound conversation", () => {
    expect(splitRoutingToolNames(none)).toEqual({ tools: [], bindingTools: [] })
  })
})
