/** @jest-environment node */

const mockGetNexusEnabledModels = jest.fn()
const mockFilterAccessibleResourceIds = jest.fn()
const mockGetConfig = jest.fn()
const mockClassify = jest.fn()
const mockExecuteQuery = jest.fn()
const mockGetConfiguredChatProviders = jest.fn()

jest.mock("@/lib/db/drizzle", () => ({ getNexusEnabledModels: () => mockGetNexusEnabledModels() }))
jest.mock("@/lib/ai/provider-credentials", () => ({
  getConfiguredChatProviders: () => mockGetConfiguredChatProviders(),
}))
jest.mock("@/lib/db/drizzle/resource-access", () => ({
  filterAccessibleResourceIds: (...args: unknown[]) => mockFilterAccessibleResourceIds(...args),
}))
jest.mock("@/lib/db/drizzle-client", () => ({ executeQuery: (...args: unknown[]) => mockExecuteQuery(...args) }))
jest.mock("../config", () => ({ getNexusRouterConfig: () => mockGetConfig() }))
jest.mock("../classifier", () => ({ classifyNexusRequest: (...args: unknown[]) => mockClassify(...args) }))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}))

import { mergeRoutedToolNames, routeNexusRequest } from "../router"
import { previewWorkspaceAutoConnectorIds } from "../workspace-auto-connector"
import { nexusRouterConfigSchema } from "../types"

const models = [
  { id: 1, name: "GPT Luna", provider: "openai", modelId: "gpt-luna", capabilities: "[]", providerMetadata: { nexusRouterTier: "light" } },
  { id: 2, name: "GPT Terra", provider: "openai", modelId: "gpt-terra", capabilities: "[]", providerMetadata: { nexusRouterTier: "medium" } },
  { id: 3, name: "Claude Sonnet", provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet", capabilities: "[]", providerMetadata: { nexusRouterTier: "medium" } },
  { id: 4, name: "Gemini Flash", provider: "google", modelId: "gemini-flash", capabilities: '["web_search"]', providerMetadata: { nexusRouterTier: "medium" } },
  { id: 5, name: "Nano Banana", provider: "google", modelId: "gemini-3.1-flash-image", capabilities: '["image_generation"]', providerMetadata: { nexusRouterTier: "light" } },
  { id: 6, name: "Gemini Deep Research", provider: "google", modelId: "gemini-deep-research", capabilities: '["deep_research"]', providerMetadata: { nexusRouterTier: "high" } },
  { id: 7, name: "Amazon Nova Lite", provider: "amazon-bedrock", modelId: "us.amazon.nova-lite-v1:0", capabilities: "[]", providerMetadata: { nexusRouterTier: "light" } },
  { id: 8, name: "No Tools", provider: "openai", modelId: "no-tools", capabilities: "[]", providerMetadata: { nexusRouterTier: "medium", supports_function_calling: false } },
]

const config = nexusRouterConfigSchema.parse({
  families: {
    openai: { light: ["gpt-luna"], medium: ["gpt-terra"], high: [] },
    anthropic: { light: [], medium: ["us.anthropic.claude-sonnet"], high: [] },
    google: { light: [], medium: ["gemini-flash"], high: [] },
  },
  specialists: {
    imageModels: ["gemini-3.1-flash-image"],
    instructionModels: ["gemini-flash"],
    webSearchModels: ["gemini-flash"],
    psdDataConnectorName: "psd-data",
  },
})

function defineNexusModelRouterSuite1Part1() {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetNexusEnabledModels.mockResolvedValue(models)
    mockFilterAccessibleResourceIds.mockResolvedValue(models.map(model => String(model.id)))
    mockGetConfig.mockResolvedValue({ config, mode: "active" })
    mockGetConfiguredChatProviders.mockResolvedValue(
      new Set(["openai", "google", "amazon-bedrock", "azure", "latimer"])
    )
    mockClassify.mockResolvedValue({
      intent: "general", tier: "medium", confidence: 0.9,
      reasonCodes: ["normal_request"], source: "classifier",
    })
  })

  it("merges automatic web search with manually enabled tools without duplicates", () => {
    expect(mergeRoutedToolNames(
      ["codeInterpreter", "webSearch"],
      ["webSearch"]
    )).toEqual(["codeInterpreter", "webSearch"])
  })

  it("constrains Advanced routing to the selected family", async () => {
    const result = await routeNexusRequest({
      text: "Help", fallbackModelId: "gpt-terra", experienceMode: "advanced",
      requestedFamily: "anthropic", enabledConnectorIds: [], userId: 7,
    })
    expect(result.modelId).toBe("us.anthropic.claude-sonnet")
    expect(result.metadata.selectedFamily).toBe("anthropic")
  })

  it("allows Standard Auto tiers to prefer Bedrock-native models", async () => {
    const bedrockFirstConfig = nexusRouterConfigSchema.parse({
      auto: { light: ["us.amazon.nova-lite-v1:0"], medium: [], high: [] },
    })
    mockGetConfig.mockResolvedValue({ config: bedrockFirstConfig, mode: "active" })
    mockClassify.mockResolvedValue({
      intent: "general", tier: "light", confidence: 0.9,
      reasonCodes: ["simple_request"], source: "classifier",
    })

    const result = await routeNexusRequest({
      text: "Define photosynthesis", fallbackModelId: "gpt-terra", experienceMode: "standard",
      requestedFamily: "auto", enabledConnectorIds: [], userId: 7,
    })

    expect(result.modelId).toBe("us.amazon.nova-lite-v1:0")
    expect(result.metadata.selectedFamily).toBe("fallback")
  })

  it("uses the image specialist regardless of requested family", async () => {
    mockClassify.mockResolvedValue({
      intent: "image", tier: "medium", confidence: 0.99,
      reasonCodes: ["explicit_image_request"], source: "deterministic",
    })
    const result = await routeNexusRequest({
      text: "Create an image", fallbackModelId: "gpt-terra", experienceMode: "advanced",
      requestedFamily: "anthropic", enabledConnectorIds: [], userId: 7,
    })
    expect(result.modelId).toBe("gemini-3.1-flash-image")
  })

  it("keeps attachment retrieval on a function-calling text model", async () => {
    const attachmentConfig = nexusRouterConfigSchema.parse({
      auto: {
        light: [],
        medium: ["no-tools", "gpt-terra"],
        high: [],
      },
    })
    mockGetConfig.mockResolvedValue({
      config: attachmentConfig,
      mode: "active",
    })

    const result = await routeNexusRequest({
      text: "Summarize my attachment",
      fallbackModelId: "no-tools",
      experienceMode: "standard",
      requestedFamily: "auto",
      enabledConnectorIds: [],
      enabledToolNames: ["searchNexusAttachments"],
      userId: 7,
    })

    expect(result.modelId).toBe("gpt-terra")
  })

  it("never selects the tool-bypassing Deep Research specialist for attachments", async () => {
    const attachmentConfig = nexusRouterConfigSchema.parse({
      auto: {
        light: [],
        medium: ["gemini-deep-research", "gpt-terra"],
        high: [],
      },
    })
    mockGetConfig.mockResolvedValue({
      config: attachmentConfig,
      mode: "active",
    })

    const result = await routeNexusRequest({
      text: "Research my attachment",
      fallbackModelId: "gemini-deep-research",
      experienceMode: "standard",
      requestedFamily: "auto",
      enabledConnectorIds: [],
      enabledToolNames: ["searchNexusAttachments"],
      userId: 7,
    })

    expect(result.modelId).toBe("gpt-terra")
  })

  }

