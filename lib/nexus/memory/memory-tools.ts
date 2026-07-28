import { tool, type ToolSet } from "ai"
import { z } from "zod"
import {
  NEXUS_MEMORY_CATEGORIES,
  type NexusMemoryCategory,
} from "@/lib/db/schema"
import { createLogger } from "@/lib/logger"
import { ContentSafetyBlockedError } from "@/lib/streaming/types"
import {
  resolveMemoryAvailability,
  type MemoryAvailability,
} from "./memory-availability"
import { buildUserMemoryFragment } from "./memory-fragment"
import {
  memoryService,
  type NexusMemoryService,
  type StoredNexusMemory,
} from "./memory-service"

export interface MemoryChatTools {
  tools: ToolSet
  systemPromptFragment?: string
}

interface MemoryToolDependencies {
  service: NexusMemoryService
  resolveAvailability(input: {
    userId: number
    cognitoSub: string
    conversationId: string
  }): Promise<MemoryAvailability>
}

const DEFAULT_DEPENDENCIES: MemoryToolDependencies = {
  service: memoryService,
  resolveAvailability: resolveMemoryAvailability,
}

export function buildMemoryChatTools(
  input: {
    userId: number
    cognitoSub: string
    conversationId: string
    requestId: string
    memories?: StoredNexusMemory[]
  },
  dependencies: MemoryToolDependencies = DEFAULT_DEPENDENCIES,
): MemoryChatTools {
  const log = createLogger({
    requestId: input.requestId,
    module: "nexus-memory-tools",
  })
  const ownedMemories = (input.memories ?? []).filter(
    (memory) => memory.userId === input.userId,
  )
  const surfacedMemoryIds = new Set(
    ownedMemories.map((memory) => memory.id),
  )

  async function writeStillEnabled(): Promise<boolean> {
    const availability = await dependencies.resolveAvailability({
      userId: input.userId,
      cognitoSub: input.cognitoSub,
      conversationId: input.conversationId,
    })
    return availability.enabled
  }

  return {
    tools: {
      saveMemory: tool({
        description:
          "Save a durable non-personal fact the user explicitly asks you to remember, such as a non-identifying role, preference, or ongoing working context. Do not save personal information, transient requests, or inferred sensitive facts.",
        inputSchema: z.object({
          content: z.string().trim().min(1).max(8_000),
          category: z.enum(NEXUS_MEMORY_CATEGORIES).default("context"),
        }),
        execute: async ({
          content,
          category,
        }: {
          content: string
          category: NexusMemoryCategory
        }): Promise<Record<string, unknown>> => {
          if (!(await writeStillEnabled())) {
            return { error: "Memory is disabled for this conversation." }
          }
          try {
            const result = await dependencies.service.save({
              userId: input.userId,
              sessionId: input.cognitoSub,
              content,
              category,
              source: "tool",
              sourceConversationId: input.conversationId,
            })
            return {
              ok: true,
              memoryId: result.memory.id,
              action: result.action,
            }
          } catch (error) {
            if (error instanceof ContentSafetyBlockedError) {
              return { error: error.blockedMessage }
            }
            log.error("saveMemory failed", {
              userId: input.userId,
              error: error instanceof Error ? error.message : String(error),
            })
            return { error: "The memory could not be saved." }
          }
        },
      }),
      forgetMemory: tool({
        description:
          "Forget one previously recalled memory when the user explicitly asks to remove it. Use only a memory id made available in this turn.",
        inputSchema: z.object({
          memoryId: z.string().uuid(),
        }),
        execute: async ({
          memoryId,
        }: {
          memoryId: string
        }): Promise<Record<string, unknown>> => {
          if (!(await writeStillEnabled())) {
            return { error: "Memory is disabled for this conversation." }
          }
          if (!surfacedMemoryIds.has(memoryId)) {
            return { error: "Memory is not available in this turn." }
          }
          try {
            const deleted = await dependencies.service.forget(
              memoryId,
              input.userId,
            )
            return deleted
              ? { ok: true, memoryId }
              : { error: "Memory not found." }
          } catch (error) {
            log.error("forgetMemory failed", {
              userId: input.userId,
              error: error instanceof Error ? error.message : String(error),
            })
            return { error: "The memory could not be forgotten." }
          }
        },
      }),
    },
    systemPromptFragment: buildUserMemoryFragment(ownedMemories),
  }
}
