import { createHash } from "node:crypto";
import {
  batchEmbeddingMessages,
  canonicalTextArtifactObjectKey,
  decideMalwareInspection,
  imageLinesFromTextract,
  isRepositoryObjectKey,
  pagesFromTextract,
  parseContentProcessingMessage,
  sanitizeProcessedContent,
} from "../contract";

describe("unified content processor contract", () => {
  test("validates durable queue messages", () => {
    expect(
      parseContentProcessingMessage(
        JSON.stringify({
          jobId: "11111111-2222-4333-8444-555555555555",
          itemVersionId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
        })
      )
    ).toEqual({
      jobId: "11111111-2222-4333-8444-555555555555",
      itemVersionId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
    });

    expect(() => parseContentProcessingMessage("{}"))
      .toThrow("missing jobId or itemVersionId");
    expect(() =>
      parseContentProcessingMessage(
        JSON.stringify({ jobId: "job-1", itemVersionId: "version-1" })
      )
    ).toThrow("missing jobId or itemVersionId");
    expect(() => parseContentProcessingMessage("not-json")).toThrow();
  });

  test("only accepts generated object keys inside the owning repository", () => {
    const key =
      "repositories/7/11111111-2222-4333-8444-555555555555/handbook.pdf";
    expect(isRepositoryObjectKey(7, key)).toBe(true);
    expect(isRepositoryObjectKey(8, key)).toBe(false);
    expect(
      isRepositoryObjectKey(
        7,
        "repositories/7/11111111-2222-4333-8444-555555555555/../secret.pdf"
      )
    ).toBe(false);
    expect(isRepositoryObjectKey(7, "repositories/7/not-a-uuid/file.pdf"))
      .toBe(false);
    expect(
      isRepositoryObjectKey(
        7,
        "repositories/7/inline/11111111-2222-4333-8444-555555555555/notes.txt"
      )
    ).toBe(false);
  });

  test("fails closed while malware inspection is required", () => {
    expect(decideMalwareInspection(false, null)).toEqual({
      status: "not_required",
    });
    expect(decideMalwareInspection(false, "NO_THREATS_FOUND")).toEqual({
      status: "clean",
      providerStatus: "NO_THREATS_FOUND",
    });
    expect(decideMalwareInspection(false, "THREATS_FOUND")).toEqual({
      status: "blocked",
      providerStatus: "THREATS_FOUND",
    });
    expect(decideMalwareInspection(true, null)).toEqual({ status: "awaiting" });
    expect(decideMalwareInspection(true, "NO_THREATS_FOUND")).toEqual({
      status: "clean",
      providerStatus: "NO_THREATS_FOUND",
    });
    expect(decideMalwareInspection(true, "THREATS_FOUND")).toEqual({
      status: "blocked",
      providerStatus: "THREATS_FOUND",
    });
    expect(decideMalwareInspection(true, "UNSUPPORTED")).toEqual({
      status: "blocked",
      providerStatus: "UNSUPPORTED",
    });
  });

  test("preserves Textract page boundaries and ignores non-line blocks", () => {
    expect(
      pagesFromTextract(
        [
          { BlockType: "PAGE", Page: 1 },
          { BlockType: "LINE", Page: 2, Text: "Second page" },
          { BlockType: "LINE", Page: 1, Text: "First line" },
          { BlockType: "LINE", Page: 1, Text: "Second line" },
        ],
        3
      )
    ).toEqual([
      { page: 1, text: "First line\nSecond line" },
      { page: 2, text: "Second page" },
      { page: 3, text: "" },
    ]);
  });

  test("preserves bounded Textract image regions for exact OCR citations", () => {
    expect(
      imageLinesFromTextract([
        { BlockType: "WORD", Text: "ignore" },
        {
          BlockType: "LINE",
          Text: " Evacuation route ",
          Geometry: {
            BoundingBox: { Left: -0.1, Top: 0.2, Width: 1.2, Height: 0.1 },
          },
        },
        { BlockType: "LINE", Text: "No geometry" },
      ])
    ).toEqual([
      {
        text: "Evacuation route",
        region: { x: 0, y: 0.2, width: 1, height: 0.1 },
      },
      { text: "No geometry", region: undefined },
    ]);
  });
});

