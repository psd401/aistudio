/** @jest-environment node */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractCanonicalTextDocument,
  isCanonicalTextContentType,
  TEXT_PROCESSOR_VERSION,
} from "@/lib/repositories/content-platform/text-processing";

describe("canonical text processing", () => {
  it("normalizes UTF-8 text into tokenizer-aware cited segments", () => {
    const extracted = extractCanonicalTextDocument(
      Buffer.from("Emergency protocol\r\n\r\nUse the silver lighthouse."),
      "text/plain",
      "quick-reference.txt"
    );

    expect(extracted.processorVersion).toBe(TEXT_PROCESSOR_VERSION);
    expect(extracted.canonicalText).toBe(
      "Emergency protocol\n\nUse the silver lighthouse."
    );
    expect(extracted.segments).toHaveLength(1);
    expect(extracted.segments[0]).toMatchObject({
      chunkIndex: 0,
      sourceLocator: { headingPath: ["quick-reference.txt"] },
      contextPrefix: "quick-reference.txt",
      segmentLevel: "section",
    });
    expect(extracted.segments[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("preserves Markdown headings as exact source labels", () => {
    const extracted = extractCanonicalTextDocument(
      Buffer.from("# Safety\nUse exit A.\n\n## Contacts\nCall extension 4100."),
      "text/markdown",
      "handbook.md"
    );

    expect(extracted.segments.map((segment) => segment.sourceLocator)).toEqual([
      { headingPath: ["handbook.md", "Safety"] },
      { headingPath: ["handbook.md", "Contacts"] },
    ]);
    expect(extracted.metadata).toMatchObject({ encoding: "utf-8", lines: 5 });
  });

  it("accepts the canonical text allowlist and rejects binary or invalid UTF-8", () => {
    expect(isCanonicalTextContentType("text/plain")).toBe(true);
    expect(isCanonicalTextContentType("text/markdown")).toBe(true);
    expect(isCanonicalTextContentType("text/csv")).toBe(true);
    expect(isCanonicalTextContentType("text/x-python")).toBe(true);
    expect(isCanonicalTextContentType("application/zip")).toBe(false);
    expect(
      extractCanonicalTextDocument(
        Buffer.from("print('canonical')"),
        "text/x-python",
        "example.py",
      ).detectedContentType,
    ).toBe("text/plain");
    expect(() =>
      extractCanonicalTextDocument(
        Uint8Array.from([0xFF, 0xFE, 0xFD]),
        "text/plain"
      )
    ).toThrow("not valid UTF-8");
    expect(() =>
      extractCanonicalTextDocument(Buffer.from("safe\0binary"), "text/plain")
    ).toThrow("binary null bytes");
  });

  it("publishes the normalized text MIME type from the worker", () => {
    const workerSource = readFileSync(
      join(
        process.cwd(),
        "infra/lambdas/unified-content-processor/index.ts",
      ),
      "utf8",
    );
    expect(workerSource).toContain(
      "detectedContentType = extracted.detectedContentType;",
    );
  });
});
