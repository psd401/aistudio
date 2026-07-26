export interface ModelPricing {
  inputCostPer1kTokens?: string | null
  outputCostPer1kTokens?: string | null
}

export interface CostRates {
  inputPerToken: number
  outputPerToken: number
}

/**
 * Convert complete, non-negative per-1k model prices to per-token rates.
 * Missing or invalid pricing returns null so configured cost caps fail closed.
 */
export function buildCostRates(modelData: ModelPricing): CostRates | null {
  const parseRate = (raw: string | null | undefined): number | null => {
    if (raw === null || raw === undefined || raw === "") return null
    const value = Number(raw)
    return Number.isFinite(value) && value >= 0 ? value : null
  }

  const inputPer1k = parseRate(modelData.inputCostPer1kTokens)
  const outputPer1k = parseRate(modelData.outputCostPer1kTokens)
  if (inputPer1k === null || outputPer1k === null) return null

  return {
    inputPerToken: inputPer1k / 1000,
    outputPerToken: outputPer1k / 1000,
  }
}
