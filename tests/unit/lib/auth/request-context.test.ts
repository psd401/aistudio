/**
 * @jest-environment node
 *
 * The client-supplied x-request-id must be validated before it becomes the logging
 * correlation id (REV-SEC-189): CRLF/oversized/forging payloads fall back to a
 * generated UUID; a well-formed id passes through for trace propagation.
 *
 * jest.setup.js globally mocks @/lib/auth/request-context, so load the REAL module
 * via jest.requireActual while keeping next/headers mocked.
 */
let mockHeaderValue: string | null = null
jest.mock("next/headers", () => ({
  __esModule: true,
  headers: async () => ({
    get: (name: string) => (name === "x-request-id" ? mockHeaderValue : null),
  }),
}))

const { getRequestId } = jest.requireActual("@/lib/auth/request-context") as {
  getRequestId: () => Promise<string>
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe("getRequestId (REV-SEC-189)", () => {
  it("passes through a well-formed client id", async () => {
    mockHeaderValue = "req-abc_123.4"
    expect(await getRequestId()).toBe("req-abc_123.4")
  })

  it("passes through a UUID", async () => {
    mockHeaderValue = "123e4567-e89b-42d3-a456-426614174000"
    expect(await getRequestId()).toBe(mockHeaderValue)
  })

  it("rejects a CRLF log-forging value and generates a UUID", async () => {
    mockHeaderValue = "a\r\nFAKE: injected"
    expect(await getRequestId()).toMatch(UUID_RE)
  })

  it("rejects an oversized value and generates a UUID", async () => {
    mockHeaderValue = "a".repeat(200)
    expect(await getRequestId()).toMatch(UUID_RE)
  })

  it("generates a UUID when the header is absent", async () => {
    mockHeaderValue = null
    expect(await getRequestId()).toMatch(UUID_RE)
  })
})