function defineNexusModelRouterSuite1Part2() {it("enforces attachment tools when legacy routing is off", async () => {
    mockGetConfig.mockResolvedValue({ config, mode: "off" })

    const result = await routeNexusRequest({
      text: "Summarize my attachment",
      fallbackModelId: "no-tools",
      experienceMode: "standard",
      requestedFamily: "auto",
      enabledConnectorIds: [],
      enabledToolNames: ["searchNexusAttachments"],
      userId: 7,
    })

    expect(result.modelId).toBe("gpt-terra")
    expect(result.metadata.reasonCodes).toContain("required_tools_enforced")
    expect(mockClassify).not.toHaveBeenCalled()
  })

  it("enforces attachment tools instead of an unsafe shadow fallback", async () => {
    mockGetConfig.mockResolvedValue({ config, mode: "shadow" })

    const result = await routeNexusRequest({
      text: "Summarize my attachment",
      fallbackModelId: "no-tools",
      experienceMode: "standard",
      requestedFamily: "auto",
      enabledConnectorIds: [],
      enabledToolNames: ["searchNexusAttachments"],
      userId: 7,
    })

    expect(result.modelId).toBe("gpt-terra")
    expect(result.metadata.reasonCodes).toContain("required_tools_enforced")
  })

  it("does not route an attachment request to a specialist-only image model", async () => {
    mockClassify.mockResolvedValue({
      intent: "image", tier: "medium", confidence: 0.99,
      reasonCodes: ["explicit_image_request"], source: "deterministic",
    })

    const result = await routeNexusRequest({
      text: "Create an image based on my attachment",
      fallbackModelId: "gpt-terra",
      experienceMode: "standard",
      requestedFamily: "auto",
      enabledConnectorIds: [],
      enabledToolNames: ["searchNexusAttachments"],
      userId: 7,
    })

    expect(result.modelId).toBe("gpt-terra")
  })

  it("automatically attaches the database-backed PSD-data MCP server", async () => {
    mockClassify.mockResolvedValue({
      intent: "psd-data", tier: "medium", confidence: 0.98,
      reasonCodes: ["psd_data_domain"], source: "deterministic",
    })
    mockExecuteQuery.mockResolvedValue([{ id: "54f0f531-f7ab-485e-bd6b-65a95c4bc871", name: "PSD Data" }])
    const result = await routeNexusRequest({
      text: "Get attendance", fallbackModelId: "gpt-terra", experienceMode: "standard",
      requestedFamily: "auto", enabledConnectorIds: [], userId: 7,
    })
    expect(result.connectorIds).toEqual(["54f0f531-f7ab-485e-bd6b-65a95c4bc871"])
    expect(result.automaticConnectorIds).toEqual(["54f0f531-f7ab-485e-bd6b-65a95c4bc871"])
    expect(result.metadata.autoAttachedPsdData).toBe(true)
  })

  it("routes current-information requests to Gemini and automatically enables web search", async () => {
    mockClassify.mockResolvedValue({
      intent: "web-search", tier: "medium", confidence: 0.96,
      reasonCodes: ["current_web_information"], source: "deterministic",
    })
    const result = await routeNexusRequest({
      text: "Search the web for today's weather", fallbackModelId: "gpt-terra",
      experienceMode: "standard", requestedFamily: "auto",
      enabledConnectorIds: [], userId: 7,
    })
    expect(result.modelId).toBe("gemini-flash")
    expect(result.automaticToolNames).toEqual(["webSearch"])
    expect(result.metadata.autoEnabledWebSearch).toBe(true)
  })

  it("fails clearly when the selected Advanced family cannot perform web search", async () => {
    mockClassify.mockResolvedValue({
      intent: "web-search", tier: "medium", confidence: 0.96,
      reasonCodes: ["current_web_information"], source: "deterministic",
    })
    await expect(routeNexusRequest({
      text: "Browse the web for current policy", fallbackModelId: "gpt-terra",
      experienceMode: "advanced", requestedFamily: "anthropic",
      enabledConnectorIds: [], userId: 7,
    })).rejects.toThrow("Web search is not available")
  })

  it("records a proposed route but executes the fallback in shadow mode", async () => {
    mockGetConfig.mockResolvedValue({ config, mode: "shadow" })
    const result = await routeNexusRequest({
      text: "Help", fallbackModelId: "gpt-terra", experienceMode: "advanced",
      requestedFamily: "anthropic", enabledConnectorIds: [], userId: 7,
    })
    expect(result.modelId).toBe("gpt-terra")
    expect(result.metadata.proposedModelId).toBe("us.anthropic.claude-sonnet")
  })

  }

