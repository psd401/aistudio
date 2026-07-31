import {
  agenticModelAdmissionIssues,
  isAgenticModelReady,
  missingAgenticRoutingTiers,
} from "@/lib/agents/model-readiness"

const readyModel = {
  active: true,
  architectEnabled: true,
  agenticReady: true,
  contextWindowTokens: 200_000,
  maxOutputTokens: 8_192,
  inputCostPer1kTokens: "0.001",
  outputCostPer1kTokens: "0.005",
}

describe("agentic model admission", () => {
  it("requires explicit approval, limits, and complete pricing", () => {
    expect(isAgenticModelReady(readyModel)).toBe(true)
    expect(
      agenticModelAdmissionIssues({
        ...readyModel,
        agenticReady: false,
        maxOutputTokens: null,
        outputCostPer1kTokens: null,
      })
    ).toEqual([
      "not_approved",
      "missing_output_limit",
      "missing_output_pricing",
    ])
  })

  it("rejects an output limit larger than the context window", () => {
    expect(
      agenticModelAdmissionIssues({
        ...readyModel,
        contextWindowTokens: 4_096,
        maxOutputTokens: 8_192,
      })
    ).toContain("output_exceeds_context")
  })

  it("reports routing tiers that have no ready model", () => {
    expect(
      missingAgenticRoutingTiers([
        { tier: "light", readyModelCount: 1 },
        { tier: "medium", readyModelCount: 0 },
        { tier: "high", readyModelCount: 2 },
      ])
    ).toEqual(["medium"])
  })
})
