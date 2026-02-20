/**
 * OAuth Popup Utility for MCP Connector Authentication
 *
 * Opens a popup window to the OAuth authorize endpoint, listens for
 * postMessage completion from the callback page, and resolves a promise
 * on success or rejects on failure/timeout.
 *
 * Usage:
 *   const result = await openOAuthPopup(serverId)
 *   // result.success === true → tokens stored, connector ready
 *
 * Part of Epic #774 — Nexus MCP Connectors
 * Issue #779
 */

/** Result shape from the OAuth callback postMessage */
export interface OAuthPopupResult {
  success: boolean
  serverId: string
  error: string | null
}

/** Options for the OAuth popup */
interface OAuthPopupOptions {
  /** Timeout in milliseconds before the popup is considered failed (default: 5 minutes) */
  timeoutMs?: number
  /** Popup window dimensions */
  width?: number
  height?: number
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_WIDTH = 600
const DEFAULT_HEIGHT = 700

/**
 * Opens an OAuth popup for the given MCP server and waits for completion.
 *
 * Flow:
 * 1. Calls /api/connectors/mcp-auth/initiate?serverId=<id> to get the authorization URL
 * 2. Opens the URL in a centered popup window
 * 3. Listens for postMessage from the callback page
 * 4. Resolves with the result (success/failure)
 *
 * @throws Error if the authorize endpoint fails or the popup is blocked
 */
export async function openOAuthPopup(
  serverId: string,
  options: OAuthPopupOptions = {}
): Promise<OAuthPopupResult> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
  } = options

  // 1. Get authorization URL from server (MCP-native OAuth flow)
  const response = await fetch(
    `/api/connectors/mcp-auth/initiate?serverId=${encodeURIComponent(serverId)}`
  )

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "Unknown error" }))
    throw new Error(
      (body as { error?: string }).error ?? `Failed to start OAuth flow (${response.status})`
    )
  }

  const data = (await response.json()) as { url?: string; authorized?: boolean }

  // If already authorized (tokens still valid), return success immediately
  if (data.authorized) {
    return {
      success: true,
      serverId,
      error: null,
    }
  }

  const url = data.url
  if (!url) {
    throw new Error("No authorization URL returned from server")
  }

  // 2. Open centered popup
  const left = Math.round(window.screenX + (window.outerWidth - width) / 2)
  const top = Math.round(window.screenY + (window.outerHeight - height) / 2)

  const popup = window.open(
    url,
    "mcp-oauth-popup",
    // noopener=no: popup intentionally needs window.opener for postMessage back to parent.
    // Mitigation: parent validates event.origin before acting on messages (line ~107).
    `width=${width},height=${height},left=${left},top=${top},popup=yes,noopener=no`
  )

  if (!popup) {
    throw new Error(
      "Popup was blocked by the browser. Please allow popups for this site."
    )
  }

  // 3. Listen for postMessage with origin validation
  return new Promise<OAuthPopupResult>((resolve, reject) => {
    const expectedOrigin = window.location.origin
    let settled = false

    function cleanup() {
      window.removeEventListener("message", onMessage)
      clearTimeout(timer)
      clearInterval(pollClosed)
    }

    function settle(result: OAuthPopupResult) {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    function onMessage(event: MessageEvent) {
      // Origin validation — only accept messages from our own origin
      if (event.origin !== expectedOrigin) return

      // Parse the message data
      let data: { type?: string; success?: boolean; serverId?: string; error?: string | null }
      try {
        data = typeof event.data === "string" ? JSON.parse(event.data) : event.data
      } catch {
        return // Not our message
      }

      if (data.type !== "mcp-oauth-callback") return
      // Accept error messages with empty serverId (cookie not yet parsed in early error paths)
      if (data.serverId !== serverId && !(data.success === false && !data.serverId)) return

      settle({
        success: Boolean(data.success),
        serverId: data.serverId ?? serverId,
        error: data.error ?? null,
      })
    }

    window.addEventListener("message", onMessage)

    // 4. Timeout
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      try { popup.close() } catch { /* cross-origin close may fail */ }
      reject(new Error("OAuth flow timed out. Please try again."))
    }, timeoutMs)

    // 5. Poll for popup closed (user closed manually)
    const pollClosed = setInterval(() => {
      try {
        if (popup.closed && !settled) {
          settled = true
          cleanup()
          reject(new Error("OAuth popup was closed before completing."))
        }
      } catch {
        // Cross-origin access to popup.closed may throw — ignore
      }
    }, 500)
  })
}
