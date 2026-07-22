import { createHash } from "node:crypto";
import type JSZip from "jszip";
import type { RepositorySourceLocator } from "@/lib/db/schema";
import {
  countRepositoryTokens,
  splitTokenizerAwareText,
} from "./token-segmentation";

export const OFFICE_CONTENT_TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;

export type OfficeDocumentType = keyof typeof OFFICE_CONTENT_TYPES;
export type OfficeContentType = (typeof OFFICE_CONTENT_TYPES)[OfficeDocumentType];

export const OFFICE_PROCESSOR_VERSIONS: Readonly<
  Record<OfficeDocumentType, string>
> = {
  docx: "office-docx-v2",
  xlsx: "office-xlsx-v2",
  pptx: "office-pptx-v2",
};

export interface OfficeSheet {
  name: string;
  rows: unknown[][];
  truncated: boolean;
}

export interface OfficeSlide {
  slide: number;
  paragraphs: string[];
}

export interface OfficeExtractionAdapter {
  verifyPackage(source: Uint8Array, declaredContentType: OfficeContentType): Promise<void>;
  extractDocxText(source: Uint8Array): Promise<string>;
  extractWorkbook(source: Uint8Array): Promise<OfficeSheet[]>;
  extractPresentation(source: Uint8Array): Promise<OfficeSlide[]>;
}

export interface OfficeSegment {
  content: string;
  contentHash: string;
  chunkIndex: number;
  tokens: number;
  sourceLocator: RepositorySourceLocator;
  contextPrefix: string;
  segmentLevel: "section" | "chunk";
  parentChunkIndex?: number;
}

export interface OfficeExtractionResult {
  documentType: OfficeDocumentType;
  detectedContentType: OfficeContentType;
  processorVersion: string;
  canonicalText: string;
  segments: OfficeSegment[];
  metadata: Record<string, unknown>;
}

const MAX_SEGMENT_CHARACTERS = 2_000;
const MAX_XLSX_ROWS_PER_SHEET = 10_000;
const MAX_EXPANDED_TEXT_CHARACTERS = 5_000_000;
const MAX_OOXML_ARCHIVE_ENTRIES = 5_000;
const MAX_OOXML_ENTRY_BYTES = 128 * 1024 ** 2;
const MAX_OOXML_EXPANDED_BYTES = 512 * 1024 ** 2;

export interface OfficeArchiveEntryMetadata {
  name: string;
  isDirectory: boolean;
  uncompressedSize: number;
}

/** Reject OOXML ZIP bombs before any parser expands the package contents. */
export function assertOfficeArchiveLimits(
  entries: readonly OfficeArchiveEntryMetadata[]
): void {
  if (entries.length > MAX_OOXML_ARCHIVE_ENTRIES) {
    throw new Error(
      `Office source archive exceeds the ${MAX_OOXML_ARCHIVE_ENTRIES}-entry safety limit`
    );
  }
  let expandedBytes = 0;
  for (const entry of entries) {
    if (
      !Number.isSafeInteger(entry.uncompressedSize) ||
      entry.uncompressedSize < 0
    ) {
      throw new Error(`Office source archive has invalid size metadata for ${entry.name}`);
    }
    if (!entry.isDirectory && entry.uncompressedSize > MAX_OOXML_ENTRY_BYTES) {
      throw new Error(`Office source archive entry exceeds the expansion safety limit`);
    }
    expandedBytes += entry.uncompressedSize;
    if (expandedBytes > MAX_OOXML_EXPANDED_BYTES) {
      throw new Error("Office source archive exceeds the total expansion safety limit");
    }
  }
}

type SizedZipEntry = {
  dir: boolean;
  _data?: { uncompressedSize?: unknown };
};

function verifyArchiveExpansionBudget(archive: JSZip): void {
  const entries = Object.entries(archive.files).map(([name, entry]) => {
    const sizedEntry = entry as typeof entry & SizedZipEntry;
    const uncompressedSize = sizedEntry.dir
      ? 0
      : sizedEntry._data?.uncompressedSize;
    if (typeof uncompressedSize !== "number") {
      throw new TypeError(`Office source archive has no size metadata for ${name}`);
    }
    return { name, isDirectory: sizedEntry.dir, uncompressedSize };
  });
  assertOfficeArchiveLimits(entries);
}

