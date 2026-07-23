/** @jest-environment node */

import {
  assertOfficeArchiveLimits,
  extractOfficeDocument,
  OFFICE_CONTENT_TYPES,
  type OfficeExtractionAdapter,
} from "@/lib/repositories/content-platform/office-processing";
import { Document, Packer, Paragraph } from "docx";
import JSZip from "jszip";
import * as XLSX from "@e965/xlsx";

function adapter(
  overrides: Partial<OfficeExtractionAdapter>
): OfficeExtractionAdapter {
  return {
    verifyPackage: async () => undefined,
    extractDocxText: async () => "",
    extractWorkbook: async () => [],
    extractPresentation: async () => [],
    ...overrides,
  };
}

describe("canonical Office processing", () => {
  it("creates deterministic paragraph-pinned DOCX segments", async () => {
    const extracted = await extractOfficeDocument(
      new Uint8Array([1]),
      OFFICE_CONTENT_TYPES.docx,
      adapter({
        extractDocxText: async () =>
          "Emergency Procedures\n\nCall the main office before beginning evacuation.",
      })
    );

    expect(extracted.processorVersion).toBe("office-docx-v2");
    expect(extracted.segments).toHaveLength(2);
    expect(extracted.segments.map((segment) => segment.sourceLocator)).toEqual([
      { paragraph: 1, paragraphEnd: 1 },
      { paragraph: 2, paragraphEnd: 2 },
    ]);
    expect(extracted.segments[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(extracted.canonicalText).toContain("<!-- paragraph:2 -->");
  });

  it("preserves XLSX sheet names and exact cell ranges", async () => {
    const extracted = await extractOfficeDocument(
      new Uint8Array([1]),
      OFFICE_CONTENT_TYPES.xlsx,
      adapter({
        extractWorkbook: async () => [
          {
            name: "Contacts",
            rows: [
              ["Name", "Extension"],
              ["Main Office", 4100],
            ],
            truncated: false,
          },
        ],
      })
    );

    expect(extracted.processorVersion).toBe("office-xlsx-v2");
    expect(extracted.segments).toHaveLength(1);
    expect(extracted.segments[0]?.sourceLocator).toEqual({
      sheet: "Contacts",
      cellRange: "A1:B2",
    });
    expect(extracted.canonicalText).toContain("Main Office\t4100");
  });

  it("keeps non-contiguous PPTX slide numbers for citations", async () => {
    const extracted = await extractOfficeDocument(
      new Uint8Array([1]),
      OFFICE_CONTENT_TYPES.pptx,
      adapter({
        extractPresentation: async () => [
          { slide: 1, paragraphs: ["Overview"] },
          { slide: 4, paragraphs: ["Recovery steps", "Contact the office"] },
        ],
      })
    );

    expect(extracted.segments.map((segment) => segment.sourceLocator.slide)).toEqual([
      1, 4,
    ]);
    expect(extracted.canonicalText).toContain("<!-- slide:4 -->");
  });

  it("rejects unsupported or text-free sources", async () => {
    await expect(
      extractOfficeDocument(new Uint8Array([1]), "application/msword")
    ).rejects.toThrow("Unsupported Office content type");
    await expect(
      extractOfficeDocument(
        new Uint8Array([1]),
        OFFICE_CONTENT_TYPES.docx,
        adapter({ extractDocxText: async () => " \n " })
      )
    ).rejects.toThrow("No searchable text");
  });

  it("rejects OOXML archive expansion and entry-count bombs before parsing", () => {
    expect(() =>
      assertOfficeArchiveLimits([
        {
          name: "word/document.xml",
          isDirectory: false,
          uncompressedSize: 129 * 1024 ** 2,
        },
      ])
    ).toThrow("entry exceeds the expansion safety limit");

    expect(() =>
      assertOfficeArchiveLimits(
        Array.from({ length: 5_001 }, (_, index) => ({
          name: `word/media/${index}.png`,
          isDirectory: false,
          uncompressedSize: 1,
        }))
      )
    ).toThrow("5000-entry safety limit");

    expect(() =>
      assertOfficeArchiveLimits([
        { name: "part-1", isDirectory: false, uncompressedSize: 128 * 1024 ** 2 },
        { name: "part-2", isDirectory: false, uncompressedSize: 128 * 1024 ** 2 },
        { name: "part-3", isDirectory: false, uncompressedSize: 128 * 1024 ** 2 },
        { name: "part-4", isDirectory: false, uncompressedSize: 128 * 1024 ** 2 },
        { name: "part-5", isDirectory: false, uncompressedSize: 1 },
      ])
    ).toThrow("total expansion safety limit");
  });

  it("parses real DOCX, XLSX, and PPTX package bytes", async () => {
    const docx = await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph("District handbook"),
              new Paragraph("Call extension 4100."),
            ],
          },
        ],
      })
    );
    const docxResult = await extractOfficeDocument(docx, OFFICE_CONTENT_TYPES.docx);
    expect(docxResult.canonicalText).toContain("Call extension 4100.");

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["School", "Phone"],
        ["Harbor Heights", "555-0100"],
      ]),
      "Directory"
    );
    const xlsx = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Uint8Array;
    const xlsxResult = await extractOfficeDocument(xlsx, OFFICE_CONTENT_TYPES.xlsx);
    expect(xlsxResult.segments[0]?.sourceLocator).toEqual({
      sheet: "Directory",
      cellRange: "A1:B2",
    });

    const archive = new JSZip();
    archive.file(
      "[Content_Types].xml",
      '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>'
    );
    archive.file(
      "ppt/slides/slide1.xml",
      '<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Opening &amp; goals</a:t></a:r></a:p></p:sld>'
    );
    archive.file(
      "ppt/slides/slide4.xml",
      '<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Final steps</a:t></a:r></a:p></p:sld>'
    );
    const pptx = await archive.generateAsync({ type: "uint8array" });
    const pptxResult = await extractOfficeDocument(pptx, OFFICE_CONTENT_TYPES.pptx);
    expect(pptxResult.segments.map((segment) => segment.sourceLocator.slide)).toEqual([
      1, 4,
    ]);
    expect(pptxResult.canonicalText).toContain("Opening & goals");

    await expect(
      extractOfficeDocument(xlsx, OFFICE_CONTENT_TYPES.docx)
    ).rejects.toThrow("does not match its declared content type");
  });
});
