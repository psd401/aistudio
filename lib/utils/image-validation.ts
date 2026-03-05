/**
 * Shared image data URI validation utilities.
 *
 * Used by tool UI components (multi-provider-tools, connector-tool-ui) to
 * validate AI-generated image data URIs before rendering. Centralised here
 * to prevent allowlist drift between consumers.
 */

/**
 * MIME types considered safe for rendering in <img> / <Image> elements.
 *
 * WARNING: `image/svg+xml` is safe only for <img src> rendering (browser sandboxes scripts
 * in that context). Do NOT use this set for CSS backgrounds, <object>, or <embed> tags —
 * SVG can execute scripts in those contexts.
 */
export const SAFE_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
])

/** Subset of SAFE_IMAGE_MIME_TYPES suitable for AI-generated plot output (no SVG). */
export const SAFE_PLOT_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

/** Maximum base64 string length for image data URIs (~3.75MB decoded). */
export const MAX_IMAGE_BASE64_LENGTH = 5 * 1024 * 1024 // 5MB base64 string length

// Alias used internally by isSafePlotData — same limit applies to plot output.
const MAX_PLOT_BASE64_LENGTH = MAX_IMAGE_BASE64_LENGTH

/**
 * Returns true if `data` is a safe, reasonably-sized image data URI for plot output.
 *
 * Note: the MIME type is self-reported by the data URI; actual content validation is
 * delegated to the browser when the URI is used in an <img> src (scripts in SVG are
 * sandboxed in that context). The 5MB cap is on the base64 string length (~3.75MB decoded).
 */
export function isSafePlotData(data: string): boolean {
  if (!data || data.length > MAX_PLOT_BASE64_LENGTH) return false
  if (!data.startsWith('data:')) return false
  const semiIdx = data.indexOf(';')
  if (semiIdx === -1) return false
  const declaredMime = data.slice(5, semiIdx)
  return SAFE_PLOT_MIME_TYPES.has(declaredMime)
}
