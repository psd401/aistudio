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
} from "@/lib/ai/document-generation-service";
import { DOCUMENT_FORMATS } from "@/lib/agents/agent-tools/descriptors";

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

  describe("isDocumentFormat", () => {
    it("accepts known formats and rejects others", () => {
      expect(isDocumentFormat("pdf")).toBe(true);
      expect(isDocumentFormat("docx")).toBe(true);
      expect(isDocumentFormat("nope")).toBe(false);
      expect(isDocumentFormat(123)).toBe(false);
    });
  });
});
