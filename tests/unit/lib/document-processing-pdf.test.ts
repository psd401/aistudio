/** @jest-environment node */

import { extractTextFromPDF } from "@/lib/document-processing";
import { extractPdfText } from "@/lib/repositories/content-platform/pdf-processing";

jest.mock("@/lib/repositories/content-platform/pdf-processing", () => ({
  extractPdfText: jest.fn(),
}));

const mockExtractPdfText = jest.mocked(extractPdfText);

describe("legacy document PDF extraction", () => {
  it("delegates to the canonical parser and preserves legacy output", async () => {
    mockExtractPdfText.mockResolvedValue({
      pageCount: 1,
      pages: [
        {
          page: 1,
          text: "One canonical parser serves legacy document callers.",
        },
      ],
      canonicalText: "<!-- page:1 -->\nOne canonical parser serves legacy document callers.",
      needsOcrPages: [],
    });
    const result = await extractTextFromPDF(Buffer.from("pdf bytes"));

    expect(result.text).toContain("canonical parser");
    expect(result.metadata).toMatchObject({ pageCount: 1, needsOcrPages: [] });
    expect(mockExtractPdfText).toHaveBeenCalledWith(expect.any(Uint8Array));
  });
});
