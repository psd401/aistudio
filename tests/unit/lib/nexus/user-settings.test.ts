/* eslint-disable no-var */
var mockExecuteTransaction = jest.fn()
var mockSafeJsonbStringify = jest.fn()
/* eslint-enable no-var */

jest.mock("@/lib/db/drizzle-client", () => ({
  executeTransaction: (...args: unknown[]) =>
    mockExecuteTransaction(...args),
}))

jest.mock("@/lib/db/json-utils", () => ({
  safeJsonbStringify: (...args: unknown[]) =>
    mockSafeJsonbStringify(...args),
}))

import { PgDialect } from "drizzle-orm/pg-core"
import { SQL } from "drizzle-orm"
import { mergeNexusUserSettings } from "@/lib/nexus/user-settings"

function settingsTransactionDouble(existingSettings?: {
  nexusMode?: "standard" | "advanced"
  preferredModelFamily?: "auto" | "openai" | "anthropic" | "google"
}) {
  const execute = jest.fn().mockResolvedValue([])
  const limit = jest
    .fn()
    .mockResolvedValue(
      existingSettings ? [{ settings: existingSettings }] : [],
    )
  const where = jest.fn(() => ({ limit }))
  const from = jest.fn(() => ({ where }))
  const select = jest.fn(() => ({ from }))
  const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined)
  const values = jest.fn(
    (_input: {
      userId: number
      settings: unknown
      updatedAt: Date
    }) => ({ onConflictDoUpdate }),
  )
  const insert = jest.fn(() => ({ values }))
  return {
    execute,
    select,
    insert,
    values,
    onConflictDoUpdate,
  }
}

describe("mergeNexusUserSettings", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSafeJsonbStringify.mockReturnValue("serialized-settings")
  })

  it("locks the user and safely preserves unrelated settings", async () => {
    const tx = settingsTransactionDouble({
      nexusMode: "advanced",
      preferredModelFamily: "google",
    })
    mockExecuteTransaction.mockImplementationOnce(
      (
        operation: (value: typeof tx) => Promise<unknown>,
      ) => operation(tx),
    )

    const result = await mergeNexusUserSettings(7, {
      memoryEnabled: false,
    })

    expect(result).toEqual({
      nexusMode: "advanced",
      preferredModelFamily: "google",
      memoryEnabled: false,
    })
    expect(mockSafeJsonbStringify).toHaveBeenCalledWith(result)
    expect(mockExecuteTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      "mergeNexusUserSettings",
    )

    const lockStatement = tx.execute.mock.calls[0]?.[0]
    expect(lockStatement).toBeInstanceOf(SQL)
    if (!(lockStatement instanceof SQL)) {
      throw new TypeError("Expected the settings lock SQL")
    }
    const renderedLock = new PgDialect().sqlToQuery(lockStatement)
    expect(renderedLock.sql).toContain("pg_advisory_xact_lock")
    expect(renderedLock.params).toContain(1_314_411_859)
    expect(renderedLock.params).toContain(7)

    const inserted = tx.values.mock.calls[0]?.[0]
    expect(inserted).toMatchObject({ userId: 7 })
    expect(inserted?.settings).toBeInstanceOf(SQL)
  })

  it("uses the same lock-protected merge for a missing preference row", async () => {
    const tx = settingsTransactionDouble()
    mockExecuteTransaction.mockImplementationOnce(
      (
        operation: (value: typeof tx) => Promise<unknown>,
      ) => operation(tx),
    )

    await expect(
      mergeNexusUserSettings(9, {
        nexusMode: "standard",
        preferredModelFamily: "auto",
      }),
    ).resolves.toEqual({
      nexusMode: "standard",
      preferredModelFamily: "auto",
    })

    expect(tx.execute).toHaveBeenCalledTimes(1)
    expect(tx.insert).toHaveBeenCalledTimes(1)
  })
})
