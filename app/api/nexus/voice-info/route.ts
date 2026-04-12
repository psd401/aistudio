/**
 * Voice Info API Route
 *
 * HTTP endpoint for voice session information and health checks.
 * The actual voice streaming happens over WebSocket at /api/nexus/voice
 * (handled by server.ts). This route is at /api/nexus/voice-info to avoid
 * Next.js claiming the WebSocket upgrade path.
 *
 * GET /api/nexus/voice-info — Returns voice availability for the current user
 *
 * @deprecated Prefer /api/nexus/voice/availability which also returns a
 * human-readable `reason` string. This endpoint only returns { available }.
 * Kept for backward compatibility with existing consumers.
 * TODO(#898): Remove once all consumers have migrated to /api/nexus/voice/availability.
 *
 * **Breaking behavior changes from the original implementation:**
 * - Previously returned 403 when a user lacked voice-mode access; now returns
 *   200 with `{ available: false }` (via centralized getVoiceAvailability).
 * - Now also enforces the `VOICE_ENABLED` kill switch, which the original did not check.
 * Consumers that relied on 403 status to show role-specific UI messages should
 * migrate to /api/nexus/voice/availability which provides a `reason` field.
 *
 * Uses the centralized getVoiceAvailability() utility which checks:
 * 1. Global voice enabled setting (admin kill switch)
 * 2. User has voice-mode tool access (role-based permission)
 * 3. Voice provider and model are configured
 * 4. Google API key is present
 *
 * Issue #872, #873, #876
 */

import { NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { getVoiceAvailability } from "@/lib/voice/availability"

/**
 * GET handler — returns voice availability for authenticated users.
 * Clients use this to check availability before attempting WebSocket connection.
 */
export async function GET() {
  const requestId = generateRequestId()
  const log = createLogger({ requestId, route: "nexus.voice-info" })
  const timer = startTimer("nexus.voice-info")

  try {
    // Auth check
    const session = await getServerSession()
    if (!session) {
      timer({ status: "unauthorized" })
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Centralized availability check
    const result = await getVoiceAvailability(session.sub)

    log.info("Voice info requested", {
      available: result.available,
      reason: result.internalReason ?? result.reason,
    })

    timer({ status: "success" })
    // Only return availability — internal config (provider, model, wsEndpoint)
    // is not needed by the client and would expose infrastructure details
    return NextResponse.json(
      { available: result.available },
      { headers: { 'Cache-Control': 'max-age=30, private' } }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error("Error getting voice info", { error: message })
    timer({ status: "error" })
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
