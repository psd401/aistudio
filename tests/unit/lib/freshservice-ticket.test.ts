import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals"

const getFreshserviceMock =
  jest.fn<Promise<unknown>, unknown[]>()
const getServerSessionMock =
  jest.fn<Promise<unknown>, unknown[]>()
const fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>

jest.mock("@/lib/settings-manager", () => ({
  Settings: {
    getFreshservice: (...args: unknown[]) => getFreshserviceMock(...args),
  },
}))

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: (...args: unknown[]) => getServerSessionMock(...args),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  }),
  generateRequestId: () => "request-1",
  sanitizeForLogging: (value: unknown) => value,
  startTimer: () => jest.fn(),
}))

jest.mock("@/lib/error-utils", () => ({
  ErrorFactories: {
    authNoSession: () => new Error("Unauthorized"),
    externalServiceError: (_service: string, error: Error) => error,
    sysConfigurationError: (message: string) => new Error(message),
    validationFailed: (
      fields: Array<{ field: string; message: string }>
    ) => new Error(fields.map((field) => field.message).join(", ")),
  },
  createSuccess: (data: unknown, message: string) => ({
    data,
    isSuccess: true,
    message,
  }),
  handleError: (error: unknown) => ({
    isSuccess: false,
    message: error instanceof Error ? error.message : String(error),
  }),
}))

import { createFreshserviceTicketAction } from "@/actions/create-freshservice-ticket.actions"
import { parseFreshserviceTicketId } from "@/lib/freshservice/ticket-response"

const originalFetch = globalThis.fetch

describe("Freshservice ticket response parsing", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    getServerSessionMock.mockResolvedValue({
      email: "user@example.test",
      name: "Test User",
      sub: "user-1",
    })
    getFreshserviceMock.mockResolvedValue({
      apiKey: "api-key",
      departmentId: "5",
      domain: "district",
      priority: "2",
      status: "2",
      ticketType: "Request",
      workspaceId: null,
    })
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  it("accepts numeric and numeric-string ticket IDs", () => {
    expect(parseFreshserviceTicketId({ id: 42 })).toBe(42)
    expect(parseFreshserviceTicketId({ id: "43" })).toBe(43)
  })

  it("rejects missing, non-numeric, and non-positive IDs", () => {
    expect(parseFreshserviceTicketId({ id: "" })).toBeNull()
    expect(parseFreshserviceTicketId({ id: "not-a-number" })).toBeNull()
    expect(parseFreshserviceTicketId({ id: -1 })).toBeNull()
  })

  it("creates a JSON ticket and accepts a string response ID", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ticket: { id: "43" } }), {
        status: 201,
      })
    )
    const form = new FormData()
    form.set("title", "Need help")
    form.set("description", "The application is unavailable")

    const result = await createFreshserviceTicketAction(form)

    expect(result).toMatchObject({
      data: {
        ticket_id: 43,
        ticket_url:
          "https://district.freshservice.com/support/tickets/43",
      },
      isSuccess: true,
    })
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({
      department_id: 5,
      email: "user@example.test",
      name: "Test User",
      subject: "Need help",
    })
  })

  it("rejects unsupported attachment types before calling Freshservice", async () => {
    const form = new FormData()
    form.set("title", "Need help")
    form.set("description", "See attachment")
    form.set("screenshotData", "data:image/svg+xml;base64,PHN2Zz4=")
    form.set("screenshotType", "image/svg+xml")

    const result = await createFreshserviceTicketAction(form)

    expect(result).toMatchObject({
      isSuccess: false,
      message: expect.stringContaining("Only JPEG, PNG, GIF, and WebP"),
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
