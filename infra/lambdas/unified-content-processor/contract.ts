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
}

export interface EmbeddingChunk {
  id: number;
  content: string;
}

export const MAX_EMBEDDING_MESSAGE_BYTES = 220_000;

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
    parsed.jobId.length === 0 ||
    typeof parsed.itemVersionId !== "string" ||
    parsed.itemVersionId.length === 0
  ) {
    throw new Error("Content processing message is missing jobId or itemVersionId");
  }
  return { jobId: parsed.jobId, itemVersionId: parsed.itemVersionId };
}

export function isRepositoryObjectKey(
  repositoryId: number,
  objectKey: string
): boolean {
  const prefix = `repositories/${repositoryId}/`;
  if (!objectKey.startsWith(prefix) || objectKey.includes("..")) return false;
  const pathParts = objectKey.slice(prefix.length).split("/");
  return (
    pathParts.length === 2 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      pathParts[0] ?? ""
    ) &&
    (pathParts[1]?.length ?? 0) > 0
  );
}

export function decideMalwareInspection(
  required: boolean,
  providerStatus: string | null
): MalwareInspectionDecision {
  if (!required) return { status: "not_required" };
  if (!providerStatus) return { status: "awaiting" };
  if (providerStatus === "NO_THREATS_FOUND") {
    return { status: "clean", providerStatus };
  }
  return { status: "blocked", providerStatus };
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

function embeddingMessage(
  itemId: number,
  generationId: string,
  chunks: readonly EmbeddingChunk[]
): EmbeddingQueueMessage {
  return {
    itemId,
    generationId,
    chunkIds: chunks.map((chunk) => chunk.id),
    texts: chunks.map((chunk) => chunk.content),
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
