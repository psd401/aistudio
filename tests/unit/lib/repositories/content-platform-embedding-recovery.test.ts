import { parseCanonicalEmbeddingDlqMessage } from "@/lib/repositories/content-platform/embedding-recovery";

describe("canonical embedding recovery", () => {
  it("accepts only canonical generation-scoped embedding records", () => {
    expect(
      parseCanonicalEmbeddingDlqMessage(
        JSON.stringify({
          itemId: 9,
          generationId: "11111111-2222-4333-8444-555555555555",
          chunkIds: [1, 2],
          texts: ["first", "second"],
        })
      )
    ).toEqual({ generationId: "11111111-2222-4333-8444-555555555555" });
  });

  it.each([
    "not-json",
    JSON.stringify({ itemId: 1, chunkIds: [1], texts: ["legacy"] }),
    JSON.stringify({
      generationId: "11111111-2222-4333-8444-555555555555",
      chunkIds: [1],
      texts: ["missing item"],
    }),
    JSON.stringify({
      generationId: "not-a-uuid",
      chunkIds: [1],
      texts: ["invalid"],
    }),
    JSON.stringify({
      generationId: "11111111-2222-4333-8444-555555555555",
      chunkIds: [1, 2],
      texts: ["mismatched"],
    }),
  ])("retains malformed or legacy DLQ records for diagnosis", (body) => {
    expect(parseCanonicalEmbeddingDlqMessage(body)).toBeNull();
  });
});
