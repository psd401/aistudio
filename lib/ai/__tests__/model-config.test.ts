/**
 * @jest-environment node
 *
 * Tests getModelConfig (REV-PERF-002). It now returns `capabilities` so the Nexus
 * chat route can derive image/deep-research routing from this single fetched row
 * instead of re-reading the same ai_models row. The active/nexusEnabled gate is
 * preserved.
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
}

describe('getModelConfig (REV-PERF-002)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns capabilities alongside the trimmed config (so the route needs no 2nd fetch)', async () => {
    mockGetAIModelByModelId.mockResolvedValue(activeModel)

    const result = await getModelConfig('gemini-2.0-flash')

    expect(result).toEqual({
      id: 42,
      name: 'Gemini',
      provider: 'google',
      model_id: 'gemini-2.0-flash',
      capabilities: { imageGeneration: true },
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
