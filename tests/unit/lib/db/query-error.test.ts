/** @jest-environment node */

import { describe, expect, it } from "@jest/globals"
import { describeQueryErrorCause } from "@/lib/db/query-error"

describe("describeQueryErrorCause", () => {
  it("pulls the postgres cause out from behind Drizzle's wrapper, without its row values", () => {
    const driverError = Object.assign(
      new Error(
        'duplicate key value violates unique constraint ' +
          '"uq_workspace_upload_target_active"',
      ),
      {
        code: "23505",
        constraint_name: "uq_workspace_upload_target_active",
        table_name: "workspace_upload_reservations",
        detail: "Key (owner_key, target_key)=(a, b) already exists.",
      },
    )
    const wrapped = new Error(
      'Failed query: insert into "workspace_upload_reservations" …',
      { cause: driverError },
    )

    expect(describeQueryErrorCause(wrapped)).toEqual({
      causeMessage:
        'duplicate key value violates unique constraint ' +
        '"uq_workspace_upload_target_active"',
      causeCode: "23505",
      causeConstraint: "uq_workspace_upload_target_active",
      causeTable: "workspace_upload_reservations",
    })
    // The driver error above CARRIES a `detail` line holding the literal row
    // values that collided. It must never reach the log payload — the code and
    // constraint above already identify what failed.
    expect(describeQueryErrorCause(wrapped)).not.toHaveProperty("causeDetail")
  })

  it("returns nothing when there is no cause to report", () => {
    expect(describeQueryErrorCause(new Error("plain"))).toBeUndefined()
    expect(describeQueryErrorCause(undefined)).toBeUndefined()
    expect(describeQueryErrorCause("a string")).toBeUndefined()
    expect(
      describeQueryErrorCause(new Error("wrapped", { cause: "text cause" })),
    ).toBeUndefined()
  })

  it("terminates on a self-referential cause chain", () => {
    const looping = new Error("loop") as Error & { cause?: unknown }
    looping.cause = looping

    expect(describeQueryErrorCause({ cause: looping })).toEqual({
      causeMessage: "loop",
    })
  })

  it("bounds a driver message so it cannot flood the log", () => {
    const wrapped = new Error("Failed query", {
      cause: Object.assign(new Error("x".repeat(5_000)), {
        detail: "y".repeat(5_000),
      }),
    })
    const described = describeQueryErrorCause(wrapped)

    expect(described?.causeMessage).toHaveLength(500)
  })
})
