/**
 * Shared image data URI validation utilities.
 *
 * Used by tool UI components (code-interpreter-ui, connector-tool-ui) to
 * validate AI-generated image data URIs before rendering. Centralised here
 * to prevent allowlist drift between consumers.
 */

/** MIME types considered safe for rendering in <img> / <Image> elements. */
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

const MAX_PLOT_BASE64_LENGTH = 5 * 1024 * 1024 // 5MB

/** Returns true if `data` is a safe, reasonably-sized image data URI for plot output. */
export function isSafePlotData(data: string): boolean {
  if (!data || data.length > MAX_PLOT_BASE64_LENGTH) return false
  if (!data.startsWith('data:')) return false
  const semiIdx = data.indexOf(';')
  if (semiIdx === -1) return false
  const declaredMime = data.slice(5, semiIdx)
  return SAFE_PLOT_MIME_TYPES.has(declaredMime)
}
