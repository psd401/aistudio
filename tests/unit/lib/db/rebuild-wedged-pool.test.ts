/**
 * Unit tests for rebuildWedgedPool (drizzle-client wedged-pool self-heal).
 *
 * Uses a mocked `postgres` factory so no real database is involved. Covers:
 * discarding + lazily rebuilding the client, the force-close of the old
 * client, and the 60s rebuild cooldown.
 *
 * @see lib/db/drizzle-client.ts
 */
import { describe, it, expect, beforeAll, jest } from '@jest/globals'

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  generateRequestId: () => 'test-request-id',
  startTimer: () => () => 100,
}))

// All mock state lives INSIDE the factory (retrieved via requireMock below) —
// out-of-scope references break under SWC's jest.mock hoisting.
jest.mock('postgres', () => {
  const clients: Array<{ end: jest.Mock; options: object }> = []
  const factory = jest.fn(() => {
    const client = {
      end: jest.fn(() => Promise.resolve()),
      // drizzle's postgres-js driver reads these off the client at construct.
      options: { parsers: {}, serializers: {} },
    }
    clients.push(client as unknown as { end: jest.Mock; options: object })
    return client
  })
  return { __esModule: true, default: factory, __clients: clients }
})

const postgresMock = jest.requireMock<{
  default: jest.Mock
  __clients: Array<{ end: jest.Mock }>
}>('postgres')
const pgFactory = postgresMock.default
const createdClients = postgresMock.__clients

// jest.setup.js globally mocks drizzle-client (to block real DB connections);
// this suite exercises the REAL module against the mocked `postgres` factory
// above (repo pattern: jest.requireActual, see the graph-embeddings note in
// jest.setup.js).
const { getDb, rebuildWedgedPool } = jest.requireActual<
  typeof import('@/lib/db/drizzle-client')
>('@/lib/db/drizzle-client')

describe('rebuildWedgedPool', () => {
  beforeAll(() => {
    process.env.DATABASE_URL =
      'postgresql://postgres:postgres@localhost:5432/aistudio_test'
  })

  it('discards the wedged client, force-closes it, and lazily rebuilds; cooldown suppresses a second rebuild', () => {
    // No client yet → rebuild is a no-op (nothing to discard).
    rebuildWedgedPool(3)
    expect(createdClients).toHaveLength(0)

    // First real use builds client #1.
    getDb()
    expect(pgFactory).toHaveBeenCalledTimes(1)
    expect(createdClients).toHaveLength(1)

    // Wedge → client #1 is discarded and force-closed with the 5s timeout.
    rebuildWedgedPool(3)
    expect(createdClients[0].end).toHaveBeenCalledWith({ timeout: 5 })

    // Next use lazily builds a FRESH client (capacity restored).
    getDb()
    expect(pgFactory).toHaveBeenCalledTimes(2)
    expect(createdClients).toHaveLength(2)

    // A second wedge within the 60s cooldown must NOT tear down the new pool
    // (one burst of deadline failures may fire the callback many times).
    rebuildWedgedPool(3)
    expect(createdClients[1].end).not.toHaveBeenCalled()
    getDb()
    expect(pgFactory).toHaveBeenCalledTimes(2)
  })
})
