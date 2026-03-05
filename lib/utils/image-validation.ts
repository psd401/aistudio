/**
 * Shared image data URI validation utilities.
 *
 * Used by tool UI components (connector-tool-ui) to
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

/** Maximum base64 string length for image data URIs (~3.75MB decoded). */
export const MAX_IMAGE_BASE64_LENGTH = 5 * 1024 * 1024 // 5MB base64 string length
