/** @jest-environment node */

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { generateVisualQueryEmbedding } from "@/lib/repositories/retrieval-v2/visual-embedding";

describe("visual query embedding", () => {
  it("uses Cohere's search_query space and validates dimensions", async () => {
    const vector = Array.from({ length: 1536 }, () => 0.25);
    const send = jest.fn().mockResolvedValue({
      body: new TextEncoder().encode(
        JSON.stringify({ embeddings: { float: [vector] } }),
      ),
    });

    await expect(
      generateVisualQueryEmbedding(
        "show the evacuation map",
        "cohere.embed-v4:0",
        1536,
        { send } as unknown as BedrockRuntimeClient,
      ),
    ).resolves.toEqual(vector);
    const command = send.mock.calls[0]?.[0] as {
      input: { body: string | Uint8Array };
    };
    const body = JSON.parse(String(command.input.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      texts: ["show the evacuation map"],
      input_type: "search_query",
      embedding_types: ["float"],
      output_dimension: 1536,
    });
  });

  it("rejects unsupported visual vector spaces before an invocation", async () => {
    await expect(
      generateVisualQueryEmbedding("map", "amazon.titan-embed-text-v1", 1536),
    ).rejects.toThrow("requires 1536-dimensional Cohere Embed v4");
  });
});
