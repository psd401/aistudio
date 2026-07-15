/**
 * @jest-environment node
 *
 * Locks in the behavior of the centralized default-role heuristic
 * (lib/auth/default-role.ts, #1207). This function is the single source of truth
 * for a security-relevant provisioning decision, and its whole purpose is to make
 * the coverage-gated retirement "a one-line edit" — so a test guards against a
 * future edit changing the numeric/non-numeric/empty behavior unintentionally.
 */
import { defaultRoleForNewUser } from "@/lib/auth/default-role"

describe("defaultRoleForNewUser (#1207 legacy heuristic)", () => {
  it("maps an all-digit username to student (K-12 student ID convention)", () => {
    expect(defaultRoleForNewUser("123456@psd401.net")).toBe("student")
    expect(defaultRoleForNewUser("0@psd401.net")).toBe("student")
  })

  it("maps a non-numeric username to staff", () => {
    expect(defaultRoleForNewUser("jane.doe@psd401.net")).toBe("staff")
    expect(defaultRoleForNewUser("teacher1@psd401.net")).toBe("staff") // digits present but not all-digit
    expect(defaultRoleForNewUser("123abc@psd401.net")).toBe("staff")
  })

  it("defaults an empty / missing username or email to staff (matches the prior inline behavior)", () => {
    expect(defaultRoleForNewUser("@psd401.net")).toBe("staff")
    expect(defaultRoleForNewUser("")).toBe("staff")
    expect(defaultRoleForNewUser(null)).toBe("staff")
    expect(defaultRoleForNewUser(undefined)).toBe("staff")
  })

  it("keys only on the local part (text before @), ignoring a numeric domain", () => {
    expect(defaultRoleForNewUser("jane@123.net")).toBe("staff")
    expect(defaultRoleForNewUser("42@123.net")).toBe("student")
  })
})
