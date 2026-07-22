import {
  batchEmbeddingMessages,
  canonicalTextArtifactObjectKey,
  decideMalwareInspection,
  imageLinesFromTextract,
  isRepositoryObjectKey,
  pagesFromTextract,
  parseContentProcessingMessage,
} from "../contract";

describe("unified content processor contract", () => {
  test("validates durable queue messages", () => {
    expect(
      parseContentProcessingMessage(
        JSON.stringify({ jobId: "job-1", itemVersionId: "version-1" })
      )
    ).toEqual({ jobId: "job-1", itemVersionId: "version-1" });

    expect(() => parseContentProcessingMessage("{}"))
      .toThrow("missing jobId or itemVersionId");
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
  });

  test("fails closed while malware inspection is required", () => {
    expect(decideMalwareInspection(false, null)).toEqual({
      status: "not_required",
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
