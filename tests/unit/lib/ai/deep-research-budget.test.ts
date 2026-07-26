/** @jest-environment node */

import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals"

type Tx = {
  execute: jest.Mock<(query: unknown) => Promise<void>>
  update: jest.Mock<(table: unknown) => {
    set: (values: unknown) => { where: (condition: unknown) => Promise<void> }
  }>
  select: jest.Mock<(selection: unknown) => {
    from: (table: unknown) => { where: (condition: unknown) => Promise<Array<{ value: number }>> }
  }>
  insert: jest.Mock<(table: unknown) => {
    values: (values: unknown) => Promise<void>
  }>
}

let transactionRows: Array<Array<{ value: number }>> = []
let activeTx: Tx

function makeTx(): Tx {
  return {
    execute: jest.fn(async () => undefined),
    update: jest.fn(() => ({
      set: () => ({ where: async () => undefined }),
    })),
    select: jest.fn(() => ({
      from: () => ({
        where: async () => transactionRows.shift() ?? [],
      }),
    })),
    insert: jest.fn(() => ({
      values: async () => undefined,
    })),
  }
}

const executeTransactionMock = jest.fn(
  async (callback: (tx: Tx) => Promise<unknown>) => {
    activeTx = makeTx()
    return callback(activeTx)
  },
)
const executeQueryMock = jest.fn(
  async (callback: (db: Tx) => Promise<unknown>, _label: string) => {
    activeTx = makeTx()
    return callback(activeTx)
  },
)

jest.mock("@/lib/db/drizzle-client", () => ({
  executeTransaction: executeTransactionMock,
  executeQuery: executeQueryMock,
}))

jest.mock("@/lib/db/schema", () => ({
  deepResearchReservations: {
    id: "id",
    userId: "user_id",
    status: "status",
    expiresAt: "expires_at",
    releasedAt: "released_at",
    reservedAt: "reserved_at",
    reservedCostCents: "reserved_cost_cents",
  },
}))

describe("Deep Research durable reservations", () => {
  let reserveDeepResearch:
    typeof import("@/lib/ai/deep-research-budget").reserveDeepResearch
  let releaseDeepResearch:
    typeof import("@/lib/ai/deep-research-budget").releaseDeepResearch

  beforeAll(async () => {
    ({ reserveDeepResearch, releaseDeepResearch } =
      await import("@/lib/ai/deep-research-budget"))
  })

  beforeEach(() => {
    jest.clearAllMocks()
    transactionRows = []
    process.env.DEEP_RESEARCH_USER_CONCURRENCY = "1"
    process.env.DEEP_RESEARCH_DEPLOYMENT_CONCURRENCY = "5"
    process.env.DEEP_RESEARCH_MAX_RUN_COST_CENTS = "500"
    process.env.DEEP_RESEARCH_USER_HOURLY_BUDGET_CENTS = "1000"
    process.env.DEEP_RESEARCH_DEPLOYMENT_HOURLY_BUDGET_CENTS = "5000"
  })

  it("locks, checks every limit, and inserts one lease before provider work", async () => {
    transactionRows = [[{ value: 0 }], [{ value: 0 }], [{ value: 0 }], [{ value: 0 }]]

    const result = await reserveDeepResearch(42)

    expect(result).toEqual(expect.objectContaining({ allowed: true }))
    expect(activeTx.execute).toHaveBeenCalledTimes(1)
    expect(activeTx.select).toHaveBeenCalledTimes(4)
    expect(activeTx.insert).toHaveBeenCalledTimes(1)
  })

  it("denies a concurrent second user lease without inserting", async () => {
    transactionRows = [[{ value: 1 }], [{ value: 1 }], [{ value: 500 }], [{ value: 500 }]]

    await expect(reserveDeepResearch(42)).resolves.toEqual({
      allowed: false,
      reason: "user_concurrency",
    })
    expect(activeTx.insert).not.toHaveBeenCalled()
  })

  it("fails closed when the conservative cost reservation exceeds budget", async () => {
    transactionRows = [[{ value: 0 }], [{ value: 0 }], [{ value: 750 }], [{ value: 750 }]]

    await expect(reserveDeepResearch(42)).resolves.toEqual({
      allowed: false,
      reason: "user_budget",
    })
    expect(activeTx.insert).not.toHaveBeenCalled()
  })

  it("releases an active lease on terminal paths", async () => {
    await releaseDeepResearch("lease-id")
    expect(executeQueryMock).toHaveBeenCalledWith(
      expect.any(Function),
      "releaseDeepResearch",
    )
    expect(activeTx.update).toHaveBeenCalledTimes(1)
  })
})
