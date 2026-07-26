/** @jest-environment node */

import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals"

type Tx = {
  execute: jest.Mock<(query: unknown) => Promise<void>>
  update: jest.Mock<(table: unknown) => {
    set: (values: unknown) => { where: (condition: unknown) => Promise<void> }
  }>
  select: jest.Mock<(selection: Record<string, unknown>) => {
    from: (table: unknown) => {
      where: (condition: unknown) =>
        | Promise<Array<Record<string, unknown>>>
        | { limit: (count: number) => Promise<Array<Record<string, unknown>>> }
    }
  }>
  insert: jest.Mock<(table: unknown) => {
    values: (values: unknown) => Promise<void>
  }>
}

let rows: Array<Array<Record<string, unknown>>> = []
let tx: Tx

function createTx(): Tx {
  return {
    execute: jest.fn(async () => undefined),
    update: jest.fn(() => ({
      set: () => ({ where: async () => undefined }),
    })),
    select: jest.fn((selection) => ({
      from: () => ({
        where: () =>
          "id" in selection
            ? { limit: async () => rows.shift() ?? [] }
            : Promise.resolve(rows.shift() ?? []),
      }),
    })),
    insert: jest.fn(() => ({ values: async () => undefined })),
  }
}

const executeTransactionMock = jest.fn(
  async (callback: (value: Tx) => Promise<unknown>, _label: string) => {
    tx = createTx()
    return callback(tx)
  },
)
const executeQueryMock = jest.fn(
  async (callback: (value: Tx) => Promise<unknown>, _label: string) => {
    tx = createTx()
    return callback(tx)
  },
)

jest.mock("@/lib/db/drizzle-client", () => ({
  executeTransaction: executeTransactionMock,
  executeQuery: executeQueryMock,
}))
jest.mock("@/lib/db/schema", () => ({
  agenticCostReservations: {
    id: "id",
    userId: "user_id",
    executionId: "execution_id",
    reservedCostCents: "reserved_cost_cents",
    status: "status",
    actualCostCents: "actual_cost_cents",
    reconciledAt: "reconciled_at",
    reservedAt: "reserved_at",
    expiresAt: "expires_at",
  },
}))

describe("agentic Assistant conservative cost reservations", () => {
  let reserveAgenticCost:
    typeof import("@/lib/agents/cost-budget").reserveAgenticCost
  let releaseAgenticCost:
    typeof import("@/lib/agents/cost-budget").releaseAgenticCost

  beforeAll(async () => {
    ({ reserveAgenticCost, releaseAgenticCost } =
      await import("@/lib/agents/cost-budget"))
  })

  beforeEach(() => {
    jest.clearAllMocks()
    rows = []
    process.env.AGENTIC_ASSISTANT_USER_HOURLY_BUDGET_CENTS = "1000"
    process.env.AGENTIC_ASSISTANT_DEPLOYMENT_HOURLY_BUDGET_CENTS = "5000"
  })

  it("atomically reserves the full configured run cap", async () => {
    rows = [[], [{ value: 0 }], [{ value: 0 }]]

    await expect(reserveAgenticCost(42, 123, 250.2)).resolves.toEqual(
      expect.objectContaining({
        allowed: true,
        reservedCostCents: 251,
      }),
    )
    expect(tx.execute).toHaveBeenCalledTimes(1)
    expect(tx.insert).toHaveBeenCalledTimes(1)
  })

  it("blocks before the tool loop when the user budget is exhausted", async () => {
    rows = [[], [{ value: 900 }], [{ value: 900 }]]

    await expect(reserveAgenticCost(42, 123, 200)).resolves.toEqual({
      allowed: false,
      reason: "user_budget",
    })
    expect(tx.insert).not.toHaveBeenCalled()
  })

  it("fails closed for unknown or non-positive reservation values", async () => {
    await expect(reserveAgenticCost(42, 123, Number.NaN)).rejects.toThrow(
      /positive finite/,
    )
    await expect(reserveAgenticCost(42, 123, 0)).rejects.toThrow(
      /positive finite/,
    )
    expect(executeTransactionMock).not.toHaveBeenCalled()
  })

  it("rejects replay of an existing execution reservation", async () => {
    rows = [[{
      id: "existing",
      userId: 42,
      status: "released",
      reservedCostCents: 100,
    }]]
    await expect(reserveAgenticCost(42, 123, 100)).resolves.toEqual({
      allowed: false,
      reason: "duplicate_execution",
    })
    expect(tx.insert).not.toHaveBeenCalled()
  })

  it("releases active leases while retaining their hourly budget record", async () => {
    await releaseAgenticCost("lease-id")
    expect(executeQueryMock).toHaveBeenCalledWith(
      expect.any(Function),
      "releaseAgenticCost",
    )
    expect(tx.update).toHaveBeenCalledTimes(1)
  })
})
