import { test, expect } from "./fixtures"

/**
 * CI-safe auth guards for issue #1404's Assistant Architect write surfaces.
 * withApiAuth authenticates before scope checks or request-body parsing, so an
 * unauthenticated caller always receives 401.
 */
test.describe("agent-assistant-import-guard", () => {
  test("POST /api/v1/assistants/import is authentication-gated", async ({
    request,
  }) => {
    const response = await request.post("/api/v1/assistants/import", {
      data: { version: "1.0", assistants: [] },
    })
    expect(response.status()).toBe(401)
  })

  test("PUT /api/v1/assistants/{id} is authentication-gated", async ({
    request,
  }) => {
    const response = await request.put("/api/v1/assistants/1", {
      data: { version: "1.0", assistants: [] },
    })
    expect(response.status()).toBe(401)
  })

  test("POST /api/v1/assistants/{id}/fork is authentication-gated", async ({
    request,
  }) => {
    const response = await request.post("/api/v1/assistants/1/fork", {
      data: {},
    })
    expect(response.status()).toBe(401)
  })
})
