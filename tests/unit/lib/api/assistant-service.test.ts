/**
 * @jest-environment node
 *
 * Access validation for the v1 assistants API (REV-COR-524): an approved assistant
 * with a null owner must remain runnable (not 404), while non-approved orphans stay
 * denied and the owner/admin/approved precedence is unchanged.
 */
import { validateAssistantAccess } from "@/lib/api/assistant-service"

describe("validateAssistantAccess (REV-COR-524)", () => {
  it("grants access to an approved assistant with a null owner", () => {
    expect(validateAssistantAccess({ userId: null, status: "approved" }, 42, false)).toEqual({
      allowed: true,
    })
  })

  it("denies a non-approved orphan (null owner) to a non-admin", () => {
    const result = validateAssistantAccess({ userId: null, status: "draft" }, 42, false)
    expect(result.allowed).toBe(false)
  })

  it("grants an admin access to a null-owner draft", () => {
    expect(validateAssistantAccess({ userId: null, status: "draft" }, 42, true).allowed).toBe(true)
  })

  it("still grants the owner and approved assistants (regression)", () => {
    expect(validateAssistantAccess({ userId: 42, status: "draft" }, 42, false).allowed).toBe(true)
    expect(validateAssistantAccess({ userId: 7, status: "approved" }, 42, false).allowed).toBe(true)
    expect(validateAssistantAccess({ userId: 7, status: "draft" }, 42, false).allowed).toBe(false)
  })
})
