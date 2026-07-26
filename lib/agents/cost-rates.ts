export interface ModelPricing {
  inputCostPer1kTokens?: string | null
  outputCostPer1kTokens?: string | null
}

export interface CostRates {
  inputPerToken: number
  outputPerToken: number
}

export function resolveTrustedAgenticTokenLimits(
  model: {
    maxTokens?: unknown
    providerMetadata?: unknown
  },
  serverOutputCeiling: number,
): { contextTokens: number; maxOutputTokens: number } | null {
  if (
    !Number.isSafeInteger(serverOutputCeiling) ||
    serverOutputCeiling < 1 ||
    typeof model.maxTokens !== "number" ||
    !Number.isSafeInteger(model.maxTokens) ||
    model.maxTokens < 1 ||
    !model.providerMetadata ||
    typeof model.providerMetadata !== "object" ||
    Array.isArray(model.providerMetadata)
  ) {
    return null
  }
  const metadata = model.providerMetadata as Record<string, unknown>
  const contextTokens = metadata.max_context_length
  if (
    typeof contextTokens !== "number" ||
    !Number.isSafeInteger(contextTokens) ||
    contextTokens < 1
  ) {
    return null
  }
  const modelOutputTokens = model.maxTokens
  const metadataOutputTokens = metadata.max_output_tokens
  const trustedMetadataOutput =
    typeof metadataOutputTokens === "number" &&
    Number.isSafeInteger(metadataOutputTokens) &&
    metadataOutputTokens > 0
      ? metadataOutputTokens
      : modelOutputTokens
  return {
    contextTokens,
    maxOutputTokens: Math.min(
      modelOutputTokens,
      trustedMetadataOutput,
      serverOutputCeiling,
    ),
  }
}

export function estimateUsageCostCents(
  rates: CostRates,
  usage: { promptTokens: number; completionTokens: number },
): number {
  const value =
    (usage.promptTokens * rates.inputPerToken +
      usage.completionTokens * rates.outputPerToken) *
    100
  return Math.max(1, Math.ceil(value))
}

/**
 * Reserve the author/server run cap plus one complete final model response.
 * Cost stop predicates only see completed steps, so a step that begins one
 * token below the cap can still consume the model's full output allowance.
 */
export function conservativeAgenticReservationCents(
  runCapCents: number,
  contextTokens: number,
  maxOutputTokens: number,
  rates: CostRates,
): number {
  if (
    !Number.isSafeInteger(runCapCents) ||
    runCapCents < 1 ||
    !Number.isSafeInteger(contextTokens) ||
    contextTokens < 1 ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1
  ) {
    throw new Error("Agentic reservation inputs must be positive integers")
  }
  return (
    runCapCents +
    Math.max(
      1,
      Math.ceil(
        (contextTokens * rates.inputPerToken +
          maxOutputTokens * rates.outputPerToken) *
          100,
      ),
    )
  )
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
