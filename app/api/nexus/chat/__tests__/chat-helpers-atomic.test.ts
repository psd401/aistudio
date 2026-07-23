/**
 * @jest-environment node
 *
 * Tests that saveUserMessage / saveAssistantMessage persist the message row and the
 * conversation-stats update inside a SINGLE executeTransaction (REV-DB-046 /
 * REV-COR-220), so a failure between the two can never desync message_count from the
 * actual nexus_messages rows.
 */

import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

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

import {
  saveUserMessage,
  saveAssistantMessage,
  saveConversationSteps,
} from '../chat-helpers'

// A chainable fake `tx` recording which write builders were invoked.
function makeTx() {
  const insertValues = jest.fn(async () => {})
  const updateWhere = jest.fn(async () => {})
  const updateSet = jest.fn(() => ({ where: updateWhere }))
  const tx = {
    insert: jest.fn(() => ({ values: insertValues })),
    update: jest.fn(() => ({ set: updateSet })),
  }
  return { tx, insertValues, updateWhere }
}

function jsonFromSql(value: unknown): unknown {
  const query = new PgDialect().sqlToQuery(value as SQL)
  return JSON.parse(String(query.params[0]))
}

const attachmentSearchResult = {
  success: true,
  query: 'attendance policy',
  results: [{
    content: 'RAW-REPOSITORY-CHUNK-MUST-NOT-BE-DURABLE',
    source: 'handbook.pdf',
    score: 0.88,
    citations: [{
      itemVersionId: '123e4567-e89b-42d3-a456-426614174000',
      chunkId: 19,
      label: 'Page 7',
      sourceLocator: { page: 7 },
    }],
  }],
}

function expectCitationOnlyAttachmentResult(insertValues: jest.Mock): void {
  const calls = insertValues.mock.calls as unknown as Array<[
    { parts: unknown },
  ]>
  const parts = jsonFromSql(calls[0][0].parts) as Array<Record<string, unknown>>
  expect(JSON.stringify(parts)).not.toContain(
    'RAW-REPOSITORY-CHUNK-MUST-NOT-BE-DURABLE'
  )
  expect(parts).toEqual([
    expect.objectContaining({
      type: 'tool-call',
      toolCallId: 'attachment-search-1',
      toolName: 'searchNexusAttachments',
      state: 'output-available',
      input: { query: 'attendance policy' },
      result: {
        success: true,
        query: 'attendance policy',
        results: [{
          source: 'handbook.pdf',
          score: 0.88,
          citations: [{
            itemVersionId: '123e4567-e89b-42d3-a456-426614174000',
            chunkId: 19,
            label: 'Page 7',
            sourceLocator: { page: 7 },
          }],
        }],
      },
    }),
  ])
}

describe('nexus message saves are transactional (REV-DB-046 / REV-COR-220)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('saveUserMessage inserts the message and updates stats in one executeTransaction', async () => {
    const { tx, insertValues, updateWhere } = makeTx()
    mockExecuteTransaction.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx))

    await saveUserMessage({ conversationId: 'c1', content: 'hi', parts: [{ type: 'text', text: 'hi' }], dbModelId: 5 })

    // Exactly one atomic unit; no separate non-transactional query.
    expect(mockExecuteTransaction).toHaveBeenCalledTimes(1)
    expect(mockExecuteTransaction.mock.calls[0][1]).toBe('saveUserMessage')
    expect(mockExecuteQuery).not.toHaveBeenCalled()
    // Both the insert and the stats update ran inside the transaction.
    expect(insertValues).toHaveBeenCalledTimes(1)
    expect(updateWhere).toHaveBeenCalledTimes(1)
    expect(tx.insert).toHaveBeenCalledTimes(1)
    expect(tx.update).toHaveBeenCalledTimes(1)
  })

  it('saveAssistantMessage inserts + updates stats in one executeTransaction', async () => {
    const { tx, insertValues, updateWhere } = makeTx()
    mockExecuteTransaction.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx))

    await saveAssistantMessage({
      conversationId: 'c1', text: 'answer', usage: { totalTokens: 10 }, finishReason: 'stop', dbModelId: 5,
    })

    expect(mockExecuteTransaction).toHaveBeenCalledTimes(1)
    expect(mockExecuteTransaction.mock.calls[0][1]).toBe('saveAssistantMessage')
    expect(mockExecuteQuery).not.toHaveBeenCalled()
    expect(insertValues).toHaveBeenCalledTimes(1)
    expect(updateWhere).toHaveBeenCalledTimes(1)
  })

  it('propagates (rolls back) when the transaction fails — the whole save rejects', async () => {
    mockExecuteTransaction.mockRejectedValue(new Error('stats update failed'))

    await expect(
      saveUserMessage({ conversationId: 'c1', content: 'hi', parts: [], dbModelId: 5 })
    ).rejects.toThrow('stats update failed')
  })

  it('persists citation-only Nexus attachment search results for a single-step response', async () => {
    const { tx, insertValues } = makeTx()
    mockExecuteTransaction.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx))

    await saveAssistantMessage({
      conversationId: 'c1',
      text: '',
      dbModelId: 5,
      toolCalls: [{
        toolCallId: 'attachment-search-1',
        toolName: 'searchNexusAttachments',
        args: { query: 'attendance policy' },
        result: attachmentSearchResult,
      }],
    })

    expectCitationOnlyAttachmentResult(insertValues)
  })

  it('persists citation-only Nexus attachment search results for a multi-step response', async () => {
    const { tx, insertValues } = makeTx()
    mockExecuteTransaction.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx))

    await saveConversationSteps({
      conversationId: 'c1',
      dbModelId: 5,
      steps: [
        {
          text: '',
          finishReason: 'tool-calls',
          toolCalls: [{
            toolCallId: 'attachment-search-1',
            toolName: 'searchNexusAttachments',
            args: { query: 'attendance policy' },
            result: attachmentSearchResult,
          }],
        },
        {
          text: 'The policy is on page 7.',
          finishReason: 'stop',
          toolCalls: [],
        },
      ],
    })

    expect(insertValues).toHaveBeenCalledTimes(2)
    expectCitationOnlyAttachmentResult(insertValues)
  })
})
