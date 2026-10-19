/**
 * @jest-environment node
 *
 * #1899 — "never end a turn with nothing for the user to read".
 *
 * Pins the classification rules in isolation from the stream transform: which
 * chunk kinds count as an answer, which answer-less shape wins when several
 * apply, and that every shape has a notice that reads as an explanation.
 *
 * @see lib/streaming/empty-turn-notice.ts
 * @see lib/streaming/__tests__/stream-deadline.test.ts — the same rules end-to-end
 */

import {
  classifyChunkVisibility,
  classifyEmptyTurn,
  emptyTurnNotice,
  EMPTY_TURN_PERSIST_NOTICE,
  ASSISTANT_SAVE_FAILED_NOTICE,
  type EmptyTurnKind,
  type EmptyTurnObservation,
} from '../empty-turn-notice'

const NOTHING_SEEN: EmptyTurnObservation = {
  sawText: false,
  sawReasoning: false,
  sawFile: false,
  sawToolActivity: false,
  sawOtherRendered: false,
  completedSteps: 0,
}

describe('classifyChunkVisibility', () => {
  it('counts only a text delta as an answer', () => {
    expect(classifyChunkVisibility('text-delta')).toBe('text')
    // text-start / text-end carry no characters, so they are not an answer.
    expect(classifyChunkVisibility('text-start')).toBe('none')
    expect(classifyChunkVisibility('text-end')).toBe('none')
  })

  it('separates reasoning and file parts, which the Nexus thread does not render', () => {
    expect(classifyChunkVisibility('reasoning-delta')).toBe('reasoning')
    expect(classifyChunkVisibility('reasoning-start')).toBe('reasoning')
    expect(classifyChunkVisibility('file')).toBe('file')
  })

  it('buckets every tool chunk type, including dynamic MCP tools', () => {
    for (const type of [
      'tool-input-start',
      'tool-input-delta',
      'tool-input-available',
      'tool-output-available',
      'tool-output-error',
    ]) {
      expect(classifyChunkVisibility(type)).toBe('tool')
    }
  })

  it('treats sources and data parts as rendered-by-the-thread', () => {
    expect(classifyChunkVisibility('source-url')).toBe('other')
    expect(classifyChunkVisibility('source-document')).toBe('other')
    expect(classifyChunkVisibility('data-schedule')).toBe('other')
  })

  it('ignores protocol chunks', () => {
    for (const type of ['start', 'start-step', 'finish-step', 'finish', 'error', '']) {
      expect(classifyChunkVisibility(type)).toBe('none')
    }
  })
})

describe('classifyEmptyTurn', () => {
  it('says nothing about a turn that wrote text', () => {
    expect(classifyEmptyTurn({ ...NOTHING_SEEN, sawText: true })).toBeNull()
    // Even a text+tool turn is fine: the user has something to read.
    expect(
      classifyEmptyTurn({ ...NOTHING_SEEN, sawText: true, sawToolActivity: true })
    ).toBeNull()
  })

  it('reports a reasoning-only turn (#1899 case 1)', () => {
    expect(classifyEmptyTurn({ ...NOTHING_SEEN, sawReasoning: true })).toBe(
      'reasoning_only'
    )
  })

  it('reports a file-only turn', () => {
    expect(classifyEmptyTurn({ ...NOTHING_SEEN, sawFile: true })).toBe('file_only')
  })

  it('reports a tool-only turn (#1899 case 2)', () => {
    expect(
      classifyEmptyTurn({ ...NOTHING_SEEN, sawToolActivity: true, completedSteps: 1 })
    ).toBe('tool_only')
  })

  it('reports step-budget exhaustion once every step is spent', () => {
    expect(
      classifyEmptyTurn({
        ...NOTHING_SEEN,
        sawToolActivity: true,
        completedSteps: 3,
        maxSteps: 3,
      })
    ).toBe('step_budget_exhausted')
    // One step short of the bound is an ordinary tool-only turn.
    expect(
      classifyEmptyTurn({
        ...NOTHING_SEEN,
        sawToolActivity: true,
        completedSteps: 2,
        maxSteps: 3,
      })
    ).toBe('tool_only')
  })

  it('ignores a nonsensical budget rather than claiming exhaustion', () => {
    for (const maxSteps of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        classifyEmptyTurn({
          ...NOTHING_SEEN,
          sawToolActivity: true,
          completedSteps: 5,
          maxSteps,
        })
      ).toBe('tool_only')
    }
  })

  it('prefers the tool explanation over reasoning or files', () => {
    // "It spent its steps on tools" tells the user to narrow the request;
    // "it thought and said nothing" only tells them to retry.
    expect(
      classifyEmptyTurn({
        ...NOTHING_SEEN,
        sawToolActivity: true,
        sawReasoning: true,
        sawFile: true,
        completedSteps: 1,
      })
    ).toBe('tool_only')
    expect(
      classifyEmptyTurn({ ...NOTHING_SEEN, sawReasoning: true, sawFile: true })
    ).toBe('reasoning_only')
  })

  it('leaves a source-only or data-only turn alone', () => {
    expect(classifyEmptyTurn({ ...NOTHING_SEEN, sawOtherRendered: true })).toBeNull()
  })

  it('falls back to the blank-response notice when nothing arrived at all', () => {
    expect(classifyEmptyTurn(NOTHING_SEEN)).toBe('nothing')
  })
})

describe('notice wording', () => {
  const kinds: EmptyTurnKind[] = [
    'step_budget_exhausted',
    'tool_only',
    'reasoning_only',
    'file_only',
    'nothing',
  ]

  it.each(kinds)('%s reads as an explanation with a next step', kind => {
    const notice = emptyTurnNotice(kind)
    // Rendered verbatim by MessagePrimitive.Error, so: prose, not a code.
    expect(notice.length).toBeGreaterThan(40)
    expect(notice).toMatch(/try again|start a new chat/i)
    expect(notice).not.toMatch(/undefined|null|\[object|Error:/)
  })

  it('gives every shape a distinct message', () => {
    expect(new Set(kinds.map(emptyTurnNotice)).size).toBe(kinds.length)
  })

  it('keeps the #1686 empty-response wording for the blank case', () => {
    expect(emptyTurnNotice('nothing')).toContain('empty response')
  })

  it('has durable notices for the persisted rows', () => {
    // These are stored in nexus_messages and replayed to the model, so they must
    // read as plain prose and must not promise a retry the row cannot deliver.
    expect(EMPTY_TURN_PERSIST_NOTICE).toMatch(/without a written answer/i)
    expect(ASSISTANT_SAVE_FAILED_NOTICE).toMatch(/could not be saved/i)
    expect(EMPTY_TURN_PERSIST_NOTICE).not.toBe(ASSISTANT_SAVE_FAILED_NOTICE)
  })
})
