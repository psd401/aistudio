/**
 * Voice Transcript Persistence Service
 *
 * Converts voice conversation transcripts into standard Nexus messages,
 * runs them through Bedrock content safety guardrails, and saves to the
 * existing conversation infrastructure so users can continue in text mode.
 *
 * Flow:
 *   1. Receive ordered TranscriptEntry[] from voice session
 *   2. Filter to final entries only, merge consecutive same-role entries
 *   3. Run each message through Bedrock guardrails (content safety)
 *   4. Replace flagged content with "[Content filtered by safety policy]"
 *   5. Save all messages + update conversation metadata in a single transaction
 *   6. Generate title from first user message if conversation is new
 *
 * Issue #875
 */

import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { sql, eq } from "drizzle-orm"
import { executeTransaction } from "@/lib/db/drizzle-client"
import { nexusMessages, nexusConversations } from "@/lib/db/schema"
import { safeJsonbStringify } from "@/lib/db/json-utils"
import { getContentSafetyService } from "@/lib/safety"
import { getConversationById } from "@/lib/db/drizzle/nexus-conversations"
import type { TranscriptEntry } from "./types"

/**
 * Default conversation title — shared sentinel used by conversation creation
 * (nexus-conversations.ts, chat-helpers.ts, route.ts) to detect untitled conversations.
 */
const DEFAULT_CONVERSATION_TITLE = "New Conversation"

// ============================================
// Types
// ============================================

/** Result of saving a voice transcript */
export interface TranscriptSaveResult {
  /** Number of messages saved */
  messageCount: number
  /** Number of messages that had content filtered by guardrails */
  filteredCount: number
  /** Whether a title was auto-generated for the conversation */
  titleGenerated: boolean
  /** Processing time in milliseconds */
  processingTimeMs: number
}

/** A transcript entry after guardrail processing */
interface ProcessedEntry {
  role: "user" | "assistant"
  text: string
  timestamp: Date
  /** Whether guardrails modified this entry's content */
  wasFiltered: boolean
}

// ============================================
// Constants
// ============================================

/** Maximum number of transcript entries to process in one save operation */
const MAX_TRANSCRIPT_ENTRIES = 500

/** Placeholder text for content blocked by safety guardrails */
const FILTERED_CONTENT_NOTICE = "[Content filtered by safety policy]"

/** Maximum title length (matches DB constraint of 500, but we target 40 for consistency) */
const MAX_TITLE_LENGTH = 40

/** Max concurrent guardrail checks — entries are processed in sequential batches of this size */
const GUARDRAIL_CONCURRENCY_LIMIT = 20

const log = createLogger({ module: "TranscriptService" })

// ============================================
// Public API
// ============================================

/**
 * Save a voice transcript to the conversation as standard Nexus messages.
 *
 * This is the main entry point called by the voice session lifecycle when
 * a session ends. It handles:
 * - Filtering to final transcript entries only
 * - Merging consecutive same-role entries
 * - Running content through Bedrock guardrails
 * - Atomic save of all messages + conversation metadata update
 * - Auto-generating a title for new conversations
 *
 * @param conversationId - UUID of the existing conversation
 * @param userId - Numeric user ID (for ownership verification)
 * @param transcript - Ordered array of transcript entries from the voice session
 * @param voiceModel - The voice model identifier (e.g. "gemini-2.0-flash-live-001")
 * @param voiceProvider - The voice provider identifier (e.g. "gemini-live") for guardrail audit trails
 * @returns Result with message count, filtered count, and processing time
 * @throws Error if conversation not found/not owned, or transaction fails
 */
