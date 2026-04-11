/**
 * Voice Context Builder
 *
 * Fetches conversation messages and formats them into a system instruction
 * for the voice model. This gives the voice AI context about what was
 * previously discussed in text, enabling seamless text-to-voice transitions.
 *
 * The system instruction is truncated to stay within Gemini Live's context
 * limits (10K characters max, matching the server-side MAX_SESSION_INSTRUCTION_LENGTH).
 *
 * Issue #874
 */

import { createLogger } from '@/lib/client-logger'

const log = createLogger({ moduleName: 'voice-context-builder' })

/** Max characters for the system instruction (must match ws-handler MAX_SESSION_INSTRUCTION_LENGTH) */
const MAX_INSTRUCTION_LENGTH = 10_000

/** Simple message representation for context building */
export interface ContextMessage {
  role: 'user' | 'assistant'
  text: string
}

/**
 * Fetch recent messages from a conversation for voice context.
 *
 * Uses the existing /api/nexus/conversations/[id]/messages endpoint.
 * Only fetches text content — images, tool calls, and other non-text
 * parts are excluded from voice context as they can't be meaningfully
 * summarized in a system instruction.
 *
 * @param conversationId - UUID of the conversation
 * @param maxMessages - Maximum number of recent messages to fetch
 * @returns Array of simplified messages with role and text content
 */
export async function fetchConversationContext(
  conversationId: string,
  maxMessages: number,
): Promise<ContextMessage[]> {
  // Clamp to a safe range — server validates too, but defensive at call site
  const clampedLimit = Math.min(Math.max(maxMessages, 1), 100)
  const baseUrl = `/api/nexus/conversations/${encodeURIComponent(conversationId)}/messages`

  // Fetch a larger window than needed to avoid a two-request count→fetch race (TOCTOU).
  // The messages endpoint returns rows ordered by createdAt ASC (oldest first) and
  // does not support DESC ordering. Previously we fetched count first, computed offset,
  // then fetched — but messages arriving between the two requests would skew the window.
  //
  // Instead: request a generous window (3× the desired limit) starting from offset 0.
  // We then take only the LAST clampedLimit messages from the result. For typical
  // conversations (< 300 messages) this returns all messages in one call. For very
  // large conversations we may miss the absolute newest messages if there are more
  // than fetchLimit total — this is an accepted trade-off vs. adding DESC support
  // to the endpoint (which would be a larger change).
  const fetchLimit = Math.min(clampedLimit * 3, 1000)
  const response = await fetch(`${baseUrl}?limit=${fetchLimit}&offset=0`)

  if (!response.ok) {
    log.warn('Failed to fetch conversation messages for voice context', {
      status: response.status,
      conversationId,
    })
    return []
  }

  let data: Record<string, unknown>
  try {
    data = await response.json()
  } catch {
    log.warn('Failed to parse conversation messages response', { conversationId })
    return []
  }

  const messages: ContextMessage[] = []

  if (!Array.isArray(data.messages)) {
    return []
  }

  for (const msg of data.messages) {
    const role = msg.role as string
    if (role !== 'user' && role !== 'assistant') continue

    // Extract text from content array (skip non-text parts)
    let text = ''
    if (Array.isArray(msg.content)) {
      const textParts = msg.content
        .filter((part: Record<string, unknown>) => part.type === 'text' && typeof part.text === 'string')
        .map((part: Record<string, unknown>) => part.text as string)
      text = textParts.join('\n')
    }

    if (text.trim()) {
      messages.push({ role: role as 'user' | 'assistant', text: text.trim() })
    }
  }

  // Return only the most recent messages (endpoint returns ASC order so tail = newest)
  return messages.length > clampedLimit ? messages.slice(-clampedLimit) : messages
}

/**
 * Build a system instruction for the voice model that includes
 * prior conversation context.
 *
 * The instruction is structured to give the voice model awareness of
 * the text conversation without overwhelming its context window.
 * Messages are truncated from the oldest if the total exceeds the limit.
 *
 * @param opts.priorMessages - Recent conversation messages
 * @returns A formatted system instruction string
 */
export function buildVoiceSystemInstruction(opts: {
  priorMessages: ContextMessage[]
}): string {
  const { priorMessages } = opts

  if (priorMessages.length === 0) {
    return 'You are a helpful AI assistant in a voice conversation. Respond naturally and conversationally.'
  }

  const prefix =
    'You are a helpful AI assistant in a voice conversation. ' +
    'The user has been having a text conversation with you. ' +
    'Here is the recent context from that conversation — use it to maintain continuity, ' +
    'but do not repeat or summarize this context unless the user asks about it.\n\n' +
    'Prior conversation:\n'

  const suffix = '\n\nContinue the conversation naturally in voice. Be concise since this is spoken.'

  // Compute available context budget from actual prefix/suffix lengths (+2 for joining newlines)
  const maxContextLength = MAX_INSTRUCTION_LENGTH - prefix.length - suffix.length - 2

  // Build context from most recent messages, trimming oldest if needed
  const contextLines: string[] = []
  let currentLength = 0

  // Iterate from newest to oldest, then reverse for chronological order
  for (let i = priorMessages.length - 1; i >= 0; i--) {
    const msg = priorMessages[i]
    const label = msg.role === 'user' ? 'User' : 'Assistant'
    const line = `${label}: ${msg.text}`

    if (currentLength + line.length + 1 > maxContextLength) {
      // Would exceed limit — stop adding older messages
      break
    }

    contextLines.unshift(line)
    currentLength += line.length + 1 // +1 for newline
  }

  if (contextLines.length === 0) {
    return 'You are a helpful AI assistant in a voice conversation. Respond naturally and conversationally.'
  }

  const instruction = prefix + contextLines.join('\n') + suffix
  log.debug('Voice system instruction built', {
    messageCount: contextLines.length,
    totalMessages: priorMessages.length,
    instructionLength: instruction.length,
  })

  return instruction.slice(0, MAX_INSTRUCTION_LENGTH)
}