function normalizeText(value: string): string {
  return value
    .replace(/\0/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function documentTypeForContentType(contentType: string): OfficeDocumentType | null {
  const entry = Object.entries(OFFICE_CONTENT_TYPES).find(
    ([, mimeType]) => mimeType === contentType
  );
  return (entry?.[0] as OfficeDocumentType | undefined) ?? null;
}

export function isOfficeContentType(contentType: string): contentType is OfficeContentType {
  return documentTypeForContentType(contentType) !== null;
}

function splitLocatedText(
  text: string,
  sourceLocator: RepositorySourceLocator
): Array<{ content: string; sourceLocator: RepositorySourceLocator }> {
  const normalized = normalizeText(text);
  const output: Array<{
    content: string;
    sourceLocator: RepositorySourceLocator;
  }> = [];
  for (const content of splitTokenizerAwareText(normalized)) {
    output.push({ content, sourceLocator });
  }
  return output;
}

function contextForLocator(locator: RepositorySourceLocator): string {
  if (locator.slide) return `Slide ${locator.slide}`;
  if (locator.paragraph) return `Paragraph ${locator.paragraph}`;
  if (locator.sheet) {
    return locator.cellRange
      ? `${locator.sheet}!${locator.cellRange}`
      : `Sheet ${locator.sheet}`;
  }
  if (locator.headingPath?.length) return locator.headingPath.join(" › ");
  return "Document section";
}

function buildSegments(
  sections: Array<{ content: string; sourceLocator: RepositorySourceLocator }>
): OfficeSegment[] {
  const output: OfficeSegment[] = [];
  for (const section of sections) {
    const located = splitLocatedText(section.content, section.sourceLocator);
    const parentChunkIndex = output.length;
    const contextPrefix = contextForLocator(section.sourceLocator);
    for (const [sectionChunkIndex, locatedChunk] of located.entries()) {
      output.push({
        content: locatedChunk.content,
        contentHash: createHash("sha256")
          .update(locatedChunk.content)
          .digest("hex"),
        chunkIndex: output.length,
        tokens: countRepositoryTokens(
          `${contextPrefix}\n${locatedChunk.content}`
        ),
        sourceLocator: locatedChunk.sourceLocator,
        contextPrefix,
        segmentLevel: sectionChunkIndex === 0 ? "section" : "chunk",
        parentChunkIndex:
          sectionChunkIndex === 0 ? undefined : parentChunkIndex,
      });
    }
  }
  return output;
}

function marker(locator: RepositorySourceLocator): string {
  if (locator.slide) return `<!-- slide:${locator.slide} -->`;
  if (locator.paragraph) {
    return `<!-- paragraph:${locator.paragraph}${
      locator.paragraphEnd && locator.paragraphEnd !== locator.paragraph
        ? `-${locator.paragraphEnd}`
        : ""
    } -->`;
  }
  if (locator.sheet) {
    return `<!-- sheet:${locator.sheet}${
      locator.cellRange ? ` range:${locator.cellRange}` : ""
    } -->`;
  }
  if (locator.headingPath?.length) {
    return `<!-- section:${locator.headingPath.join(" > ")} -->`;
  }
  return "<!-- section:document -->";
}

function canonicalTextFromSegments(segments: OfficeSegment[]): string {
  return segments
    .map((segment) => `${marker(segment.sourceLocator)}\n${segment.content}`)
    .join("\n\n");
}

function assertExpandedTextLimit(textLength: number): void {
  if (textLength > MAX_EXPANDED_TEXT_CHARACTERS) {
    throw new Error(
      `Expanded Office text exceeds ${MAX_EXPANDED_TEXT_CHARACTERS} characters`
    );
  }
}

function docxSections(text: string): Array<{
  content: string;
  sourceLocator: RepositorySourceLocator;
}> {
  const paragraphs = normalizeText(text)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return paragraphs.map((content, index) => ({
    content,
    sourceLocator: { paragraph: index + 1, paragraphEnd: index + 1 },
  }));
}

function safeSheetName(name: string): string {
  return name.replace(/[\r\n\t]/g, " ").trim() || "Sheet";
}

function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.replace(/[\r\n\t]+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return cellText(record.text);
    if (record.result != null) return cellText(record.result);
    if (typeof record.w === "string") return cellText(record.w);
  }
  return String(value).replace(/[\r\n\t]+/g, " ").trim();
}

function spreadsheetSections(sheets: OfficeSheet[]): Array<{
  content: string;
  sourceLocator: RepositorySourceLocator;
}> {
  const sections: Array<{
    content: string;
    sourceLocator: RepositorySourceLocator;
  }> = [];
  for (const sheet of sheets) {
    const sheetName = safeSheetName(sheet.name);
    const rows = sheet.rows.slice(0, MAX_XLSX_ROWS_PER_SHEET);
    const maxColumns = Math.max(1, ...rows.map((row) => row.length));
    let startRow = 1;
    let batch: string[] = [];
    let batchLength = 0;
    const flush = (endRow: number) => {
      if (batch.length === 0) return;
      const endColumn = columnName(maxColumns);
      sections.push({
        content: `## Sheet: ${sheetName}\n${batch.join("\n")}`,
        sourceLocator: {
          sheet: sheetName,
          cellRange: `A${startRow}:${endColumn}${endRow}`,
        },
      });
      batch = [];
      batchLength = 0;
      startRow = endRow + 1;
    };
    for (const [index, row] of rows.entries()) {
      const rowText = row.map(cellText).join("\t").trimEnd();
      if (
        batch.length > 0 &&
        batchLength + rowText.length + 1 > MAX_SEGMENT_CHARACTERS
      ) {
        flush(index);
      }
      batch.push(rowText);
      batchLength += rowText.length + 1;
    }
    flush(rows.length);
    if (sheet.truncated || sheet.rows.length > MAX_XLSX_ROWS_PER_SHEET) {
      sections.push({
        content: `Sheet ${sheetName} was truncated after ${MAX_XLSX_ROWS_PER_SHEET} rows.`,
        sourceLocator: {
          sheet: sheetName,
          cellRange: `A${MAX_XLSX_ROWS_PER_SHEET}:${columnName(maxColumns)}${MAX_XLSX_ROWS_PER_SHEET}`,
        },
      });
    }
  }
  return sections;
}

function columnName(columnNumber: number): string {
  let value = Math.max(1, columnNumber);
  let output = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    value = Math.floor((value - 1) / 26);
  }
  return output;
}

