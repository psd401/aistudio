const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}

jest.mock("@/lib/logger", () => ({
  createLogger: () => logger,
  sanitizeForLogging: (value: unknown) => value,
  generateRequestId: () => "request-test",
  getLogContext: () => ({}),
}))

import {
  ErrorFactories,
  handleError,
} from "@/lib/error-utils"
import { ErrorLevel, type AppError } from "@/types/actions-types"

describe("handleError", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns a typed error user message and logs at its configured level", () => {
    const error = ErrorFactories.validationFailed([
      { field: "name", message: "Name is required" },
    ], { userMessage: "Check the form" })

    const result = handleError(error, "Fallback", {
      includeErrorInResponse: true,
    })

    expect(result).toEqual(expect.objectContaining({
      isSuccess: false,
      message: "Check the form",
      error: expect.objectContaining({ code: error.code }),
    }))
    expect(logger.info).toHaveBeenCalled()
  })

  it("preserves legacy AppError logging and response behavior", () => {
    const error = new Error("Legacy failure") as AppError
    error.level = ErrorLevel.WARN
    error.details = { operation: "legacy" }

    const result = handleError(error, "Try again", {
      includeErrorInResponse: true,
    })

    expect(result).toEqual({
      isSuccess: false,
      message: "Try again",
      error,
    })
    expect(logger.warn).toHaveBeenCalledWith(
      "Legacy failure",
      expect.objectContaining({ details: { operation: "legacy" } })
    )
  })

  it("records each AggregateError member", () => {
    const error = new AggregateError(
      [new Error("first"), new Error("second")],
      "Multiple failures"
    )

    handleError(error, "Try again", { includeErrorInResponse: false })

    expect(logger.error).toHaveBeenCalledWith(
      "Multiple failures",
      expect.objectContaining({
        errors: [expect.any(Error), expect.any(Error)],
      })
    )
  })

  it("omits internal errors when response inclusion is disabled", () => {
    expect(handleError(new Error("secret"), "Safe message", {
      includeErrorInResponse: false,
    })).toEqual({
      isSuccess: false,
      message: "Safe message",
    })
  })

  it("keeps safe rate-limit retry metadata in production responses", () => {
    const resetAt = "2026-08-01T20:30:00.000Z"
    const error = ErrorFactories.bizRateLimitExceeded(
      "submit artifact records",
      30,
      resetAt
    )

    expect(handleError(error, "Fallback", {
      includeErrorInResponse: false,
    })).toEqual({
      isSuccess: false,
      message: "Too many requests. Please wait a moment and try again",
      error: {
        code: "BIZ_RATE_LIMIT_EXCEEDED",
        statusCode: 429,
        retryAfterSeconds: 30,
        resetAt,
      },
    })
  })

  it("handles non-Error throws as unknown failures", () => {
    const result = handleError({ reason: "bad" }, "Safe message", {
      includeErrorInResponse: true,
    })

    expect(result).toEqual({
      isSuccess: false,
      message: "Safe message",
      error: { reason: "bad" },
    })
    expect(logger.error).toHaveBeenCalledWith(
      "Unknown error occurred",
      expect.objectContaining({ error: { reason: "bad" } })
    )
  })
})
