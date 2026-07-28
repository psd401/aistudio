import { describe, it, expect, jest } from '@jest/globals'

jest.mock('@/lib/db/drizzle-client', () => ({ executeQuery: jest.fn() }))
jest.mock('drizzle-orm', () => ({ inArray: jest.fn(), eq: jest.fn() }))
jest.mock('@/lib/db/schema', () => ({}))
jest.mock('@/lib/logger', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

import { validateImportFile } from '@/lib/assistant-export-import'

const validAssistant = {
  name: 'Test Assistant',
  description: 'A test',
  status: 'approved',
  prompts: [
    { name: 'p1', content: 'Hello ${name}', model_name: 'claude-3', position: 0 }
  ],
  input_fields: []
}

const validImport = {
  version: '1.0',
  exported_at: '2026-01-01T00:00:00Z',
  assistants: [validAssistant]
}

function defineImportCollectionLimitTests() {
  it('rejects more than 100 assistants before import transactions begin', () => {
    const data = {
      ...validImport,
      assistants: Array.from({ length: 101 }, (_, index) => ({
        ...validAssistant,
        name: `Assistant ${index}`,
      })),
    }
    const result = validateImportFile(data)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/Too many assistants.*100/)
  })

  it('accepts exactly 100 assistants', () => {
    const data = {
      ...validImport,
      assistants: Array.from({ length: 100 }, (_, index) => ({
        ...validAssistant,
        name: `Assistant ${index}`,
      })),
    }
    expect(validateImportFile(data)).toEqual({ valid: true })
  })

  it('rejects more than 50 input fields per assistant', () => {
    const input_fields = Array.from({ length: 51 }, (_, index) => ({
      name: `f${index}`,
      label: `F${index}`,
      field_type: 'short_text',
      position: index,
    }))
    const data = {
      ...validImport,
      assistants: [{ ...validAssistant, input_fields }],
    }
    const result = validateImportFile(data)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/too many input fields.*50/)
  })

  it('accepts exactly 50 input fields per assistant', () => {
    const input_fields = Array.from({ length: 50 }, (_, index) => ({
      name: `f${index}`,
      label: `F${index}`,
      field_type: 'short_text',
      position: index,
    }))
    const data = {
      ...validImport,
      assistants: [{ ...validAssistant, input_fields }],
    }
    expect(validateImportFile(data)).toEqual({ valid: true })
  })

  it('rejects more than 500 repository bindings per envelope', () => {
    const data = {
      ...validImport,
      assistants: [{
        ...validAssistant,
        prompts: [{
          ...validAssistant.prompts[0],
          repository_ids: Array.from({ length: 501 }, (_, index) => index + 1),
        }],
      }],
    }
    const result = validateImportFile(data)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/Too many repository bindings.*500/)
  })
}

function defineAssistantConfigInvariantTests() {
  it('rejects advanced model routing without a model family', () => {
    const data = {
      ...validImport,
      assistants: [{
        ...validAssistant,
        model_routing_mode: 'advanced',
      }],
    }
    const result = validateImportFile(data)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/advanced model routing requires model_routing_family/)
  })

  it('rejects a model family unless advanced routing is selected', () => {
    const data = {
      ...validImport,
      assistants: [{
        ...validAssistant,
        model_routing_mode: 'standard',
        model_routing_family: 'anthropic',
      }],
    }
    const result = validateImportFile(data)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/model_routing_family requires advanced model routing/)
  })

  it('rejects a zero agent cost cap before persistence', () => {
    const data = {
      ...validImport,
      assistants: [{
        ...validAssistant,
        agent_cost_cap_cents: 0,
      }],
    }
    const result = validateImportFile(data)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/agent_cost_cap_cents must be a positive integer/)
  })
}

function definePortableContractTests() {
  it('accepts explicit nulls for every nullable portable property', () => {
    const data = {
      ...validImport,
      assistants: [{
        ...validAssistant,
        image_path: null,
        timeout_seconds: null,
        prompts: [{
          ...validAssistant.prompts[0],
          system_context: null,
          parallel_group: null,
          input_mapping: null,
          timeout_seconds: null,
        }],
        input_fields: [{
          name: 'format',
          label: 'Format',
          field_type: 'select',
          position: 0,
          options: null,
        }],
      }],
    }
    expect(validateImportFile(data)).toEqual({ valid: true })
  })

  it.each([
    {
      label: 'assistant timeout',
      assistant: { ...validAssistant, timeout_seconds: 0 },
      expected: /timeout_seconds must be a positive integer/,
    },
    {
      label: 'prompt timeout',
      assistant: {
        ...validAssistant,
        prompts: [{ ...validAssistant.prompts[0], timeout_seconds: 0 }],
      },
      expected: /prompt timeout_seconds must be a positive integer/,
    },
    {
      label: 'string prompt timeout',
      assistant: {
        ...validAssistant,
        prompts: [{ ...validAssistant.prompts[0], timeout_seconds: '30' }],
      },
      expected: /prompt timeout_seconds must be a positive integer/,
    },
  ])('rejects an invalid $label before persistence', ({ assistant, expected }) => {
    const result = validateImportFile({
      ...validImport,
      assistants: [assistant],
    })
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(expected)
  })
}

