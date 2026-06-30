import { describe, it, expect, beforeEach } from "@jest/globals"

// Unit tests for the agent cost projection actions (#1083).
//
// The SQL aggregation runs in PostgreSQL, so these tests mock `executeQuery`
// and assert the JS-side shaping: totalUsd reduction, explicit missing-pricing
// surfacing, projection math (actual tokens × candidate pricing), candidate
// sanitization/dedup/cap, and the no-candidates short-circuit.

/* eslint-disable no-var */
var mockRequireRole: jest.Mock
// Queue of results executeQuery returns, in call order.
var queryResults: unknown[]
/* eslint-enable no-var */

mockRequireRole = jest.fn(() => Promise.resolve({ user: { id: 1 } }))
queryResults = []

jest.mock("@/lib/auth/role-helpers", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}))

// executeQuery just dequeues the next staged result; the query-builder callback
// is never executed (its DB work is what we're standing in for).
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(() => {
    if (queryResults.length === 0) {
      throw new Error("test: executeQuery called more times than staged")
    }
    return Promise.resolve(queryResults.shift())
  }),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  generateRequestId: () => "req",
  startTimer: () => jest.fn(),
  sanitizeForLogging: (x: unknown) => x,
}))

jest.mock("@/lib/error-utils", () => ({
  createSuccess: (data: unknown) => ({ isSuccess: true, data, message: "ok" }),
  handleError: (err: unknown) => ({
    isSuccess: false,
    data: null,
    message: err instanceof Error ? err.message : String(err),
  }),
}))

import {
  getAgentCostByModel,
  getAgentCostProjection,
} from "@/actions/admin/agent-cost-projection.actions"

beforeEach(() => {
  queryResults = []
  mockRequireRole.mockClear()
})

describe("getAgentCostByModel", () => {
  it("sums priced rows and surfaces missing-pricing models explicitly", async () => {
    queryResults = [
      [
        // GLM-5: priced (input $0.001/1k, output $0.0032/1k).
        {
          model: "zai.glm-5",
          messageCount: 4,
          inputTokens: 10000,
          outputTokens: 2000,
          // 10000*0.001/1000 + 2000*0.0032/1000 = 0.01 + 0.0064 = 0.0164
          usd: "0.0164",
          hasPricing: true,
        },
        // An unpriced model still in the data — must NOT be dropped.
        {
          model: "mystery-model",
          messageCount: 1,
          inputTokens: 500,
          outputTokens: 100,
          usd: "0",
          hasPricing: false,
        },
      ],
    ]

    const res = await getAgentCostByModel("30d")
    expect(res.isSuccess).toBe(true)
    if (!res.isSuccess || !res.data) throw new Error("expected success")

    expect(res.data.byModel).toHaveLength(2)
    const glm = res.data.byModel.find((m) => m.model === "zai.glm-5")!
    expect(glm.usd).toBeCloseTo(0.0164, 6)
    expect(glm.pricingMissing).toBe(false)

    const mystery = res.data.byModel.find((m) => m.model === "mystery-model")!
    expect(mystery.pricingMissing).toBe(true)
    expect(mystery.usd).toBe(0)

    // Total only counts what is priced.
    expect(res.data.totalUsd).toBeCloseTo(0.0164, 6)
    // Missing-pricing is surfaced for the model that has usage.
    expect(res.data.modelsMissingPricing).toEqual(["mystery-model"])
    expect(res.data.windowDays).toBe(30)
  })

  it("does not flag a zero-usage unpriced model as missing-pricing", async () => {
    queryResults = [
      [
        {
          model: "never-used",
          messageCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          usd: "0",
          hasPricing: false,
        },
      ],
    ]
    const res = await getAgentCostByModel("7d")
    if (!res.isSuccess || !res.data) throw new Error("expected success")
    // pricingMissing is true on the row, but it isn't escalated to the
    // admin-facing modelsMissingPricing list because it has no usage.
    expect(res.data.byModel[0].pricingMissing).toBe(true)
    expect(res.data.modelsMissingPricing).toEqual([])
    expect(res.data.windowDays).toBe(7)
  })

  it("returns null windowDays for the all-time range", async () => {
    queryResults = [[]]
    const res = await getAgentCostByModel("all")
    if (!res.isSuccess || !res.data) throw new Error("expected success")
    expect(res.data.windowDays).toBeNull()
    expect(res.data.totalUsd).toBe(0)
  })

  it("coerces an invalid range to 30d", async () => {
    queryResults = [[]]
    const res = await getAgentCostByModel("bogus" as never)
    if (!res.isSuccess || !res.data) throw new Error("expected success")
    expect(res.data.windowDays).toBe(30)
  })
})

