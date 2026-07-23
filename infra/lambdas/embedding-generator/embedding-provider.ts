export const DEFAULT_EMBEDDING_PROVIDER = 'amazon-bedrock';
export const DEFAULT_EMBEDDING_MODEL_ID = 'amazon.titan-embed-text-v1';
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

export type EmbeddingProvider = 'openai' | 'amazon-bedrock' | 'azure';

export interface EmbeddingDescriptor {
  provider: EmbeddingProvider;
  modelId: string;
  dimensions: number;
}

export function normalizeEmbeddingProvider(provider: string): EmbeddingProvider {
  switch (provider.trim().toLowerCase()) {
    case 'openai':
      return 'openai';
    case 'bedrock':
    case 'amazon-bedrock':
      return 'amazon-bedrock';
    case 'azure':
    case 'azure-openai':
      return 'azure';
    default:
      throw new Error(`Unsupported embedding provider: ${provider}`);
  }
}

export function parseEmbeddingDescriptor(
  descriptor: string | null | undefined,
  dimensions: number | null | undefined
): EmbeddingDescriptor {
  if (!descriptor || !Number.isSafeInteger(dimensions) || !dimensions || dimensions <= 0) {
    throw new Error('Index generation has invalid embedding configuration');
  }
  const separator = descriptor.indexOf(':');
  if (separator <= 0 || separator === descriptor.length - 1) {
    throw new Error(`Invalid index generation embedding descriptor: ${descriptor}`);
  }
  return {
    provider: normalizeEmbeddingProvider(descriptor.slice(0, separator)),
    modelId: descriptor.slice(separator + 1).trim(),
    dimensions,
  };
}

export function buildBedrockEmbeddingBody(
  modelId: string,
  text: string,
  dimensions: number,
  inputType: 'search_document' | 'search_query' = 'search_document'
): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Embedding input cannot be empty');

  if (modelId === 'amazon.titan-embed-text-v2:0') {
    if (![256, 512, 1024].includes(dimensions)) {
      throw new Error(`Titan Text Embeddings V2 does not support ${dimensions} dimensions`);
    }
    return JSON.stringify({ inputText: trimmed, dimensions, normalize: true });
  }

  if (modelId === 'amazon.titan-embed-text-v1') {
    if (dimensions !== 1536) {
      throw new Error(`Titan Embeddings G1 requires 1536 dimensions, got ${dimensions}`);
    }
    return JSON.stringify({ inputText: trimmed });
  }

  if (modelId === 'cohere.embed-v4:0') {
    if (![256, 512, 1024, 1536].includes(dimensions)) {
      throw new Error(`Cohere Embed v4 does not support ${dimensions} dimensions`);
    }
    return JSON.stringify({
      texts: [trimmed],
      input_type: inputType,
      embedding_types: ['float'],
      output_dimension: dimensions,
      truncate: 'RIGHT',
    });
  }

  throw new Error(`Unsupported Bedrock embedding model: ${modelId}`);
}

export interface CohereMultimodalEmbeddingInput {
  text: string;
  imageDataUri?: string;
}

export function buildCohereMultimodalEmbeddingBody(
  modelId: string,
  input: CohereMultimodalEmbeddingInput,
  dimensions: number,
): string {
  if (modelId !== 'cohere.embed-v4:0') {
    throw new Error(`Unsupported multimodal embedding model: ${modelId}`);
  }
  if (![256, 512, 1024, 1536].includes(dimensions)) {
    throw new Error(`Cohere Embed v4 does not support ${dimensions} dimensions`);
  }
  const text = input.text.trim();
  if (!text) throw new Error('Multimodal embedding input cannot be empty');
  if (
    input.imageDataUri &&
    !/^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(
      input.imageDataUri,
    )
  ) {
    throw new Error('Cohere Embed v4 image input must be a supported base64 data URI');
  }
  return JSON.stringify({
    inputs: [
      {
        content: [
          { type: 'text', text },
          ...(input.imageDataUri
            ? [
                {
                  type: 'image_url',
                  image_url: { url: input.imageDataUri },
                },
              ]
            : []),
        ],
      },
    ],
    input_type: 'search_document',
    embedding_types: ['float'],
    output_dimension: dimensions,
    truncate: 'RIGHT',
  });
}

export function parseEmbeddingVector(value: unknown, expectedDimensions: number, modelId: string): number[] {
  if (!value || typeof value !== 'object') {
    throw new Error(`Embedding model ${modelId} returned an invalid response`);
  }
  const record = value as {
    embedding?: unknown;
    embeddings?: unknown;
  };
  let embedding = record.embedding;
  if (Array.isArray(record.embeddings)) {
    embedding = record.embeddings[0];
  } else if (
    record.embeddings &&
    typeof record.embeddings === 'object' &&
    Array.isArray((record.embeddings as { float?: unknown }).float)
  ) {
    embedding = (record.embeddings as { float: unknown[] }).float[0];
  }
  if (!Array.isArray(embedding) || embedding.length !== expectedDimensions) {
    throw new Error(
      `Embedding model ${modelId} returned ${Array.isArray(embedding) ? embedding.length : 0} dimensions; expected ${expectedDimensions}`,
    );
  }
  if (!embedding.every((element) => typeof element === 'number' && Number.isFinite(element))) {
    throw new Error(`Embedding model ${modelId} returned non-finite vector values`);
  }
  return embedding;
}

export function embeddingDescriptor(provider: string, modelId: string): string {
  return `${normalizeEmbeddingProvider(provider)}:${modelId.trim()}`;
}