function defineNexusModelRouterSuite1Part3() {it("stays in the Advanced family when the requested tier is unavailable", async () => {
    mockClassify.mockResolvedValue({
      intent: "general", tier: "high", confidence: 0.9,
      reasonCodes: ["complex"], source: "classifier",
    })
    const result = await routeNexusRequest({
      text: "Complex request", fallbackModelId: "gpt-terra", experienceMode: "advanced",
      requestedFamily: "anthropic", enabledConnectorIds: [], userId: 7,
    })
    expect(result.modelId).toBe("us.anthropic.claude-sonnet")
    expect(result.metadata.fallbackUsed).toBe(true)
  })

  it("does not silently cross an unavailable Advanced family", async () => {
    mockFilterAccessibleResourceIds.mockResolvedValue(["1", "2", "4", "5", "6"])
    await expect(routeNexusRequest({
      text: "Help", fallbackModelId: "gpt-terra", experienceMode: "advanced",
      requestedFamily: "anthropic", enabledConnectorIds: [], userId: 7,
    })).rejects.toThrow("anthropic family")
  })

  it("keeps shadow mode non-disruptive when a proposed family is unavailable", async () => {
    mockGetConfig.mockResolvedValue({ config, mode: "shadow" })
    mockFilterAccessibleResourceIds.mockResolvedValue(["1", "2", "4", "5", "6"])
    const result = await routeNexusRequest({
      text: "Help", fallbackModelId: "gpt-terra", experienceMode: "advanced",
      requestedFamily: "anthropic", enabledConnectorIds: [], userId: 7,
    })
    expect(result.modelId).toBe("gpt-terra")
    expect(result.metadata.fallbackUsed).toBe(true)
  })

  it("never routes an ordinary request to a specialist-only Deep Research model", async () => {
    mockClassify.mockResolvedValue({
      intent: "general", tier: "high", confidence: 0.9,
      reasonCodes: ["complex"], source: "classifier",
    })
    const result = await routeNexusRequest({
      text: "Complex request", fallbackModelId: "gpt-terra", experienceMode: "standard",
      requestedFamily: "auto", enabledConnectorIds: [], userId: 7,
    })
    expect(result.modelId).not.toBe("gemini-deep-research")
    expect(result.modelId).toBe("gpt-terra")
  })

  it("fails clearly instead of answering an image request with a text model", async () => {
    mockClassify.mockResolvedValue({
      intent: "image", tier: "medium", confidence: 0.99,
      reasonCodes: ["explicit_image_request"], source: "deterministic",
    })
    mockFilterAccessibleResourceIds.mockResolvedValue(["1", "2", "3", "4", "6"])
    await expect(routeNexusRequest({
      text: "Create an image", fallbackModelId: "gpt-terra", experienceMode: "standard",
      requestedFamily: "auto", enabledConnectorIds: [], userId: 7,
    })).rejects.toThrow("Image generation is not available")
  })

  it("fails clearly instead of silently answering without PSD-data", async () => {
    mockClassify.mockResolvedValue({
      intent: "psd-data", tier: "medium", confidence: 0.98,
      reasonCodes: ["psd_data_domain"], source: "deterministic",
    })
    mockExecuteQuery.mockRejectedValue(new Error("database unavailable"))
    await expect(routeNexusRequest({
      text: "Get attendance", fallbackModelId: "gpt-terra", experienceMode: "standard",
      requestedFamily: "auto", enabledConnectorIds: [], userId: 7,
    })).rejects.toThrow("PSD Data is not configured")
  })
}

const defineNexusModelRouterSuite1 = () => {
  defineNexusModelRouterSuite1Part1()
  defineNexusModelRouterSuite1Part2()
  defineNexusModelRouterSuite1Part3()
};

describe("Nexus model router", defineNexusModelRouterSuite1)

/**
 * #1786: while a live-data artifact is open beside the chat, follow-up turns
 * ("add a school dropdown") classify as `general` and used to lose the PSD Data
 * tools — the model then wrote SQL against guessed column names and reported
 * success. The open ARTIFACT, not the sentence, is the routing signal.
 */