describe("unified content artifact and embedding contract", () => {
  test("creates deterministic repository-scoped artifact keys", () => {
    expect(
      canonicalTextArtifactObjectKey(
        7,
        "11111111-2222-4333-8444-555555555555",
        "pdf/v2"
      )
    ).toBe(
      "repositories/7/artifacts/11111111-2222-4333-8444-555555555555/pdf-v2/canonical.md"
    );
    expect(() =>
      canonicalTextArtifactObjectKey(0, "not-a-version", "pdf/v2")
    ).toThrow();
  });

  test("batches embeddings beneath the SQS payload limit without reordering", () => {
    const chunks = Array.from({ length: 7 }, (_, index) => ({
      id: index + 1,
      content: `${index}:${"x".repeat(50)}`,
    }));
    const batches = batchEmbeddingMessages(
      9,
      "11111111-2222-4333-8444-555555555555",
      chunks,
      280
    );

    expect(batches.length).toBeGreaterThan(1);
    expect(
      batches.flatMap((batch) => batch.chunkIds)
    ).toEqual(chunks.map((chunk) => chunk.id));
    expect(
      batches.every(
        (batch) => Buffer.byteLength(JSON.stringify(batch), "utf8") <= 280
      )
    ).toBe(true);
  });

  test("adds retrieval context and modalities to embedding inputs", () => {
    const [message] = batchEmbeddingMessages(
      9,
      "11111111-2222-4333-8444-555555555555",
      [
        {
          id: 1,
          content: "Evacuation route",
          contextPrefix: "Campus map",
          modality: "image",
          visualObjectKey:
            "repositories/7/artifacts/11111111-2222-4333-8444-555555555555/thumbnail.jpg",
          visualMediaType: "image/jpeg",
        },
      ],
    );

    expect(message).toEqual({
      itemId: 9,
      generationId: "11111111-2222-4333-8444-555555555555",
      chunkIds: [1],
      texts: ["Campus map\nEvacuation route"],
      modalities: ["image"],
      visualSources: [
        {
          objectKey:
            "repositories/7/artifacts/11111111-2222-4333-8444-555555555555/thumbnail.jpg",
          mediaType: "image/jpeg",
        },
      ],
    });
  });

  test("rejects one embedding chunk that cannot fit in a bounded message", () => {
    expect(() =>
      batchEmbeddingMessages(
        9,
        "11111111-2222-4333-8444-555555555555",
        [{ id: 1, content: "x".repeat(500) }],
        100
      )
    ).toThrow("exceeds the SQS message limit");
  });
});

// Regression coverage for the SQS payload poisoning that failed 188 production
// index generations: one PDF carried U+FFFF, and copy-forward replicated its
// chunks into every subsequent generation.
const GENERATION = "11111111-2222-4333-8444-555555555555";
const POISONED =
  "Grade 3 ￿ standards \uD800 lone ﷐ arc \u{1FFFF} plane";

/**
 * Independent transcription of the character set SQS accepts:
 *   #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
 *
 * Deliberately written without reusing the production sanitizer's regex so the
 * assertions cannot pass merely because both share the same bug.
 */
/**
 * The non-surrogate half of the transcription: true when a BMP code unit is
 * one SQS rejects. Split out from `hasIllegalCodePoint` purely to keep both
 * functions under the repo's cyclomatic-complexity ceiling; the combined
 * predicate is unchanged.
 */
function isIllegalBmpUnit(unit: number): boolean {
  if (unit === 0x09 || unit === 0x0A || unit === 0x0D) return false; // tab / LF / CR
  if (unit < 0x20 || unit === 0x7F) return true;
  if (unit >= 0xFDD0 && unit <= 0xFDEF) return true;
  return unit === 0xFFFE || unit === 0xFFFF;
}

function hasIllegalCodePoint(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true; // lone high surrogate
      const codePoint = (unit - 0xD800) * 0x400 + (next - 0xDC00) + 0x10000;
      if ((codePoint & 0xFFFE) === 0xFFFE) return true; // U+nFFFE / U+nFFFF
      index++;
      continue;
    }
    if (unit >= 0xDC00 && unit <= 0xDFFF) return true; // lone low surrogate
    if (isIllegalBmpUnit(unit)) return true;
  }
  return false;
}

describe("hasIllegalCodePoint (test oracle)", () => {
  test("recognises the code points SQS rejects", () => {
    expect(hasIllegalCodePoint("￿")).toBe(true);
    expect(hasIllegalCodePoint("￾")).toBe(true);
    expect(hasIllegalCodePoint("﷐")).toBe(true);
    expect(hasIllegalCodePoint("\uD800")).toBe(true);
    expect(hasIllegalCodePoint("\uDC00")).toBe(true);
    expect(hasIllegalCodePoint("\u{1FFFE}")).toBe(true);
    expect(hasIllegalCodePoint("\u{10FFFF}")).toBe(true);
    expect(hasIllegalCodePoint(" ")).toBe(true);
  });

  test("accepts the code points SQS allows", () => {
    expect(hasIllegalCodePoint("plain text")).toBe(false);
    expect(hasIllegalCodePoint("a\tb\nc\rd")).toBe(false);
    expect(hasIllegalCodePoint("\u{1F389}")).toBe(false);
    expect(hasIllegalCodePoint("\u{20000}")).toBe(false);
    expect(hasIllegalCodePoint("퟿�")).toBe(false);
  });
});

