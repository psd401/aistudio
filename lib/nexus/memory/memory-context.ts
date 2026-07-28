import type { ToolSet } from "ai"
import {
  resolveMemoryAvailability,
  type MemoryAvailability,
} from "./memory-availability"
import {
  buildMemoryChatTools,
  type MemoryChatTools,
} from "./memory-tools"
import {
  memoryService,
  type NexusMemoryService,
  type StoredNexusMemory,
} from "./memory-service"

interface MemoryContextDependencies {
  service: Pick<NexusMemoryService, "retrieve">
  resolveAvailability(input: {
    userId: number
    cognitoSub: string
    conversationId: string
  }): Promise<MemoryAvailability>
  buildTools(input: {
    userId: number
    cognitoSub: string
    conversationId: string
    requestId: string
    memories: StoredNexusMemory[]
  }): MemoryChatTools
}

const DEFAULT_DEPENDENCIES: MemoryContextDependencies = {
  service: memoryService,
  resolveAvailability: resolveMemoryAvailability,
  buildTools: buildMemoryChatTools,
}

export interface NexusMemoryTurnContext {
  enabled: boolean
  reason: MemoryAvailability["reason"]
  tools?: ToolSet
  userMemoryFragment?: string
}

export async function resolveNexusMemoryContext(
  input: {
    userId: number
    cognitoSub: string
    conversationId: string
    latestUserText: string
    requestId: string
  },
  dependencies: MemoryContextDependencies = DEFAULT_DEPENDENCIES,
): Promise<NexusMemoryTurnContext> {
  const availability = await dependencies.resolveAvailability(input)
  if (!availability.enabled) {
    return {
      enabled: false,
      reason: availability.reason,
    }
  }

  const memories = await dependencies.service.retrieve({
    userId: input.userId,
    query: input.latestUserText,
  })
  const memoryTools = dependencies.buildTools({ ...input, memories })

  return {
    enabled: true,
    reason: "enabled",
    tools: memoryTools.tools,
    userMemoryFragment: memoryTools.systemPromptFragment,
  }
}
