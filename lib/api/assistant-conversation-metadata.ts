import { z } from "zod";

const assistantConversationMetadataSchema = z
  .object({
    assistantId: z.number().int().positive().safe(),
    runtimeRepositoryIds: z
      .array(z.number().int().positive().safe())
      .max(10)
      .default([]),
  })
  .passthrough();

export interface BoundAssistantConversationMetadata {
  assistantId: number;
  runtimeRepositoryIds: number[];
}

/**
 * Parse the server-owned fields that bind an API conversation to an assistant
 * and its runtime attachment repositories. Missing or malformed bindings fail
 * closed so a caller cannot replay a conversation through another assistant
 * path or widen its repository set with hand-edited JSONB.
 */
export function parseBoundAssistantConversationMetadata(
  metadata: unknown
): BoundAssistantConversationMetadata | null {
  const parsed = assistantConversationMetadataSchema.safeParse(metadata);
  if (!parsed.success) return null;
  return {
    assistantId: parsed.data.assistantId,
    runtimeRepositoryIds: [...new Set(parsed.data.runtimeRepositoryIds)],
  };
}
