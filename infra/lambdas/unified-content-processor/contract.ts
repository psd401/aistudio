import { createHash } from "node:crypto";
import { isRepositorySourceObjectKey } from "../../../lib/repositories/content-platform/object-key";
import { sanitizeTextForMessaging } from "../../../lib/utils/text-sanitizer";

export interface ContentProcessingMessage {
  jobId: string;
  itemVersionId: string;
}

export interface TextractLineBlock {
  BlockType?: string;
  Text?: string;
  Page?: number;
  Geometry?: {
    BoundingBox?: {
      Left?: number;
      Top?: number;
      Width?: number;
      Height?: number;
    };
  };
}

export interface TextractImageLine {
  text: string;
  region?: { x: number; y: number; width: number; height: number };
}

export interface PageText {
  page: number;
  text: string;
}

export interface EmbeddingQueueMessage {
  itemId: number;
  generationId: string;
  chunkIds: number[];
  texts: string[];
  modalities: Array<"text" | "image" | "audio" | "video" | "table">;
  visualSources: Array<
    { objectKey: string; mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" } | null
  >;
  /** Re-run only atomic generation activation; every required vector exists. */
  activationOnly?: boolean;
}

export interface EmbeddingChunk {
  id: number;
  content: string;
  contextPrefix?: string;
  modality?: "text" | "image" | "audio" | "video" | "table";
  visualObjectKey?: string | null;
  visualMediaType?: "image/jpeg" | "image/png" | "image/webp" | "image/gif" | null;
}

export const MAX_EMBEDDING_MESSAGE_BYTES = 220_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MalwareInspectionDecision =
  | { status: "not_required" }
  | { status: "awaiting" }
  | { status: "clean"; providerStatus: "NO_THREATS_FOUND" }
  | { status: "blocked"; providerStatus: string };

export function parseContentProcessingMessage(
  body: string
): ContentProcessingMessage {
  const parsed = JSON.parse(body) as Partial<ContentProcessingMessage>;
  if (
    typeof parsed.jobId !== "string" ||
    !UUID_PATTERN.test(parsed.jobId) ||
    typeof parsed.itemVersionId !== "string" ||
    !UUID_PATTERN.test(parsed.itemVersionId)
  ) {
    throw new Error("Content processing message is missing jobId or itemVersionId");
  }
  return { jobId: parsed.jobId, itemVersionId: parsed.itemVersionId };
}

export function isRepositoryObjectKey(
  repositoryId: number,
  objectKey: string
): boolean {
  return isRepositorySourceObjectKey(repositoryId, objectKey);
}

export function decideMalwareInspection(
  required: boolean,
  providerStatus: string | null
): MalwareInspectionDecision {
  if (providerStatus === "NO_THREATS_FOUND") {
    return { status: "clean", providerStatus };
  }
  // A verdict already attached to the object remains authoritative even if an
  // administrator subsequently disables mandatory scanning. In particular, a
  // THREATS_FOUND tag must never become a configuration-dependent bypass.
  if (providerStatus) return { status: "blocked", providerStatus };
  return required ? { status: "awaiting" } : { status: "not_required" };
}

export function pagesFromTextract(
  blocks: readonly TextractLineBlock[],
  pageCount: number
): PageText[] {
  const lines = new Map<number, string[]>();
  for (const block of blocks) {
    if (block.BlockType !== "LINE" || !block.Text || !block.Page) continue;
    const pageLines = lines.get(block.Page) ?? [];
    pageLines.push(block.Text);
    lines.set(block.Page, pageLines);
  }
  return Array.from({ length: pageCount }, (_, index) => ({
    page: index + 1,
    text: (lines.get(index + 1) ?? []).join("\n"),
  }));
}

export function imageLinesFromTextract(
  blocks: readonly TextractLineBlock[]
): TextractImageLine[] {
  return blocks.flatMap((block) => {
    if (block.BlockType !== "LINE" || !block.Text?.trim()) return [];
    const box = block.Geometry?.BoundingBox;
    const values = [box?.Left, box?.Top, box?.Width, box?.Height];
    const hasRegion = values.every(
      (value): value is number => typeof value === "number" && Number.isFinite(value)
    );
    return [
      {
        text: block.Text.trim(),
        region: hasRegion
          ? {
              x: Math.max(0, Math.min(1, values[0])),
              y: Math.max(0, Math.min(1, values[1])),
              width: Math.max(0, Math.min(1, values[2])),
              height: Math.max(0, Math.min(1, values[3])),
            }
          : undefined,
      },
    ];
  });
}

export function canonicalTextArtifactObjectKey(
  repositoryId: number,
  itemVersionId: string,
  processorVersion: string
): string {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new Error("A valid repository id is required for an artifact key");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      itemVersionId
    )
  ) {
    throw new Error("A valid item version id is required for an artifact key");
  }
  const safeProcessorVersion = processorVersion.replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!safeProcessorVersion) {
    throw new Error("A processor version is required for an artifact key");
  }
  return `repositories/${repositoryId}/artifacts/${itemVersionId}/${safeProcessorVersion}/canonical.md`;
}

interface SanitizableSegment {
  content: string;
  contentHash: string;
  contextPrefix?: string;
}

interface SanitizableContent<TSegment extends SanitizableSegment> {
  canonicalText: string;
  segments: TSegment[];
}