describe("embedding payload SQS safety", () => {
  test("strips every SQS-illegal code point from poisoned chunk text", () => {
    const [message] = batchEmbeddingMessages(268, GENERATION, [
      { id: 1, content: POISONED, contextPrefix: "Math ￿ map" },
    ]);

    expect(message.texts).toEqual([
      "Math  map\nGrade 3  standards  lone  arc  plane",
    ]);
    expect(hasIllegalCodePoint(message.texts[0])).toBe(false);
    expect(hasIllegalCodePoint(JSON.stringify(message))).toBe(false);
  });

  test("preserves emoji and supplementary CJK while stripping noncharacters", () => {
    const [message] = batchEmbeddingMessages(268, GENERATION, [
      { id: 1, content: "party \u{1F389} \u{20000} ￿" },
    ]);

    expect(message.texts).toEqual(["party \u{1F389} \u{20000} "]);
    expect(hasIllegalCodePoint(message.texts[0])).toBe(false);
  });

  test("round-trips through JSON.stringify/parse unchanged", () => {
    const [message] = batchEmbeddingMessages(268, GENERATION, [
      { id: 1, content: POISONED },
      { id: 2, content: "clean chunk \u{1F389}" },
    ]);

    const body = JSON.stringify(message);
    expect(hasIllegalCodePoint(body)).toBe(false);
    expect(JSON.parse(body)).toEqual(message);
  });

  test("leaves clean chunk text byte-identical", () => {
    const clean = "Evacuation route\tSection 4\nRoom 12";
    const [message] = batchEmbeddingMessages(268, GENERATION, [
      { id: 1, content: clean, contextPrefix: "Campus map" },
    ]);

    expect(message.texts).toEqual([`Campus map\n${clean}`]);
  });

  test("still respects the byte ceiling when sanitisation shrinks input", () => {
    const chunks = Array.from({ length: 12 }, (_unused, index) => ({
      id: index + 1,
      content: `${"￿".repeat(20)}chunk ${index} ${"y".repeat(40)}`,
    }));

    const batches = batchEmbeddingMessages(268, GENERATION, chunks, 300);

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((batch) => batch.chunkIds)).toEqual(
      chunks.map((chunk) => chunk.id)
    );
    for (const batch of batches) {
      expect(Buffer.byteLength(JSON.stringify(batch), "utf8")).toBeLessThanOrEqual(
        300
      );
      expect(batch.texts.every((text) => !hasIllegalCodePoint(text))).toBe(true);
    }
  });
});

