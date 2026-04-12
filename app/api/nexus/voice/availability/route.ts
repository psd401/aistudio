/**
 * Voice Availability API Route
 *
 * Dedicated endpoint for checking voice mode availability for the current user.
 * Returns { available: boolean, reason?: string } with human-readable reasons
 * when voice is not available.
 *
 * GET /api/nexus/voice/availability
 *
 * Unlike /api/nexus/voice-info (which only returns { available: boolean }),
 * this endpoint includes the reason string so the client can display
 * context-appropriate messages to the user.
 *
 * Issue #876
 */

import { NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { getVoiceAvailability } from "@/lib/voice/availability"

export async function GET() {
  const requestId = generateRequestId()
  const log = createLogger({ requestId, route: "nexus.voice.availability" })
  const timer = startTimer("nexus.voice.availability")

  try {
    const session = await getServerSession()
    if (!session) {
      timer({ status: "unauthorized" })
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const result = await getVoiceAvailability(session.sub)

    log.info("Voice availability checked", {
      available: result.available,
      reason: result.reason,
    })

    timer({ status: "success" })
    return NextResponse.json(result, {
      headers: { "Cache-Control": "max-age=30, private" },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error("Error checking voice availability", { error: message })
    timer({ status: "error" })
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
