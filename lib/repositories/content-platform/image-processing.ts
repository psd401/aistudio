import { createHash } from "node:crypto";
import sharp from "sharp";
import type {
  RepositorySourceLocator,
  RepositorySourceRegion,
} from "@/lib/db/schema";
import { countRepositoryTokens } from "./token-segmentation";

export const IMAGE_PROCESSOR_VERSION = "image-normalize-v2";

export const IMAGE_CONTENT_TYPES = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  tiff: "image/tiff",
} as const;

export type ImageContentType =
  (typeof IMAGE_CONTENT_TYPES)[keyof typeof IMAGE_CONTENT_TYPES];

export interface PreparedRepositoryImage {
  detectedContentType: ImageContentType;
  width: number;
  height: number;
  frameCount: number;
  hasAlpha: boolean;
  sourceSha256: string;
  thumbnail: Uint8Array;
  thumbnailSha256: string;
  captionImage: Uint8Array;
  ocrImage: Uint8Array;
  metadata: Record<string, unknown>;
}

export interface ImageOcrLine {
  text: string;
  region?: RepositorySourceRegion;
}

export interface ImageSearchSegment {
  content: string;
  contentHash: string;
  chunkIndex: number;
  tokens: number;
  modality: "image";
  sourceLocator: RepositorySourceLocator;
  contextPrefix: string;
  segmentLevel: "section" | "chunk";
  parentChunkIndex?: number;
}

export interface ImageSearchDocument {
  canonicalText: string;
  segments: ImageSearchSegment[];
  ocrText: string;
  ocrRegions: RepositorySourceRegion[];
}

const MAX_INPUT_PIXELS = 100_000_000;
const THUMBNAIL_DIMENSION = 1_024;
const CAPTION_DIMENSION = 2_048;
const CAPTION_MAX_BYTES = 4_500_000;
const OCR_DIMENSION = 6_000;
const TEXTRACT_IMAGE_MAX_BYTES = 9_500_000;
const MAX_SEGMENT_CHARACTERS = 2_000;
const MAX_REGIONS_PER_SEGMENT = 100;

const FULL_IMAGE_REGION: RepositorySourceRegion = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
};

export function isImageContentType(
  contentType: string
): contentType is ImageContentType {
  return Object.values(IMAGE_CONTENT_TYPES).includes(
    contentType as ImageContentType
  );
}

