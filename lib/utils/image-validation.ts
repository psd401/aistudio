/**
 * Shared image validation utilities.
 *
 * Used by tool UI components (connector-tool-ui) to validate AI-generated
 * image data URIs before rendering, and by the Model Compare feature to
 * validate S3 presigned URLs before emitting them to the client. Centralised
 * here to prevent allowlist drift between server and client consumers.
 */

/**
 * Validate that a URL from an AI image generation response is a legitimate
 * HTTPS S3 URL before rendering in <img> / <a> tags.
 *
 * Guards against a compromised upstream provider returning a `javascript:`
 * URI or `http:` URL that could be exploited when rendered in the browser.
 * Must be kept in sync with the server-side check in app/api/compare/route.ts.
 */
export function isSafeImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname.endsWith('.amazonaws.com')
  } catch {
    return false
  }
}


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