function presentationSections(slides: OfficeSlide[]): Array<{
  content: string;
  sourceLocator: RepositorySourceLocator;
}> {
  return slides
    .filter((slide) => slide.paragraphs.some((paragraph) => paragraph.trim()))
    .map((slide) => ({
      content: `## Slide ${slide.slide}\n${slide.paragraphs.join("\n")}`,
      sourceLocator: { slide: slide.slide },
    }));
}

function decodeXmlText(value: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|quot);/gi, (match, entity) => {
    if (entity.startsWith("#")) {
      const codePoint = entity.startsWith("#x")
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10FFFF
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return entities[entity.toLowerCase()] ?? match;
  });
}

function extractSlideTextRuns(xml: string): string[] {
  const runs: string[] = [];
  const openTag = "<a:t";
  const closeTag = "</a:t>";
  let cursor = 0;
  while (cursor < xml.length) {
    const open = xml.indexOf(openTag, cursor);
    if (open < 0) break;
    const contentStart = xml.indexOf(">", open + openTag.length);
    if (contentStart < 0) break;
    const close = xml.indexOf(closeTag, contentStart + 1);
    if (close < 0) break;
    const text = decodeXmlText(xml.slice(contentStart + 1, close)).trim();
    if (text) runs.push(text);
    cursor = close + closeTag.length;
  }
  return runs;
}

const OOXML_MAIN_CONTENT_TYPE_MARKERS: Readonly<Record<OfficeDocumentType, string>> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
};

