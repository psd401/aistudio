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

// The DOCX builder imports `marked`, which is pure ESM and NOT jest-loadable in
// this repo (next/jest overrides transformIgnorePatterns — same constraint
// documented for lib/content/render/markdown-render.ts in jest.config.js). The
// real markdown -> Word mapping is covered by tests/smoke/nexus-document-markdown
// .smoke.ts under Bun; here the builder is a black box so these tests can keep
// verifying what the SERVICE owns: storage, keys, filenames and the result shape.
jest.mock("@/lib/ai/document-docx-builder", () => ({
  buildDocxDocument: jest.fn(() => ({ fake: "docx-document" })),
  packDocx: jest.fn().mockResolvedValue(Buffer.from("DOCX-BYTES-XXXXXXXX")),
}));

import {
  conversationIdFromDocumentKey,
  generateDocument,
  isConversationScopedDocumentKey,
  isDocumentFormat,
  sanitizeForWinAnsi,
  transliterateForWinAnsi,
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
      // 1 call for the whole-string fast-path attempt, 1 for the retry after
      // transliteration (#1898), then 1 more per UNIQUE character in the
      // fallback (just "😀") — not 50.
      expect(encodeTextSpy).toHaveBeenCalledTimes(3);
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

describe("generateDocument (#1898)", () => {
  beforeEach(() => {
    sendMock.mockClear();
  });

  /**
   * The DoD for #1898 names curly quotes, accented names and en dashes as the
   * characters that must survive. They are in fact INSIDE Windows-1252, so the
   * real risk is a regression that starts replacing them: this test uses the
   * real pdf-lib Helvetica (not the stub) and asserts the sanitizer returns the
   * string untouched, so any such regression fails here.
   */
  describe("PDF text fidelity (#1898)", () => {
    it("keeps curly quotes, accented names and en/em dashes verbatim", async () => {
      const { PDFDocument, StandardFonts } = await import("pdf-lib");
      const pdf = await PDFDocument.create();
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const text =
        "José Núñez said \u201CRead the caf\u00E9 memo\u201D \u2014 pages 3\u20135 \u2026 it\u2019s ready.";
      expect(sanitizeForWinAnsi(text, font)).toBe(text);
      expect(sanitizeForWinAnsi(text, font)).not.toContain("?");
    });

    it("renders such a PDF without replacing any character", async () => {
      const result = await generateDocument({
        format: "pdf",
        title: "Caf\u00E9 \u2014 Weekly Update",
        content:
          "Jos\u00E9 N\u00FA\u00F1ez: \u201Cthe se\u00F1or\u2019s r\u00E9sum\u00E9 \u2013 pages 3\u20135\u2026\u201D",
        userId: "42",
      });
      expect(result.format).toBe("pdf");
      expect(result.bytes).toBeGreaterThan(0);
    });

    it("transliterates characters CP1252 cannot encode instead of dropping them", () => {
      expect(transliterateForWinAnsi("Draft \u2192 Review")).toBe("Draft -> Review");
      expect(transliterateForWinAnsi("\u2713 done, \u2717 blocked")).toBe(
        "[x] done, [ ] blocked"
      );
      expect(transliterateForWinAnsi("cost \u2264 100")).toBe("cost <= 100");
      expect(transliterateForWinAnsi("\tindented")).toBe("    indented");
      expect(transliterateForWinAnsi("zero\u200Bwidth")).toBe("zerowidth");
    });

    it("leaves CP1252 punctuation alone so correct output is not degraded", () => {
      const inCp1252 = "\u201Cquote\u201D \u2013 \u2014 \u2026 \u2022 \u20AC caf\u00E9";
      expect(transliterateForWinAnsi(inCp1252)).toBe(inCp1252);
    });

    it("still replaces a genuinely unmappable character with ?", async () => {
      const { PDFDocument, StandardFonts } = await import("pdf-lib");
      const pdf = await PDFDocument.create();
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      // Line break forces the fallback path; the emoji has no CP1252 form.
      expect(sanitizeForWinAnsi("a\n\u{1F600}b", font)).toBe("a\n?b");
    });
  });

  describe("conversation-scoped delivery (#1898)", () => {
    const conversationId = "11111111-2222-3333-4444-555555555555";

    it("stores under the conversation prefix and returns an authenticated path", async () => {
      const result = await generateDocument({
        format: "txt",
        content: "hello",
        filename: "notes",
        userId: "42",
        conversationId,
      });
      expect(result.s3Key.startsWith(`v2/nexus-documents/${conversationId}/`)).toBe(
        true
      );
      expect(result.downloadPath).toBe(`/api/nexus/documents/${result.s3Key}`);
      // No presigned URL is minted for a conversation-scoped document: the
      // route re-authorizes instead, so there is no bearer credential to leak.
      expect(result.url).toBeUndefined();
    });

    it("keeps the presigned URL for a request with no conversation", async () => {
      const result = await generateDocument({
        format: "txt",
        content: "hello",
        userId: "42",
      });
      expect(result.url).toBe("https://signed.example/doc");
      expect(result.downloadPath).toBeUndefined();
      expect(result.s3Key.startsWith("v2/generated-documents/42/")).toBe(true);
    });

    it("rejects a conversationId that is not a UUID", async () => {
      await expect(
        generateDocument({
          format: "txt",
          content: "hello",
          userId: "42",
          conversationId: "../../other-conversation",
        })
      ).rejects.toThrow(/UUID/i);
    });

    it("recognizes and parses only well-formed conversation-scoped keys", async () => {
      const result = await generateDocument({
        format: "docx",
        content: "# Hi",
        userId: "42",
        conversationId,
      });
      expect(isConversationScopedDocumentKey(result.s3Key)).toBe(true);
      expect(conversationIdFromDocumentKey(result.s3Key)).toBe(conversationId);

      for (const bad of [
        "v2/generated-documents/42/x-doc.txt",
        `v2/nexus-documents/${conversationId}/nested/doc.txt`,
        "v2/nexus-documents/not-a-uuid/doc.txt",
        `v2/nexus-documents/${conversationId}/../../secret.txt`,
        `v2/nexus-documents/${conversationId}/doc`,
        "",
      ]) {
        expect(isConversationScopedDocumentKey(bad)).toBe(false);
        expect(conversationIdFromDocumentKey(bad)).toBeNull();
      }
    });
  });

});
