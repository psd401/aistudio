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

import { incompleteTurnReason, turnNeedsEmptyNotice } from '../chat-helpers'
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
  })

  it('keeps a single tool-call step rather than calling it empty (#1899)', () => {
    // Reversed from the original rule, deliberately. A one-shot
    // `generate_document` / `show_chart` call whose trailing sentence the model
    // skipped used to be dropped as `no_content` — so the file the user asked
    // for vanished on reload. The tool history is the deliverable; persist it.
    expect(incompleteTurnReason({ text: '', steps: [toolCallStep] })).toBeNull()
    expect(
      incompleteTurnReason({
        text: '',
        toolCalls: [
          { toolCallId: 't1', toolName: 'generate_document', args: {} },
        ],
      })
    ).toBeNull()
  })

  it('does not take step COUNT as evidence of content (#1899)', () => {
    // saveConversationSteps filters out every text-free, tool-free step, so a
    // run of empty step boundaries wrote zero rows while reporting success —
    // the blank-bubble bug again, reached through the multi-step path.
    const emptyStep = { text: '', toolCalls: [] } as unknown as StepData
    expect(
      incompleteTurnReason({ text: '', steps: [emptyStep, emptyStep, emptyStep] })
    ).toBe('no_content')
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

/**
 * #1899 case 2, reload half — flagged by two reviewers on PR #1945.
 *
 * A text-free tool turn is NOT `no_content` (its tool rows are the history
 * worth keeping), so it never reached the notice branch: the live notice was
 * transient and the reload showed tool cards with no explanation. The tool rows
 * are now followed by a notice row, unless the tool itself was the deliverable.
 */
describe('turnNeedsEmptyNotice', () => {
  const docStep = {
    text: '',
    toolCalls: [{ toolCallId: 'd1', toolName: 'generate_document', args: {} }],
  } as unknown as StepData

  it('asks for a notice after a text-free web_fetch chain', () => {
    expect(
      turnNeedsEmptyNotice({ text: '', steps: [toolCallStep, toolCallStep] })
    ).toBe(true)
    expect(
      turnNeedsEmptyNotice({
        text: '',
        toolCalls: [{ toolCallId: 't1', toolName: 'web_fetch', args: {} }],
      })
    ).toBe(true)
  })

  it('stays quiet when a direct-render tool produced the deliverable', () => {
    // The download card is the answer; a notice under it would contradict it.
    expect(turnNeedsEmptyNotice({ text: '', steps: [docStep] })).toBe(false)
    expect(
      turnNeedsEmptyNotice({
        text: '',
        toolCalls: [{ toolCallId: 'd1', toolName: 'show_chart', args: {} }],
      })
    ).toBe(false)
  })

  it('stays quiet when any step wrote prose, even if the last did not', () => {
    expect(
      turnNeedsEmptyNotice({ text: '', steps: [textStep, toolCallStep] })
    ).toBe(false)
  })

  it('stays quiet for an ordinary answered turn', () => {
    expect(turnNeedsEmptyNotice({ text: 'Here is the schedule.' })).toBe(false)
    // Whitespace is not an answer — matches incompleteTurnReason.
    expect(turnNeedsEmptyNotice({ text: '  \n ' })).toBe(true)
  })
})
