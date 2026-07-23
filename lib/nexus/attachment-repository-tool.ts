import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { createLogger } from "@/lib/logger";
import { retrieveRepositoryContent } from "@/lib/repositories/retrieval-v2/service";
import {
  getContentSafetyService,
  type ContentSafetyResult,
} from "@/lib/safety";
import type { TokenMappingSink } from "@/lib/safety/token-mapping-sink";
import { ContentSafetyBlockedError } from "@/lib/streaming/types";

interface CreateNexusAttachmentToolsInput {
  repositoryIds: number[];
  userCognitoSub: string;
  tokenMappingSink: TokenMappingSink;
}

class NexusAttachmentSafetyUnavailableError extends Error {
  constructor() {
    super("Attachment search results could not be safety-checked");
    this.name = "NexusAttachmentSafetyUnavailableError";
  }
}

async function protectRetrievedChunk(input: {
  content: string;
  sessionId: string;
  tokenMappingSink: TokenMappingSink;
  log: ReturnType<typeof createLogger>;
}): Promise<string> {
  let result: ContentSafetyResult;
  try {
    result = await getContentSafetyService().processInput(
      input.content,
      input.sessionId
    );
  } catch (error) {
    // The shared service normally degrades gracefully. If an implementation or
    // test double rejects outright, fail this tool result closed and keep the
    // provider-facing error free of repository bytes.
    input.log.warn("Nexus attachment safety processing failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new NexusAttachmentSafetyUnavailableError();
  }

  if (!result.allowed) {
    throw new ContentSafetyBlockedError(
      result.blockedMessage ||
        "Retrieved attachment content was blocked by safety guardrails",
      result.blockedCategories || [],
      "input"
    );
  }

  input.tokenMappingSink.add(result.tokens || []);
  return result.processedContent;
}

/**
 * Attachment search is a core input tool, not a user-selected capability. The
 * repository IDs come exclusively from owner-validated server bindings and the
 * retrieval service independently revalidates the current principal. Retrieved
 * bytes cross the same safety/PII boundary as prompt text before the external
 * model can consume the tool result.
 */
export function createNexusAttachmentTools(
  input: CreateNexusAttachmentToolsInput
): ToolSet {
  const repositoryIds = [...new Set(input.repositoryIds)].filter(
    (id) => Number.isSafeInteger(id) && id > 0
  );
  if (repositoryIds.length === 0) return {};

  const log = createLogger({
    module: "nexus-attachment-repository-tool",
  });

  return {
    searchNexusAttachments: tool({
      description:
        "Search the documents attached to this Nexus conversation. Use this before answering questions about attachments and cite the returned source labels.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(4_000),
        limit: z.number().int().min(1).max(10).optional().default(5),
      }),
      execute: async ({
        query,
        limit,
      }: {
        query: string;
        limit?: number;
      }) => {
        const result = await retrieveRepositoryContent({
          query,
          repositoryIds,
          userCognitoSub: input.userCognitoSub,
          mode: "hybrid",
          limit: limit ?? 5,
        });
        const hits = await Promise.all(
          result.results.map(async (hit) => ({
            content: await protectRetrievedChunk({
              content:
                hit.context.find(
                  (segment) => segment.chunkId === hit.chunkId
                )?.content ?? hit.content,
              sessionId: input.userCognitoSub,
              tokenMappingSink: input.tokenMappingSink,
              log,
            }),
            source: hit.itemName,
            score: hit.similarity,
            citations: hit.citations.map((citation) => ({
              itemVersionId: citation.itemVersionId,
              chunkId: citation.chunkId,
              label: citation.label,
              sourceLocator: citation.sourceLocator,
            })),
          }))
        );
        log.info("Nexus attachment search completed", {
          repositoryCount: repositoryIds.length,
          resultCount: hits.length,
        });
        return {
          success: true,
          query,
          results: hits,
        };
      },
    }),
  };
}