describe("Nexus model router workspace attachment", () => {
  const PSD_CONNECTOR_ID = "54f0f531-f7ab-485e-bd6b-65a95c4bc871"
  const editableArtifact = {
    objectId: "441910f0-9e0e-4633-acf1-62415e388db4",
    kind: "artifact" as const,
    editable: true,
  }
  const followUp = {
    text: "Add a school dropdown at the top that filters every card and chart",
    fallbackModelId: "gpt-terra",
    experienceMode: "standard" as const,
    requestedFamily: "auto" as const,
    enabledConnectorIds: [],
    userId: 7,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetNexusEnabledModels.mockResolvedValue(models)
    mockFilterAccessibleResourceIds.mockResolvedValue(models.map(model => String(model.id)))
    mockGetConfig.mockResolvedValue({ config, mode: "active" })
    mockGetConfiguredChatProviders.mockResolvedValue(
      new Set(["openai", "google", "amazon-bedrock", "azure", "latimer"])
    )
    mockExecuteQuery.mockResolvedValue([{ id: PSD_CONNECTOR_ID, name: "PSD Data" }])
    // The exact misclassification from the reproduction: a UI-sounding edit.
    mockClassify.mockResolvedValue({
      intent: "general", tier: "medium", confidence: 0.9,
      reasonCodes: ["normal_request"], source: "classifier",
    })
  })

  it("attaches PSD Data for an editable artifact even when the turn classifies as general", async () => {
    const result = await routeNexusRequest({ ...followUp, workspace: editableArtifact })

    expect(result.connectorIds).toEqual([PSD_CONNECTOR_ID])
    expect(result.workspacePsdDataConnectorId).toBe(PSD_CONNECTOR_ID)
    expect(result.metadata.autoAttachedPsdData).toBe(true)
    expect(result.metadata.reasonCodes).toContain("workspace_artifact_psd_data")
  })

  it("never makes a workspace connector REQUIRED, which would fail the whole turn", async () => {
    // `automaticConnectorIds` is the list the chat route throws over when a
    // connector will not connect. A user who lacks PSD Data access must still
    // be able to ask for a dropdown.
    const result = await routeNexusRequest({ ...followUp, workspace: editableArtifact })

    expect(result.automaticConnectorIds).toEqual([])
  })

  it("still makes an explicit psd-data request REQUIRED, workspace or not", async () => {
    mockClassify.mockResolvedValue({
      intent: "psd-data", tier: "medium", confidence: 0.98,
      reasonCodes: ["psd_data_domain"], source: "deterministic",
    })

    const result = await routeNexusRequest({ ...followUp, workspace: editableArtifact })

    expect(result.automaticConnectorIds).toEqual([PSD_CONNECTOR_ID])
  })

  it("does not duplicate a manually enabled PSD Data connector", async () => {
    const result = await routeNexusRequest({
      ...followUp,
      enabledConnectorIds: [PSD_CONNECTOR_ID],
      workspace: editableArtifact,
    })

    expect(result.connectorIds).toEqual([PSD_CONNECTOR_ID])
  })

  it("leaves a document workspace turn exactly as it was", async () => {
    const result = await routeNexusRequest({
      ...followUp,
      workspace: { ...editableArtifact, kind: "document" as const },
    })

    expect(result.connectorIds).toEqual([])
    expect(result.metadata.autoAttachedPsdData).toBe(false)
    expect(result.workspacePsdDataConnectorId).toBeNull()
    // No connector lookup at all — a document turn must not pay for one.
    expect(mockExecuteQuery).not.toHaveBeenCalled()
  })

  it("does not attach for a read-only viewer, who authors nothing", async () => {
    const result = await routeNexusRequest({
      ...followUp,
      workspace: { ...editableArtifact, editable: false },
    })

    expect(result.connectorIds).toEqual([])
    expect(result.workspacePsdDataConnectorId).toBeNull()
    expect(mockExecuteQuery).not.toHaveBeenCalled()
  })

  it("leaves a turn with no workspace open exactly as it was", async () => {
    const result = await routeNexusRequest({ ...followUp, workspace: null })

    expect(result.connectorIds).toEqual([])
    expect(result.workspacePsdDataConnectorId).toBeNull()
    expect(mockExecuteQuery).not.toHaveBeenCalled()
  })

  it("degrades instead of failing the turn when the connector cannot be resolved", async () => {
    // Unlike an explicit psd-data REQUEST (which fails closed), the user asked
    // for a dropdown — the turn still has work to do, just not data work.
    mockExecuteQuery.mockRejectedValue(new Error("database unavailable"))

    const result = await routeNexusRequest({ ...followUp, workspace: editableArtifact })

    expect(result.connectorIds).toEqual([])
    expect(result.workspacePsdDataConnectorId).toBeNull()
    expect(result.metadata.autoAttachedPsdData).toBe(false)
    expect(result.metadata.reasonCodes).toContain("workspace_psd_data_unavailable")
  })

  it("names the connector in shadow mode, which never mutates the turn's connectors", async () => {
    mockGetConfig.mockResolvedValue({ config, mode: "shadow" })

    const result = await routeNexusRequest({ ...followUp, workspace: editableArtifact })

    expect(result.connectorIds).toEqual([])
    expect(result.workspacePsdDataConnectorId).toBe(PSD_CONNECTOR_ID)
    expect(result.metadata.reasonCodes).toContain("workspace_psd_data_unavailable")
  })

  it("names the connector with the router off, so the route can still see the user's own choice", async () => {
    // Router-off attaches nothing; the route decides from the tools that bound.
    mockGetConfig.mockResolvedValue({ config, mode: "off" })

    const result = await routeNexusRequest({
      ...followUp,
      enabledConnectorIds: [PSD_CONNECTOR_ID],
      workspace: editableArtifact,
    })

    expect(result.connectorIds).toEqual([PSD_CONNECTOR_ID])
    expect(result.workspacePsdDataConnectorId).toBe(PSD_CONNECTOR_ID)
  })

  describe("prefers a model that can call the data tools it attaches", () => {
    const noToolsFirst = nexusRouterConfigSchema.parse({
      ...config,
      auto: { light: [], medium: ["no-tools", "gpt-terra"], high: [] },
    })

    it("routes an artifact turn past a candidate without function calling", async () => {
      mockGetConfig.mockResolvedValue({ config: noToolsFirst, mode: "active" })

      const result = await routeNexusRequest({ ...followUp, workspace: editableArtifact })

      expect(result.modelId).toBe("gpt-terra")
      expect(result.connectorIds).toEqual([PSD_CONNECTOR_ID])
    })

    it("keeps the first candidate for a turn that attaches no data tools", async () => {
      mockGetConfig.mockResolvedValue({ config: noToolsFirst, mode: "active" })

      const result = await routeNexusRequest({
        ...followUp,
        workspace: { ...editableArtifact, kind: "document" as const },
      })

      expect(result.modelId).toBe("no-tools")
    })

    it("keeps the normal model instead of failing when none can call tools", async () => {
      // A preference, not a requirement: the chat route warns this turn instead.
      mockGetConfig.mockResolvedValue({ config: noToolsFirst, mode: "active" })
      mockFilterAccessibleResourceIds.mockResolvedValue(["8"])

      const result = await routeNexusRequest({
        ...followUp,
        fallbackModelId: "no-tools",
        workspace: editableArtifact,
      })

      expect(result.modelId).toBe("no-tools")
      expect(result.connectorIds).toEqual([PSD_CONNECTOR_ID])
    })
  })

  it("makes no PSD Data claim for a document workspace with the router off", async () => {
    mockGetConfig.mockResolvedValue({ config, mode: "off" })

    const result = await routeNexusRequest({
      ...followUp,
      workspace: { ...editableArtifact, kind: "document" as const },
    })

    expect(result.workspacePsdDataConnectorId).toBeNull()
    expect(mockExecuteQuery).not.toHaveBeenCalled()
  })

})

/**
 * The Connect popover answers "is PSD Data on for this workspace?" BEFORE any
 * turn is sent, from `previewWorkspaceAutoConnectorIds`. The only wrong answer
 * is one that disagrees with what the router then actually does, so pin the two
 * against each other rather than against a hardcoded expectation.
 */
/**
 * #1696: a pasted link needs `web_fetch`, but `web_fetch` is universal — the
 * decision names no required tool, so nothing else keeps such a turn off a
 * model that cannot call it. Its own suite rather than a case inside the
 * workspace block, which is already at the `max-lines-per-function` ceiling.
 */
