/**
 * @jest-environment node
 *
 * The assistants list cursor is an opaque assistant-id string, but its numeric
 * shape must be validated at the route so a malformed value (?cursor=abc) is a 400
 * before the DB, not a NaN comparison that surfaces as a 500 (REV-SEC-168).
 */
import { listQuerySchema } from "@/app/api/v1/assistants/route"

describe("assistants list cursor validation (REV-SEC-168)", () => {
  it("rejects a non-numeric cursor", () => {
    expect(listQuerySchema.safeParse({ cursor: "abc" }).success).toBe(false)
  })

  it("rejects zero and negative cursors", () => {
    expect(listQuerySchema.safeParse({ cursor: "0" }).success).toBe(false)
    expect(listQuerySchema.safeParse({ cursor: "-5" }).success).toBe(false)
  })

  it("accepts a valid positive-integer cursor", () => {
    const parsed = listQuerySchema.safeParse({ cursor: "42" })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.cursor).toBe("42")
  })

  it("accepts an absent cursor (optional)", () => {
    expect(listQuerySchema.safeParse({}).success).toBe(true)
  })
})
