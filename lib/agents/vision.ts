/**
 * Agentic image / vision input handling (Issue #926).
 *
 * Lets an agentic Assistant Architect accept image inputs and pass them to
 * vision-capable models: form input values that are images (data:image URIs or
 * http(s) image URLs) are converted to AI SDK file message parts and attached to
 * the initial user message. The author is responsible for selecting a
 * vision-capable model (the platform has no per-model `vision` capability flag to
 * gate on); non-image inputs are untouched.
 *
 * Pure + dependency-free so it is unit-testable and safe in any bundle.
 */

/** An AI SDK v6 file message part (the shape `convertToModelMessages` accepts). */
export interface ImageFilePart {
  type: "file";
  mediaType: string;
  url: string;
}

/** Cap on image parts attached to one run (guards against abuse / huge prompts). */
const MAX_IMAGE_PARTS = 10;

const EXT_TO_MEDIA_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

/**
 * Detect whether an input value is an image and, if so, return the file part for
 * it. Recognizes base64 `data:image/...` URIs and http(s) URLs with an image
 * extension. Returns null for anything else.
 */
export function detectImageInput(value: unknown): ImageFilePart | null {
  if (typeof value !== "string") return null;
  const url = value.trim();

  const dataUri = url.match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
  if (dataUri) {
    return { type: "file", mediaType: dataUri[1].toLowerCase(), url };
  }

  // Parse with URL rather than a regex (avoids ReDoS): only http(s), and the
  // pathname's final extension must be a known image type. The query string is
  // in `search`, so it never affects the extension check.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const ext = parsed.pathname.split(".").pop()?.toLowerCase() ?? "";
  // Direct lookup (not `ext in obj`) so an inherited key like "toString" can't
  // false-match a path ending in ".toString".
  const mediaType = Object.prototype.hasOwnProperty.call(EXT_TO_MEDIA_TYPE, ext)
    ? EXT_TO_MEDIA_TYPE[ext]
    : undefined;
  if (mediaType) {
    return { type: "file", mediaType, url };
  }

  return null;
}

/**
 * Extract AI SDK file parts for every image-valued entry in the form inputs,
 * capped at {@link MAX_IMAGE_PARTS}. Order follows the inputs' iteration order.
 */
export function extractImageInputParts(
  inputs: Record<string, unknown>
): ImageFilePart[] {
  const parts: ImageFilePart[] = [];
  for (const value of Object.values(inputs)) {
    const part = detectImageInput(value);
    if (part) {
      parts.push(part);
      if (parts.length >= MAX_IMAGE_PARTS) break;
    }
  }
  return parts;
}