export const defaultOfficeExtractionAdapter: OfficeExtractionAdapter = {
  async verifyPackage(source, declaredContentType) {
    const JSZip = (await import("jszip")).default;
    let archive: InstanceType<typeof JSZip>;
    try {
      archive = await JSZip.loadAsync(Buffer.from(source));
    } catch (error) {
      throw new Error("Office source is not a valid OOXML ZIP package", {
        cause: error,
      });
    }
    verifyArchiveExpansionBudget(archive);
    const manifest = archive.file("[Content_Types].xml");
    if (!manifest) throw new Error("Office source is missing [Content_Types].xml");
    const manifestXml = await manifest.async("string");
    const documentType = documentTypeForContentType(declaredContentType);
    if (
      !documentType ||
      !manifestXml.includes(OOXML_MAIN_CONTENT_TYPE_MARKERS[documentType])
    ) {
      throw new Error("Office source package does not match its declared content type");
    }
  },
  async extractDocxText(source) {
    const mammoth = (await import("mammoth")).default;
    const result = await mammoth.extractRawText({ buffer: Buffer.from(source) });
    return result.value;
  },
  async extractWorkbook(source) {
    const XLSX = await import("@e965/xlsx");
    const workbook = XLSX.read(Buffer.from(source), {
      cellFormula: false,
      sheetRows: MAX_XLSX_ROWS_PER_SHEET,
    });
    return workbook.SheetNames.map((name) => {
      const worksheet = workbook.Sheets[name];
      if (!worksheet) return { name, rows: [], truncated: false };
      const rows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
        header: 1,
        defval: "",
        raw: false,
      });
      return {
        name,
        rows,
        truncated: rows.length >= MAX_XLSX_ROWS_PER_SHEET,
      };
    });
  },
  async extractPresentation(source) {
    const JSZip = (await import("jszip")).default;
    const archive = await JSZip.loadAsync(Buffer.from(source));
    const slideNames = Object.keys(archive.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort(
        (left, right) =>
          Number(left.match(/slide(\d+)\.xml$/)?.[1]) -
          Number(right.match(/slide(\d+)\.xml$/)?.[1])
      );
    const slides: OfficeSlide[] = [];
    for (const name of slideNames) {
      const file = archive.file(name);
      if (!file) continue;
      const xml = await file.async("string");
      const paragraphs = extractSlideTextRuns(xml);
      slides.push({
        slide: Number(name.match(/slide(\d+)\.xml$/)?.[1]),
        paragraphs,
      });
    }
    return slides;
  },
};

export async function extractOfficeDocument(
  source: Uint8Array,
  contentType: string,
  adapter: OfficeExtractionAdapter = defaultOfficeExtractionAdapter
): Promise<OfficeExtractionResult> {
  const documentType = documentTypeForContentType(contentType);
  if (!documentType) throw new Error(`Unsupported Office content type: ${contentType}`);
  await adapter.verifyPackage(source, OFFICE_CONTENT_TYPES[documentType]);

  let sections: Array<{
    content: string;
    sourceLocator: RepositorySourceLocator;
  }>;
  let metadata: Record<string, unknown>;
  if (documentType === "docx") {
    const text = await adapter.extractDocxText(source);
    assertExpandedTextLimit(text.length);
    sections = docxSections(text);
    metadata = { paragraphCount: sections.length };
  } else if (documentType === "xlsx") {
    const sheets = await adapter.extractWorkbook(source);
    sections = spreadsheetSections(sheets);
    metadata = {
      sheetCount: sheets.length,
      totalRows: sheets.reduce((total, sheet) => total + sheet.rows.length, 0),
      truncatedSheets: sheets.filter((sheet) => sheet.truncated).map((sheet) => sheet.name),
    };
  } else {
    const slides = await adapter.extractPresentation(source);
    sections = presentationSections(slides);
    metadata = { slideCount: slides.length };
  }

  const segments = buildSegments(sections);
  if (segments.length === 0) {
    throw new Error(`No searchable text was extracted from the ${documentType.toUpperCase()} source`);
  }
  const canonicalText = canonicalTextFromSegments(segments);
  assertExpandedTextLimit(canonicalText.length);
  return {
    documentType,
    detectedContentType: OFFICE_CONTENT_TYPES[documentType],
    processorVersion: OFFICE_PROCESSOR_VERSIONS[documentType],
    canonicalText,
    segments,
    metadata,
  };
}
