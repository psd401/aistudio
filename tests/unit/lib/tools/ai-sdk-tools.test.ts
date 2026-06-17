import { describe, it, expect } from "@jest/globals"
import {
  AI_SDK_TOOLS,
  getSelectableToolConfigs,
  getSelectableToolConfig,
  filterToolsByCapabilities,
  type ModelCapabilities,
} from "@/lib/tools/catalog/ai-sdk-tools"
import { TOOL_MANIFEST } from "@/lib/tools/catalog/manifest"

/**
 * Single-source unification for AI SDK chat tools (#924 follow-up).
 *
 * These tests pin the contract that `ai-sdk-tools.ts` is the ONE definition of the
 * chat tools and that the catalog manifest derives from it (so the server + client
 * registries, which derive from the catalog/source, stay in lockstep).
 */

/** Build a ModelCapabilities with everything off, then enable the given keys. */
function caps(enabled: (keyof ModelCapabilities)[]): ModelCapabilities {
  const all: (keyof ModelCapabilities)[] = [
    "webSearch",
    "codeInterpreter",
    "codeExecution",
    "grounding",
    "workspaceTools",
    "canvas",
    "artifacts",
    "thinking",
    "reasoning",
    "computerUse",
    "responsesAPI",
    "promptCaching",
    "contextCaching",
    "imageGeneration",
  ]
  const result = Object.fromEntries(all.map((k) => [k, false])) as ModelCapabilities
  for (const key of enabled) result[key] = true
  return result
}

describe("ai-sdk-tools selectable registry", () => {
  it("excludes universal tools (show_chart) and exposes the 3 selectable tools", () => {
    const configs = getSelectableToolConfigs()
    const names = configs.map((c) => c.name)
    expect(names).toEqual(["webSearch", "codeInterpreter", "generateImage"])
    expect(names).not.toContain("showChart")
  })

  it("carries display metadata for each selectable tool", () => {
    const web = getSelectableToolConfig("webSearch")
    expect(web).toMatchObject({
      name: "webSearch",
      displayName: "Web Search",
      category: "search",
      requiredCapabilities: ["webSearch", "grounding"],
    })
    expect(getSelectableToolConfig("generateImage")?.category).toBe("media")
  })

  it("returns undefined for a non-selectable / unknown name", () => {
    expect(getSelectableToolConfig("showChart")).toBeUndefined()
    expect(getSelectableToolConfig("nope")).toBeUndefined()
  })
})

describe("filterToolsByCapabilities (model gating)", () => {
  it("shows a tool when the model has ANY of its required capabilities", () => {
    const onlyWebSearch = filterToolsByCapabilities(caps(["webSearch"]))
    expect(onlyWebSearch.map((t) => t.name)).toEqual(["webSearch"])
  })

  it("shows the image tool only when imageGeneration is present", () => {
    expect(filterToolsByCapabilities(caps(["imageGeneration"])).map((t) => t.name)).toEqual([
      "generateImage",
    ])
    expect(filterToolsByCapabilities(caps([])).map((t) => t.name)).toEqual([])
  })

  it("includes code interpreter via either codeInterpreter or codeExecution", () => {
    expect(
      filterToolsByCapabilities(caps(["codeExecution"])).some((t) => t.name === "codeInterpreter")
    ).toBe(true)
  })
})

describe("catalog manifest derives from the single source", () => {
  it("has an ai_sdk manifest entry for every AI_SDK_TOOLS entry", () => {
    for (const tool of AI_SDK_TOOLS) {
      const entry = TOOL_MANIFEST.find((e) => e.identifier === tool.identifier)
      expect(entry).toBeDefined()
      expect(entry?.surfaces).toContain("ai_sdk")
      expect(entry?.name).toBe(tool.wireName)
      expect(entry?.requiredScopes).toEqual(tool.requiredScopes)
    }
  })

  it("carries UI metadata on selectable manifest entries and omits it on universals", () => {
    const webEntry = TOOL_MANIFEST.find((e) => e.identifier === "chat.web_search")
    expect(webEntry?.displayName).toBe("Web Search")
    expect(webEntry?.requiredCapabilities).toEqual(["webSearch", "grounding"])

    const chartEntry = TOOL_MANIFEST.find((e) => e.identifier === "chat.show_chart")
    expect(chartEntry?.displayName).toBeUndefined()
  })

  it("defines no duplicate friendly names", () => {
    const friendly = AI_SDK_TOOLS.map((t) => t.friendlyName)
    expect(new Set(friendly).size).toBe(friendly.length)
  })
})
