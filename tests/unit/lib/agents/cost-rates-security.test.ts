import { buildCostRates } from "@/lib/agents/cost-rates"

describe("agentic cost-cap pricing", () => {
  it.each([
    { inputCostPer1kTokens: null, outputCostPer1kTokens: "2" },
    { inputCostPer1kTokens: "1", outputCostPer1kTokens: null },
    { inputCostPer1kTokens: "", outputCostPer1kTokens: "2" },
    { inputCostPer1kTokens: "-1", outputCostPer1kTokens: "2" },
    { inputCostPer1kTokens: "NaN", outputCostPer1kTokens: "2" },
  ])("returns unknown when either price is missing or invalid", (pricing) => {
    expect(buildCostRates(pricing)).toBeNull()
  })

  it("produces exact per-token rates when both prices are known", () => {
    expect(
      buildCostRates({
        inputCostPer1kTokens: "1.5",
        outputCostPer1kTokens: "3",
      }),
    ).toEqual({ inputPerToken: 0.0015, outputPerToken: 0.003 })
  })

  it("recognizes an explicitly free model as completely priced", () => {
    expect(
      buildCostRates({
        inputCostPer1kTokens: "0",
        outputCostPer1kTokens: "0",
      }),
    ).toEqual({ inputPerToken: 0, outputPerToken: 0 })
  })
})
