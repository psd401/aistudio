/**
 * Keep an image no model can read from failing every turn of a conversation.
 *
 * The client resends the whole history each turn. Before attach-time conversion
 * existed, an iPhone HEIC was inlined as `data:image/heic;base64,...`; Bedrock
 * Claude then rejected EVERY later request in that conversation ("Unsupported
 * image mime type: image/heic") and Bedrock GPT failed with "image format could
 * not be determined". The client no longer produces such parts, but existing
 * conversations still carry them, and a stale tab could still send one.
 *
 * This swaps each inline image part whose bytes are not one of the four
 * universally accepted formats for a short text note, in the copy sent to the
 * MODEL only — persistence keeps the original part. Decided from the bytes, not
 * the label: assistant-ui labels every image part `image/png` regardless.
 */
import { MODEL_SAFE_IMAGE_MIME_TYPES, sniffImageFormat } from "@/lib/attachments/image-format";

/**
 * What the model sees in place of an image it could not have read. Format only:
 * the filename is user-chosen (it can name a student) and a provider image block
 * never carries it (Bedrock image blocks are format + bytes), so the note must
 * not be what sends it.
 */
export function unsupportedImageNote(format: string): string {
  return `[The user attached an image in ${format} format, which could not be sent to the model. Ask them to re-attach it as JPEG or PNG if it matters.]`;
}

/**
 * First bytes of a base64 data URL payload, or null when `url` isn't one.
 * Only base64 data URLs are inspected: the composer builds image parts with
 * FileReader.readAsDataURL, which always emits base64. A percent-encoded image
 * data URL would pass through unguarded.
 */
function dataUrlHeader(url: string): { declared: string; header: Uint8Array } | null {
  if (url.slice(0, 5).toLowerCase() !== "data:") return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  // "data:<type>[;param]*;base64," — split by hand (no regex over a multi-MB URL).
  const [declared = "", ...params] = url.slice(5, comma).split(";");
  if (!params.some((param) => param.toLowerCase() === "base64")) return null;
  // 24 base64 chars decode to the first 18 bytes — enough for every signature.
  const head = url.slice(comma + 1, comma + 1 + 24);
  try {
    return { declared: declared.toLowerCase(), header: new Uint8Array(Buffer.from(head, "base64")) };
  } catch {
    return null;
  }
}

/** Human label for the note: "HEIC", "BMP", ... from the data URL's type. */
function formatLabel(declared: string, sniffed: string | null): string {
  if (sniffed === "heif") return "HEIC";
  const subtype = declared.split("/")[1];
  return subtype ? subtype.toUpperCase() : "an unsupported";
}

interface ReplaceResult<T> {
  messages: T[];
  replaced: number;
}

/**
 * Return `messages` with every unreadable inline image part replaced by a text
 * note. Messages without such a part are returned as the same object.
 */
export function replaceUnsupportedImageParts<T>(messages: readonly T[]): ReplaceResult<T> {
  let replaced = 0;
  const out = messages.map((message) => {
    const record = message as unknown as { parts?: unknown };
    if (!record || !Array.isArray(record.parts)) return message;

    let changed = false;
    const parts = record.parts.map((part: unknown) => {
      if (!part || typeof part !== "object") return part;
      const p = part as {
        type?: unknown;
        url?: unknown;
        image?: unknown;
        mediaType?: unknown;
      };
      // AI SDK `file` parts carry the data URL in `url`; legacy assistant-ui
      // `image` parts carry it in `image`.
      const url =
        p.type === "file" ? p.url : p.type === "image" ? p.image : undefined;
      if (typeof url !== "string") return part;
      const parsed = dataUrlHeader(url);
      if (!parsed) return part;
      const isImage =
        p.type === "image" ||
        parsed.declared.startsWith("image/") ||
        (typeof p.mediaType === "string" && p.mediaType.startsWith("image/"));
      if (!isImage) return part;

      const sniffed = sniffImageFormat(parsed.header);
      if (sniffed && MODEL_SAFE_IMAGE_MIME_TYPES.has(sniffed)) return part;

      changed = true;
      replaced += 1;
      return {
        type: "text",
        text: unsupportedImageNote(formatLabel(parsed.declared, sniffed)),
      };
    });

    return changed ? ({ ...(message as object), parts } as T) : message;
  });
  return { messages: out, replaced };
}