describe("Nexus model router link handling", () => {
  const noToolsFirst = nexusRouterConfigSchema.parse({
    ...config,
    auto: { light: [], medium: ["no-tools", "gpt-terra"], high: [] },
  })
  const turn = {
    text: "Rewrite this paragraph to be shorter",
    fallbackModelId: "gpt-terra",
    experienceMode: "standard" as const,
    requestedFamily: "auto" as const,
    enabledConnectorIds: [],
    userId: 7,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetNexusEnabledModels.mockResolvedValue(models)
    mockFilterAccessibleResourceIds.mockResolvedValue(models.map(model => String(model.id)))
    mockGetConfig.mockResolvedValue({ config: noToolsFirst, mode: "active" })
    mockGetConfiguredChatProviders.mockResolvedValue(
      new Set(["openai", "google", "amazon-bedrock", "azure", "latimer"])
    )
    // The reported shape: a link turn that classifies as plain `general`.
    mockClassify.mockResolvedValue({
      intent: "general", tier: "medium", confidence: 0.9,
      reasonCodes: ["explicit_url_web_fetch"], source: "deterministic",
    })
  })

  it("routes a pasted-link turn past a candidate without function calling", async () => {
    const result = await routeNexusRequest({
      ...turn,
      text: "Open https://example.com/article and quote the main heading",
    })

    expect(result.modelId).toBe("gpt-terra")
  })

  it("keeps the first candidate for a turn with no link and no data tools", async () => {
    const result = await routeNexusRequest(turn)

    expect(result.modelId).toBe("no-tools")
  })

  it("keeps the normal model for a link turn when none can call tools", async () => {
    // The preference must never harden into a requirement — that is the hard
    // "cannot access URLs" dead end #1696 removed.
    mockFilterAccessibleResourceIds.mockResolvedValue(["8"])

    const result = await routeNexusRequest({
      ...turn,
      fallbackModelId: "no-tools",
      text: "Summarize https://example.com/article for me",
    })

    expect(result.modelId).toBe("no-tools")
  })

  it("degrades a link + current-info turn to fetch-only when web search is unavailable", async () => {
    // Anthropic has no web-search model; without the fallback this throws and
    // refuses the link outright.
    mockClassify.mockResolvedValue({
      intent: "web-search", tier: "medium", confidence: 0.96,
      reasonCodes: ["current_web_information", "explicit_url_web_fetch"], source: "deterministic",
    })

    const result = await routeNexusRequest({
      ...turn,
      experienceMode: "advanced",
      requestedFamily: "anthropic",
      text: "Summarize https://example.com and give today's weather",
    })

    expect(result.modelId).toBe("us.anthropic.claude-sonnet")
    expect(result.metadata.intent).toBe("general")
    expect(result.metadata.reasonCodes).toContain("web_search_unavailable_fetch_only")
    expect(result.automaticToolNames).toEqual([])
  })

  it("still fails an explicit web-search request with a link when search is unavailable", async () => {
    // The user asked for a search; silently answering from the page alone
    // would skip what they asked for.
    mockClassify.mockResolvedValue({
      intent: "web-search", tier: "medium", confidence: 0.96,
      reasonCodes: ["current_web_information"], source: "deterministic",
    })

    await expect(routeNexusRequest({
      ...turn,
      experienceMode: "advanced",
      requestedFamily: "anthropic",
      text: "Search the web for district guidance, then compare it with https://example.com",
    })).rejects.toThrow("Web search is not available")
  })

  it("still fails a current-info turn with no link when web search is unavailable", async () => {
    mockClassify.mockResolvedValue({
      intent: "web-search", tier: "medium", confidence: 0.96,
      reasonCodes: ["current_web_information"], source: "deterministic",
    })

    await expect(routeNexusRequest({
      ...turn,
      experienceMode: "advanced",
      requestedFamily: "anthropic",
      text: "Give today's weather",
    })).rejects.toThrow("Web search is not available")
  })
})

describe("Nexus workspace auto-connector preview", () => {
  const PSD_CONNECTOR_ID = "54f0f531-f7ab-485e-bd6b-65a95c4bc871"
  const editableArtifact = {
    objectId: "441910f0-9e0e-4633-acf1-62415e388db4",
    kind: "artifact" as const,
    editable: true,
  }
  const followUp = {
    text: "Add a school dropdown at the top that filters every card and chart",
    fallbackModelId: "gpt-terra",
    experienceMode: "standard" as const,
    requestedFamily: "auto" as const,
    enabledConnectorIds: [],
    userId: 7,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetNexusEnabledModels.mockResolvedValue(models)
    mockFilterAccessibleResourceIds.mockResolvedValue(models.map(model => String(model.id)))
    mockGetConfig.mockResolvedValue({ config, mode: "active" })
    mockGetConfiguredChatProviders.mockResolvedValue(
      new Set(["openai", "google", "amazon-bedrock", "azure", "latimer"])
    )
    mockExecuteQuery.mockResolvedValue([{ id: PSD_CONNECTOR_ID, name: "PSD Data" }])
    mockClassify.mockResolvedValue({
      intent: "general", tier: "medium", confidence: 0.9,
      reasonCodes: ["normal_request"], source: "classifier",
    })
  })

  describe("agrees with the live routing decision", () => {
    it("previews the connector the router attaches", async () => {
      const routed = await routeNexusRequest({ ...followUp, workspace: editableArtifact })

      await expect(previewWorkspaceAutoConnectorIds(editableArtifact)).resolves.toEqual(
        routed.connectorIds
      )
      expect(routed.connectorIds).toEqual([PSD_CONNECTOR_ID])
    })

    it("previews nothing for a document, which the router also leaves alone", async () => {
      const workspace = { ...editableArtifact, kind: "document" as const }
      const routed = await routeNexusRequest({ ...followUp, workspace })

      await expect(previewWorkspaceAutoConnectorIds(workspace)).resolves.toEqual(
        routed.connectorIds
      )
      expect(routed.connectorIds).toEqual([])
    })

    it("previews nothing for a read-only viewer, who gets no attachment either", async () => {
      const workspace = { ...editableArtifact, editable: false }
      const routed = await routeNexusRequest({ ...followUp, workspace })

      await expect(previewWorkspaceAutoConnectorIds(workspace)).resolves.toEqual(
        routed.connectorIds
      )
    })

    it("previews nothing outside active routing, which attaches nothing", async () => {
      mockGetConfig.mockResolvedValue({ config, mode: "shadow" })
      const routed = await routeNexusRequest({ ...followUp, workspace: editableArtifact })

      await expect(previewWorkspaceAutoConnectorIds(editableArtifact)).resolves.toEqual(
        routed.connectorIds
      )
      expect(routed.connectorIds).toEqual([])
    })

    it("previews nothing when the connector cannot be resolved", async () => {
      mockExecuteQuery.mockRejectedValue(new Error("database unavailable"))

      await expect(previewWorkspaceAutoConnectorIds(editableArtifact)).resolves.toEqual([])
    })
  })
})

