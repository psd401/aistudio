import {
  buildCostRates,
  conservativeAgenticReservationCents,
  estimateUsageCostCents,
  resolveTrustedAgenticTokenLimits,
} from "@/lib/agents/cost-rates"

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

  it("reserves the run cap plus a full context input and maximum output", () => {
    expect(
      conservativeAgenticReservationCents(
        100,
        200_000,
        8_000,
        { inputPerToken: 0.000003, outputPerToken: 0.000015 },
      ),
    ).toBe(172)
  })

  it("resolves full context separately from the model output ceiling", () => {
    const limits = resolveTrustedAgenticTokenLimits(
      {
        maxTokens: 4_096,
        providerMetadata: {
          max_context_length: 128_000,
          max_output_tokens: 8_192,
        },
      },
      32_768,
    )
    expect(limits).toEqual({
      contextTokens: 128_000,
      maxOutputTokens: 4_096,
    })
    expect(
      conservativeAgenticReservationCents(
        100,
        limits?.contextTokens ?? 0,
        limits?.maxOutputTokens ?? 0,
        { inputPerToken: 0.000003, outputPerToken: 0.000015 },
      ),
    ).toBe(145)
  })

  it("fails closed when trusted context metadata is absent", () => {
    expect(
      resolveTrustedAgenticTokenLimits(
        { maxTokens: 4_096, providerMetadata: {} },
        32_768,
      ),
    ).toBeNull()
  })

  it("rounds measured non-zero usage up to a whole cent", () => {
    expect(
      estimateUsageCostCents(
        { inputPerToken: 0.000001, outputPerToken: 0.000002 },
        { promptTokens: 1, completionTokens: 1 },
      ),
    ).toBe(1)
  })
})
