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
})
