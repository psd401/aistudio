/**
 * @jest-environment node
 *
 * Tests getModelConfig (REV-PERF-002). It returns `capabilities` and provider
 * metadata so the Nexus route can derive special routing and function-calling
 * support from one fetched row. The active/nexusEnabled gate is preserved.
 */

const mockGetAIModelById = jest.fn()
const mockGetAIModelByModelId = jest.fn()
jest.mock('@/lib/db/drizzle', () => ({
  getAIModelById: (...a: unknown[]) => mockGetAIModelById(...a),
  getAIModelByModelId: (...a: unknown[]) => mockGetAIModelByModelId(...a),
}))

jest.mock('@/lib/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
}))

import { getModelConfig } from '../model-config'

const activeModel = {
  id: 42,
  name: 'Gemini',
  provider: 'google',
  modelId: 'gemini-2.0-flash',
  active: true,
  nexusEnabled: true,
  capabilities: { imageGeneration: true },
  providerMetadata: { supports_function_calling: false },
}

describe('getModelConfig (REV-PERF-002)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns route capability metadata without a second model fetch', async () => {
    mockGetAIModelByModelId.mockResolvedValue(activeModel)

    const result = await getModelConfig('gemini-2.0-flash')

    expect(result).toEqual({
      id: 42,
      name: 'Gemini',
      provider: 'google',
      model_id: 'gemini-2.0-flash',
      capabilities: { imageGeneration: true },
      providerMetadata: { supports_function_calling: false },
    })
    // Only one ai_models read for a string model id.
    expect(mockGetAIModelByModelId).toHaveBeenCalledTimes(1)
    expect(mockGetAIModelById).not.toHaveBeenCalled()
  })

  it('resolves a numeric model id with a single lookup', async () => {
    mockGetAIModelById.mockResolvedValue(activeModel)

    const result = await getModelConfig(42)

    expect(result?.capabilities).toEqual({ imageGeneration: true })
    expect(mockGetAIModelById).toHaveBeenCalledTimes(1)
  })

  it('returns null for an inactive model (gate preserved)', async () => {
    mockGetAIModelByModelId.mockResolvedValue({ ...activeModel, active: false })
    expect(await getModelConfig('gemini-2.0-flash')).toBeNull()
  })

  it('returns null for a non-nexus model (gate preserved)', async () => {
    mockGetAIModelByModelId.mockResolvedValue({ ...activeModel, nexusEnabled: false })
    expect(await getModelConfig('gemini-2.0-flash')).toBeNull()
  })
})
