/**
 * Voice Provider Factory
 *
 * Creates voice provider instances by provider ID.
 * Mirrors the pattern in /lib/ai/provider-factory.ts.
 *
 * Issue #872
 */

import type { VoiceProvider } from "./types"
import { GeminiLiveProvider } from "./gemini-live-provider"

const SUPPORTED_PROVIDERS = ["gemini-live"] as const
export type SupportedVoiceProvider = (typeof SUPPORTED_PROVIDERS)[number]

/**
 * Create a voice provider instance by provider ID.
 *
 * @param providerId - The provider identifier (e.g. 'gemini-live')
 * @returns A new VoiceProvider instance
 * @throws If the provider is not supported
 */
export function createVoiceProvider(providerId: string): VoiceProvider {
  const normalized = providerId.toLowerCase()

  switch (normalized) {
    case "gemini-live":
      return new GeminiLiveProvider()
    default:
      throw new Error(
        `Unsupported voice provider: '${providerId}'. Supported: ${SUPPORTED_PROVIDERS.join(", ")}`
      )
  }
}

/**
 * Check if a voice provider is supported.
 */
export function isSupportedVoiceProvider(providerId: string): boolean {
  return SUPPORTED_PROVIDERS.includes(providerId.toLowerCase() as SupportedVoiceProvider)
}

/**
 * Get list of supported voice provider IDs.
 */
export function getSupportedVoiceProviders(): readonly string[] {
  return SUPPORTED_PROVIDERS
}
