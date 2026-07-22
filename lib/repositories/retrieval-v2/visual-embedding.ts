import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

export async function generateVisualQueryEmbedding(
  query: string,
  modelId: string,
  dimensions: number,
  client = new BedrockRuntimeClient({
    region: process.env.AWS_REGION ?? "us-east-1",
  })
): Promise<number[]> {
  if (modelId !== "cohere.embed-v4:0" || dimensions !== 1536) {
    throw new Error("Visual retrieval requires 1536-dimensional Cohere Embed v4");
  }
  const response = await client.send(
    new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        texts: [query],
        input_type: "search_query",
        embedding_types: ["float"],
        output_dimension: dimensions,
        truncate: "RIGHT",
      }),
    })
  );
  const value = JSON.parse(new TextDecoder().decode(response.body)) as {
    embeddings?: unknown;
  };
  const embeddings = value.embeddings;
  const vector = Array.isArray(embeddings)
    ? embeddings[0]
    : embeddings && typeof embeddings === "object"
      ? (embeddings as { float?: unknown[] }).float?.[0]
      : undefined;
  if (
    !Array.isArray(vector) ||
    vector.length !== dimensions ||
    !vector.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  ) {
    throw new Error("Cohere Embed v4 returned an invalid query vector");
  }
  return vector as number[];
}
