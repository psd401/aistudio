/**
 * @jest-environment node
 *
 * #1899 case 4 — "a failed save leaves a prompt with no reply".
 *
 * The user message is written before streaming starts. When the assistant
 * message then failed to save, the failure was only logged, so the conversation
 * reloaded showing the prompt with nothing under it — indistinguishable, to the
 * person reading it, from the model never answering. These specs pin that a
 * notice row is written instead, and that the notice row itself cannot make
 * things worse (no tool calls, no second throw escaping).
 *
 * The transaction/row-shape contract for the underlying writers lives in
 * chat-helpers-atomic.test.ts; this suite mocks at the transaction boundary and
 * asserts only on the control flow and what text lands in the row.
 *
 * @see app/api/nexus/chat/chat-helpers.ts (persistAssistantTurn)
 * @see lib/streaming/empty-turn-notice.ts
 */

import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

const mockExecuteQuery = jest.fn()
const mockExecuteTransaction = jest.fn()
jest.mock('@/lib/db/drizzle-client', () => ({
  executeQuery: (...a: unknown[]) => mockExecuteQuery(...a),
  executeTransaction: (...a: unknown[]) => mockExecuteTransaction(...a),
}))

// The spy object is built INSIDE the factory and read back off the mocked
// module: a const declared up here is still undefined when the hoisted factory
// runs (chat-helpers builds its logger at import time).
jest.mock('@/lib/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  return {
    createLogger: jest.fn(() => log),
    generateRequestId: jest.fn(() => 'rid'),
    startTimer: jest.fn(() => jest.fn()),
    sanitizeForLogging: jest.fn((d: unknown) => d),
    __log: log,
  }
})

import * as logger from '@/lib/logger'
import { persistAssistantTurn, type StepData } from '../chat-helpers'
import {
  ASSISTANT_SAVE_FAILED_NOTICE,
  EMPTY_TURN_PERSIST_NOTICE,
} from '@/lib/streaming/empty-turn-notice'

/** A chainable fake `tx` recording the rows inserted through it. */
function makeTx() {
  const insertValues = jest.fn(async () => {})
  const updateWhere = jest.fn(async () => {})
  const tx = {
    insert: jest.fn(() => ({ values: insertValues })),
    update: jest.fn(() => ({ set: jest.fn(() => ({ where: updateWhere })) })),
  }
  return { tx, insertValues }
}

/** Run the callback handed to executeTransaction against a fresh fake tx. */
function transactionSucceeds() {
  const rows: Array<Record<string, unknown>> = []
  mockExecuteTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
    const { tx, insertValues } = makeTx()
    await cb(tx)
    for (const call of insertValues.mock.calls as unknown as Array<[Record<string, unknown>]>) {
      rows.push(call[0])
    }
  })
  return rows
}

function jsonFromSql(value: unknown): unknown {
  return JSON.parse(String(new PgDialect().sqlToQuery(value as SQL).params[0]))
}

const mockLog = (logger as unknown as { __log: Record<string, jest.Mock> }).__log

const BASE = { conversationId: 'conv-1', dbModelId: 7 }

const toolStep: StepData = {
  text: '',
  toolCalls: [
    {
      toolCallId: 'c1',
      toolName: 'web_fetch',
      args: { url: 'https://example.test' },
      result: { ok: true },
    },
  ],
  finishReason: 'tool-calls',
}

beforeEach(() => {
  jest.clearAllMocks()
  for (const fn of Object.values(mockLog)) fn.mockClear()
  mockExecuteQuery.mockResolvedValue([])
})

describe('persistAssistantTurn — the happy paths are unchanged', () => {
  it('writes a single row for a one-step turn', async () => {
    const rows = transactionSucceeds()

    const result = await persistAssistantTurn({
      ...BASE,
      text: 'Here is the schedule.',
      finishReason: 'stop',
    })

    expect(result).toEqual({ persisted: true, fallbackPersisted: false })
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe('Here is the schedule.')
  })

  it('still writes one row per step for a multi-step turn (#977)', async () => {
    // Consolidating steps breaks convertToModelMessages on reload, so the
    // step-splitting path must survive this refactor.
    const rows = transactionSucceeds()

    const result = await persistAssistantTurn({
      ...BASE,
      text: 'Done.',
      steps: [toolStep, { text: 'Done.', toolCalls: [], finishReason: 'stop' }],
    })

    expect(result.persisted).toBe(true)
    expect(rows).toHaveLength(2)
  })
})

