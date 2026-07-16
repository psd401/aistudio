/** @jest-environment node */

const mockGetSettings = jest.fn()

jest.mock("@/lib/settings-manager", () => ({ getSettings: (...args: unknown[]) => mockGetSettings(...args) }))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}))

import { getNexusRouterConfig } from "../config"

describe("Nexus router configuration", () => {
  beforeEach(() => jest.clearAllMocks())

  it("defaults to shadow Nova Micro routing with Nano Banana image candidates", async () => {
    mockGetSettings.mockResolvedValue({ NEXUS_ROUTER_CONFIG_V1: null, NEXUS_ROUTER_MODE: null })
    const result = await getNexusRouterConfig()
    expect(result.mode).toBe("shadow")
    expect(result.config.classifier.modelId).toBe("us.amazon.nova-micro-v1:0")
    expect(result.config.specialists.imageModels[0]).toBe("gemini-3.1-flash-image-preview")
  })

  it("loads ordered candidates and shadow mode from settings", async () => {
    mockGetSettings.mockResolvedValue({
      NEXUS_ROUTER_MODE: "shadow",
      NEXUS_ROUTER_CONFIG_V1: JSON.stringify({
        version: "test-2",
        families: {
          openai: { light: ["small"], medium: ["medium"], high: ["large"] },
          anthropic: { light: [], medium: [], high: [] },
          google: { light: [], medium: [], high: [] },
        },
      }),
    })
    const result = await getNexusRouterConfig()
    expect(result.mode).toBe("shadow")
    expect(result.config.families.openai.medium).toEqual(["medium"])
  })

  it("falls back safely when JSON or mode is invalid", async () => {
    mockGetSettings.mockResolvedValue({
      NEXUS_ROUTER_MODE: "broken",
      NEXUS_ROUTER_CONFIG_V1: "{not-json",
    })
    const result = await getNexusRouterConfig()
    expect(result.mode).toBe("shadow")
    expect(result.config.confidenceFloor).toBe(0.55)
  })
})
