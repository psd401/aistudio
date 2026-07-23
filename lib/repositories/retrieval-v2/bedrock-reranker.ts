import type { BedrockAgentRuntimeClient } from "@aws-sdk/client-bedrock-agent-runtime";

export interface RerankDocumentInput {
  text: string;
}

export interface RepositoryReranker {
  rerank(
    query: string,
    documents: RerankDocumentInput[],
    limit: number
  ): Promise<Array<{ index: number; score: number }>>;
}

export class BedrockRepositoryReranker implements RepositoryReranker {
  private readonly client?: BedrockAgentRuntimeClient;

  constructor(
    private readonly modelId: string,
    private readonly region = process.env.AWS_REGION ?? "us-east-1",
    client?: BedrockAgentRuntimeClient,
    private readonly timeoutMs = 5_000
  ) {
    this.client = client;
  }

  async rerank(
    query: string,
    documents: RerankDocumentInput[],
    limit: number
  ): Promise<Array<{ index: number; score: number }>> {
    if (documents.length === 0) return [];
    // Keep the provider SDK out of routes that only import repository search.
    // Jest/browser-conditioned bundles otherwise resolve its browser ESM entry.
    const { BedrockAgentRuntimeClient, RerankCommand } = await import(
      "@aws-sdk/client-bedrock-agent-runtime"
    );
    const client =
      this.client ?? new BedrockAgentRuntimeClient({ region: this.region });
    const command = new RerankCommand({
      queries: [{ type: "TEXT", textQuery: { text: query } }],
      sources: documents.map((document) => ({
        type: "INLINE",
        inlineDocumentSource: {
          type: "TEXT",
          textDocument: { text: document.text },
        },
      })),
      rerankingConfiguration: {
        type: "BEDROCK_RERANKING_MODEL",
        bedrockRerankingConfiguration: {
          numberOfResults: Math.min(limit, documents.length),
          modelConfiguration: {
            modelArn: `arn:aws:bedrock:${this.region}::foundation-model/${this.modelId}`,
          },
        },
      },
    });
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);
    try {
      const response = await client.send(command, {
        abortSignal: abortController.signal,
      });
      return (response.results ?? []).flatMap((result) =>
        result.index != null && result.relevanceScore != null
          ? [{ index: result.index, score: result.relevanceScore }]
          : []
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