export async function saveVoiceTranscript(
  conversationId: string,
  userId: number,
  transcript: TranscriptEntry[],
  voiceModel?: string,
  voiceProvider?: string,
): Promise<TranscriptSaveResult> {
  const requestId = generateRequestId()
  const timer = startTimer("saveVoiceTranscript")

  log.info("Saving voice transcript", {
    requestId,
    conversationId,
    userId,
    rawEntryCount: transcript.length,
    voiceModel,
  })

  try {
    // Step 1: Verify conversation exists and is owned by user
    // getConversationById checks both id AND userId (ownership) — returns null for either mismatch
    const conversation = await getConversationById(conversationId, userId)
    if (!conversation) {
      throw new Error("Conversation not found or access denied")
    }

    // Step 2: Prepare entries — filter non-final, merge consecutive same-role
    const mergedEntries = prepareTranscriptEntries(transcript)

    if (mergedEntries.length === 0) {
      log.info("No transcript entries to save after preparation", { requestId })
      const elapsed = timer({ status: "empty" })
      return { messageCount: 0, filteredCount: 0, titleGenerated: false, processingTimeMs: typeof elapsed === "number" ? elapsed : 0 }
    }

    log.info("Transcript entries prepared", {
      requestId,
      rawCount: transcript.length,
      mergedCount: mergedEntries.length,
    })

    // Step 3: Run content through Bedrock guardrails
    const processedEntries = await applyGuardrails(mergedEntries, conversationId, requestId, voiceModel, voiceProvider)
    const filteredCount = processedEntries.filter((e) => e.wasFiltered).length

    if (filteredCount > 0) {
      log.warn("Voice transcript entries filtered by guardrails", {
        requestId,
        conversationId,
        filteredCount,
        totalCount: processedEntries.length,
      })
    }

    // Step 4: Determine if title needs to be auto-generated
    const needsTitle = !conversation.title || conversation.title === DEFAULT_CONVERSATION_TITLE
    const autoTitle = needsTitle ? generateVoiceTitle(processedEntries) : null

    // Step 5: Atomic save — all messages + conversation metadata in one transaction
    await executeTransaction(
      async (tx) => {
        // Insert all messages
        const messageValues = processedEntries.map((entry) => ({
          conversationId,
          role: entry.role,
          content: entry.text,
          parts: sql`${safeJsonbStringify([{ type: "text", text: entry.text }])}::jsonb`,
          metadata: sql`${safeJsonbStringify({
            source: "voice",
            ...(entry.wasFiltered ? { filtered: true } : {}),
          })}::jsonb`,
          createdAt: entry.timestamp,
        }))

        // processedEntries is guaranteed non-empty (early return above for empty case)
        await tx.insert(nexusMessages).values(messageValues)

        // Update conversation metadata — use explicit typed fields to prevent
        // silent no-ops from misspelled column names (CLAUDE.md silent failure pattern)
        await tx
          .update(nexusConversations)
          .set({
            messageCount: sql`COALESCE(${nexusConversations.messageCount}, 0) + ${processedEntries.length}`,
            lastMessageAt: processedEntries[processedEntries.length - 1].timestamp,
            updatedAt: new Date(),
            ...(voiceModel ? { modelUsed: voiceModel } : {}),
            ...(autoTitle ? { title: autoTitle } : {}),
          })
          .where(eq(nexusConversations.id, conversationId))
      },
      "saveVoiceTranscript",
    )

    const elapsed = timer({ status: "success" })
    log.info("Voice transcript saved", {
      requestId,
      conversationId,
      messageCount: processedEntries.length,
      filteredCount,
      titleGenerated: !!autoTitle,
      processingTimeMs: elapsed,
    })

    return {
      messageCount: processedEntries.length,
      filteredCount,
      titleGenerated: !!autoTitle,
      processingTimeMs: typeof elapsed === "number" ? elapsed : 0,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error("Failed to save voice transcript", {
      requestId,
      conversationId,
      error: message,
    })
    timer({ status: "error" })
    throw error
  }
}

// ============================================
// Internal Functions
// ============================================

/**
 * Prepare transcript entries for persistence:
 * 1. Filter to final entries only (isFinal === true)
 * 2. Skip entries with empty text
 * 3. Merge consecutive entries from the same role
 * 4. Cap at MAX_TRANSCRIPT_ENTRIES
 *
 * Merging is important because Gemini Live can emit multiple transcript
 * fragments for a single "turn" (e.g., partial sentences). Merging them
 * produces cleaner messages that read naturally in the text UI.
 */
export function prepareTranscriptEntries(
  entries: TranscriptEntry[],
): Array<{ role: "user" | "assistant"; text: string; timestamp: Date }> {
  // Step 1: Filter to final, non-empty entries
  const finalEntries = entries.filter(
    (e) => e.isFinal && e.text.trim().length > 0,
  )

  if (finalEntries.length === 0) return []

  // Step 2: Merge consecutive same-role entries
  const merged: Array<{ role: "user" | "assistant"; text: string; timestamp: Date }> = []

  for (const entry of finalEntries) {
    const last = merged[merged.length - 1]
    if (last && last.role === entry.role) {
      // Append text with a space separator, keep the earlier timestamp
      last.text = `${last.text} ${entry.text.trim()}`
    } else {
      merged.push({
        role: entry.role,
        text: entry.text.trim(),
        timestamp: entry.timestamp,
      })
    }
  }

  // Step 3: Cap at maximum — log if truncation occurs so data loss is visible
  if (merged.length > MAX_TRANSCRIPT_ENTRIES) {
    log.warn("Transcript truncated to maximum entry limit", {
      originalCount: merged.length,
      maxEntries: MAX_TRANSCRIPT_ENTRIES,
      droppedCount: merged.length - MAX_TRANSCRIPT_ENTRIES,
    })
  }
  return merged.slice(0, MAX_TRANSCRIPT_ENTRIES)
}

/**
 * Apply Bedrock content safety guardrails to transcript entries.
 *
 * Processes entries in batches to avoid overwhelming the guardrails API.
 * If an individual entry is flagged, its content is replaced with the
 * filtered notice — the entry is NOT removed from the transcript.
 *
 * On guardrail service error (disabled, unavailable), entries pass through
 * unmodified (graceful degradation — consistent with existing pattern).
 */
async function applyGuardrails(
  entries: Array<{ role: "user" | "assistant"; text: string; timestamp: Date }>,
  conversationId: string,
  requestId: string,
  voiceModel?: string,
  voiceProvider?: string,
): Promise<ProcessedEntry[]> {
  const safetySvc = getContentSafetyService()

  if (!safetySvc.isGuardrailsEnabled()) {
    log.info("Guardrails disabled, skipping transcript safety check", { requestId })
    return entries.map((e) => ({ ...e, wasFiltered: false }))
  }

  const processed: ProcessedEntry[] = []

  // Process in batches
  for (let i = 0; i < entries.length; i += GUARDRAIL_CONCURRENCY_LIMIT) {
    const batch = entries.slice(i, i + GUARDRAIL_CONCURRENCY_LIMIT)

    // Process each entry in the batch concurrently
    const batchResults = await Promise.all(
      batch.map(async (entry) => {
        try {
          const sessionId = `voice-${conversationId}`

          // Use the appropriate check based on role
          const result = entry.role === "user"
            ? await safetySvc.checkInputSafety(entry.text, sessionId)
            : await safetySvc.checkOutputSafety(entry.text, voiceModel ?? "unknown-voice-model", voiceProvider ?? "unknown-voice-provider", sessionId)

          if (!result.allowed) {
            log.warn("Voice transcript entry filtered by guardrails", {
              requestId,
              role: entry.role,
              blockedReason: result.blockedReason,
              blockedCategories: result.blockedCategories,
            })
            return {
              role: entry.role,
              text: FILTERED_CONTENT_NOTICE,
              timestamp: entry.timestamp,
              wasFiltered: true,
            }
          }

          return { ...entry, wasFiltered: false }
        } catch (error) {
          // Graceful degradation — allow entry through on error
          const message = error instanceof Error ? error.message : String(error)
          log.warn("Guardrail check failed for transcript entry, allowing through", {
            requestId,
            role: entry.role,
            error: message,
          })
          return { ...entry, wasFiltered: false }
        }
      }),
    )

    processed.push(...batchResults)
  }

  return processed
}

/**
 * Generate a conversation title from the first user message in the transcript.
 * Follows the same pattern as generateConversationTitle in chat-helpers.ts:
 * - Extract first user text
 * - Clean whitespace
 * - Truncate to MAX_TITLE_LENGTH chars with ellipsis
 */
function generateVoiceTitle(entries: ProcessedEntry[]): string | null {
  const firstUserEntry = entries.find(
    (e) => e.role === "user" && e.text !== FILTERED_CONTENT_NOTICE,
  )

  if (!firstUserEntry) return null

  const cleaned = firstUserEntry.text.replace(/\s+/g, " ").trim()
  if (!cleaned) return null

  if (cleaned.length <= MAX_TITLE_LENGTH) return cleaned
  return `${cleaned.slice(0, MAX_TITLE_LENGTH).trim()}...`
}
