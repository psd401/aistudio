jest.mock("@/lib/db/drizzle", () => ({
  getNexusEnabledModels: jest.fn(),
}))
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(),
}))
jest.mock("@/lib/db/schema", () => ({
  nexusMcpServers: {
    id: "id",
    name: "name",
  },
}))
jest.mock("@/lib/db/drizzle/resource-access", () => ({
  filterAccessibleResourceIds: jest.fn(),
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
  }),
}))
jest.mock("@/lib/ai/capability-utils", () => ({
  hasCapability: jest.fn(() => false),
}))
jest.mock("@/lib/ai/model-router/core", () => ({
  inferModelFamily: jest.fn((model: { provider: string }) => {
    if (model.provider === "openai") return "openai"
    if (model.provider === "google") return "google"
    return null
  }),
  inferModelTier: jest.fn(() => "medium"),
  selectRoutedTextModel: jest.fn(),
}))
jest.mock("@/lib/nexus/model-router/classifier", () => ({
  classifyNexusRequest: jest.fn(),
}))
jest.mock("@/lib/nexus/model-router/config", () => ({
  getNexusRouterConfig: jest.fn(),
}))

import { getNexusEnabledModels } from "@/lib/db/drizzle"
import { filterAccessibleResourceIds } from "@/lib/db/drizzle/resource-access"
import { selectRoutedTextModel } from "@/lib/ai/model-router/core"
import { classifyNexusRequest } from "@/lib/nexus/model-router/classifier"
import { getNexusRouterConfig } from "@/lib/nexus/model-router/config"
import { routeNexusRequest } from "@/lib/nexus/model-router/router"
import type {
  NexusRouterConfig,
  NexusRouterRuntimeMode,
} from "@/lib/nexus/model-router/types"

const CONFIG: NexusRouterConfig = {
  version: "test",
  classifier: {
    provider: "amazon-bedrock",
    modelId: "classifier",
    timeoutMs: 2_500,
  },
  families: {
    openai: { light: [], medium: ["routed"], high: [] },
    anthropic: { light: [], medium: [], high: [] },
    google: { light: [], medium: ["routed"], high: [] },
  },
  auto: { light: [], medium: ["routed"], high: [] },
  specialists: {
    imageModels: [],
    instructionModels: [],
    webSearchModels: ["routed"],
    psdDataConnectorName: "psd-data",
  },
  confidenceFloor: 0.55,
}

const MODELS = [
  {
    id: 1,
    modelId: "fallback",
    provider: "openai",
    capabilities: [],
  },
  {
    id: 2,
    modelId: "routed",
    provider: "google",
    capabilities: [],
  },
]

const getModelsMock = jest.mocked(getNexusEnabledModels)
const filterAccessibleMock = jest.mocked(filterAccessibleResourceIds)
const selectRoutedMock = jest.mocked(selectRoutedTextModel)
const classifyMock = jest.mocked(classifyNexusRequest)
const getConfigMock = jest.mocked(getNexusRouterConfig)

function setMode(mode: NexusRouterRuntimeMode): void {
  getConfigMock.mockResolvedValue({ config: CONFIG, mode })
}

function route(overrides: {
  enabledToolNames?: string[]
} = {}) {
  return routeNexusRequest({
    text: "Find current information",
    fallbackModelId: "fallback",
    experienceMode: "standard",
    requestedFamily: "auto",
    enabledConnectorIds: ["manual-connector"],
    enabledToolNames: overrides.enabledToolNames,
    userId: 42,
  })
}

describe("Nexus model router runtime modes", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getModelsMock.mockResolvedValue(
      MODELS as unknown as Awaited<ReturnType<typeof getNexusEnabledModels>>
    )
    filterAccessibleMock.mockResolvedValue(new Set(["1", "2"]))
    selectRoutedMock.mockImplementation((options) => ({
      model: options.models[1],
      fallbackUsed: false,
    }))
    classifyMock.mockResolvedValue({
      intent: "web-search",
      tier: "medium",
      confidence: 0.9,
      reasonCodes: ["deterministic_web_search"],
      source: "deterministic",
    })
  })

  it("keeps the fallback model when routing is off and no tools are required", async () => {
    setMode("off")

    const result = await route()

    expect(result.modelId).toBe("fallback")
    expect(result.metadata.reasonCodes).toEqual(["router_off"])
    expect(classifyMock).not.toHaveBeenCalled()
  })

  it("enforces required tools even while routing is off", async () => {
    setMode("off")

    const result = await route({ enabledToolNames: ["repositorySearch"] })

    expect(result.modelId).toBe("routed")
    expect(result.metadata.reasonCodes).toEqual([
      "router_off",
      "required_tools_enforced",
    ])
  })

  it("records a proposal but retains the fallback model in shadow mode", async () => {
    setMode("shadow")
    classifyMock.mockResolvedValueOnce({
      intent: "general",
      tier: "medium",
      confidence: 0.9,
      reasonCodes: ["default_general"],
      source: "deterministic",
    })

    const result = await route()

    expect(result.modelId).toBe("fallback")
    expect(result.metadata.proposedModelId).toBe("routed")
    expect(result.metadata.fallbackUsed).toBe(true)
    expect(result.automaticToolNames).toEqual([])
  })

  it("activates the routed model and required web-search tool in active mode", async () => {
    setMode("active")

    const result = await route()

    expect(result.modelId).toBe("routed")
    expect(result.automaticToolNames).toEqual(["webSearch"])
    expect(result.metadata.reasonCodes).toContain("required_tools_enforced")
  })
})
