import { and, eq } from "drizzle-orm"
import { executeQuery } from "@/lib/db/drizzle-client"
import { nexusConversations, nexusUserPreferences } from "@/lib/db/schema"
import { hasCapabilityAccess } from "@/lib/db/drizzle/capabilities"
import { createLogger } from "@/lib/logger"
import { getSetting } from "@/lib/settings-manager"

export type MemoryGateReason =
  | "enabled"
  | "global-disabled"
  | "capability-denied"
  | "user-disabled"
  | "conversation-disabled"
  | "conversation-not-found"
  | "gate-error"

export interface MemoryGateInputs {
  globalEnabled: boolean
  capabilityGranted: boolean
  userEnabled: boolean
  conversationOwned: boolean
  conversationEnabled: boolean
}

export interface MemoryAvailability {
  enabled: boolean
  reason: MemoryGateReason
}

export function evaluateMemoryGates(
  gates: MemoryGateInputs,
): MemoryAvailability {
  if (!gates.globalEnabled) {
    return { enabled: false, reason: "global-disabled" }
  }
  if (!gates.capabilityGranted) {
    return { enabled: false, reason: "capability-denied" }
  }
  if (!gates.userEnabled) {
    return { enabled: false, reason: "user-disabled" }
  }
  if (!gates.conversationOwned) {
    return { enabled: false, reason: "conversation-not-found" }
  }
  if (!gates.conversationEnabled) {
    return { enabled: false, reason: "conversation-disabled" }
  }
  return { enabled: true, reason: "enabled" }
}

function enabledSetting(value: string | null): boolean {
  if (value === null || value.trim() === "") return true
  return !["false", "0", "off", "no"].includes(value.trim().toLowerCase())
}

export async function isNexusMemoryGloballyEnabled(): Promise<boolean> {
  return enabledSetting(await getSetting("NEXUS_MEMORY_ENABLED"))
}

export async function isNexusMemoryEnabledForUser(
  userId: number,
): Promise<boolean> {
  const [preference] = await executeQuery(
    (db) =>
      db
        .select({ settings: nexusUserPreferences.settings })
        .from(nexusUserPreferences)
        .where(eq(nexusUserPreferences.userId, userId))
        .limit(1),
    "loadNexusMemoryUserToggle",
  )
  return preference?.settings?.memoryEnabled !== false
}

async function loadConversationGate(
  conversationId: string,
  userId: number,
): Promise<{ owned: boolean; enabled: boolean }> {
  const [conversation] = await executeQuery(
    (db) =>
      db
        .select({ metadata: nexusConversations.metadata })
        .from(nexusConversations)
        .where(
          and(
            eq(nexusConversations.id, conversationId),
            eq(nexusConversations.userId, userId),
          ),
        )
        .limit(1),
    "loadNexusMemoryConversationToggle",
  )
  return {
    owned: conversation !== undefined,
    enabled: conversation?.metadata?.memoryDisabled !== true,
  }
}

export async function resolveMemoryAvailability(input: {
  userId: number
  cognitoSub: string
  conversationId: string
}): Promise<MemoryAvailability> {
  const log = createLogger({
    module: "nexus-memory-availability",
    userId: String(input.userId),
  })
  try {
    const [globalSetting, capabilityGranted, userEnabled, conversation] =
      await Promise.all([
        isNexusMemoryGloballyEnabled(),
        hasCapabilityAccess(input.cognitoSub, "nexus-memory"),
        isNexusMemoryEnabledForUser(input.userId),
        loadConversationGate(input.conversationId, input.userId),
      ])
    return evaluateMemoryGates({
      globalEnabled: globalSetting,
      capabilityGranted,
      userEnabled,
      conversationOwned: conversation.owned,
      conversationEnabled: conversation.enabled,
    })
  } catch (error) {
    // Gate failures disable memory but do not fail the chat turn.
    log.error("Nexus memory gate resolution failed", {
      conversationId: input.conversationId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { enabled: false, reason: "gate-error" }
  }
}

export async function resolveMemoryControlAvailability(input: {
  userId: number
  cognitoSub: string
}): Promise<boolean> {
  try {
    const [globalSetting, capabilityGranted] = await Promise.all([
      isNexusMemoryGloballyEnabled(),
      hasCapabilityAccess(input.cognitoSub, "nexus-memory"),
    ])
    return globalSetting && capabilityGranted
  } catch {
    return false
  }
}
