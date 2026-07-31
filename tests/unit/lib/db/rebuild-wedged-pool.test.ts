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
  const clients: Array<{
    end: jest.Mock
    reserve: jest.Mock
    options: object
  }> = []
  const reservedSessions: Array<{
    release: jest.Mock
    unsafe: jest.Mock
    options: object
  }> = []
  const factory = jest.fn(() => {
    const reserve = jest.fn(async () => {
      const reserved = {
        release: jest.fn(),
        unsafe: jest
          .fn<() => Promise<unknown[]>>()
          .mockResolvedValue([]),
        options: { parsers: {}, serializers: {} },
      }
      reservedSessions.push(reserved)
      return reserved
    })
    const client = {
      end: jest.fn(() => Promise.resolve()),
      reserve,
      // drizzle's postgres-js driver reads these off the client at construct.
      options: { parsers: {}, serializers: {} },
    }
    clients.push(client)
    return client
  })
  return {
    __esModule: true,
    default: factory,
    __clients: clients,
    __reservedSessions: reservedSessions,
  }
})

const postgresMock = jest.requireMock<{
  default: jest.Mock
  __clients: Array<{ end: jest.Mock; reserve: jest.Mock }>
  __reservedSessions: Array<{ release: jest.Mock; unsafe: jest.Mock }>
}>('postgres')
const pgFactory = postgresMock.default
const createdClients = postgresMock.__clients
const reservedSessions = postgresMock.__reservedSessions

async function returnFortyTwo(): Promise<number> {
  return 42
}

// jest.setup.js globally mocks drizzle-client (to block real DB connections);
// this suite exercises the REAL module against the mocked `postgres` factory
// above (repo pattern: jest.requireActual, see the graph-embeddings note in
// jest.setup.js).
const {
  getDb,
  rebuildWedgedPool,
  withUnretriedDatabaseSession,
} = jest.requireActual<
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

  it('reserves one connection, invokes side-effecting work once, and always releases', async () => {
    if (createdClients.length === 0) getDb()
    const callback = jest.fn(async () => {
      throw new Error('external effect failed')
    })

    await expect(
      withUnretriedDatabaseSession(
        callback,
        'nonReplayableWorkspaceFence',
        { deadlineMs: 1_000 },
      ),
    ).rejects.toThrow('external effect failed')

    expect(callback).toHaveBeenCalledTimes(1)
    expect(createdClients.at(-1)?.reserve).toHaveBeenCalledTimes(1)
    expect(reservedSessions).toHaveLength(1)
    expect(reservedSessions[0]?.release).toHaveBeenCalledTimes(1)
  })

  it('runs BEGIN and COMMIT on the exact reserved client without drizzle begin()', async () => {
    const result = await withUnretriedDatabaseSession(
      (session) =>
        session.executeTransaction(returnFortyTwo, 'manualTransaction'),
      'manualReservedTransaction',
      { deadlineMs: 1_000 },
    )

    expect(result).toBe(42)
    const reserved = reservedSessions.at(-1)
    expect(reserved?.unsafe.mock.calls.map((call) => call[0])).toEqual([
      'BEGIN',
      'COMMIT',
    ])
    expect(reserved?.release).toHaveBeenCalledTimes(1)
  })

  it('releases a reservation that arrives after the acquire deadline exactly once', async () => {
    let resolveReserve!: (reserved: {
      release: jest.Mock
      unsafe: jest.Mock
      options: object
    }) => void
    const lateReserve = new Promise<{
      release: jest.Mock
      unsafe: jest.Mock
      options: object
    }>((resolve) => {
      resolveReserve = resolve
    })
    const dedicatedClient = createdClients.at(-1)
    dedicatedClient?.reserve.mockImplementationOnce(() => lateReserve)
    const callback = jest.fn(async () => undefined)
    const timedOut = withUnretriedDatabaseSession(
      callback,
      'lateReservedSession',
      { deadlineMs: 10 },
    )
    await expect(timedOut).rejects.toThrow('acquire timed out')
    const late = {
      release: jest.fn(),
      unsafe: jest
        .fn<() => Promise<unknown[]>>()
        .mockResolvedValue([]),
      options: { parsers: {}, serializers: {} },
    }
    resolveReserve(late)
    await Promise.resolve()
    await Promise.resolve()

    expect(callback).not.toHaveBeenCalled()
    expect(late.release).toHaveBeenCalledTimes(1)
  })
})
