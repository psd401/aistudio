/**
 * Voice Mode Availability Check
 *
 * Centralized utility that combines all voice availability checks:
 * 1. Global voice enabled setting (admin kill switch)
 * 2. User has voice-mode tool access (role-based permission)
 * 3. Voice provider and model are configured
 * 4. Google API key is present
 *
 * Used by:
 * - /api/nexus/voice-info (HTTP availability check for client)
 * - WebSocket proxy (authorize connection)
 * - Admin settings (show status)
 *
 * Issue #876
 */

import { Settings } from "@/lib/settings-manager"
import { hasToolAccess } from "@/lib/db/drizzle/users"

export interface VoiceAvailabilityResult {
  /** Whether voice mode is available for this user */
  available: boolean
  /** Human-readable reason when voice is not available */
  reason?: string
}

/**
 * Check voice mode availability for a specific user.
 *
 * @param cognitoSub - The user's Cognito sub identifier
 * @returns Availability result with optional reason string
 */
export async function getVoiceAvailability(cognitoSub: string): Promise<VoiceAvailabilityResult> {
  // 1. Check global voice enabled setting
  const voiceSettings = await Settings.getVoice()
  if (!voiceSettings.enabled) {
    return { available: false, reason: "Voice mode is disabled by administrator" }
  }

  // 2. Check user has voice-mode permission
  const hasAccess = await hasToolAccess(cognitoSub, "voice-mode")
  if (!hasAccess) {
    return { available: false, reason: "Voice mode is not enabled for your role" }
  }

  // 3. Check provider and model are configured
  if (!voiceSettings.provider || !voiceSettings.model) {
    return { available: false, reason: "Voice provider not configured" }
  }

  // 4. Check API key is configured
  const googleApiKey = await Settings.getGoogleAI()
  if (!googleApiKey) {
    return { available: false, reason: "Voice provider API key not configured" }
  }

  return { available: true }
}
