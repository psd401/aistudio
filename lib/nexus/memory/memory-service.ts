import { getContentSafetyService } from "@/lib/safety"
import { ContentSafetyBlockedError } from "@/lib/streaming/types"
import { createLogger } from "@/lib/logger"
import { getSetting } from "@/lib/settings-manager"
import type {
  NexusMemoryCategory,
  NexusMemorySource,
} from "@/lib/db/schema"
import { generateMemoryEmbedding } from "./memory-embeddings"
import {
  drizzleMemoryRepository,
  type MemoryRepository,
  type MemoryWriteResult,
  type StoredNexusMemory,
} from "./memory-repository"

export const MEMORY_DEDUP_THRESHOLD = 0.9
const DEFAULT_RETRIEVAL_THRESHOLD = 0.3
const DEFAULT_RETRIEVAL_TOP_K = 6
const MAX_RETRIEVAL_TOP_K = 20
const MAX_MEMORY_CONTENT_CHARS = 8_000
const PII_PLACEHOLDER_PATTERN = /\[PII:[^\]\r\n]+\]/i

interface SafetyResult {
  allowed: boolean
  processedContent: string
  hasPII?: boolean
  blockedMessage?: string
  blockedCategories?: string[]
}

interface MemoryServiceDependencies {
  repository: MemoryRepository
  processInput(content: string, sessionId: string): Promise<SafetyResult>
  generateEmbedding(content: string): Promise<number[]>
  getSetting(key: string): Promise<string | null>
}

export interface SaveMemoryInput {
  userId: number
  sessionId: string
  content: string
  category: NexusMemoryCategory
  source: NexusMemorySource
  sourceConversationId?: string
}

export interface RetrieveMemoryInput {
  userId: number
  query: string
}

export interface NexusMemoryService {
  save(input: SaveMemoryInput): Promise<MemoryWriteResult>
  retrieve(input: RetrieveMemoryInput): Promise<StoredNexusMemory[]>
  forget(memoryId: string, userId: number): Promise<boolean>
}

function boundedTopK(raw: string | null): number {
  const parsed =
    raw === null || raw.trim() === "" ? Number.NaN : Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return DEFAULT_RETRIEVAL_TOP_K
  }
  return Math.min(parsed, MAX_RETRIEVAL_TOP_K)
}

function boundedThreshold(raw: string | null): number {
  const parsed =
    raw === null || raw.trim() === "" ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_RETRIEVAL_THRESHOLD
}

function validateInput(input: SaveMemoryInput): string {
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0) {
    throw new Error("A positive Nexus memory owner id is required")
  }
  const content = input.content.trim()
  if (!content) {
    throw new Error("Memory content cannot be empty")
  }
  if (content.length > MAX_MEMORY_CONTENT_CHARS) {
    throw new Error(
      `Memory content cannot exceed ${MAX_MEMORY_CONTENT_CHARS} characters`,
    )
  }
  return content
}

export function createMemoryService(
  dependencies: MemoryServiceDependencies,
): NexusMemoryService {
  const log = createLogger({ module: "nexus-memory-service" })

  return {
    async save(input) {
      const content = validateInput(input)

      // Non-negotiable safety choke point: EVERY current and future write
      // enters here before embedding or database access. System-prompt memory is
      // not re-screened later, so reordering this would expose raw user content.
      const safety = await dependencies.processInput(content, input.sessionId)
      if (!safety.allowed) {
        throw new ContentSafetyBlockedError(
          safety.blockedMessage || "This memory cannot be saved",
          safety.blockedCategories || [],
          "input",
        )
      }
      const sanitized = safety.processedContent.trim()
      if (
        safety.hasPII === true ||
        PII_PLACEHOLDER_PATTERN.test(sanitized)
      ) {
        // PII token mappings intentionally expire after one hour. Persisting
        // their placeholders would corrupt durable memory once the mapping
        // expires, while detokenizing here would store raw PII. Reject the
        // write after the mandatory safety pass instead.
        throw new ContentSafetyBlockedError(
          "For privacy, personal information cannot be saved to memory.",
          ["pii"],
          "input",
        )
      }
      if (!sanitized) {
        throw new Error("Memory content is empty after safety processing")
      }
      if (
        input.sourceConversationId &&
        !(await dependencies.repository.conversationIsOwned(
          input.sourceConversationId,
          input.userId,
        ))
      ) {
        throw new Error("Memory source conversation not found")
      }

      // Side effect stays outside the retryable database transaction.
      const embedding = await dependencies.generateEmbedding(sanitized)
      return dependencies.repository.saveWithDedup(
        {
          userId: input.userId,
          content: sanitized,
          category: input.category,
          source: input.source,
          sourceConversationId: input.sourceConversationId,
          embedding,
        },
        MEMORY_DEDUP_THRESHOLD,
      )
    },

    async retrieve(input) {
      try {
        const profilePromise =
          dependencies.repository.listProfileMemories(input.userId)
        const relevantPromise = input.query.trim()
          ? (async (): Promise<StoredNexusMemory[]> => {
              try {
                const [thresholdSetting, topKSetting, embedding] =
                  await Promise.all([
                    dependencies.getSetting("MEMORY_RETRIEVAL_THRESHOLD"),
                    dependencies.getSetting("MEMORY_RETRIEVAL_TOP_K"),
                    dependencies.generateEmbedding(input.query),
                  ])
                return dependencies.repository.findRelevantMemories(
                  input.userId,
                  embedding,
                  boundedThreshold(thresholdSetting),
                  boundedTopK(topKSetting),
                )
              } catch (error) {
                // Profile facts are always injected. A relevance failure must
                // not discard profile rows that do not need query embedding.
                log.warn(
                  "Nexus relevant-memory retrieval failed; using profile only",
                  {
                    userId: input.userId,
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                )
                return []
              }
            })()
          : Promise.resolve([])
        const [profile, relevant] = await Promise.all([
          profilePromise,
          relevantPromise,
        ])
        const seen = new Set(profile.map((memory) => memory.id))
        return [
          ...profile,
          ...relevant.filter((memory) => !seen.has(memory.id)),
        ]
      } catch (error) {
        // Profile/database failures are fail-open: memory never takes chat down.
        log.warn("Nexus memory retrieval failed; continuing without memory", {
          userId: input.userId,
          error: error instanceof Error ? error.message : String(error),
        })
        return []
      }
    },

    forget(memoryId, userId) {
      return dependencies.repository.softDeleteOwned(memoryId, userId)
    },
  }
}

export const memoryService = createMemoryService({
  repository: drizzleMemoryRepository,
  processInput: (content, sessionId) =>
    getContentSafetyService().processInput(content, sessionId),
  generateEmbedding: generateMemoryEmbedding,
  getSetting,
})

export type { StoredNexusMemory }
