/**
 * Server-side Voice Instruction Builder
 *
 * Fetches conversation messages from the database and formats them into
 * a system instruction for the Gemini Live voice model. This runs server-side
 * to prevent client-controlled instruction injection.
 *
 * Previously this was done client-side (voice-context-builder.ts), which
 * allowed the client to send arbitrary systemInstruction content to the
 * voice model. Moving it server-side means:
 * - Server verifies conversation ownership before accessing messages
 * - Only actual DB messages are included in the instruction
 * - Client cannot inject arbitrary text into the voice model's system prompt
 *
 * Issue #874, #895
 */

import { createLogger } from "@/lib/logger"
import { getUserIdByCognitoSub } from "@/lib/db/drizzle/users"
import { getConversationById } from "@/lib/db/drizzle/nexus-conversations"
import { getMessagesByConversation, getMessageCount } from "@/lib/db/drizzle/nexus-messages"
import { MAX_SESSION_INSTRUCTION_LENGTH } from "./constants"
import type { MessagePart } from "@/lib/db/drizzle/nexus-messages"

const log = createLogger({ context: "voice-instruction-builder" })

/** Max number of recent messages to include in voice context */
const MAX_CONTEXT_MESSAGES = 20

/**
 * Build a voice system instruction from a conversation's messages.
 *
 * Verifies that the authenticated user owns the conversation, fetches recent
 * messages, and formats them into a system instruction for the voice model.
 *
 * @param conversationId - UUID of the conversation
 * @param cognitoSub - The authenticated user's Cognito sub claim
 * @returns System instruction string, or undefined if the conversation
 *   doesn't exist, isn't owned by this user, or has no messages
 */
export async function buildInstructionFromConversation(
  conversationId: string,
  cognitoSub: string,
): Promise<string | undefined> {
  // Resolve Cognito sub to numeric user ID
  const userIdStr = await getUserIdByCognitoSub(cognitoSub)
  if (!userIdStr) {
    log.warn("Could not resolve user ID from Cognito sub", { cognitoSub })
    return undefined
  }
  const userId = Number.parseInt(userIdStr, 10)

  // Verify the user owns this conversation
  const conversation = await getConversationById(conversationId, userId)
  if (!conversation) {
    log.warn("Conversation not found or not owned by user", { conversationId, userId })
    return undefined
  }

  // Fetch the most recent messages (ordered ASC, so compute offset for tail)
  const totalCount = await getMessageCount(conversationId)
  if (totalCount === 0) return undefined

  const offset = Math.max(totalCount - MAX_CONTEXT_MESSAGES, 0)
  const messages = await getMessagesByConversation(conversationId, {
    limit: MAX_CONTEXT_MESSAGES,
    offset,
    includeModel: false,
  })

  // Extract text from messages
  const contextMessages: { role: string; text: string }[] = []
  for (const msg of messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue

    let text = ""
    if (Array.isArray(msg.parts)) {
      const textParts = (msg.parts as MessagePart[])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
      text = textParts.join("\n")
    } else if (typeof msg.content === "string" && msg.content.trim()) {
      text = msg.content.trim()
    }

    if (text.trim()) {
      contextMessages.push({ role: msg.role, text: text.trim() })
    }
  }

  if (contextMessages.length === 0) return undefined

  return formatInstruction(contextMessages)
}

/** Format extracted messages into a system instruction string. */
function formatInstruction(messages: { role: string; text: string }[]): string {
  const prefix =
    "You are a helpful AI assistant in a voice conversation. " +
    "The user has been having a text conversation with you. " +
    "Here is the recent context from that conversation — use it to maintain continuity, " +
    "but do not repeat or summarize this context unless the user asks about it.\n\n" +
    "Prior conversation:\n"

  const suffix = "\n\nContinue the conversation naturally in voice. Be concise since this is spoken."

  const maxContextLength = MAX_SESSION_INSTRUCTION_LENGTH - prefix.length - suffix.length - 2

  // Build from newest to oldest, then reverse for chronological order
  const contextLines: string[] = []
  let currentLength = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    const label = msg.role === "user" ? "User" : "Assistant"
    const line = `${label}: ${msg.text}`

    if (currentLength + line.length + 1 > maxContextLength) break

    contextLines.unshift(line)
    currentLength += line.length + 1
  }

  if (contextLines.length === 0) return "You are a helpful AI assistant in a voice conversation. Respond naturally and conversationally."

  const instruction = prefix + contextLines.join("\n") + suffix

  log.info("Voice system instruction built from DB", {
    messageCount: contextLines.length,
    totalMessages: messages.length,
    instructionLength: instruction.length,
  })

  return instruction.slice(0, MAX_SESSION_INSTRUCTION_LENGTH)
}