describe("Nexus model router credential filtering", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetNexusEnabledModels.mockResolvedValue(models)
    mockFilterAccessibleResourceIds.mockResolvedValue(models.map(model => String(model.id)))
    mockGetConfig.mockResolvedValue({ config, mode: "active" })
    mockClassify.mockResolvedValue({
      intent: "general", tier: "medium", confidence: 0.9,
      reasonCodes: ["normal_request"], source: "classifier",
    })
  })

  it("routes AUTO past a candidate whose provider credential is not configured", async () => {
    const autoConfig = nexusRouterConfigSchema.parse({
      auto: { light: [], medium: ["gpt-terra", "us.anthropic.claude-sonnet"], high: [] },
    })
    mockGetConfig.mockResolvedValue({ config: autoConfig, mode: "active" })
    mockGetConfiguredChatProviders.mockResolvedValue(new Set(["amazon-bedrock", "google"]))

    const result = await routeNexusRequest({
      text: "Help", fallbackModelId: "gpt-terra", experienceMode: "standard",
      requestedFamily: "auto", enabledConnectorIds: [], userId: 7,
    })

    expect(result.modelId).toBe("us.anthropic.claude-sonnet")
    expect(result.metadata.selectedFamily).toBe("anthropic")
  })

  it("keeps the explicitly selected model when routing is off, even without its provider key", async () => {
    mockGetConfig.mockResolvedValue({ config, mode: "off" })
    mockGetConfiguredChatProviders.mockResolvedValue(new Set(["amazon-bedrock", "google"]))

    const result = await routeNexusRequest({
      text: "Help", fallbackModelId: "gpt-terra", experienceMode: "standard",
      requestedFamily: "auto", enabledConnectorIds: [], userId: 7,
    })

    expect(result.modelId).toBe("gpt-terra")
  })

  it("fails clearly when the requested Advanced family's provider is not configured", async () => {
    mockGetConfiguredChatProviders.mockResolvedValue(new Set(["amazon-bedrock", "google"]))

    await expect(routeNexusRequest({
      text: "Help", fallbackModelId: "us.anthropic.claude-sonnet", experienceMode: "advanced",
      requestedFamily: "openai", enabledConnectorIds: [], userId: 7,
    })).rejects.toThrow("openai family")
  })

  it("re-routes required tools to a configured provider when routing is off and the explicit model's provider is not", async () => {
    mockGetConfig.mockResolvedValue({ config, mode: "off" })
    mockGetConfiguredChatProviders.mockResolvedValue(new Set(["amazon-bedrock", "google"]))

    const result = await routeNexusRequest({
      text: "Summarize my attachment", fallbackModelId: "gpt-terra", experienceMode: "standard",
      requestedFamily: "auto", enabledConnectorIds: [],
      enabledToolNames: ["searchNexusAttachments"], userId: 7,
    })

    expect(result.modelId).toBe("us.anthropic.claude-sonnet")
    expect(result.metadata.reasonCodes).toContain("required_tools_enforced")
  })

  it("fails fast before provider creation when no configured provider has an accessible model", async () => {
    // The explicitly selected model's provider being unconfigured must NOT be
    // executed as a last resort here — that is the stream-time missing-key 500
    // this filter exists to prevent. Exhaustion fails fast with a clear error.
    mockGetConfiguredChatProviders.mockResolvedValue(new Set(["azure"]))

    await expect(routeNexusRequest({
      text: "Help", fallbackModelId: "gpt-terra", experienceMode: "standard",
      requestedFamily: "auto", enabledConnectorIds: [], userId: 7,
    })).rejects.toThrow("No accessible Nexus model is available")
  })

  it("does not offer image generation through an unconfigured provider", async () => {
    mockClassify.mockResolvedValue({
      intent: "image", tier: "medium", confidence: 0.99,
      reasonCodes: ["explicit_image_request"], source: "deterministic",
    })
    mockGetConfiguredChatProviders.mockResolvedValue(new Set(["amazon-bedrock", "openai"]))

    await expect(routeNexusRequest({
      text: "Create an image", fallbackModelId: "gpt-terra", experienceMode: "standard",
      requestedFamily: "auto", enabledConnectorIds: [], userId: 7,
    })).rejects.toThrow("Image generation is not available")
  })
})

/**
 * #1840: the classifier rates the latest message alone. With an artifact open
 * beside the chat, the shortest authoring follow-ups ("did that work?", "turn
 * live data back on") score `light` — and on the light tier the model was
 * observed making no tool calls at all and describing a panel control that does
 * not exist, instead of calling `update_workspace_artifact`. An editable
 * artifact therefore raises the tier FLOOR to medium.
 */
