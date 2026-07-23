export interface EmbeddingCompletionMessage {
  generationId?: string;
}

/**
 * Legacy embedding messages represent an entire item. Canonical messages can
 * be split across bounded SQS payloads, so their item is complete only after
 * the whole index generation has no remaining unembedded chunks.
 */
export function shouldMarkItemEmbedded(
  message: EmbeddingCompletionMessage,
  pendingGenerationChunks: number
): boolean {
  if (!message.generationId) return true;
  return pendingGenerationChunks === 0;
}
