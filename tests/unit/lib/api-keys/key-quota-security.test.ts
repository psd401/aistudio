/** @jest-environment node */

import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals"

let activeKeyCount = 0
const operations: string[] = []

const executeTransactionMock = jest.fn(
  async (
    callback: (tx: {
      execute: (query: unknown) => Promise<void>
      select: (selection: unknown) => {
        from: (table: unknown) => {
          where: (condition: unknown) => Promise<Array<{ value: number }>>
        }
      }
      insert: (table: unknown) => {
        values: (values: unknown) => {
          returning: (selection: unknown) => Promise<Array<{ id: number }>>
        }
      }
    }) => Promise<unknown>,
  ) =>
    callback({
      execute: async () => {
        operations.push("lock")
      },
      select: () => ({
        from: () => ({
          where: async () => {
            operations.push("count")
            return [{ value: activeKeyCount }]
          },
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: async () => {
            operations.push("insert")
            return [{ id: 101 }]
          },
        }),
      }),
    }),
)

jest.mock("@/lib/db/drizzle-client", () => ({
  executeTransaction: executeTransactionMock,
  executeQuery: jest.fn(),
}))
jest.mock("@/lib/db/schema", () => ({
  apiKeys: {
    id: "id",
    userId: "user_id",
    isActive: "is_active",
  },
}))
jest.mock("@/lib/api-keys/argon2-loader", () => ({
  hashArgon2: async () => "argon-hash",
  verifyArgon2: async () => true,
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  generateRequestId: () => "request-id",
  startTimer: () => jest.fn(),
  sanitizeForLogging: (value: unknown) => value,
}))
jest.mock("@/lib/error-utils", () => ({
  ErrorFactories: {
    validationFailed: () => new Error("validation failed"),
    bizQuotaExceeded: () => new Error("API key creation quota exceeded"),
  },
}))

describe("API key quota serialization", () => {
  let generateApiKey: typeof import("@/lib/api-keys/key-service").generateApiKey

  beforeAll(async () => {
    ({ generateApiKey } = await import("@/lib/api-keys/key-service"))
  })

  beforeEach(() => {
    jest.clearAllMocks()
    operations.length = 0
    activeKeyCount = 0
  })

  it("takes the per-user transaction lock before count and insert", async () => {
    activeKeyCount = 9

    await expect(
      generateApiKey(42, "last allowed key", ["chat:read"]),
    ).resolves.toEqual(expect.objectContaining({ keyId: 101 }))
    expect(operations).toEqual(["lock", "count", "insert"])
  })

  it("rejects at the quota while holding the same transaction lock", async () => {
    activeKeyCount = 10

    await expect(
      generateApiKey(42, "overflow key", ["chat:read"]),
    ).rejects.toThrow(/quota exceeded/i)
    expect(operations).toEqual(["lock", "count"])
  })
})
