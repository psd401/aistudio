import type { RepositorySourceLocator } from "@/lib/db/schema";

export type RetrievalMode = "keyword" | "vector" | "hybrid";
export type RetrievalModality = "text" | "image" | "audio" | "video" | "table";

export interface RetrievalGenerationSnapshot {
  repositoryId: number;
  repositoryName: string;
  generationId: string;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  visualEmbeddingModel: string | null;
  visualEmbeddingDimensions: number | null;
}

export interface RetrievalCandidate {
  chunkId: number;
  repositoryId: number;
  repositoryName: string;
  generationId: string;
  itemId: number;
  itemStableId: string;
  itemName: string;
  itemVersionId: string;
  versionNumber: number;
  artifactId: string | null;
  content: string;
  contextPrefix: string;
  chunkIndex: number;
  parentChunkIndex: number | null;
  segmentLevel: "document" | "section" | "chunk";
  modality: RetrievalModality;
  sourceLocator: RepositorySourceLocator;
  tokens: number;
  metadata: Record<string, unknown>;
  fusedScore: number;
  denseScore?: number;
  lexicalScore?: number;
  visualScore?: number;
  rerankScore?: number;
}

export interface RetrievalCitation {
  repositoryId: number;
  repositoryName: string;
  itemId: number;
  itemStableId: string;
  itemName: string;
  itemVersionId: string;
  versionNumber: number;
  artifactId: string | null;
  chunkId: number;
  chunkIndex: number;
  modality: RetrievalModality;
  sourceLocator: RepositorySourceLocator;
  label: string;
}

export interface RetrievalContextSegment {
  chunkId: number;
  chunkIndex: number;
  content: string;
  contextPrefix: string;
  modality: RetrievalModality;
  tokens: number;
  citation: RetrievalCitation;
}

export interface RetrievalResult extends RetrievalCandidate {
  similarity: number;
  context: RetrievalContextSegment[];
  citations: RetrievalCitation[];
}

export interface RetrievalDiagnostics {
  durationMs: number;
  repositoriesRequested: number;
  repositoriesAuthorized: number;
  denseCandidates: number;
  lexicalCandidates: number;
  visualCandidates: number;
  fusedCandidates: number;
  reranked: boolean;
  rerankModelId?: string;
  returnedResults: number;
  returnedTokens: number;
}

export interface RetrievalResponse {
  results: RetrievalResult[];
  diagnostics: RetrievalDiagnostics;
}

export interface RepositoryRetrievalRequest {
  query: string;
  repositoryIds: number[];
  userCognitoSub: string;
  mode?: RetrievalMode;
  limit?: number;
  threshold?: number;
  tokenBudget?: number;
  modalities?: RetrievalModality[];
  rerank?: boolean;
  denseWeight?: number;
}
