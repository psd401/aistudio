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
}

export interface GenerateDocumentResult {
  url: string;
  s3Key: string;
  format: DocumentFormat;
  filename: string;
  bytes: number;
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

async function buildPdf(title: string | undefined, content: string): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

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

  if (title) {
    for (const l of wrapPdfLines(title, bold, 18, maxWidth)) drawLine(l, bold, 18);
    y -= 8;
  }
  for (const l of wrapPdfLines(content, font, fontSize, maxWidth)) {
    if (l === "") {
      y -= lineHeight / 2;
      continue;
    }
    drawLine(l, font, fontSize);
    y -= lineHeight - (fontSize + 4);
  }

  return pdf.save();
}

async function buildDocx(title: string | undefined, content: string): Promise<Buffer> {
  const { Document, Packer, Paragraph, HeadingLevel } = await import("docx");
  const children = [];
  if (title) {
    children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }));
  }
  for (const para of content.split(/\n{2,}/)) {
    children.push(new Paragraph({ text: para.replace(/\n/g, " ") }));
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
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

async function buildPptx(title: string | undefined, content: string): Promise<Buffer> {
  const pptxgen = (await import("pptxgenjs")).default;
  const pptx = new pptxgen();
  // Slides separated by a line containing only '---'.
  const slides = content.split(/\n-{3,}\n/).map((s) => s.trim());
  if (title) {
    const cover = pptx.addSlide();
    cover.addText(title, { x: 0.5, y: 1.5, w: 9, h: 1.5, fontSize: 32, bold: true });
  }
  for (const slideText of slides) {
    if (!slideText) continue;
    const slide = pptx.addSlide();
    const [head, ...rest] = slideText.split(/\n/);
    slide.addText(head || "", { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 24, bold: true });
    if (rest.length > 0) {
      slide.addText(rest.join("\n"), { x: 0.5, y: 1.4, w: 9, h: 4.5, fontSize: 16 });
    }
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
  // Deterministic-ish, traceable key; the requestId disambiguates concurrent runs.
  const s3Key = `v2/generated-documents/${request.userId}/${requestId}-${filename}`;

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

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: s3Key }),
    { expiresIn: 3600 }
  );

  log.info("Document generated", {
    requestId,
    format: request.format,
    bytes: body.length,
    s3Key,
  });

  return { url, s3Key, format: request.format, filename, bytes: body.length };
}
