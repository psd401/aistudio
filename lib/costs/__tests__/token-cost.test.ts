import { exactTokenCostUsd, blendedTokenCostUsd } from "@/lib/costs/token-cost"

/**
 * Locks in the token-cost math (PR #1087 finding #5). The blended cases assert
 * the exact arithmetic identity with the pre-existing inline formulas so the
 * cost-optimizer (0.6) and Activity-dashboard (0.5) refactors are provably
 * behavior-preserving.
 */
describe("exactTokenCostUsd", () => {
  it("prices input and output independently (per-1k rates)", () => {
    // 1000 in @ $0.001/1k + 500 out @ $0.0032/1k = 0.001 + 0.0016
    expect(exactTokenCostUsd(1000, 500, 0.001, 0.0032)).toBeCloseTo(0.0026, 10)
  })

  it("is zero when both token counts are zero", () => {
    expect(exactTokenCostUsd(0, 0, 0.001, 0.0032)).toBe(0)
  })
})

describe("blendedTokenCostUsd", () => {
  it("default 0.5 weight == totalTokens*(in+out)/2/1000 (Activity SQL)", () => {
    const total = 4000
    const inPrice = 0.001
    const outPrice = 0.0032
    const legacy = (total * (inPrice + outPrice)) / 2.0 / 1000.0
    expect(blendedTokenCostUsd(total, inPrice, outPrice)).toBeCloseTo(legacy, 12)
  })

  it("0.6 weight == (tokens/1000)*(in*0.6 + out*0.4) (cost-optimizer)", () => {
    const tokens = 3000
    const inPrice = 0.002
    const outPrice = 0.004
    const legacy = (tokens / 1000) * (inPrice * 0.6 + outPrice * 0.4)
    expect(blendedTokenCostUsd(tokens, inPrice, outPrice, 0.6)).toBeCloseTo(
      legacy,
      12
    )
  })
})
