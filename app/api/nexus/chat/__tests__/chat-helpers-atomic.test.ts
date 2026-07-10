/**
 * @jest-environment node
 *
 * Tests that saveUserMessage / saveAssistantMessage persist the message row and the
 * conversation-stats update inside a SINGLE executeTransaction (REV-DB-046 /
 * REV-COR-220), so a failure between the two can never desync message_count from the
 * actual nexus_messages rows.
 */

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

import { saveUserMessage, saveAssistantMessage } from '../chat-helpers'

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
})
