/**
 * Voice Info API Route
 *
 * HTTP endpoint for voice session information and health checks.
 * The actual voice streaming happens over WebSocket at /api/nexus/voice
 * (handled by server.ts). This route is at /api/nexus/voice-info to avoid
 * Next.js claiming the WebSocket upgrade path.
 *
 * GET /api/nexus/voice-info — Returns voice configuration and availability
 *
 * Issue #872, #873
 */

import { NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { Settings } from "@/lib/settings-manager"
import { hasToolAccess } from "@/lib/db/drizzle/users"

/**
 * GET handler — returns voice configuration for authenticated users.
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

    // Tool access check
    const hasAccess = await hasToolAccess(session.sub, "voice-mode")
    if (!hasAccess) {
      timer({ status: "forbidden" })
      return NextResponse.json({ error: "Voice mode not enabled" }, { status: 403 })
    }

    // Get voice settings
    const voiceSettings = await Settings.getVoice()

    // Voice is available only when provider, model, and API key are all configured
    const googleApiKey = await Settings.getGoogleAI()
    const isConfigured = !!googleApiKey && !!voiceSettings.provider && !!voiceSettings.model

    log.info("Voice info requested", {
      provider: voiceSettings.provider,
      model: voiceSettings.model,
      isConfigured,
    })

    timer({ status: "success" })
    // Only return availability — internal config (provider, model, wsEndpoint)
    // is not needed by the client and would expose infrastructure details
    return NextResponse.json({ available: isConfigured })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error("Error getting voice info", { error: message })
    timer({ status: "error" })
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
