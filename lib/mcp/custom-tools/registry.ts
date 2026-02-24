/**
 * Custom Tool Provider Registry
 *
 * Dispatches to provider-specific modules based on the connector URL.
 * When a connector has toolSource === "custom", this module resolves the
 * correct provider and returns its tool definitions.
 */

import type { ToolSet } from "ai"
import type { CustomToolProvider } from "./types"
import { canvaProvider } from "./canva"

/** Registered custom tool providers — add new providers here */
const providers: CustomToolProvider[] = [canvaProvider]

/**
 * Loads custom tools for a connector based on its URL.
 * Matches the URL against registered provider patterns.
 *
 * @throws Error if no provider matches the URL
 */
export function loadCustomTools(serverUrl: string, accessToken: string): ToolSet {
  const provider = providers.find((p) =>
    p.urlPatterns.some((pattern) => pattern.test(serverUrl))
  )

  if (!provider) {
    throw new Error(
      `No custom tool provider found for URL: ${serverUrl}. ` +
        `Registered providers: ${providers.map((p) => p.key).join(", ")}`
    )
  }

  return provider.buildTools(accessToken)
}