describe('persistAssistantTurn — a failing persist still answers the prompt', () => {
  /** Fail the first transaction, let any later one through. */
  function failFirstTransaction(): Array<Record<string, unknown>> {
    const rows: Array<Record<string, unknown>> = []
    let attempt = 0
    mockExecuteTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      attempt += 1
      if (attempt === 1) throw new Error('deadlock detected')
      const { tx, insertValues } = makeTx()
      await cb(tx)
      for (const call of insertValues.mock.calls as unknown as Array<[Record<string, unknown>]>) {
        rows.push(call[0])
      }
    })
    return rows
  }

  it('saves the notice row when the real reply cannot be written', async () => {
    const rows = failFirstTransaction()

    const result = await persistAssistantTurn({
      ...BASE,
      text: 'Here is the schedule.',
      finishReason: 'stop',
    })

    expect(result).toEqual({ persisted: false, fallbackPersisted: true })
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe(ASSISTANT_SAVE_FAILED_NOTICE)
    expect(rows[0].role).toBe('assistant')
    expect(rows[0].finishReason).toBe('error')
    expect(jsonFromSql(rows[0].metadata)).toMatchObject({ assistantSaveFailed: true })
    expect(mockLog.error).toHaveBeenCalledWith(
      'Failed to save assistant message',
      expect.objectContaining({ conversationId: 'conv-1' })
    )
  })

  it('carries no tool call into the notice row', async () => {
    // A tool_use block whose tool_result was never stored throws
    // AI_MissingToolResultsError the next time the conversation loads — the
    // fallback must not trade one broken thread for another.
    const rows = failFirstTransaction()

    await persistAssistantTurn({
      ...BASE,
      text: '',
      toolCalls: [
        { toolCallId: 'c1', toolName: 'web_fetch', args: {}, result: { ok: true } },
      ],
      steps: [toolStep, toolStep],
    })

    expect(rows).toHaveLength(1)
    const parts = jsonFromSql(rows[0].parts) as Array<Record<string, unknown>>
    expect(parts.every(part => part.type === 'text')).toBe(true)
    expect(jsonFromSql(rows[0].tokenUsage)).toMatchObject({ totalTokens: 0 })
  })

  it('reports, rather than throws, when the fallback write also fails', async () => {
    // If the database itself is down there is nothing further to do — but
    // onFinish must not reject, or MCP cleanup and the request timer are skipped.
    mockExecuteTransaction.mockRejectedValue(new Error('connection terminated'))

    await expect(
      persistAssistantTurn({ ...BASE, text: 'Here is the schedule.' })
    ).resolves.toEqual({ persisted: false, fallbackPersisted: false })

    expect(mockLog.error).toHaveBeenCalledWith(
      'Failed to save the save-failure notice too',
      expect.objectContaining({ conversationId: 'conv-1' })
    )
  })
})

describe('persistAssistantTurn — an answer-less turn leaves a readable row', () => {
  it('stores the empty-turn notice the route hands it (#1899 case 1)', async () => {
    // The stream already showed a notice; without this row it vanished on
    // reload and the prompt looked unanswered, which is what drove the resends.
    const rows = transactionSucceeds()

    const result = await persistAssistantTurn({
      ...BASE,
      text: EMPTY_TURN_PERSIST_NOTICE,
      finishReason: 'no_content',
      metadata: { emptyTurn: true },
    })

    expect(result.persisted).toBe(true)
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe(EMPTY_TURN_PERSIST_NOTICE)
    expect(jsonFromSql(rows[0].metadata)).toMatchObject({ emptyTurn: true })
  })
})
