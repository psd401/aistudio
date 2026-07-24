/** Strict raster inspection and metadata-stripping normalization (#1284). */

import { createHash } from "node:crypto";
import sharp from "sharp";
import { ValidationError } from "./errors";

export const CONTENT_ASSET_MAX_BYTES = 20 * 1024 * 1024;
export const CONTENT_ASSET_MAX_DIMENSION = 12_000;
export const CONTENT_ASSET_MAX_PIXELS = 40_000_000;
export const CONTENT_ASSET_PROCESSOR_VERSION = "atrium-image-normalize-v1";

export const CONTENT_ASSET_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
export type ContentAssetContentType = (typeof CONTENT_ASSET_TYPES)[number];

export interface NormalizedContentAsset {
  bytes: Uint8Array;
  contentType: ContentAssetContentType;
  width: number;
  height: number;
  sha256: string;
}

export function isContentAssetContentType(
  value: string
): value is ContentAssetContentType {
  return CONTENT_ASSET_TYPES.includes(value as ContentAssetContentType);
}

function mimeForFormat(format: string | undefined): ContentAssetContentType {
  switch (format) {
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      throw new ValidationError("Asset signature is not PNG, JPEG, or WebP", {
        rejectionCode: "UNSUPPORTED_SIGNATURE",
      });
  }
}

function displayDimensions(
  width: number,
  height: number,
  orientation: number | undefined
): { width: number; height: number } {
  return orientation && orientation >= 5 && orientation <= 8
    ? { width: height, height: width }
    : { width, height };
}

export async function normalizeContentAsset(input: {
  source: Uint8Array;
  declaredContentType: ContentAssetContentType;
  declaredWidth?: number;
  declaredHeight?: number;
}): Promise<NormalizedContentAsset> {
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(input.source, {
      failOn: "error",
      limitInputPixels: CONTENT_ASSET_MAX_PIXELS,
      pages: 1,
    }).metadata();
  } catch {
    throw new ValidationError("Asset is not a decodable bounded raster image", {
      rejectionCode: "IMAGE_DECODE_FAILED",
    });
  }

  const detectedContentType = mimeForFormat(metadata.format);
  if (detectedContentType !== input.declaredContentType) {
    throw new ValidationError("Asset MIME type does not match its byte signature", {
      rejectionCode: "MIME_SIGNATURE_MISMATCH",
    });
  }
  if (!metadata.width || !metadata.height) {
    throw new ValidationError("Asset has no valid pixel dimensions", {
      rejectionCode: "INVALID_DIMENSIONS",
    });
  }
  if ((metadata.pages ?? 1) !== 1) {
    throw new ValidationError("Animated or multi-page images are not supported", {
      rejectionCode: "MULTI_FRAME_IMAGE",
    });
  }
  const dimensions = displayDimensions(
    metadata.width,
    metadata.height,
    metadata.orientation
  );
  if (
    dimensions.width > CONTENT_ASSET_MAX_DIMENSION ||
    dimensions.height > CONTENT_ASSET_MAX_DIMENSION ||
    dimensions.width * dimensions.height > CONTENT_ASSET_MAX_PIXELS
  ) {
    throw new ValidationError("Asset dimensions exceed the safe pixel limit", {
      rejectionCode: "PIXEL_LIMIT_EXCEEDED",
    });
  }
  if (
    (input.declaredWidth !== undefined &&
      input.declaredWidth !== dimensions.width) ||
    (input.declaredHeight !== undefined &&
      input.declaredHeight !== dimensions.height)
  ) {
    throw new ValidationError(
      "Declared asset dimensions do not match decoded pixels",
      { rejectionCode: "DIMENSION_MISMATCH" }
    );
  }

  // sharp strips EXIF/XMP/IPTC and other metadata unless keepMetadata/withMetadata
  // is requested. rotate() applies orientation to pixels before that metadata is
  // discarded, yielding one safe, deterministic display orientation.
  let pipeline = sharp(input.source, {
    failOn: "error",
    limitInputPixels: CONTENT_ASSET_MAX_PIXELS,
    pages: 1,
  }).rotate();
  if (detectedContentType === "image/jpeg") {
    pipeline = pipeline
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 92, progressive: true, mozjpeg: true });
  } else if (detectedContentType === "image/png") {
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
  } else {
    pipeline = pipeline.webp({ quality: 92, effort: 5 });
  }
  const bytes = await pipeline.toBuffer();
  if (bytes.byteLength > CONTENT_ASSET_MAX_BYTES) {
    throw new ValidationError("Normalized asset exceeds the byte limit", {
      rejectionCode: "NORMALIZED_BYTE_LIMIT_EXCEEDED",
    });
  }
  return {
    bytes,
    contentType: detectedContentType,
    width: dimensions.width,
    height: dimensions.height,
    sha256: createHash("sha256").update(bytes).digest("base64url"),
  };
}
