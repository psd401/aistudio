jest.mock("nanoid", () => ({
  nanoid: () => "test-request-id",
}))
jest.mock("winston", () => ({
  __esModule: true,
  default: {
    createLogger: () => ({
      debug: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    }),
    format: {
      colorize: jest.fn(),
      combine: jest.fn(),
      errors: jest.fn(),
      printf: jest.fn(),
      timestamp: jest.fn(),
    },
    transports: {
      Console: jest.fn(),
    },
  },
}))
jest.unmock("@/lib/logger")

import { sanitizeForLogging } from "@/lib/logger"

describe("structured logger sanitization", () => {
  it("redacts sensitive keys, masks emails, and terminates circular input", () => {
    const input: Record<string, unknown> = {
      userEmail: "student@example.com",
      accessToken: "secret-token",
      message: "safe",
    }
    input.self = input

    expect(sanitizeForLogging(input)).toEqual({
      userEmail: "***@example.com",
      accessToken: "[REDACTED]",
      message: "safe",
      self: "[Circular]",
    })
  })

  it("preserves safe Error details while omitting cause chains", () => {
    const error = new Error("request failed", {
      cause: new Error("database password=hidden"),
    })
    Object.assign(error, {
      requestId: "request-1",
      apiKey: "top-secret",
    })

    const result = sanitizeForLogging(error) as Record<string, unknown>

    expect(result.name).toBe("Error")
    expect(result.message).toBe("request failed")
    expect(result).not.toHaveProperty("cause")
    expect(result.customProperties).toEqual({
      requestId: "request-1",
      apiKey: "[REDACTED]",
    })
  })

  it("drops unsafe property names", () => {
    const input = Object.create(null) as Record<string, unknown>
    input.safe = "value"
    input["constructor"] = "blocked"
    input["prototype"] = "blocked"

    expect(sanitizeForLogging(input)).toEqual({ safe: "value" })
  })
})
