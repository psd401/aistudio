/**
 * Document Generation Service (Issue #926).
 *
 * Generates downloadable documents (PDF / DOCX / XLSX / PPTX and plain
 * md/html/txt/csv) from text content and stores them in S3, returning a
 * time-limited presigned URL. Backs the agentic `documents.create` tool so an
 * agentic Assistant Architect can deliver reports, spreadsheets, and slide decks.
 *
 * Heavy format libraries (`pdf-lib`, `docx`, `exceljs`, `pptxgenjs`) are imported
 * lazily inside each format branch so only the requested format's dependency is
 * loaded, and the module graph stays out of any non-Node bundle.
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createLogger, generateRequestId } from "@/lib/logger";
import { Settings } from "@/lib/settings-manager";
import {
  DOCUMENT_FORMATS,
  type DocumentFormat,
} from "@/lib/agents/agent-tools/descriptors";
// Single-sourced with the download card so the path the tool result carries and
// the path the card accepts cannot drift apart.
import { NEXUS_DOCUMENT_DOWNLOAD_PREFIX } from "@/lib/tools/document-create-contract";

const log = createLogger({ module: "document-generation-service" });

/** Max input content length accepted (guards against unbounded generation). */
const MAX_CONTENT_CHARS = 1_000_000;

const FORMAT_MIME: Record<DocumentFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  md: "text/markdown",
  html: "text/html",
  txt: "text/plain",
  csv: "text/csv",
};

export interface GenerateDocumentRequest {
  format: DocumentFormat;
  content: string;
  title?: string;
  filename?: string;
  userId: string;
  /**
   * Nexus conversation this document belongs to (#1898). When set, the object is
   * stored under the conversation-scoped prefix and delivered through the
   * authenticated `/api/nexus/documents/...` route — which re-checks that the
   * caller owns this conversation on every download — instead of a presigned S3
   * URL. A presigned URL cannot be re-authorized, stops working after an hour,
   * and would be handed to the model as a bearer credential in the tool result.
   */
  conversationId?: string;
}

export interface GenerateDocumentResult {
  /**
   * Presigned S3 GET URL, valid one hour. Omitted for conversation-scoped
   * documents — those use {@link GenerateDocumentResult.downloadPath}.
   */
  url?: string;
  /**
   * App-relative authenticated download path, present only when the request
   * carried a `conversationId`.
   */
  downloadPath?: string;
  s3Key: string;
  format: DocumentFormat;
  filename: string;
  bytes: number;
}

/** S3 prefix for conversation-scoped Nexus documents (#1898). */
export const NEXUS_DOCUMENT_PREFIX = "v2/nexus-documents/";


/**
 * Canonical UUID form. The conversation id becomes a path segment that the
 * download route parses back out and uses as a DB lookup key, so anything that
 * is not a plain UUID is rejected at generation time rather than stored under a
 * prefix the route would later refuse to serve.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isConversationScopedDocumentKey(s3Key: string): boolean {
  if (!s3Key.startsWith(NEXUS_DOCUMENT_PREFIX)) return false;
  const rest = s3Key.slice(NEXUS_DOCUMENT_PREFIX.length).split("/");
  if (rest.length !== 2) return false;
  const [conversationId, objectName] = rest;
  if (!UUID_PATTERN.test(conversationId)) return false;
  // `safeBaseName` restricts the base to [\w-]; the extension is a known format.
  return /^[\w-]+\.[a-z]{2,5}$/.test(objectName);
}

/** The conversation id embedded in a conversation-scoped key, else null. */
export function conversationIdFromDocumentKey(s3Key: string): string | null {
  if (!isConversationScopedDocumentKey(s3Key)) return null;
  return s3Key.slice(NEXUS_DOCUMENT_PREFIX.length).split("/")[0];
}

export function isDocumentFormat(value: unknown): value is DocumentFormat {
  return (
    typeof value === "string" &&
    (DOCUMENT_FORMATS as readonly string[]).includes(value)
  );
}

/** Sanitize a caller-supplied base filename to a safe slug (no extension). */
function safeBaseName(name: string | undefined): string {
  const base = (name || "document")
    .replace(/\.[^.]*$/, "")
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || "document";
}

