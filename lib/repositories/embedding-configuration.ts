export const DEFAULT_REPOSITORY_EMBEDDING_PROVIDER = "amazon-bedrock";
export const DEFAULT_REPOSITORY_EMBEDDING_MODEL_ID =
  "amazon.titan-embed-text-v1";
export const DEFAULT_REPOSITORY_EMBEDDING_DIMENSIONS = 1536;
export const REPOSITORY_VECTOR_DIMENSIONS = 1536;

export interface RepositoryEmbeddingConfiguration {
  provider: string;
  modelId: string;
  dimensions: number;
  descriptor: string;
}

export function normalizeRepositoryEmbeddingProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "bedrock") return "amazon-bedrock";
  if (normalized === "azure-openai") return "azure";
  return normalized;
}

export function repositoryEmbeddingDescriptor(
  provider: string,
  modelId: string,
): string {
  return `${normalizeRepositoryEmbeddingProvider(provider)}:${modelId.trim()}`;
}

export function parseRepositoryEmbeddingDescriptor(
  descriptor: string | null | undefined,
  dimensions: number | null | undefined,
): RepositoryEmbeddingConfiguration | null {
  if (!descriptor || !dimensions || dimensions <= 0) return null;
  const separator = descriptor.indexOf(":");
  if (separator <= 0 || separator === descriptor.length - 1) return null;
  const provider = normalizeRepositoryEmbeddingProvider(
    descriptor.slice(0, separator),
  );
  const modelId = descriptor.slice(separator + 1).trim();
  if (!provider || !modelId) return null;
  return { provider, modelId, dimensions, descriptor };
}

export function repositoryEmbeddingConfigurationFromSettings(
  values: Readonly<Record<string, string | null | undefined>>,
): RepositoryEmbeddingConfiguration {
  const provider = normalizeRepositoryEmbeddingProvider(
    values.EMBEDDING_MODEL_PROVIDER ?? DEFAULT_REPOSITORY_EMBEDDING_PROVIDER,
  );
  const modelId =
    values.EMBEDDING_MODEL_ID?.trim() || DEFAULT_REPOSITORY_EMBEDDING_MODEL_ID;
  const dimensions = Number.parseInt(
    values.EMBEDDING_DIMENSIONS ??
      String(DEFAULT_REPOSITORY_EMBEDDING_DIMENSIONS),
    10,
  );
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0) {
    throw new Error(
      "Repository embedding dimensions must be a positive integer",
    );
  }
  if (dimensions !== REPOSITORY_VECTOR_DIMENSIONS) {
    throw new Error(
      `Repository embeddings must use ${REPOSITORY_VECTOR_DIMENSIONS} dimensions until the repository vector schema is migrated`,
    );
  }
  return {
    provider,
    modelId,
    dimensions,
    descriptor: repositoryEmbeddingDescriptor(provider, modelId),
  };
}

export function canReuseRepositoryEmbeddings(
  activeModel: string | null | undefined,
  activeDimensions: number | null | undefined,
  nextModel: string | null | undefined,
  nextDimensions: number | null | undefined,
): boolean {
  if (!nextModel || !nextDimensions) return true;
  return activeModel === nextModel && activeDimensions === nextDimensions;
}
