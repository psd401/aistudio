/** @jest-environment node */

import { BedrockAgentRuntimeClient } from "@aws-sdk/client-bedrock-agent-runtime";
import { BedrockRepositoryReranker } from "@/lib/repositories/retrieval-v2/bedrock-reranker";

describe("Bedrock repository reranker", () => {
  it("sends bounded inline text sources and maps provider scores", async () => {
    const send = jest.fn().mockResolvedValue({
      results: [
        { index: 1, relevanceScore: 0.95 },
        { index: 0, relevanceScore: 0.4 },
        { index: undefined, relevanceScore: 1 },
      ],
    });
    const reranker = new BedrockRepositoryReranker(
      "cohere.rerank-v3-5:0",
      "us-east-1",
      { send } as unknown as BedrockAgentRuntimeClient,
    );

    await expect(
      reranker.rerank(
        "closure policy",
        [{ text: "Document one" }, { text: "Document two" }],
        20,
      ),
    ).resolves.toEqual([
      { index: 1, score: 0.95 },
      { index: 0, score: 0.4 },
    ]);
    const command = send.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    const options = send.mock.calls[0]?.[1] as { abortSignal?: AbortSignal };
    expect(command.input).toMatchObject({
      queries: [{ type: "TEXT", textQuery: { text: "closure policy" } }],
      rerankingConfiguration: {
        bedrockRerankingConfiguration: {
          numberOfResults: 2,
          modelConfiguration: {
            modelArn:
              "arn:aws:bedrock:us-east-1::foundation-model/cohere.rerank-v3-5:0",
          },
        },
      },
    });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("aborts a stalled provider request at the configured deadline", async () => {
    jest.useFakeTimers();
    const send = jest.fn(
      (_command: unknown, options?: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener("abort", () => {
            reject(new Error("request aborted"));
          });
        }),
    );
    const reranker = new BedrockRepositoryReranker(
      "cohere.rerank-v3-5:0",
      "us-east-1",
      { send } as unknown as BedrockAgentRuntimeClient,
      25,
    );

    const pending = reranker.rerank("closure policy", [{ text: "Document" }], 1);
    const rejection = expect(pending).rejects.toThrow("request aborted");
    await jest.advanceTimersByTimeAsync(25);
    await rejection;
    jest.useRealTimers();
  });
});
