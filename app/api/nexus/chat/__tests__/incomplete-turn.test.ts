/**
 * @jest-environment node
 *
 * Guards the rule that decides whether a finished stream may be written to the
 * conversation as a completed assistant turn.
 *
 * Production failure this encodes: a Nexus turn on an unmapped model inherited a
 * 30s wall-clock budget, called the attachment-search tool (which returned at
 * +7s), and was aborted mid-answer at exactly +30s. AI SDK v6 fired `onFinish`
 * anyway with only the completed tool-call step, and the route persisted it —
 * `textLength: 0`, `finishReason: "tool-calls"`, logged `status: "success"`.
 * The user was left with a permanently blank assistant bubble and no error.
 *
 * @see ../chat-helpers.ts (incompleteTurnReason)
 */

import { describe, it, expect } from '@jest/globals'

const mockExecuteQuery = jest.fn()
const mockExecuteTransaction = jest.fn()
jest.mock('@/lib/db/drizzle-client', () => ({
  executeQuery: (...a: unknown[]) => mockExecuteQuery(...a),
  executeTransaction: (...a: unknown[]) => mockExecuteTransaction(...a),
}))

jest.mock('@/lib/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
  generateRequestId: jest.fn(() => 'rid'),
  startTimer: jest.fn(() => jest.fn()),
  sanitizeForLogging: jest.fn((d: unknown) => d),
}))

import { incompleteTurnReason } from '../chat-helpers'
import type { StepData } from '../chat-helpers'

/** A tool-call step with no assistant prose — what the aborted prod turn produced. */
const toolCallStep = { text: '', toolCalls: [{ toolCallId: 't1', toolName: 'searchNexusAttachments', args: {} }] } as unknown as StepData
const textStep = { text: 'Here is the schedule.', toolCalls: [] } as unknown as StepData

describe('incompleteTurnReason', () => {
  it('rejects the exact production failure: aborted, single tool-call step, no text', () => {
    expect(
      incompleteTurnReason({ text: '', aborted: true, steps: [toolCallStep] })
    ).toBe('stream_aborted')
  })

  it('rejects an aborted run even when it produced partial text', () => {
    // A truncated run's trailing step can hold a tool call whose result never
    // arrived; replaying that pair throws AI_MissingToolResultsError on reload.
    expect(
      incompleteTurnReason({ text: 'Here is the partial', aborted: true, steps: [toolCallStep] })
    ).toBe('stream_aborted')
  })

  it('rejects a completed run that produced nothing at all', () => {
    expect(incompleteTurnReason({ text: '', steps: [] })).toBe('no_content')
    expect(incompleteTurnReason({ text: '   \n\t  ' })).toBe('no_content')
    expect(incompleteTurnReason({ text: '', steps: [toolCallStep] })).toBe('no_content')
  })

  it('accepts an ordinary completed answer', () => {
    expect(incompleteTurnReason({ text: 'Here is the schedule.' })).toBeNull()
    expect(incompleteTurnReason({ text: 'Here is the schedule.', aborted: false })).toBeNull()
  })

  it('accepts a completed multi-step run whose final step has no prose', () => {
    // MCP connector flows persist each step separately (Issue #977). Dropping
    // these would break tool-history replay, so a text-free FINAL step is fine
    // as long as there is real multi-step history and the run was not aborted.
    expect(
      incompleteTurnReason({ text: '', steps: [toolCallStep, textStep, toolCallStep] })
    ).toBeNull()
  })

  it('treats abort as decisive regardless of how much history exists', () => {
    expect(
      incompleteTurnReason({
        text: 'partial',
        aborted: true,
        steps: [toolCallStep, textStep, toolCallStep],
      })
    ).toBe('stream_aborted')
  })
})
