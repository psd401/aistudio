import { createHash } from "node:crypto";
import type { RepositorySourceLocator } from "@/lib/db/schema";
import {
  countRepositoryTokens,
  splitTokenizerAwareText,
} from "./token-segmentation";

export const TEXT_PROCESSOR_VERSION = "structured-text-v1";

export const TEXT_CONTENT_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
] as const;

export type CanonicalTextContentType = (typeof TEXT_CONTENT_TYPES)[number];

export interface CanonicalTextSegment {
  content: string;
  contentHash: string;
  chunkIndex: number;
  tokens: number;
  sourceLocator: RepositorySourceLocator;
  contextPrefix: string;
  segmentLevel: "section" | "chunk";
  parentChunkIndex?: number;
}

export interface CanonicalTextDocument {
  canonicalText: string;
  detectedContentType: CanonicalTextContentType;
  processorVersion: string;
  segments: CanonicalTextSegment[];
  metadata: {
    encoding: "utf-8";
    characters: number;
    lines: number;
  };
}

interface TextSection {
  heading: string | null;
  content: string;
}

export function isCanonicalTextContentType(
  contentType: string
): contentType is CanonicalTextContentType {
  return (TEXT_CONTENT_TYPES as readonly string[]).includes(contentType);
}

function normalizeText(source: Uint8Array): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    throw new Error("Text source is not valid UTF-8");
  }
  const normalized = decoded
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  if (normalized.includes("\0")) {
    throw new Error("Text source contains binary null bytes");
  }
  if (!normalized) throw new Error("Text source has no searchable content");
  return normalized;
}

function markdownSections(text: string): TextSection[] {
  const sections: TextSection[] = [];
  let heading: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    const content = lines.join("\n").trim();
    if (content) sections.push({ heading, content });
    lines = [];
  };
  for (const line of text.split("\n")) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[2]?.trim().slice(0, 160) || null;
    }
    lines.push(line);
  }
  flush();
  return sections;
}

function sourceLabel(fileName: string | undefined): string {
  const value = fileName?.trim().slice(0, 160);
  return value || "Repository text";
}

/** Decode, structurally segment, and cite UTF-8 repository text. */
export function extractCanonicalTextDocument(
  source: Uint8Array,
  contentType: string,
  fileName?: string
): CanonicalTextDocument {
  if (!isCanonicalTextContentType(contentType)) {
    throw new Error("Unsupported canonical text content type");
  }
  const canonicalText = normalizeText(source);
  const sections =
    contentType === "text/markdown"
      ? markdownSections(canonicalText)
      : [{ heading: null, content: canonicalText }];
  const label = sourceLabel(fileName);
  const segments: CanonicalTextSegment[] = [];
  for (const section of sections) {
    const sectionStart = segments.length;
    const chunks = splitTokenizerAwareText(section.content);
    for (const [sectionChunkIndex, content] of chunks.entries()) {
      const headingPath = [label];
      if (section.heading) headingPath.push(section.heading);
      if (chunks.length > 1) headingPath.push(`Part ${sectionChunkIndex + 1}`);
      const contextPrefix = headingPath.join(" › ");
      segments.push({
        content,
        contentHash: createHash("sha256").update(content).digest("hex"),
        chunkIndex: segments.length,
        tokens: countRepositoryTokens(`${contextPrefix}\n${content}`),
        sourceLocator: { headingPath },
        contextPrefix,
        segmentLevel: sectionChunkIndex === 0 ? "section" : "chunk",
        parentChunkIndex:
          sectionChunkIndex === 0 ? undefined : sectionStart,
      });
    }
  }
  if (segments.length === 0) {
    throw new Error("Text source has no searchable content");
  }

  return {
    canonicalText,
    detectedContentType: contentType,
    processorVersion: TEXT_PROCESSOR_VERSION,
    segments,
    metadata: {
      encoding: "utf-8",
      characters: canonicalText.length,
      lines: canonicalText.split("\n").length,
    },
  };
}