/** Split one CSV line into cells (handles double-quoted fields with commas). */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes && ch === '"' && line[i + 1] === '"') {
      cur += '"';
      i++;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

/** Minimal CSV row parser (handles double-quoted fields with embedded commas). */
function parseCsv(content: string): string[][] {
  return content
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map(parseCsvLine);
}

/** Wrap text into lines that fit `maxWidth` at `fontSize` for a pdf-lib font. */
function wrapPdfLines(
  text: string,
  font: { widthOfTextAtSize: (s: string, size: number) => number },
  fontSize: number,
  maxWidth: number
): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of rawLine.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, fontSize) > maxWidth && line) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Readable CP1252 stand-ins for the characters a chat model most often emits
 * that WinAnsi cannot encode (Issue #1898).
 *
 * Without this, every one of them became "?" — the arrow in "Draft -> Review"
 * and the check in a checklist alike. Note what is NOT in this table: curly
 * quotes, en/em dashes, the ellipsis, the bullet, the euro sign and every
 * accented Latin-1 letter are all *inside* CP1252 and already round-trip
 * unchanged, so transliterating them would degrade correct output.
 *
 * Tab is here because WinAnsi rejects control characters, so an indented line
 * previously lost its indentation to a "?" rather than keeping it as spaces.
 */
const WIN_ANSI_TRANSLITERATIONS: ReadonlyMap<string, string> = new Map([
  ["\t", "    "],
  // Zero-width and BOM characters carry no visual meaning in a PDF line.
  ["​", ""],
  ["‌", ""],
  ["‍", ""],
  ["﻿", ""],
  // Exotic spaces → a plain space.
  [" ", " "],
  [" ", " "],
  [" ", " "],
  [" ", " "],
  [" ", " "],
  [" ", " "],
  [" ", " "],
  ["　", " "],
  // Hyphen variants CP1252 lacks (the en/em dash it has).
  ["‐", "-"],
  ["‑", "-"],
  ["‒", "-"],
  ["―", "--"],
  ["−", "-"],
  // Arrows.
  ["←", "<-"],
  ["↑", "^"],
  ["→", "->"],
  ["↓", "v"],
  ["↔", "<->"],
  ["⇐", "<="],
  ["⇒", "=>"],
  ["⇔", "<=>"],
  // Comparison / math.
  ["≠", "!="],
  ["≤", "<="],
  ["≥", ">="],
  ["≈", "~="],
  ["±", "+/-"],
  ["∞", "infinity"],
  // Marks commonly used in checklists and tables.
  ["✓", "[x]"],
  ["✔", "[x]"],
  ["✗", "[ ]"],
  ["✘", "[ ]"],
  ["☑", "[x]"],
  ["☐", "[ ]"],
  ["■", "•"],
  ["▪", "•"],
  ["●", "•"],
  ["◦", "•"],
  ["‣", "•"],
  ["⁃", "•"],
  // Primes, used for feet/inches and minutes/seconds.
  ["′", "'"],
  ["″", '"'],
]);

/**
 * Replace known non-WinAnsi characters with CP1252 equivalents. Characters not
 * in the table are left alone for the caller's encodability check to handle.
 *
 * Exported for unit testing.
 */
export function transliterateForWinAnsi(text: string): string {
  let out = "";
  let changed = false;
  for (const ch of text) {
    const replacement = WIN_ANSI_TRANSLITERATIONS.get(ch);
    if (replacement === undefined) {
      out += ch;
    } else {
      out += replacement;
      changed = true;
    }
  }
  return changed ? out : text;
}

/**
 * pdf-lib's StandardFonts (Helvetica) use WinAnsi (CP1252) encoding, so drawText
 * and width measurement throw on any character outside CP1252 (emoji, CJK, Cyrillic,
 * Greek, most math/arrow symbols). Known characters are transliterated to readable
 * CP1252 equivalents first (#1898); anything still unencodable becomes "?" so a
 * single such character no longer fails the entire PDF request (REV-COR-499).
 * ASCII/CP1252 text is returned unchanged via the whole-string fast path.
 *
 * Exported for unit testing.
 */
export function sanitizeForWinAnsi(
  text: string,
  font: { encodeText(t: string): unknown }
): string {
  try {
    font.encodeText(text);
    return text;
  } catch {
    // Retry once after transliteration: it resolves whole classes of input
    // (tab-indented text, arrows) without entering the per-character path.
    const source = transliterateForWinAnsi(text);
    try {
      font.encodeText(source);
      return source;
    } catch {
      // Fall through to the per-character pass below.
    }
    let out = "";
    let replaced = 0;
    // Cache per-character encodability: natural-language text is highly repetitive,
    // so this turns the fallback from O(N) encodeText calls into O(unique chars).
    const cache = new Map<string, boolean>();
    for (const ch of source) {
      // \r/\n never reach drawText directly — wrapPdfLines splits on them first —
      // so preserve them unconditionally instead of letting the WinAnsi control-
      // character rejection turn every line break into "?".
      if (ch === "\n" || ch === "\r") {
        out += ch;
        continue;
      }
      let ok = cache.get(ch);
      if (ok === undefined) {
        try {
          font.encodeText(ch);
          ok = true;
        } catch {
          ok = false;
        }
        cache.set(ch, ok);
      }
      if (ok) {
        out += ch;
      } else {
        out += "?";
        replaced++;
      }
    }
    if (replaced > 0) {
      log.warn("Replaced non-WinAnsi characters in PDF text", { replaced });
    }
    return out;
  }
}

async function buildPdf(title: string | undefined, content: string): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Standard fonts can only encode WinAnsi (CP1252); sanitize so non-CP1252
  // characters degrade to "?" instead of throwing (REV-COR-499). `font` and `bold`
  // share the same WinAnsi encoding, so validating against `font` covers both.
  const safeTitle = title === undefined ? undefined : sanitizeForWinAnsi(title, font);
  const safeContent = sanitizeForWinAnsi(content, font);

  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 54;
  const fontSize = 11;
  const lineHeight = 15;
  const maxWidth = pageWidth - margin * 2;

  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const drawLine = (text: string, f: typeof font, size: number) => {
    if (y < margin) {
      page = pdf.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
    page.drawText(text, { x: margin, y, size, font: f });
    y -= size + 4;
  };

  if (safeTitle) {
    for (const l of wrapPdfLines(safeTitle, bold, 18, maxWidth)) drawLine(l, bold, 18);
    y -= 8;
  }
  for (const l of wrapPdfLines(safeContent, font, fontSize, maxWidth)) {
    if (l === "") {
      y -= lineHeight / 2;
      continue;
    }
    drawLine(l, font, fontSize);
    y -= lineHeight - (fontSize + 4);
  }

  return pdf.save();
}

/**
 * DOCX from markdown (#1898). The body is parsed as markdown rather than being
 * written out verbatim, so `## Heading`, `**bold**`, `- bullets`, `1.` lists and
 * pipe tables become real Word structures instead of literal punctuation on the
 * page. Lazy-imported so `docx` stays out of every other format's graph.
 */
async function buildDocx(title: string | undefined, content: string): Promise<Buffer> {
  const { buildDocxDocument, packDocx } = await import(
    "@/lib/ai/document-docx-builder"
  );
  return packDocx(buildDocxDocument(title, content));
}

async function buildXlsx(title: string | undefined, content: string): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet((title || "Sheet1").slice(0, 31));
  for (const row of parseCsv(content)) {
    ws.addRow(row);
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

/**
 * PPTX from markdown (#1898): a title per slide plus real bullet points.
 *
 * Slide breaks come from `markdownToSlides`, which treats a heading and a `---`
 * thematic break as the same boundary — so the `---` convention this tool has
 * always advertised still works, and a model that simply writes `## Slide title`
 * gets the deck it meant. Bullets are passed as separate text objects with
 * `bullet: true` rather than one newline-joined block, which is what made every
 * previous deck a wall of text.
 */
async function buildPptx(title: string | undefined, content: string): Promise<Buffer> {
  const pptxgen = (await import("pptxgenjs")).default;
  const { markdownToSlides } = await import("@/lib/ai/markdown-blocks");
  const pptx = new pptxgen();
  const slides = markdownToSlides(content);
  if (title) {
    const cover = pptx.addSlide();
    cover.addText(title, { x: 0.5, y: 1.5, w: 9, h: 1.5, fontSize: 32, bold: true });
  }
  for (const spec of slides) {
    const slide = pptx.addSlide();
    slide.addText(spec.title, {
      x: 0.5,
      y: 0.4,
      w: 9,
      h: 0.8,
      fontSize: 24,
      bold: true,
    });
    if (spec.bullets.length > 0) {
      slide.addText(
        spec.bullets.map((text) => ({ text, options: { bullet: true } })),
        { x: 0.5, y: 1.4, w: 9, h: 4.5, fontSize: 16 }
      );
    }
  }
  // A deck with no slides at all is not a valid pptx.
  if (!title && slides.length === 0) {
    pptx.addSlide().addText("(empty)", { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 24 });
  }
  // 'nodebuffer' yields a Node Buffer.
  const out = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}

/** Produce the document bytes for a given format. */
async function renderDocument(
  format: DocumentFormat,
  title: string | undefined,
  content: string
): Promise<Uint8Array | Buffer> {
  switch (format) {
    case "pdf":
      return buildPdf(title, content);
    case "docx":
      return buildDocx(title, content);
    case "xlsx":
      return buildXlsx(title, content);
    case "pptx":
      return buildPptx(title, content);
    case "md":
      return Buffer.from(title ? `# ${title}\n\n${content}` : content, "utf8");
    case "html":
      return Buffer.from(
        `<!doctype html><html><head><meta charset="utf-8">` +
          `<title>${(title || "Document").replace(/[<>]/g, "")}</title></head>` +
          `<body>${title ? `<h1>${title.replace(/[<>]/g, "")}</h1>` : ""}` +
          `<pre>${content.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre></body></html>`,
        "utf8"
      );
    case "csv":
      return Buffer.from(content, "utf8");
    case "txt":
    default:
      return Buffer.from(title ? `${title}\n\n${content}` : content, "utf8");
  }
}

function getDocumentsBucket(): string {
  if (process.env.NODE_ENV === "test") {
    return process.env.DOCUMENTS_BUCKET_NAME || "test-documents-bucket";
  }
  if (!process.env.DOCUMENTS_BUCKET_NAME) {
    throw new Error("DOCUMENTS_BUCKET_NAME environment variable is required");
  }
  return process.env.DOCUMENTS_BUCKET_NAME;
}

let s3ClientCache: S3Client | null = null;
async function getS3Client(): Promise<S3Client> {
  if (s3ClientCache) return s3ClientCache;
  const s3Config = await Settings.getS3();
  s3ClientCache = new S3Client({ region: s3Config.region || "us-west-2" });
  return s3ClientCache;
}

/**
 * Generate a document and store it in S3. Returns a presigned GET URL valid for
 * one hour (mirrors the image-generation service's storage + signing pattern).
 */
export async function generateDocument(
  request: GenerateDocumentRequest
): Promise<GenerateDocumentResult> {
  const requestId = generateRequestId();
  if (!isDocumentFormat(request.format)) {
    throw new Error(`Unsupported document format: ${String(request.format)}`);
  }
  if (typeof request.content !== "string" || request.content.length === 0) {
    throw new Error("Document content is required");
  }
  if (request.content.length > MAX_CONTENT_CHARS) {
    throw new Error(
      `Document content exceeds the maximum of ${MAX_CONTENT_CHARS} characters`
    );
  }

  const bytes = await renderDocument(request.format, request.title, request.content);
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

  const base = safeBaseName(request.filename || request.title);
  const filename = `${base}.${request.format}`;
  const conversationId = request.conversationId;
  if (conversationId !== undefined && !UUID_PATTERN.test(conversationId)) {
    throw new Error("conversationId must be a UUID");
  }
  // Deterministic-ish, traceable key; the requestId disambiguates concurrent runs.
  // A conversation-scoped document lives under the conversation so the download
  // route can re-derive and re-authorize the owner from the key alone.
  const s3Key = conversationId
    ? `${NEXUS_DOCUMENT_PREFIX}${conversationId}/${requestId}-${filename}`
    : `v2/generated-documents/${request.userId}/${requestId}-${filename}`;

  const s3 = await getS3Client();
  const bucket = getDocumentsBucket();
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: body,
      ContentType: FORMAT_MIME[request.format],
      Metadata: {
        userId: request.userId,
        format: request.format,
        generatedAt: new Date().toISOString(),
      },
    })
  );

  // Conversation-scoped documents are never presigned: the authenticated route
  // re-checks ownership on every download, which a presigned URL cannot do.
  const delivery = conversationId
    ? { downloadPath: `${NEXUS_DOCUMENT_DOWNLOAD_PREFIX}${s3Key}` }
    : {
        url: await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: bucket, Key: s3Key }),
          { expiresIn: 3600 }
        ),
      };

  log.info("Document generated", {
    requestId,
    format: request.format,
    bytes: body.length,
    s3Key,
    conversationScoped: Boolean(conversationId),
  });

  return {
    ...delivery,
    s3Key,
    format: request.format,
    filename,
    bytes: body.length,
  };
}
