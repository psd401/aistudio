/**
 * Health Check Endpoint
 * Public — no authentication required.
 * Part of Epic #674 (External API Platform) - Issue #679
 */

import { NextResponse } from "next/server"
import { generateRequestId } from "@/lib/logger"

export async function GET() {
  const requestId = generateRequestId()
  return NextResponse.json(
    {
      status: "ok",
      version: "v1",
      timestamp: new Date().toISOString(),
    },
    {
      headers: { "X-Request-Id": requestId },
    }
  )
}
