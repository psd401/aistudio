/**
 * Shrink a chat photo before it is inlined into the Nexus request (#1850).
 *
 * The standard chat route hands the model the image's inline data URL, and the
 * AI SDK resends the whole history every turn. A phone photo is 5-10MB, ~33%
 * more as base64, so one or two photos pushed the request past the 10MB body
 * limit Next.js applies to proxied routes and the turn failed with a JSON parse
 * error. Vision models downscale large images anyway (Claude ~1568px, GPT
 * ~2048px), so sending more pixels than this buys nothing.
 *
 * Every failure path returns the original data URL: shrinking is an
 * optimization, never a reason to lose the attachment.
 */

/** Longest edge, in pixels, an image is scaled down to. */
export const MAX_IMAGE_EDGE_PX = 2048;

/** Images at or under both limits are sent untouched. */
export const MAX_UNTOUCHED_IMAGE_BYTES = 1_500_000;

const JPEG_QUALITY = 0.85;

export interface DownscalePlan {
  width: number;
  height: number;
  mimeType: "image/jpeg" | "image/png";
}

/**
 * What to re-encode to, or null to send the original. Pure, so the rules are
 * testable without a canvas.
 */
export function planImageDownscale(input: {
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
}): DownscalePlan | null {
  const { width, height, bytes, mimeType } = input;
  // Animated GIFs would lose their animation on a canvas round-trip.
  if (mimeType === "image/gif") return null;
  if (!(width > 0) || !(height > 0)) return null;

  const longest = Math.max(width, height);
  if (longest <= MAX_IMAGE_EDGE_PX && bytes <= MAX_UNTOUCHED_IMAGE_BYTES) return null;

  const scale = Math.min(1, MAX_IMAGE_EDGE_PX / longest);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    // PNG may carry transparency that JPEG would flatten to black.
    mimeType: mimeType === "image/png" ? "image/png" : "image/jpeg",
  };
}

/**
 * The data URL to send for `file`: a downscaled re-encode when that is smaller,
 * otherwise `originalDataUrl`.
 */
export async function downscaleImageDataUrl(
  file: File,
  originalDataUrl: string
): Promise<string> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    return originalDataUrl;
  }

  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    const plan = planImageDownscale({
      width: bitmap.width,
      height: bitmap.height,
      bytes: file.size,
      mimeType: file.type,
    });
    if (!plan) return originalDataUrl;

    const canvas = document.createElement("canvas");
    canvas.width = plan.width;
    canvas.height = plan.height;
    const context = canvas.getContext("2d");
    if (!context) return originalDataUrl;
    context.drawImage(bitmap, 0, 0, plan.width, plan.height);

    const reencoded = canvas.toDataURL(
      plan.mimeType,
      plan.mimeType === "image/jpeg" ? JPEG_QUALITY : undefined
    );
    // toDataURL silently falls back to PNG for unsupported types, and a small
    // image can grow when re-encoded; only ever send the smaller of the two.
    if (!reencoded.startsWith(`data:${plan.mimeType}`)) return originalDataUrl;
    return reencoded.length < originalDataUrl.length ? reencoded : originalDataUrl;
  } catch {
    return originalDataUrl;
  } finally {
    bitmap?.close();
  }
}

/** The media type a data URL declares, e.g. "image/jpeg". */
export function dataUrlMediaType(dataUrl: string): string | null {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
  return match ? match[1] : null;
}
