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
 * - /api/nexus/voice/availability (HTTP availability check for client)
 * - WebSocket proxy (authorize connection)
 *
 * Issue #876
 */

import { Settings } from "@/lib/settings-manager"
import { hasToolAccess } from "@/lib/db/drizzle/users"
import { isSupportedVoiceProvider } from "./provider-factory"

/** Categorizes the type of unavailability for downstream close-code decisions */
export type UnavailabilityType = "permission" | "config" | "error"

export interface VoiceAvailabilityResult {
  /** Whether voice mode is available for this user */
  available: boolean
  /** Human-readable reason when voice is not available (safe for client display) */
  reason?: string
  /** Detailed internal reason for server-side logging only (may contain config details) */
  internalReason?: string
  /** Category of failure — "permission" for user/admin issues, "config" for server-side issues */
  type?: UnavailabilityType
  /**
   * Validated voice config — only present when available is true.
   * Returned so callers (e.g., ws-handler) can reuse the validated settings
   * without re-fetching from cache, avoiding a TOCTOU window.
   */
  config?: {
    provider: string
    model: string
    language: string
    voiceName: string | null
    apiKey: string
  }
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
    return { available: false, reason: "Voice mode is disabled by administrator", type: "permission" }
  }

  // 2. Check user has voice-mode permission
  const hasAccess = await hasToolAccess(cognitoSub, "voice-mode")
  if (!hasAccess) {
    return { available: false, reason: "Voice mode is not enabled for your role", type: "permission" }
  }

  // 3. Check provider and model are configured and provider is supported
  if (!voiceSettings.provider || !voiceSettings.model || !isSupportedVoiceProvider(voiceSettings.provider)) {
    return {
      available: false,
      reason: "Voice mode is not currently available",
      internalReason: "Voice provider not configured or unsupported",
      type: "config",
    }
  }

  // 4. Check API key is configured
  const googleApiKey = await Settings.getGoogleAI()
  if (!googleApiKey) {
    return {
      available: false,
      reason: "Voice mode is not currently available",
      internalReason: "Voice provider API key not configured",
      type: "config",
    }
  }

  return {
    available: true,
    config: {
      provider: voiceSettings.provider,
      model: voiceSettings.model,
      language: voiceSettings.language,
      voiceName: voiceSettings.voiceName,
      apiKey: googleApiKey,
    },
  }
}