describe("Nexus model router workspace artifact tier floor", () => {
  const PSD_CONNECTOR_ID = "54f0f531-f7ab-485e-bd6b-65a95c4bc871"
  const editableArtifact = {
    objectId: "441910f0-9e0e-4633-acf1-62415e388db4",
    kind: "artifact" as const,
    editable: true,
  }
  // Advanced + a single family so the tier maps to exactly one model id:
  // light -> gpt-luna, medium -> gpt-terra.
  const shortFollowUp = {
    text: "Did that work?",
    fallbackModelId: "gpt-luna",
    experienceMode: "advanced" as const,
    requestedFamily: "openai" as const,
    enabledConnectorIds: [],
    userId: 7,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetNexusEnabledModels.mockResolvedValue(models)
    mockFilterAccessibleResourceIds.mockResolvedValue(models.map(model => String(model.id)))
    mockGetConfig.mockResolvedValue({ config, mode: "active" })
    mockGetConfiguredChatProviders.mockResolvedValue(
      new Set(["openai", "google", "amazon-bedrock", "azure", "latimer"])
    )
    mockExecuteQuery.mockResolvedValue([{ id: PSD_CONNECTOR_ID, name: "PSD Data" }])
    // The reproduction: a three-word follow-up in an authoring session.
    mockClassify.mockResolvedValue({
      intent: "general", tier: "light", confidence: 0.9,
      reasonCodes: ["simple_request"], source: "classifier",
    })
  })

  it("raises a light follow-up to medium with an editable artifact bound", async () => {
    const result = await routeNexusRequest({ ...shortFollowUp, workspace: editableArtifact })

    expect(result.metadata.tier).toBe("medium")
    expect(result.modelId).toBe("gpt-terra")
    expect(result.metadata.reasonCodes).toContain("workspace_artifact_min_tier")
  })

  it("leaves a turn with no workspace on the light tier", async () => {
    const result = await routeNexusRequest({ ...shortFollowUp, workspace: null })

    expect(result.metadata.tier).toBe("light")
    expect(result.modelId).toBe("gpt-luna")
    expect(result.metadata.reasonCodes).not.toContain("workspace_artifact_min_tier")
  })

  it("leaves a bound document on the light tier", async () => {
    const result = await routeNexusRequest({
      ...shortFollowUp,
      workspace: { ...editableArtifact, kind: "document" as const },
    })

    expect(result.metadata.tier).toBe("light")
    expect(result.modelId).toBe("gpt-luna")
    expect(result.metadata.reasonCodes).not.toContain("workspace_artifact_min_tier")
  })

  it("leaves a read-only artifact viewer on the light tier", async () => {
    const result = await routeNexusRequest({
      ...shortFollowUp,
      workspace: { ...editableArtifact, editable: false },
    })

    expect(result.metadata.tier).toBe("light")
    expect(result.modelId).toBe("gpt-luna")
    expect(result.metadata.reasonCodes).not.toContain("workspace_artifact_min_tier")
  })

  it("is a floor, not a cap: a high classification keeps its own tier", async () => {
    mockClassify.mockResolvedValue({
      intent: "general", tier: "high", confidence: 0.95,
      reasonCodes: ["complex_request"], source: "classifier",
    })

    const result = await routeNexusRequest({ ...shortFollowUp, workspace: editableArtifact })

    expect(result.metadata.tier).toBe("high")
    expect(result.metadata.reasonCodes).not.toContain("workspace_artifact_min_tier")
  })

  it("adds no reason code when the classifier already chose medium", async () => {
    mockClassify.mockResolvedValue({
      intent: "general", tier: "medium", confidence: 0.9,
      reasonCodes: ["normal_request"], source: "classifier",
    })

    const result = await routeNexusRequest({ ...shortFollowUp, workspace: editableArtifact })

    expect(result.metadata.tier).toBe("medium")
    expect(result.metadata.reasonCodes).not.toContain("workspace_artifact_min_tier")
  })

  it("still attaches PSD Data on the raised turn", async () => {
    const result = await routeNexusRequest({ ...shortFollowUp, workspace: editableArtifact })

    expect(result.connectorIds).toEqual([PSD_CONNECTOR_ID])
    expect(result.metadata.reasonCodes).toContain("workspace_artifact_psd_data")
  })

  /**
   * The strongest form of the shadow contract: with a required tool present,
   * `selectedRuntimeModel` executes `selection.model`, so even the RAISED TIER
   * alone would reroute — straight to the configured medium candidate, no
   * `minTier` needed. Shadow must therefore withhold the floor entirely, keeping
   * `metadata.tier` at the classifier's own verdict.
   */
  it("withholds the floor from a shadow turn with a required tool", async () => {
    mockGetConfig.mockResolvedValue({ config, mode: "shadow" })

    const result = await routeNexusRequest({
      ...shortFollowUp,
      enabledToolNames: ["searchNexusAttachments"],
      workspace: editableArtifact,
    })

    expect(result.modelId).toBe("gpt-luna")
    expect(result.metadata.tier).toBe("light")
    expect(result.metadata.reasonCodes).toContain("required_tools_enforced")
    expect(result.metadata.reasonCodes).not.toContain("workspace_artifact_min_tier")
    expect(result.metadata.reasonCodes).not.toContain("workspace_artifact_min_tier_unmet")
  })

  it("still applies the floor to an ACTIVE turn with a required tool", async () => {
    const result = await routeNexusRequest({
      ...shortFollowUp,
      enabledToolNames: ["searchNexusAttachments"],
      workspace: editableArtifact,
    })

    expect(result.modelId).toBe("gpt-terra")
    expect(result.metadata.tier).toBe("medium")
    expect(result.metadata.reasonCodes).toContain("workspace_artifact_min_tier")
  })

  it("records the raise in shadow mode, which still executes the legacy fallback", async () => {
    mockGetConfig.mockResolvedValue({ config, mode: "shadow" })

    const result = await routeNexusRequest({ ...shortFollowUp, workspace: editableArtifact })

    expect(result.modelId).toBe("gpt-luna")
    expect(result.metadata.proposedModelId).toBe("gpt-terra")
    expect(result.metadata.tier).toBe("medium")
    expect(result.metadata.reasonCodes).toContain("workspace_artifact_min_tier")
    expect(result.metadata.reasonCodes).not.toContain("workspace_artifact_min_tier_unmet")
  })

  /**
   * The floor is still a PREFERENCE, never a new way to fail a turn: with nothing
   * at or above it, the turn keeps the light model it would have had — and says
   * so, because `workspace_artifact_min_tier` alone would look like proof the fix
   * was live on exactly the turns where it was defeated.
   */
  it("flags the floor as unmet when only a light model is accessible", async () => {
    mockFilterAccessibleResourceIds.mockResolvedValue(["1"])

    const result = await routeNexusRequest({ ...shortFollowUp, workspace: editableArtifact })

    expect(result.modelId).toBe("gpt-luna")
    expect(result.metadata.tier).toBe("medium")
    expect(result.metadata.reasonCodes).toContain("workspace_artifact_min_tier")
    expect(result.metadata.reasonCodes).toContain("workspace_artifact_min_tier_unmet")
  })

  it("does not flag the floor unmet for a turn with no workspace", async () => {
    mockFilterAccessibleResourceIds.mockResolvedValue(["1"])

    const result = await routeNexusRequest({ ...shortFollowUp, workspace: null })

    expect(result.modelId).toBe("gpt-luna")
    expect(result.metadata.reasonCodes).not.toContain("workspace_artifact_min_tier_unmet")
  })

  /**
   * The specialist lists ignore `tier` entirely, so neither the raise nor a
   * below-floor specialist model says anything about tool-capable routing.
   */
  it("does not flag the floor unmet on a specialist image turn", async () => {
    mockClassify.mockResolvedValue({
      intent: "image", tier: "light", confidence: 0.99,
      reasonCodes: ["explicit_image_request"], source: "deterministic",
    })

    const result = await routeNexusRequest({
      ...shortFollowUp,
      requestedFamily: "auto" as const,
      workspace: editableArtifact,
    })

    expect(result.modelId).toBe("gemini-3.1-flash-image")
    expect(result.metadata.reasonCodes).not.toContain("workspace_artifact_min_tier_unmet")
  })
})