describe("sanitizeProcessedContent", () => {
  const sha256 = (value: string) =>
    createHash("sha256").update(value).digest("hex");

  test("recomputes contentHash only for segments whose content changed", () => {
    const cleanSegment = {
      chunkIndex: 0,
      content: "Clean segment",
      contentHash: sha256("Clean segment"),
    };
    const poisonedSegment = {
      chunkIndex: 1,
      content: "Poisoned ￿ segment",
      contentHash: sha256("Poisoned ￿ segment"),
    };

    const result = sanitizeProcessedContent({
      canonicalText: "Clean segment\n\nPoisoned ￿ segment",
      segments: [cleanSegment, poisonedSegment],
    });

    // Canonical text is replay-bound and never queued, so it stays byte-identical.
    expect(result.canonicalText).toBe("Clean segment\n\nPoisoned ￿ segment");
    // Untouched segment is returned by reference — byte-identical, same hash.
    expect(result.segments[0]).toBe(cleanSegment);
    expect(result.segments[0].contentHash).toBe(sha256("Clean segment"));
    // Changed segment is hashed over exactly what will be stored.
    expect(result.segments[1].content).toBe("Poisoned  segment");
    expect(result.segments[1].contentHash).toBe(sha256("Poisoned  segment"));
    expect(result.segments[1].contentHash).not.toBe(poisonedSegment.contentHash);
    // The original objects are never mutated.
    expect(poisonedSegment.content).toBe("Poisoned ￿ segment");
  });

  test("sanitises contextPrefix without rehashing unchanged content", () => {
    const original = {
      chunkIndex: 0,
      content: "Body text",
      contentHash: sha256("Body text"),
      contextPrefix: "Chapter ￿ 1",
    };

    const result = sanitizeProcessedContent({
      canonicalText: "Body text",
      segments: [original],
    });

    expect(result.segments[0].contextPrefix).toBe("Chapter  1");
    expect(result.segments[0].content).toBe("Body text");
    // Content did not change, so its hash must not be recomputed or altered.
    expect(result.segments[0].contentHash).toBe(original.contentHash);
  });

  test("returns the same object when nothing needed sanitising", () => {
    const content = {
      canonicalText: "All clean \u{1F389}",
      segments: [
        {
          chunkIndex: 0,
          content: "All clean \u{1F389}",
          contentHash: sha256("All clean \u{1F389}"),
          contextPrefix: "Intro",
        },
      ],
    };

    expect(sanitizeProcessedContent(content)).toBe(content);
  });

  test("returns the same object when unsafe characters exist only in canonical text", () => {
    const content = {
      canonicalText: "Replay-bound ￿ artifact",
      segments: [
        {
          chunkIndex: 0,
          content: "Clean searchable segment",
          contentHash: sha256("Clean searchable segment"),
        },
      ],
    };

    expect(sanitizeProcessedContent(content)).toBe(content);
  });

  test("preserves unrelated segment fields on a sanitised segment", () => {
    const result = sanitizeProcessedContent({
      canonicalText: "text",
      segments: [
        {
          chunkIndex: 0,
          tokens: 42,
          sourceLocator: { page: 3 },
          modality: "text" as const,
          content: "Poisoned ￿",
          contentHash: sha256("Poisoned ￿"),
        },
      ],
    });

    expect(result.segments[0]).toMatchObject({
      chunkIndex: 0,
      tokens: 42,
      sourceLocator: { page: 3 },
      modality: "text",
      content: "Poisoned ",
      contentHash: sha256("Poisoned "),
    });
  });

  test("preserves replay-bound canonical text while making segments SQS-legal", () => {
    const poisoned = "a￿b\uD800c﷐d\u{1FFFF}e";
    const result = sanitizeProcessedContent({
      canonicalText: poisoned,
      segments: [
        { chunkIndex: 0, content: poisoned, contentHash: sha256(poisoned) },
      ],
    });

    expect(result.canonicalText).toBe(poisoned);
    expect(hasIllegalCodePoint(result.canonicalText)).toBe(true);
    expect(hasIllegalCodePoint(result.segments[0].content)).toBe(false);
    expect(result.segments[0].contentHash).toBe(sha256("abcde"));
  });

  test("sanitised chunks survive the full write-then-queue path", () => {
    // The write-time pass and the send-time pass must agree: content stored by
    // publishProcessedContent is what queueEmbeddings later puts on the queue.
    const published = sanitizeProcessedContent({
      canonicalText: POISONED,
      segments: [
        { chunkIndex: 0, content: POISONED, contentHash: sha256(POISONED) },
      ],
    });

    const [message] = batchEmbeddingMessages(268, GENERATION, [
      { id: 1, content: published.segments[0].content },
    ]);

    expect(message.texts[0]).toBe(published.segments[0].content);
    expect(hasIllegalCodePoint(message.texts[0])).toBe(false);
  });
});

// publishDocumentVersion asserts that reprocessing an already-published item
// version reproduces its canonical artifact byte-for-byte. Even removal-only
// sanitization would break that binding for an existing poisoned artifact, so
// canonical text must not be rewritten on this path at all.
describe("sanitizeProcessedContent replay safety", () => {
  const sha256 = (value: string) =>
    createHash("sha256").update(value).digest("hex");

  test("is a total no-op for SQS-clean content, including non-NFC text", () => {
    const canonicalText = [
      "Café study guide", // NFD accent
      "Width   spaced", // EN QUAD
      "10 Å resolution", // ANGSTROM SIGN
      "豈 compatibility", // CJK compatibility ideograph
      "party \u{1F389}",
    ].join("\n\n");
    const content = {
      canonicalText,
      segments: [
        {
          chunkIndex: 0,
          content: canonicalText,
          contentHash: sha256(canonicalText),
          contextPrefix: "Chapter   1",
        },
      ],
    };

    const result = sanitizeProcessedContent(content);

    // Same object identity: nothing was rewritten, so a replay reproduces the
    // exact bytes the artifact already holds.
    expect(result).toBe(content);
    expect(result.canonicalText).toBe(canonicalText);
    expect(result.segments[0].contentHash).toBe(sha256(canonicalText));
  });

  test("leaves poisoned canonical text byte-identical while sanitising segments", () => {
    const clean = "Café   guide";
    const poisoned = `${clean} ￿`;
    const content = {
      canonicalText: poisoned,
      segments: [
        { chunkIndex: 0, content: clean, contentHash: sha256(clean) },
        { chunkIndex: 1, content: poisoned, contentHash: sha256(poisoned) },
      ],
    };

    const result = sanitizeProcessedContent(content);

    expect(result.canonicalText).toBe(poisoned);
    expect(result.segments[0]).toBe(content.segments[0]);
    expect(result.segments[1].content).toBe(`${clean} `);
    expect(result.segments[1].contentHash).toBe(sha256(`${clean} `));
  });
});
