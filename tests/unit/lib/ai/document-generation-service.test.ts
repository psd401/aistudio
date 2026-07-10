/**
 * @jest-environment node
 *
 * Document generation service (Issue #926). Runs in the Node environment because
 * the format libraries (pptxgenjs in particular) lazy-import `node:fs`/`node:https`,
 * which jsdom blocks — matching the real server runtime where this service runs.
 *
 * Uses the global `jest` (NOT `import { jest } from '@jest/globals'`) so jest.mock
 * hoisting works (documented learning: the @jest/globals import disables hoisting).
 */

// S3 + presigner + settings mocked so generation is exercised without AWS.
const sendMock = jest.fn().mockResolvedValue({});
jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = sendMock;
  },
  PutObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  GetObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));
jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn().mockResolvedValue("https://signed.example/doc"),
}));
jest.mock("@/lib/settings-manager", () => ({
  Settings: { getS3: jest.fn().mockResolvedValue({ region: "us-west-2" }) },
}));

import {
  generateDocument,
  isDocumentFormat,
  sanitizeForWinAnsi,
} from "@/lib/ai/document-generation-service";
import { DOCUMENT_FORMATS } from "@/lib/agents/agent-tools/descriptors";

/** A font stub that rejects a fixed set of "non-WinAnsi" characters, like pdf-lib's StandardFonts. */
function makeFontStub(unencodable: Set<string>) {
  return {
    encodeText(t: string) {
      for (const ch of t) {
        if (unencodable.has(ch)) throw new Error(`cannot encode ${ch}`);
      }
      return t;
    },
  };
}

describe("generateDocument", () => {
  beforeEach(() => {
    sendMock.mockClear();
  });

  // pptx is exercised in document-generation-pptx.test.ts (a separate process):
  // pptxgenjs lazy-imports `node:fs`, which fails under jest once exceljs has been
  // loaded in the same worker (a jest module-loader interference, not a runtime
  // issue). Isolating it in its own file avoids that cross-library interference.
  const FORMATS = DOCUMENT_FORMATS.filter((f) => f !== "pptx");

  it.each(FORMATS)("produces a %s document and stores it", async (format) => {
    const content =
      format === "xlsx" || format === "csv"
        ? "name,score\nAda,99\nGrace,100"
        : "Hello world.\n\nSecond paragraph.";
    const result = await generateDocument({
      format,
      title: "Test Doc",
      content,
      userId: "42",
    });
    expect(result.url).toBe("https://signed.example/doc");
    expect(result.format).toBe(format);
    expect(result.filename.endsWith(`.${format}`)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.s3Key).toContain("v2/generated-documents/42/");
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty content payload", async () => {
    await expect(
      generateDocument({ format: "txt", content: "", userId: "1" })
    ).rejects.toThrow(/content is required/i);
  });

  it("rejects an unsupported format", async () => {
    await expect(
      // @ts-expect-error deliberately invalid format
      generateDocument({ format: "exe", content: "x", userId: "1" })
    ).rejects.toThrow(/Unsupported document format/);
  });

  it("rejects content over the size cap", async () => {
    await expect(
      generateDocument({
        format: "txt",
        content: "a".repeat(1_000_001),
        userId: "1",
      })
    ).rejects.toThrow(/maximum/i);
  });

  it("sanitizes the filename to a safe slug", async () => {
    const result = await generateDocument({
      format: "txt",
      content: "x",
      filename: "../../etc/passwd evil.txt",
      userId: "7",
    });
    expect(result.filename).not.toContain("/");
    expect(result.filename).not.toContain("..");
    expect(result.filename.endsWith(".txt")).toBe(true);
  });

  it("renders a PDF with non-WinAnsi characters (emoji/CJK/Cyrillic/Greek) instead of throwing (REV-COR-499)", async () => {
    const result = await generateDocument({
      format: "pdf",
      title: "Unicode 😀 Report 日本語",
      content: "Hello 😀 world — café 日本語 Привет Ωμέγα ↦ ∑",
      userId: "42",
    });
    expect(result.format).toBe("pdf");
    expect(result.bytes).toBeGreaterThan(0);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("still renders an ASCII/CP1252-only PDF (regression, REV-COR-499)", async () => {
    const result = await generateDocument({
      format: "pdf",
      title: "Plain Report",
      content: "Hello world.\n\nSecond paragraph — café, résumé, naïve.",
      userId: "42",
    });
    expect(result.format).toBe("pdf");
    expect(result.bytes).toBeGreaterThan(0);
  });

  describe("sanitizeForWinAnsi", () => {
    // pdf-lib's real StandardFonts reject "\n" too, which is what drives both bugs
    // this covers: line breaks surviving the fallback, and the fallback being cached.
    const font = makeFontStub(new Set(["\n", "😀"]));

    it("preserves line breaks when the fallback path is triggered by an unencodable character", () => {
      const result = sanitizeForWinAnsi("Hello 😀\n\nSecond paragraph.", font);
      expect(result).toBe("Hello ?\n\nSecond paragraph.");
    });

    it("returns ASCII/CP1252 text unchanged via the whole-string fast path", () => {
      expect(sanitizeForWinAnsi("Plain text, no issues.", font)).toBe(
        "Plain text, no issues."
      );
    });

    it("caches per-character encodability instead of re-checking repeated characters", () => {
      const encodeTextSpy = jest.spyOn(font, "encodeText");
      const repeated = "😀".repeat(50);
      encodeTextSpy.mockClear();
      sanitizeForWinAnsi(repeated, font);
      // 1 call for the whole-string fast-path attempt, then 1 more per UNIQUE
      // character in the fallback (just "😀") — not 50.
      expect(encodeTextSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("isDocumentFormat", () => {
    it("accepts known formats and rejects others", () => {
      expect(isDocumentFormat("pdf")).toBe(true);
      expect(isDocumentFormat("docx")).toBe(true);
      expect(isDocumentFormat("nope")).toBe(false);
      expect(isDocumentFormat(123)).toBe(false);
    });
  });
});