function contentTypeForSharpFormat(format: string | undefined): ImageContentType {
  switch (format) {
    case "jpeg":
      return IMAGE_CONTENT_TYPES.jpeg;
    case "png":
      return IMAGE_CONTENT_TYPES.png;
    case "webp":
      return IMAGE_CONTENT_TYPES.webp;
    case "gif":
      return IMAGE_CONTENT_TYPES.gif;
    case "tiff":
      return IMAGE_CONTENT_TYPES.tiff;
    default:
      throw new Error("Image source uses an unsupported or unrecognized format");
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

function imagePipeline(source: Uint8Array) {
  return sharp(source, {
    failOn: "error",
    limitInputPixels: MAX_INPUT_PIXELS,
    page: 0,
    pages: 1,
  })
    .rotate()
    .flatten({ background: "#ffffff" });
}

async function boundedJpeg(
  source: Uint8Array,
  attempts: ReadonlyArray<{ dimension: number; quality: number }>,
  maximumBytes: number
): Promise<Uint8Array> {
  for (const attempt of attempts) {
    const result = await imagePipeline(source)
      .resize({
        width: attempt.dimension,
        height: attempt.dimension,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: attempt.quality, progressive: true })
      .toBuffer();
    if (result.byteLength <= maximumBytes) return result;
  }
  throw new Error(
    `Image derivative could not be bounded below ${maximumBytes} bytes`
  );
}

/**
 * Inspect source bytes with libvips and create deterministic, single-frame JPEG
 * derivatives for Nova captioning, Textract OCR, and repository previews.
 */
export async function prepareRepositoryImage(
  source: Uint8Array,
  declaredContentType: string
): Promise<PreparedRepositoryImage> {
  if (!isImageContentType(declaredContentType)) {
    throw new Error("The declared image content type is not supported");
  }
  const metadata = await sharp(source, {
    failOn: "error",
    limitInputPixels: MAX_INPUT_PIXELS,
  }).metadata();
  const detectedContentType = contentTypeForSharpFormat(metadata.format);
  if (detectedContentType !== declaredContentType) {
    throw new Error(
      `Image signature ${detectedContentType} does not match declared type ${declaredContentType}`
    );
  }
  if (!metadata.width || !metadata.height) {
    throw new Error("Image source has no valid dimensions");
  }
  const dimensions = displayDimensions(
    metadata.width,
    metadata.height,
    metadata.orientation
  );
  const thumbnail = await boundedJpeg(
    source,
    [{ dimension: THUMBNAIL_DIMENSION, quality: 82 }],
    2_000_000
  );
  const captionImage = await boundedJpeg(
    source,
    [
      { dimension: CAPTION_DIMENSION, quality: 85 },
      { dimension: 1_600, quality: 78 },
      { dimension: 1_280, quality: 72 },
    ],
    CAPTION_MAX_BYTES
  );
  const ocrImage = await boundedJpeg(
    source,
    [
      { dimension: OCR_DIMENSION, quality: 90 },
      { dimension: 5_000, quality: 84 },
      { dimension: 4_000, quality: 78 },
      { dimension: 3_000, quality: 72 },
    ],
    TEXTRACT_IMAGE_MAX_BYTES
  );
  const frameCount = Math.max(1, metadata.pages ?? 1);
  return {
    detectedContentType,
    width: dimensions.width,
    height: dimensions.height,
    frameCount,
    hasAlpha: metadata.hasAlpha ?? false,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    thumbnail,
    thumbnailSha256: createHash("sha256").update(thumbnail).digest("hex"),
    captionImage,
    ocrImage,
    metadata: {
      width: dimensions.width,
      height: dimensions.height,
      sourceFormat: metadata.format,
      frameCount,
      animated: frameCount > 1,
      hasAlpha: metadata.hasAlpha ?? false,
      density: metadata.density,
      orientation: metadata.orientation,
      thumbnailMaxDimension: THUMBNAIL_DIMENSION,
      ocrNormalized: true,
    },
  };
}

function normalizeText(value: string): string {
  return value
    .replace(/\0/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizedRegion(
  region: RepositorySourceRegion | undefined
): RepositorySourceRegion | undefined {
  if (!region) return undefined;
  const values = [region.x, region.y, region.width, region.height];
  if (values.some((value) => !Number.isFinite(value))) return undefined;
  return {
    x: Math.max(0, Math.min(1, region.x)),
    y: Math.max(0, Math.min(1, region.y)),
    width: Math.max(0, Math.min(1, region.width)),
    height: Math.max(0, Math.min(1, region.height)),
  };
}

function segment(
  content: string,
  chunkIndex: number,
  regions: RepositorySourceRegion[],
  segmentLevel: "section" | "chunk",
  parentChunkIndex?: number
): ImageSearchSegment {
  return {
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    chunkIndex,
    tokens: countRepositoryTokens(content),
    modality: "image",
    sourceLocator: { regions: regions.length > 0 ? regions : [FULL_IMAGE_REGION] },
    contextPrefix: "Image",
    segmentLevel,
    parentChunkIndex,
  };
}

/** Build searchable caption/OCR segments with normalized image-region citations. */
export function buildImageSearchDocument(input: {
  caption: string;
  ocrLines: readonly ImageOcrLine[];
  width: number;
  height: number;
  detectedContentType: ImageContentType;
}): ImageSearchDocument {
  const caption = normalizeText(input.caption);
  const lines = input.ocrLines
    .map((line) => ({
      text: normalizeText(line.text),
      region: normalizedRegion(line.region),
    }))
    .filter((line) => line.text.length > 0);
  const segments: ImageSearchSegment[] = [];
  if (caption) {
    segments.push(
      segment(
        `Image description: ${caption}`,
        segments.length,
        [FULL_IMAGE_REGION],
        "section"
      )
    );
  }

  let pendingLines: string[] = [];
  let pendingRegions: RepositorySourceRegion[] = [];
  const flush = () => {
    if (pendingLines.length === 0) return;
    segments.push(
      segment(
        `Visible text:\n${pendingLines.join("\n")}`,
        segments.length,
        pendingRegions,
        "chunk",
        segments[0] ? 0 : undefined
      )
    );
    pendingLines = [];
    pendingRegions = [];
  };
  for (const line of lines) {
    const nextLength = pendingLines.join("\n").length + line.text.length + 1;
    if (
      pendingLines.length > 0 &&
      (nextLength > MAX_SEGMENT_CHARACTERS ||
        pendingRegions.length >= MAX_REGIONS_PER_SEGMENT)
    ) {
      flush();
    }
    pendingLines.push(line.text.slice(0, MAX_SEGMENT_CHARACTERS));
    if (line.region) pendingRegions.push(line.region);
  }
  flush();

  if (segments.length === 0) {
    segments.push(
      segment(
        `Image (${input.detectedContentType}, ${input.width} by ${input.height} pixels)`,
        0,
        [FULL_IMAGE_REGION],
        "section"
      )
    );
  }

  const ocrText = lines.map((line) => line.text).join("\n");
  const canonicalParts = [
    caption ? `<!-- image:description -->\n${caption}` : "",
    ocrText ? `<!-- image:ocr -->\n${ocrText}` : "",
  ].filter(Boolean);
  if (canonicalParts.length === 0) {
    canonicalParts.push(`<!-- image:metadata -->\n${segments[0]?.content ?? "Image"}`);
  }
  return {
    canonicalText: canonicalParts.join("\n\n"),
    segments,
    ocrText,
    ocrRegions: lines.flatMap((line) => (line.region ? [line.region] : [])),
  };
}

export function imageArtifactObjectKey(
  repositoryId: number,
  itemVersionId: string,
  fileName: "thumbnail.jpg" | "ocr-source.jpg" | "ocr.txt"
): string {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new Error("A valid repository id is required for an image artifact key");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      itemVersionId
    )
  ) {
    throw new Error("A valid item version id is required for an image artifact key");
  }
  return `repositories/${repositoryId}/artifacts/${itemVersionId}/${IMAGE_PROCESSOR_VERSION}/${fileName}`;
}