describe("getAgentCostProjection", () => {
  it("projects actual token volume onto a priced candidate", async () => {
    // First query: actual totals. Second: candidate pricing rows.
    queryResults = [
      [{ inputTokens: 100000, outputTokens: 20000, actualUsd: "0.164" }],
      [
        {
          modelId: "us.anthropic.claude-opus-4-7",
          name: "Claude Opus 4.7",
          inputCost: "0.005000",
          outputCost: "0.025000",
        },
      ],
    ]

    const res = await getAgentCostProjection("30d", [
      "us.anthropic.claude-opus-4-7",
    ])
    if (!res.isSuccess || !res.data) throw new Error("expected success")

    expect(res.data.actualInputTokens).toBe(100000)
    expect(res.data.actualOutputTokens).toBe(20000)
    expect(res.data.actualUsd).toBeCloseTo(0.164, 6)

    // Opus: 100000*0.005/1000 + 20000*0.025/1000 = 0.5 + 0.5 = 1.0
    expect(res.data.candidates).toHaveLength(1)
    expect(res.data.candidates[0].usd).toBeCloseTo(1.0, 6)
    expect(res.data.candidates[0].pricingMissing).toBe(false)
    expect(res.data.candidates[0].name).toBe("Claude Opus 4.7")
  })

  it("flags a candidate with no pricing row instead of implying $0", async () => {
    queryResults = [
      [{ inputTokens: 100000, outputTokens: 20000, actualUsd: "0.164" }],
      [], // no pricing rows returned for the requested candidate
    ]

    const res = await getAgentCostProjection("30d", ["ghost-model"])
    if (!res.isSuccess || !res.data) throw new Error("expected success")

    expect(res.data.candidates).toHaveLength(1)
    const ghost = res.data.candidates[0]
    expect(ghost.model).toBe("ghost-model")
    expect(ghost.name).toBe("ghost-model") // falls back to the id
    expect(ghost.pricingMissing).toBe(true)
    expect(ghost.usd).toBe(0)
  })

  it("handles a candidate priced on only one direction", async () => {
    queryResults = [
      [{ inputTokens: 100000, outputTokens: 20000, actualUsd: "0" }],
      [
        {
          modelId: "input-only",
          name: "Input Only",
          inputCost: "0.002000",
          outputCost: null,
        },
      ],
    ]
    const res = await getAgentCostProjection("30d", ["input-only"])
    if (!res.isSuccess || !res.data) throw new Error("expected success")
    // Has at least one price, so NOT missing; output side contributes 0.
    // 100000*0.002/1000 + 20000*0/1000 = 0.2
    expect(res.data.candidates[0].pricingMissing).toBe(false)
    expect(res.data.candidates[0].usd).toBeCloseTo(0.2, 6)
  })

  it("short-circuits with no DB pricing query when no candidates given", async () => {
    // Only the totals query runs; no second query is staged, and the action
    // must not call executeQuery a second time.
    queryResults = [
      [{ inputTokens: 50, outputTokens: 10, actualUsd: "0" }],
    ]
    const res = await getAgentCostProjection("30d", [])
    if (!res.isSuccess || !res.data) throw new Error("expected success")
    expect(res.data.candidates).toEqual([])
    expect(res.data.actualInputTokens).toBe(50)
  })

  it("dedupes and bounds the candidate list", async () => {
    // 20 distinct candidates + duplicates; only the first 12 distinct survive.
    const many = Array.from({ length: 20 }, (_, i) => `model-${i}`)
    const withDupes = [...many, "model-0", "model-1"]

    queryResults = [
      [{ inputTokens: 1000, outputTokens: 1000, actualUsd: "0" }],
      // Pricing query returns nothing; we only assert the candidate count.
      [],
    ]
    const res = await getAgentCostProjection("30d", withDupes)
    if (!res.isSuccess || !res.data) throw new Error("expected success")
    expect(res.data.candidates).toHaveLength(12)
  })

  it("ignores non-string candidate entries", async () => {
    queryResults = [
      [{ inputTokens: 1000, outputTokens: 1000, actualUsd: "0" }],
      [],
    ]
    const res = await getAgentCostProjection("30d", [
      "valid-model",
      // @ts-expect-error — deliberately passing junk to test runtime guard
      42,
      // @ts-expect-error — deliberately passing junk to test runtime guard
      null,
      "",
    ])
    if (!res.isSuccess || !res.data) throw new Error("expected success")
    expect(res.data.candidates).toHaveLength(1)
    expect(res.data.candidates[0].model).toBe("valid-model")
  })
})
