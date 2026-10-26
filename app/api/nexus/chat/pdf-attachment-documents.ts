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
 *  - only Claude 4.x/5.x on Bedrock — the one path verified end to end (Gemini
 *    accepts PDFs too, but has not been verified on our model ids),
 *  - only after the PDF's extracted text passes the same content-safety check
 *    retrieved chunks get (`protectRetrievedChunk`), so the model never sees a
 *    PDF that the search path would have refused to return,
 *  - bounded size, and
 *  - fail-open: a PDF that fails any step is simply not attached, and the turn
 *    proceeds on text retrieval exactly as before. Nothing here blocks a turn.
 * The bytes go only into the model's copy of the message; nothing is persisted.
 */

import type { UIMessage } from "ai";
import type { createLogger } from "@/lib/logger";
import {
  loadItemVersionText,
  resolveNexusAttachmentPdfSources,
  type NexusAttachmentImageSource,
  type NexusAttachmentReference,
} from "@/lib/nexus/ephemeral-repository-service";
import { getContentSafetyService } from "@/lib/safety";
import { isRepositorySourceObjectKey } from "@/lib/repositories/content-platform/object-key";
import { getObjectStream } from "@/lib/aws/s3-client";

/** Largest single PDF sent inline (Bedrock Claude accepted a 22MB PDF). */
export const MAX_PDF_DOCUMENT_BYTES = 20 * 1024 * 1024;
/** Largest combined PDF payload for one turn. */
export const MAX_PDF_DOCUMENTS_TOTAL_BYTES = 24 * 1024 * 1024;
/** Bedrock Converse accepts at most 5 documents per request. */
export const MAX_PDF_DOCUMENTS = 5;

/** Models verified to read PDF pages visually when the PDF is in the request. */
export function modelReadsPdfDocuments(modelConfig: { provider: string; model_id: string }): boolean {
  return (
    modelConfig.provider.toLowerCase() === "amazon-bedrock" &&
    /claude-(?:(?:opus|sonnet|haiku|fable)-[45]\b|[45]\b)/i.test(modelConfig.model_id)
  );
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

/** Guardrail input size per call; longer extracted text is checked in slices. */
const SAFETY_SLICE_CHARS = 20_000;

/**
 * The content-safety check retrieved attachment chunks pass
 * (`protectRetrievedChunk`), applied to the PDF's extracted text before the PDF
 * itself goes to the model. With guardrails off it allows without loading text.
 */
export function pdfContentSafetyCheck(
  sessionId: string,
  deps: {
    safety?: Pick<ReturnType<typeof getContentSafetyService>, "isEnabled" | "processInput">;
    loadText?: (itemVersionId: string) => Promise<string>;
  } = {}
): (source: NexusAttachmentImageSource) => Promise<boolean> {
  return async (source) => {
    const safety = deps.safety ?? getContentSafetyService();
    if (!safety.isEnabled()) return true;
    const text = await (deps.loadText ?? loadItemVersionText)(source.itemVersionId);
    for (let start = 0; start < text.length; start += SAFETY_SLICE_CHARS) {
      const result = await safety.processInput(text.slice(start, start + SAFETY_SLICE_CHARS), sessionId);
      if (!result.allowed) return false;
    }
    return true;
  };
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

/**
 * One PDF's bytes if the content-safety check allows it and it loads; null
 * otherwise. Each PDF stands alone: one that fails is skipped, the rest attach.
 */
async function loadAllowedPdf(
  source: NexusAttachmentImageSource,
  params: {
    log: ReturnType<typeof createLogger>;
    isPdfContentAllowed: (source: NexusAttachmentImageSource) => Promise<boolean>;
    loadPdf?: (source: NexusAttachmentImageSource) => Promise<Buffer | null>;
  }
): Promise<Buffer | null> {
  try {
    if (!(await params.isPdfContentAllowed(source))) {
      params.log.info("PDF not attached for visual reading: content-safety check did not allow it");
      return null;
    }
    return await (params.loadPdf ?? readPdf)(source);
  } catch (error) {
    params.log.warn("Could not attach one PDF for visual reading; skipping it", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
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
  /**
   * Whether the PDF's content may be shown to the model — the same check
   * retrieved chunks pass. Resolves false to skip the PDF (never to block).
   */
  isPdfContentAllowed: (source: NexusAttachmentImageSource) => Promise<boolean>;
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
      const bytes = await loadAllowedPdf(source, params);
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