/**
 * Strip messaging-unsafe code points from the canonical text and searchable
 * segments at write time, so newly published content never carries them into
 * durable storage.
 *
 * Runs immediately before the canonical text is stored, which covers every
 * processor (text, pdf, office, image, media) including the Textract and BDA
 * paths. It covers `canonicalText`, `segments[].content` and
 * `segments[].contextPrefix` — the fields that become chunk rows and therefore
 * SQS payloads. `artifactMetadata` and `additionalArtifacts[].textInline` are
 * deliberately left alone: nothing queues them, and rewriting them would move
 * their own replay bindings.
 *
 * `contentHash` is recomputed **only** for segments whose content actually
 * changed — untouched segments are returned by reference, so the stored hash
 * keeps matching the stored bytes.
 *
 * Because sanitizeTextForMessaging only ever deletes, content with no illegal
 * code points comes back byte-identical. That matters: publishDocumentVersion
 * asserts that reprocessing an already-published item version reproduces its
 * canonical artifact exactly, so any rewrite of clean content here would break
 * the replay binding. Genuinely poisoned content does change, and that replay
 * mismatch is classified terminal in lifecycle.ts rather than burning the
 * whole retry budget.
 *
 * The canonical text's own digest is not recomputed here: storeCanonicalText
 * hashes whatever it is handed, so passing sanitized text through keeps the S3
 * body, its ChecksumSHA256 and canonicalTextSha256 mutually consistent.
 */
export function sanitizeProcessedContent<
  TSegment extends SanitizableSegment,
  TContent extends SanitizableContent<TSegment>,
>(content: TContent): TContent {
  const canonicalText = sanitizeTextForMessaging(content.canonicalText);
  let changed = canonicalText !== content.canonicalText;

  const segments = content.segments.map((segment) => {
    const sanitizedContent = sanitizeTextForMessaging(segment.content);
    const sanitizedContextPrefix =
      segment.contextPrefix === undefined
        ? undefined
        : sanitizeTextForMessaging(segment.contextPrefix);
    if (
      sanitizedContent === segment.content &&
      sanitizedContextPrefix === segment.contextPrefix
    ) {
      return segment;
    }
    changed = true;
    const next: TSegment = { ...segment, content: sanitizedContent };
    if (sanitizedContextPrefix !== undefined) {
      next.contextPrefix = sanitizedContextPrefix;
    }
    if (sanitizedContent !== segment.content) {
      next.contentHash = createHash("sha256")
        .update(sanitizedContent)
        .digest("hex");
    }
    return next;
  });

  return changed ? { ...content, canonicalText, segments } : content;
}

function embeddingMessage(
  itemId: number,
  generationId: string,
  chunks: readonly EmbeddingChunk[]
): EmbeddingQueueMessage {
  return {
    itemId,
    generationId,
    chunkIds: chunks.map((chunk) => chunk.id),
    // Sanitize at the single send-time chokepoint. Both queueEmbeddings and the
    // recovery dispatcher build their payloads here, and this is also the
    // function batchEmbeddingMessages sizes against — so byte accounting stays
    // exact while poisoned chunks that already exist in older index generations
    // are neutralised on their way out.
    texts: chunks.map((chunk) =>
      sanitizeTextForMessaging(
        [chunk.contextPrefix?.trim(), chunk.content].filter(Boolean).join("\n")
      )
    ),
    modalities: chunks.map((chunk) => chunk.modality ?? "text"),
    visualSources: chunks.map((chunk) =>
      chunk.visualObjectKey && chunk.visualMediaType
        ? {
            objectKey: chunk.visualObjectKey,
            mediaType: chunk.visualMediaType,
          }
        : null
    ),
  };
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Build bounded SQS payloads without splitting a searchable chunk. The
 * conservative default leaves room below SQS's 256 KiB message ceiling for
 * future envelope metadata.
 */
export function batchEmbeddingMessages(
  itemId: number,
  generationId: string,
  chunks: readonly EmbeddingChunk[],
  maximumBytes = MAX_EMBEDDING_MESSAGE_BYTES
): EmbeddingQueueMessage[] {
  if (!Number.isSafeInteger(itemId) || itemId <= 0) {
    throw new Error("A valid repository item id is required");
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("A positive embedding message limit is required");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      generationId
    )
  ) {
    throw new Error("A valid index generation id is required");
  }

  const batches: EmbeddingQueueMessage[] = [];
  let pending: EmbeddingChunk[] = [];
  for (const chunk of chunks) {
    const candidate = [...pending, chunk];
    if (
      jsonByteLength(embeddingMessage(itemId, generationId, candidate)) <=
      maximumBytes
    ) {
      pending = candidate;
      continue;
    }
    if (pending.length === 0) {
      throw new Error(`Embedding chunk ${chunk.id} exceeds the SQS message limit`);
    }
    batches.push(embeddingMessage(itemId, generationId, pending));
    pending = [chunk];
    if (
      jsonByteLength(embeddingMessage(itemId, generationId, pending)) >
      maximumBytes
    ) {
      throw new Error(`Embedding chunk ${chunk.id} exceeds the SQS message limit`);
    }
  }
  if (pending.length > 0) {
    batches.push(embeddingMessage(itemId, generationId, pending));
  }
  return batches;
}
