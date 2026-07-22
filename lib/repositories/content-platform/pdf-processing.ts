import { createHash } from "node:crypto";
import type { RepositorySourceLocator } from "@/lib/db/schema";
import {
  countRepositoryTokens,
  splitTokenizerAwareText,
} from "./token-segmentation";

export const PDF_PROCESSOR_VERSION = "pdf-text-v2";

export interface PdfPageText {
  page: number;
  text: string;
}

export interface PdfExtractionResult {
  pageCount: number;
  pages: PdfPageText[];
  canonicalText: string;
  needsOcrPages: number[];
}

export interface PdfSegment {
  content: string;
  contentHash: string;
  chunkIndex: number;
  tokens: number;
  sourceLocator: RepositorySourceLocator;
  contextPrefix: string;
  segmentLevel: "section" | "chunk";
  parentChunkIndex?: number;
}

export interface PdfTextExtractor {
  extract(buffer: Uint8Array): Promise<{
    pageCount: number;
    pages: PdfPageText[];
  }>;
}

export interface PdfSegmentOptions {
  maxCharacters?: number;
  overlapCharacters?: number;
  maxTokens?: number;
  overlapTokens?: number;
}

const PDF_MAGIC = "%PDF-";
const MIN_PAGE_TEXT_CHARACTERS = 20;
const DEFAULT_MAX_SEGMENT_CHARACTERS = 2_000;
const DEFAULT_OVERLAP_CHARACTERS = 200;

function normalizePageText(text: string): string {
  return text
    .replace(/\0/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function assertPdfMagic(buffer: Uint8Array): void {
  if (buffer.byteLength < PDF_MAGIC.length) {
    throw new Error("PDF source is empty or truncated");
  }
  const signature = new TextDecoder("ascii").decode(
    buffer.subarray(0, PDF_MAGIC.length)
  );
  if (signature !== PDF_MAGIC) {
    throw new Error("Source bytes do not contain a PDF signature");
  }
}

const defaultPdfTextExtractor: PdfTextExtractor = {
  async extract(buffer) {
    // pdf-parse v2 is ESM-only. Loading it at the extraction boundary keeps
    // consumers that only use segmentation (including Jest's CJS runtime) from
    // evaluating its import.meta-based browser bundle.
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText({
        lineEnforce: true,
        parseHyperlinks: true,
        pageJoiner: "",
      });
      return {
        pageCount: result.total,
        pages: result.pages.map((page) => ({
          page: page.num,
          text: page.text,
        })),
      };
    } finally {
      await parser.destroy();
    }
  },
};

/**
 * Extract page-pinned text without flattening page boundaries. Pages with too
 * little usable text are explicitly identified for the OCR stage instead of
 * silently disappearing from retrieval.
 */
export async function extractPdfText(
  source: Uint8Array,
  extractor: PdfTextExtractor = defaultPdfTextExtractor
): Promise<PdfExtractionResult> {
  assertPdfMagic(source);
  const extracted = await extractor.extract(source);
  if (!Number.isSafeInteger(extracted.pageCount) || extracted.pageCount < 1) {
    throw new Error("PDF parser returned an invalid page count");
  }

  const byPage = new Map<number, string>();
  for (const page of extracted.pages) {
    if (
      Number.isSafeInteger(page.page) &&
      page.page >= 1 &&
      page.page <= extracted.pageCount
    ) {
      byPage.set(page.page, normalizePageText(page.text));
    }
  }

  const pages = Array.from({ length: extracted.pageCount }, (_, index) => ({
    page: index + 1,
    text: byPage.get(index + 1) ?? "",
  }));
  const needsOcrPages = pages
    .filter((page) => page.text.replace(/\s/g, "").length < MIN_PAGE_TEXT_CHARACTERS)
    .map((page) => page.page);

  return {
    pageCount: extracted.pageCount,
    pages,
    canonicalText: pages
      .map((page) => `<!-- page:${page.page} -->\n${page.text}`)
      .join("\n\n"),
    needsOcrPages,
  };
}

function findSplitPoint(text: string, maxCharacters: number): number {
  if (text.length <= maxCharacters) return text.length;
  const preferredFloor = Math.floor(maxCharacters * 0.6);
  const candidates = ["\n\n", "\n", ". ", "; ", ", ", " "];
  for (const separator of candidates) {
    const index = text.lastIndexOf(separator, maxCharacters);
    if (index >= preferredFloor) return index + separator.length;
  }
  return maxCharacters;
}

function pageSegments(
  text: string,
  maxCharacters: number,
  overlapCharacters: number
): string[] {
  const segments: string[] = [];
  let start = 0;
  while (start < text.length) {
    const remaining = text.slice(start);
    const length = findSplitPoint(remaining, maxCharacters);
    const segment = remaining.slice(0, length).trim();
    if (segment) segments.push(segment);
    if (length >= remaining.length) break;

    const nextStart = start + length - overlapCharacters;
    start = Math.max(start + 1, nextStart);
    while (start < text.length && /\s/.test(text[start])) start += 1;
  }
  return segments;
}

/** Deterministic, page-aware segmentation suitable for exact PDF citations. */
export function segmentPdfPages(
  pages: PdfPageText[],
  options: PdfSegmentOptions = {}
): PdfSegment[] {
  const maxCharacters = options.maxCharacters ?? DEFAULT_MAX_SEGMENT_CHARACTERS;
  const overlapCharacters =
    options.overlapCharacters ?? DEFAULT_OVERLAP_CHARACTERS;
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 200) {
    throw new Error("maxCharacters must be an integer of at least 200");
  }
  if (
    !Number.isSafeInteger(overlapCharacters) ||
    overlapCharacters < 0 ||
    overlapCharacters >= maxCharacters
  ) {
    throw new Error("overlapCharacters must be smaller than maxCharacters");
  }

  const segments: PdfSegment[] = [];
  for (const page of pages) {
    const normalized = normalizePageText(page.text);
    if (!normalized) continue;
    const contents =
      options.maxCharacters != null || options.overlapCharacters != null
        ? pageSegments(normalized, maxCharacters, overlapCharacters)
        : splitTokenizerAwareText(normalized, {
            maximumTokens: options.maxTokens,
            overlapTokens: options.overlapTokens,
          });
    const parentChunkIndex = segments.length;
    for (const [pageChunkIndex, content] of contents.entries()) {
      const contextPrefix = `Page ${page.page}`;
      segments.push({
        content,
        contentHash: createHash("sha256").update(content).digest("hex"),
        chunkIndex: segments.length,
        tokens: countRepositoryTokens(`${contextPrefix}\n${content}`),
        sourceLocator: { page: page.page, pageEnd: page.page },
        contextPrefix,
        segmentLevel: pageChunkIndex === 0 ? "section" : "chunk",
        parentChunkIndex:
          pageChunkIndex === 0 ? undefined : parentChunkIndex,
      });
    }
  }
  return segments;
}
