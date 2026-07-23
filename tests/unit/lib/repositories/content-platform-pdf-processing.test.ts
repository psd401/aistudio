import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  extractPdfText,
  segmentPdfPages,
  type PdfTextExtractor,
} from "@/lib/repositories/content-platform/pdf-processing";

async function createPdf(pages: string[]): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = document.addPage([612, 792]);
    page.drawText(text, { x: 50, y: 740, size: 12, font });
  }
  return document.save();
}

describe("canonical PDF processing", () => {
  it("extracts text with exact page boundaries", async () => {
    const source = await createPdf([
      "The first page contains enough searchable district policy text.",
      "The second page contains a separate citation-ready procedure.",
    ]);

    const extractor: PdfTextExtractor = {
      extract: async () => ({
        pageCount: 2,
        pages: [
          {
            page: 1,
            text: "The first page contains enough searchable district policy text.",
          },
          {
            page: 2,
            text: "The second page contains a separate citation-ready procedure.",
          },
        ],
      }),
    };
    const result = await extractPdfText(source, extractor);

    expect(result.pageCount).toBe(2);
    expect(result.pages[0]).toMatchObject({ page: 1 });
    expect(result.pages[0].text).toContain("first page");
    expect(result.pages[1].text).toContain("second page");
    expect(result.canonicalText).toContain("<!-- page:2 -->");
    expect(result.needsOcrPages).toEqual([]);
  });

  it("identifies only low-text pages for OCR", async () => {
    const extractor: PdfTextExtractor = {
      extract: async () => ({
        pageCount: 3,
        pages: [
          { page: 1, text: "A full page of searchable text for the repository." },
          { page: 2, text: " " },
          { page: 3, text: "tiny" },
        ],
      }),
    };

    const result = await extractPdfText(
      new TextEncoder().encode("%PDF-placeholder"),
      extractor
    );

    expect(result.needsOcrPages).toEqual([2, 3]);
  });

  it("creates deterministic bounded segments without crossing pages", () => {
    const longPage = Array.from(
      { length: 70 },
      (_, index) => `Sentence ${index} contains durable repository content.`
    ).join(" ");

    const first = segmentPdfPages(
      [
        { page: 4, text: longPage },
        { page: 5, text: "A short but searchable second page." },
      ],
      { maxCharacters: 500, overlapCharacters: 50 }
    );
    const second = segmentPdfPages(
      [
        { page: 4, text: longPage },
        { page: 5, text: "A short but searchable second page." },
      ],
      { maxCharacters: 500, overlapCharacters: 50 }
    );

    expect(first.length).toBeGreaterThan(2);
    expect(first.every((segment) => segment.content.length <= 500)).toBe(true);
    expect(first.at(-1)?.sourceLocator).toEqual({ page: 5, pageEnd: 5 });
    expect(first.map((segment) => segment.contentHash)).toEqual(
      second.map((segment) => segment.contentHash)
    );
    expect(new Set(first.map((segment) => segment.chunkIndex)).size).toBe(
      first.length
    );
  });

  it("rejects spoofed non-PDF bytes before parsing", async () => {
    const extractor: PdfTextExtractor = {
      extract: jest.fn(),
    };

    await expect(
      extractPdfText(new TextEncoder().encode("not a pdf"), extractor)
    ).rejects.toThrow("PDF signature");
    expect(extractor.extract).not.toHaveBeenCalled();
  });
});
