/**
 * Give the model the current turn's attached PDFs as documents it can SEE.
 *
 * Repository-backed attachments reach the model only as extracted text through
 * `searchNexusAttachments`. Extraction keeps the printed characters and loses
 * everything drawn on the page: a scanned answer sheet's circled letters came
 * through as "1. A B C D" for every student, so the model correctly refused to
 * score them (prod, 2026-10-26). Claude on Bedrock and Gemini read PDF pages
 * visually when the PDF itself is in the request (verified on Bedrock: circled
 * letters on a rendered sheet read 3/3; 7MB and 22MB PDFs accepted).
 *
 * Scope is deliberately narrow:
 *  - only the CURRENT turn's attachments (later turns keep repository search),
 *  - only owner-bound, clean, processed PDFs (same rules as image references),
 *  - only models known to read PDFs visually,
 *  - bounded size, and
 *  - fail-open: any problem leaves the turn exactly as it was before.
 * The bytes go only into the model's copy of the message; nothing is persisted.
 */

import type { UIMessage } from "ai";
import type { createLogger } from "@/lib/logger";
import {
  resolveNexusAttachmentPdfSources,
  type NexusAttachmentImageSource,
  type NexusAttachmentReference,
} from "@/lib/nexus/ephemeral-repository-service";
import { isRepositorySourceObjectKey } from "@/lib/repositories/content-platform/object-key";
import { getObjectStream } from "@/lib/aws/s3-client";

/** Largest single PDF sent inline (Bedrock Claude accepted a 22MB PDF). */
export const MAX_PDF_DOCUMENT_BYTES = 20 * 1024 * 1024;
/** Largest combined PDF payload for one turn. */
export const MAX_PDF_DOCUMENTS_TOTAL_BYTES = 24 * 1024 * 1024;
/** Bedrock Converse accepts at most 5 documents per request. */
export const MAX_PDF_DOCUMENTS = 5;

/** Models that read PDF pages visually when the PDF is in the request. */
export function modelReadsPdfDocuments(modelConfig: { provider: string; model_id: string }): boolean {
  const provider = modelConfig.provider.toLowerCase();
  if (provider === "google") return /gemini/i.test(modelConfig.model_id);
  if (provider === "amazon-bedrock") {
    return /claude-(?:(?:opus|sonnet|haiku|fable)-[45]\b|[45]\b)/i.test(modelConfig.model_id);
  }
  return false;
}

/**
 * Bedrock document names allow only letters, numbers, whitespace, hyphens,
 * parentheses and square brackets, with no consecutive whitespace. The AI SDK
 * derives the name from the filename minus its extension.
 */
export function bedrockSafePdfFilename(name: string, index: number): string {
  const base = name.replace(/\.pdf$/i, "");
  const safe = base
    .replace(/[^\d\sA-Za-z()[\]-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
    .trim();
  return `${safe || `attachment ${index + 1}`}.pdf`;
}

async function readPdf(source: NexusAttachmentImageSource): Promise<Buffer | null> {
  if (!isRepositorySourceObjectKey(source.repositoryId, source.objectKey)) return null;
  if (source.byteSize != null && source.byteSize > MAX_PDF_DOCUMENT_BYTES) return null;
  const object = await getObjectStream(source.objectKey);
  if (object.contentLength != null && object.contentLength > MAX_PDF_DOCUMENT_BYTES) {
    object.stream.destroy();
    return null;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of object.stream) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > MAX_PDF_DOCUMENT_BYTES) {
      object.stream.destroy();
      return null;
    }
    chunks.push(buffer);
  }
  const bytes = Buffer.concat(chunks);
  return bytes.subarray(0, 5).toString("latin1") === "%PDF-" ? bytes : null;
}

/** Index of the last user message, or -1. */
function lastUserIndex(messages: UIMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

export interface PdfDocumentAttachmentResult {
  messages: UIMessage[];
  attachedCount: number;
}

/**
 * Add the current turn's PDFs to the last user message as `file` parts the
 * model can read visually. Returns the input unchanged when nothing applies or
 * anything fails.
 */
export async function withAttachedPdfDocuments(params: {
  messages: UIMessage[];
  references: NexusAttachmentReference[];
  ownerId: number;
  conversationId: string;
  modelConfig: { provider: string; model_id: string };
  log: ReturnType<typeof createLogger>;
  resolveSources?: typeof resolveNexusAttachmentPdfSources;
  loadPdf?: (source: NexusAttachmentImageSource) => Promise<Buffer | null>;
}): Promise<PdfDocumentAttachmentResult> {
  const unchanged = { messages: params.messages, attachedCount: 0 };
  if (params.references.length === 0 || !modelReadsPdfDocuments(params.modelConfig)) {
    return unchanged;
  }
  const userIndex = lastUserIndex(params.messages);
  if (userIndex < 0) return unchanged;

  try {
    const sources = await (params.resolveSources ?? resolveNexusAttachmentPdfSources)({
      ownerId: params.ownerId,
      conversationId: params.conversationId,
      references: params.references,
    });
    const parts: UIMessage["parts"] = [];
    let total = 0;
    for (const source of sources.slice(0, MAX_PDF_DOCUMENTS)) {
      const bytes = await (params.loadPdf ?? readPdf)(source);
      if (!bytes || total + bytes.byteLength > MAX_PDF_DOCUMENTS_TOTAL_BYTES) continue;
      total += bytes.byteLength;
      parts.push({
        type: "file",
        mediaType: "application/pdf",
        filename: bedrockSafePdfFilename(source.itemName ?? "", parts.length),
        url: `data:application/pdf;base64,${bytes.toString("base64")}`,
      });
    }
    if (parts.length === 0) return unchanged;

    const messages = params.messages.slice();
    const target = messages[userIndex];
    messages[userIndex] = { ...target, parts: [...parts, ...target.parts] };
    params.log.info("Attached PDF documents for visual reading", {
      attachedCount: parts.length,
      totalBytes: total,
      provider: params.modelConfig.provider,
    });
    return { messages, attachedCount: parts.length };
  } catch (error) {
    params.log.warn("Could not attach PDF documents; continuing with text retrieval only", {
      error: error instanceof Error ? error.message : String(error),
    });
    return unchanged;
  }
}
