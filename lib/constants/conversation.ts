/**
 * Conversation Constants
 *
 * Shared sentinel values used across conversation creation, title detection,
 * and voice transcript persistence. Centralizing these prevents silent
 * coupling failures if a default value changes in one location.
 */

/**
 * Default title assigned to new conversations when no title is provided.
 *
 * Used by:
 * - nexus-conversations.ts (conversation creation default)
 * - transcript-service.ts (detect untitled conversations for auto-titling)
 */
export const DEFAULT_CONVERSATION_TITLE = "New Conversation"
