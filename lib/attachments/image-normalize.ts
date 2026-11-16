/**
 * Turn whatever image a user attaches into one every Nexus vision model accepts.
 *
 * The four formats below are the intersection every provider we route to takes
 * inline (Bedrock Claude rejects anything else outright: "Unsupported image mime
 * type: image/heic, expected one of: image/jpeg, image/png, image/gif,
 * image/webp"; Bedrock GPT fails with "image format could not be determined").
 *
 * iPhone photos are HEIC by default. Before this module a HEIC fell through
 * `VisionImageAdapter` to assistant-ui's `SimpleImageAttachmentAdapter`
 * (`accept = "image/*"`), was inlined verbatim as `data:image/heic`, and — because
 * the client resends the whole history every turn — made every later turn of
 * that conversation fail too. Chrome cannot decode HEIC, so it is converted with
 * a lazily loaded WASM decoder (`heic-to`, ~3MB, fetched only when a HEIC is
 * attached). Other browser-decodable formats (BMP, AVIF, TIFF in Safari, ...) are
 * re-encoded through a canvas. Anything that cannot be converted is refused at
 * attach time with a message the user can act on, so it never reaches history.
 */

import { sniffImageFormat } from "@/lib/attachments/image-format";

/** JPEG quality used for every conversion. */
const CONVERTED_JPEG_QUALITY = 0.9;

/**
 * An attach-time failure whose message is written for the user and is safe to
 * show verbatim (the composer's error toast uses it as the description).
 */
export class ImageAttachmentRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageAttachmentRejectedError";
  }
}

export const IMAGE_REJECTION_MESSAGES = {
  heicConversionFailed:
    "This HEIC photo could not be converted. Export it as JPEG (in Photos or Preview) and attach it again.",
  svg:
    "SVG images can't be sent to the AI. Export it as PNG or JPEG and attach it again.",
  unsupported:
    "This image format isn't supported. Save it as JPEG or PNG and attach it again.",
  tooLarge: "This image is larger than 20MB. Use a smaller image.",
} as const;

const IMAGE_REJECTION_MESSAGE_SET: ReadonlySet<string> = new Set(
  Object.values(IMAGE_REJECTION_MESSAGES)
);

/**
 * True for a message this module wrote for the user. The composer's
 * attachment-error event carries only `error.message`, so this is how the toast
 * tells a user-facing rejection from an internal failure it should not echo.
 */
export function isImageRejectionMessage(message: string): boolean {
  return IMAGE_REJECTION_MESSAGE_SET.has(message);
}

/** Read the first `count` bytes of a blob. */
async function readHeader(blob: Blob, count: number): Promise<Uint8Array> {
  const buffer = await blob.slice(0, count).arrayBuffer();
  return new Uint8Array(buffer);
}

/** `photo.HEIC` → `photo.jpg`; a name without an extension gains one. */
export function toJpegFileName(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, "");
  return `${base || "image"}.jpg`;
}

async function decodeHeicToJpeg(file: File): Promise<Blob> {
  // Dynamic import keeps the ~3MB WASM decoder out of the Nexus bundle; it is
  // only fetched the first time someone attaches a HEIC.
  const { heicTo } = await import("heic-to");
  return heicTo({ blob: file, type: "image/jpeg", quality: CONVERTED_JPEG_QUALITY });
}

async function reencodeWithCanvas(file: File): Promise<Blob | null> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    return null;
  }
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    // JPEG has no alpha: paint white first so transparent pixels don't go black.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob | null>(resolve =>
      canvas.toBlob(resolve, "image/jpeg", CONVERTED_JPEG_QUALITY)
    );
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

export interface ImageConverters {
  heicToJpeg: (file: File) => Promise<Blob>;
  canvasToJpeg: (file: File) => Promise<Blob | null>;
}

const defaultConverters: ImageConverters = {
  heicToJpeg: decodeHeicToJpeg,
  canvasToJpeg: reencodeWithCanvas,
};

/**
 * Return `file` unchanged when its bytes are already a model-safe format;
 * otherwise a JPEG conversion. Throws {@link ImageAttachmentRejectedError} when
 * the image cannot be converted.
 */
export async function normalizeImageFile(
  file: File,
  converters: ImageConverters = defaultConverters
): Promise<File> {
  const format = sniffImageFormat(await readHeader(file, 16));

  if (format && format !== "heif") {
    // Bytes are fine. Make sure the declared type matches them — FileReader
    // builds the data URL from `file.type`, and the provider trusts that label.
    return file.type === format
      ? file
      : new File([file], file.name, { type: format, lastModified: file.lastModified });
  }

  const asJpeg = (blob: Blob) =>
    new File([blob], toJpegFileName(file.name), {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });

  const declared = file.type.toLowerCase();
  const looksHeif =
    format === "heif" ||
    declared.startsWith("image/heic") ||
    declared.startsWith("image/heif") ||
    /\.(heic|heif)$/i.test(file.name);

  if (looksHeif) {
    // Safari decodes HEIC natively; try the cheap path first.
    const viaCanvas = await converters.canvasToJpeg(file);
    if (viaCanvas) return asJpeg(viaCanvas);
    try {
      return asJpeg(await converters.heicToJpeg(file));
    } catch {
      throw new ImageAttachmentRejectedError(IMAGE_REJECTION_MESSAGES.heicConversionFailed);
    }
  }

  if (declared === "image/svg+xml" || /\.svg$/i.test(file.name)) {
    throw new ImageAttachmentRejectedError(IMAGE_REJECTION_MESSAGES.svg);
  }

  const viaCanvas = await converters.canvasToJpeg(file);
  if (viaCanvas) return asJpeg(viaCanvas);
  throw new ImageAttachmentRejectedError(IMAGE_REJECTION_MESSAGES.unsupported);
}
