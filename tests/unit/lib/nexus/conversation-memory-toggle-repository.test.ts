/* eslint-disable no-var */
var mockExecuteQuery = jest.fn()
/* eslint-enable no-var */

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
}))

import { PgDialect } from "drizzle-orm/pg-core"
import { SQL } from "drizzle-orm"
import { updateConversationMemoryDisabled } from "@/lib/db/drizzle/nexus-conversations"

function databaseDouble() {
  const returning = jest.fn().mockResolvedValue([
    {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Renamed",
      metadata: {
        last_provider: "openai",
        memoryDisabled: true,
      },
    },
  ])
  const where = jest.fn(() => ({ returning }))
  const set = jest.fn((_values: Record<string, unknown>) => ({ where }))
  const update = jest.fn(() => ({ set }))
  return { update, set }
}

describe("conversation memory toggle repository update", () => {
  it("merges memoryDisabled atomically while preserving a combined update", async () => {
    const db = databaseDouble()
    mockExecuteQuery.mockImplementation(
      async (operation: (value: { update: typeof db.update }) => unknown) =>
        operation({ update: db.update }),
    )

    await updateConversationMemoryDisabled(
      "11111111-1111-4111-8111-111111111111",
      7,
      true,
      { title: "Renamed" },
    )

    const updateValues = db.set.mock.calls[0]?.[0]
    if (!updateValues) throw new Error("Expected an update payload")
    expect(updateValues.title).toBe("Renamed")
    expect(updateValues.metadata).toBeInstanceOf(SQL)

    const rendered = new PgDialect().sqlToQuery(updateValues.metadata as SQL)
    expect(rendered.sql.toLowerCase()).toContain("jsonb_set")
    expect(rendered.sql.toLowerCase()).toContain("coalesce")
    expect(rendered.sql).toContain("memoryDisabled")
    expect(rendered.params).toContain(true)
  })
})
