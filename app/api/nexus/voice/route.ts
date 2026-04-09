/**
 * Voice API Route
 *
 * HTTP endpoint for voice session information and health checks.
 * The actual voice streaming happens over WebSocket (handled by server.ts).
 *
 * GET /api/nexus/voice — Returns voice configuration and connection info
 *
 * Issue #872
 */

import { NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { Settings } from "@/lib/settings-manager"
import { hasToolAccess } from "@/utils/roles"

/**
 * GET handler — returns voice configuration for authenticated users.
 * Clients use this to check availability before attempting WebSocket connection.
 */
export async function GET() {
  const requestId = generateRequestId()
  const log = createLogger({ requestId, route: "nexus.voice" })
  const timer = startTimer("nexus.voice.info")

  try {
    // Auth check
    const session = await getServerSession()
    if (!session) {
      timer({ status: "unauthorized" })
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Tool access check
    const hasAccess = await hasToolAccess("voice-mode")
    if (!hasAccess) {
      timer({ status: "forbidden" })
      return NextResponse.json({ error: "Voice mode not enabled" }, { status: 403 })
    }

    // Get voice settings
    const voiceSettings = await Settings.getVoice()

    // Check if the provider is configured (Google API key exists)
    const googleApiKey = await Settings.getGoogleAI()
    const isConfigured = !!googleApiKey

    log.info("Voice info requested", {
      provider: voiceSettings.provider,
      isConfigured,
    })

    timer({ status: "success" })
    return NextResponse.json({
      available: isConfigured,
      provider: voiceSettings.provider,
      model: voiceSettings.model,
      language: voiceSettings.language,
      // WebSocket endpoint for clients to connect to
      wsEndpoint: "/api/nexus/voice",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error("Error getting voice info", { error: message })
    timer({ status: "error" })
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
