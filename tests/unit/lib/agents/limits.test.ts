import { describe, it, expect } from "@jest/globals"
import {
  resolveAgentRunLimits,
  isCostCapExceeded,
} from "@/lib/agents/limits"
import { AGENT_LIMIT_DEFAULTS, AGENT_LIMIT_CEILINGS } from "@/lib/agents/types"

describe("resolveAgentRunLimits", () => {
  it("applies defaults when no config is provided", () => {
    const limits = resolveAgentRunLimits({})
    expect(limits.maxSteps).toBe(AGENT_LIMIT_DEFAULTS.maxSteps)
    expect(limits.timeoutSeconds).toBe(AGENT_LIMIT_DEFAULTS.timeoutSeconds)
    expect(limits.costCapCents).toBeNull()
  })

  it("passes through valid in-range values", () => {
    const limits = resolveAgentRunLimits({
      agentMaxSteps: 15,
      agentTimeoutSeconds: 120,
      agentCostCapCents: 500,
    })
    expect(limits.maxSteps).toBe(15)
    expect(limits.timeoutSeconds).toBe(120)
    expect(limits.costCapCents).toBe(500)
  })

  it("clamps steps and timeout to their ceilings", () => {
    const limits = resolveAgentRunLimits({
      agentMaxSteps: 9999,
      agentTimeoutSeconds: 99999,
    })
    expect(limits.maxSteps).toBe(AGENT_LIMIT_CEILINGS.maxSteps)
    expect(limits.timeoutSeconds).toBe(AGENT_LIMIT_CEILINGS.timeoutSeconds)
  })

  it("falls back to defaults for non-positive / non-finite input", () => {
    const limits = resolveAgentRunLimits({
      agentMaxSteps: 0,
      agentTimeoutSeconds: -5,
    })
    expect(limits.maxSteps).toBe(AGENT_LIMIT_DEFAULTS.maxSteps)
    expect(limits.timeoutSeconds).toBe(AGENT_LIMIT_DEFAULTS.timeoutSeconds)
  })

  it("treats a zero or negative cost cap as no cap (null)", () => {
    expect(resolveAgentRunLimits({ agentCostCapCents: 0 }).costCapCents).toBeNull()
    expect(resolveAgentRunLimits({ agentCostCapCents: -10 }).costCapCents).toBeNull()
    expect(resolveAgentRunLimits({ agentCostCapCents: null }).costCapCents).toBeNull()
  })

  it("floors fractional values", () => {
    const limits = resolveAgentRunLimits({
      agentMaxSteps: 12.9,
      agentTimeoutSeconds: 60.7,
      agentCostCapCents: 99.9,
    })
    expect(limits.maxSteps).toBe(12)
    expect(limits.timeoutSeconds).toBe(60)
    expect(limits.costCapCents).toBe(99)
  })
})

describe("isCostCapExceeded", () => {
  it("never trips when the cap is null", () => {
    const limits = resolveAgentRunLimits({})
    expect(isCostCapExceeded(limits, 1_000_000)).toBe(false)
  })

  it("trips at or above the cap", () => {
    const limits = resolveAgentRunLimits({ agentCostCapCents: 100 })
    expect(isCostCapExceeded(limits, 99)).toBe(false)
    expect(isCostCapExceeded(limits, 100)).toBe(true)
    expect(isCostCapExceeded(limits, 101)).toBe(true)
  })
})