/**
 * `selectRoutedTextModel` sweeps `[tier, medium, light, high]`, so with the tier
 * raised to medium it would still prefer an accessible LIGHT model over an
 * accessible high one — landing the turn on exactly the model the floor exists to
 * avoid. `minTier` makes the below-floor models ineligible first (#1840).
 */
describe("Nexus model router artifact floor with no medium model accessible", () => {
  const PSD_CONNECTOR_ID = "54f0f531-f7ab-485e-bd6b-65a95c4bc871"
  const editableArtifact = {
    objectId: "441910f0-9e0e-4633-acf1-62415e388db4",
    kind: "artifact" as const,
    editable: true,
  }
  const shortFollowUp = {
    text: "Did that work?",
    fallbackModelId: "gpt-luna",
    experienceMode: "advanced" as const,
    requestedFamily: "openai" as const,
    enabledConnectorIds: [],
    userId: 7,
  }
  const gptSol = {
    id: 9, name: "GPT Sol", provider: "openai", modelId: "gpt-sol",
    capabilities: "[]", providerMetadata: { nexusRouterTier: "high" },
  }

  beforeEach(() => {
    jest.clearAllMocks()
    // Only the light and the high model are reachable — no medium anywhere.
    mockGetNexusEnabledModels.mockResolvedValue([...models, gptSol])
    mockFilterAccessibleResourceIds.mockResolvedValue(["1", "9"])
    mockGetConfig.mockResolvedValue({ config, mode: "active" })
    mockGetConfiguredChatProviders.mockResolvedValue(
      new Set(["openai", "google", "amazon-bedrock", "azure", "latimer"])
    )
    mockExecuteQuery.mockResolvedValue([{ id: PSD_CONNECTOR_ID, name: "PSD Data" }])
    mockClassify.mockResolvedValue({
      intent: "general", tier: "light", confidence: 0.9,
      reasonCodes: ["simple_request"], source: "classifier",
    })
  })

  it("reaches the high model instead of falling back below the floor", async () => {
    const result = await routeNexusRequest({ ...shortFollowUp, workspace: editableArtifact })

    expect(result.modelId).toBe("gpt-sol")
    expect(result.metadata.reasonCodes).toContain("workspace_artifact_min_tier")
    expect(result.metadata.reasonCodes).not.toContain("workspace_artifact_min_tier_unmet")
  })

  it("still keeps the light model for the same access with no workspace bound", async () => {
    const result = await routeNexusRequest({ ...shortFollowUp, workspace: null })

    expect(result.modelId).toBe("gpt-luna")
  })

  /**
   * Shadow mode exists to answer "what would active routing have chosen?", so a
   * proposal that skipped the floor would compare the wrong thing — naming the
   * light model for a deployment where active mode reaches the high one.
   */
  it("proposes the same high model in shadow mode while executing the fallback", async () => {
    mockGetConfig.mockResolvedValue({ config, mode: "shadow" })

    const result = await routeNexusRequest({ ...shortFollowUp, workspace: editableArtifact })

    expect(result.modelId).toBe("gpt-luna")
    expect(result.metadata.proposedModelId).toBe("gpt-sol")
    expect(result.metadata.reasonCodes).not.toContain("workspace_artifact_min_tier_unmet")
  })

  /**
   * `selectModel` takes its image-specialist branch only while no input tool is
   * required. An image turn WITH one falls through to ordinary tier-aware text
   * routing, so treating every image intent as tier-independent would drop the
   * floor exactly where it still applies.
   */
  it("applies the floor to an image turn that falls through to text routing", async () => {
    mockClassify.mockResolvedValue({
      intent: "image", tier: "light", confidence: 0.99,
      reasonCodes: ["explicit_image_request"], source: "deterministic",
    })

    const result = await routeNexusRequest({
      ...shortFollowUp,
      enabledToolNames: ["searchNexusAttachments"],
      workspace: editableArtifact,
    })

    expect(result.modelId).toBe("gpt-sol")
    expect(result.metadata.reasonCodes).not.toContain("workspace_artifact_min_tier_unmet")
  })

  /**
   * A shadow turn with a required tool EXECUTES `selection.model`, not the legacy
   * fallback, so the preferences must not touch it: shadow mode quietly rerouting
   * live traffic would break the one contract it has.
   */
  it("leaves a shadow turn with a required tool on its original route", async () => {
    mockGetConfig.mockResolvedValue({ config, mode: "shadow" })

    const result = await routeNexusRequest({
      ...shortFollowUp,
      enabledToolNames: ["searchNexusAttachments"],
      workspace: editableArtifact,
    })

    expect(result.modelId).toBe("gpt-luna")
    expect(result.metadata.reasonCodes).toContain("required_tools_enforced")
  })
})