describe('validateImportFile', () => {
  it('accepts a valid import file', () => {
    expect(validateImportFile(validImport)).toEqual({ valid: true })
  })

  it('rejects null', () => {
    expect(validateImportFile(null)).toMatchObject({ valid: false })
  })

  it('rejects missing version', () => {
    expect(validateImportFile({ assistants: [] })).toMatchObject({ valid: false })
  })

  it('rejects unsupported version', () => {
    expect(validateImportFile({ version: '2.0', assistants: [] })).toMatchObject({ valid: false })
  })

  it('rejects an empty assistant batch', () => {
    expect(
      validateImportFile({ version: '1.0', assistants: [] })
    ).toEqual({
      valid: false,
      error: 'Import envelope must contain at least one assistant',
    })
  })

  it('rejects assistant name longer than 255 characters', () => {
    const longName = 'a'.repeat(256)
    const data = { ...validImport, assistants: [{ ...validAssistant, name: longName }] }
    const result = validateImportFile(data)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/name too long/)
  })

  it('accepts assistant name exactly 255 characters', () => {
    const name = 'a'.repeat(255)
    const data = { ...validImport, assistants: [{ ...validAssistant, name }] }
    expect(validateImportFile(data)).toEqual({ valid: true })
  })

  it('rejects more than 20 prompts per assistant', () => {
    const prompts = Array.from({ length: 21 }, (_, i) => ({
      name: `p${i}`, content: 'x', model_name: 'claude-3', position: i
    }))
    const data = { ...validImport, assistants: [{ ...validAssistant, prompts }] }
    const result = validateImportFile(data)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/too many prompts/)
  })

  it('accepts exactly 20 prompts per assistant', () => {
    const prompts = Array.from({ length: 20 }, (_, i) => ({
      name: `p${i}`, content: 'x', model_name: 'claude-3', position: i
    }))
    const data = { ...validImport, assistants: [{ ...validAssistant, prompts }] }
    expect(validateImportFile(data)).toEqual({ valid: true })
  })

  defineImportCollectionLimitTests()

  it('rejects unsupported input field types before import writes begin', () => {
    const data = {
      ...validImport,
      assistants: [{
        ...validAssistant,
        input_fields: [{
          name: 'format',
          label: 'Format',
          field_type: 'radio',
          position: 0,
        }],
      }],
    }
    const result = validateImportFile(data)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/unsupported input field type: radio/)
  })

  it('accepts the full-fidelity agentic and prompt-tool configuration', () => {
    const data = {
      ...validImport,
      assistants: [{
        ...validAssistant,
        mode: 'agentic',
        model_routing_mode: 'advanced',
        model_routing_family: 'anthropic',
        agent_enabled_tools: ['repositories.search'],
        agent_enabled_connectors: ['connector-1'],
        agent_max_steps: 12,
        agent_timeout_seconds: 240,
        agent_cost_cap_cents: 75,
        agent_max_requests_per_hour: 20,
        retrieval_scope: {
          collectionId: 'collection-1',
          tags: ['family'],
          maxVisibilityLevel: 'internal',
        },
        prompts: [{
          ...validAssistant.prompts[0],
          input_mapping: { topic: 'input.topic' },
          repository_ids: [17],
          enabled_tools: ['repositories.search'],
        }],
      }],
    }
    expect(validateImportFile(data)).toEqual({ valid: true })
  })

  definePortableContractTests()

  defineAssistantConfigInvariantTests()

  it('rejects prompt content exceeding 10,000,000 characters', () => {
    const content = 'x'.repeat(10_000_001)
    const data = {
      ...validImport,
      assistants: [{ ...validAssistant, prompts: [{ name: 'p', content, model_name: 'm', position: 0 }] }]
    }
    const result = validateImportFile(data)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/content too large/)
  })

  it('rejects system_context exceeding 10,000,000 characters', () => {
    const system_context = 'x'.repeat(10_000_001)
    const data = {
      ...validImport,
      assistants: [{
        ...validAssistant,
        prompts: [{ name: 'p', content: 'hi', system_context, model_name: 'm', position: 0 }]
      }]
    }
    const result = validateImportFile(data)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/system_context too large/)
  })

  it('rejects an import envelope whose serialized size exceeds 10 MB', () => {
    const data = {
      ...validImport,
      assistants: [{
        ...validAssistant,
        description: 'x'.repeat(10 * 1024 * 1024),
      }],
    }
    const result = validateImportFile(data)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/payload too large/)
  })
})
