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
  requestedRepositoryIds: undefined as number[] | undefined,
  hasStoredDirectBinding: false,
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

  it("keeps conversation search required when this request picks a repository", () => {
    const result = splitRoutingToolNames({
      ...none,
      hasDurableRepositoryBinding: true,
      requestedRepositoryIds: [12],
      hasProjectBinding: true,
    })

    expect(result.tools).toContain("searchConversationRepositories")
    expect(result.bindingTools).toEqual(["searchProjectRepositories"])
  })

  it("keeps a stored direct pick when the request sends no selection", () => {
    const result = splitRoutingToolNames({
      ...none,
      hasDurableRepositoryBinding: true,
      hasStoredDirectBinding: true,
      hasProjectBinding: true,
    })

    expect(result.bindingTools).toEqual(["searchProjectRepositories"])
  })

  /**
   * Clearing the picker sends `repositoryIds: []`, which removes the stored
   * direct binding later in the same turn. Routing must not still treat that
   * stale row as a user choice, or "draw a cat" goes back to a text model.
   */
  it("treats a cleared picker as no choice even with a stale direct binding", () => {
    const result = splitRoutingToolNames({
      ...none,
      hasDurableRepositoryBinding: true,
      requestedRepositoryIds: [],
      hasStoredDirectBinding: true,
      hasProjectBinding: true,
    })

    expect(result.bindingTools).toEqual([
      "searchConversationRepositories",
      "searchProjectRepositories",
    ])
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
