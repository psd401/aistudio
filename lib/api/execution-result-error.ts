import { NextResponse } from "next/server"
import { ErrorCode } from "@/types/error-types"

/**
 * Map a typed error to an appropriate HTTP response for execution-result API routes.
 *
 * Uses ErrorCode (set by ErrorFactories) to determine status code — not error.name
 * string matching, which breaks on refactoring, and not handleError(), which returns
 * ActionState shape (designed for Server Actions, not API routes).
 */
export function executionResultErrorResponse(
  error: unknown,
  fallbackMessage: string
): NextResponse {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code
    if (code === ErrorCode.INVALID_INPUT || code === ErrorCode.MISSING_REQUIRED_FIELD) {
      return NextResponse.json({ error: "Invalid execution result ID" }, { status: 400 })
    }
    if (code === ErrorCode.AUTH_NO_SESSION || code === ErrorCode.AUTH_INVALID_TOKEN) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 })
    }
    if (code === ErrorCode.DB_RECORD_NOT_FOUND) {
      return NextResponse.json({ error: "Execution result not found" }, { status: 404 })
    }
  }
  return NextResponse.json({ error: fallbackMessage }, { status: 500 })
}
