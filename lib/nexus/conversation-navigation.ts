/**
 * Utility functions for secure conversation navigation and validation
 */

import { createLogger } from '@/lib/client-logger'

const log = createLogger({ moduleName: 'conversation-navigation' })

/**
 * Validates a conversation ID format (RFC 4122 UUID v4)
 * @param conversationId - The conversation ID to validate
 * @returns true if the conversation ID is a valid UUID v4, false otherwise
 */
export function validateConversationId(conversationId: string | null | undefined): conversationId is string {
  if (!conversationId) return false

  // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  // - 8-4-4-4-12 hexadecimal digits separated by hyphens
  // - Third group starts with '4' (version 4)
  // - Fourth group starts with '8', '9', 'a', or 'b' (variant bits)
  const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

  return uuidV4Pattern.test(conversationId)
}

/**
 * Securely navigate to a conversation with validation
 * @param conversationId - The conversation ID to navigate to (null for new conversation)
 */
export function navigateToConversation(conversationId: string | null) {
  try {
    if (conversationId && validateConversationId(conversationId)) {
      const targetUrl = `/nexus?id=${conversationId}`
      // Validate the constructed URL before navigation
      if (targetUrl.startsWith('/nexus')) {
        window.location.href = targetUrl
      } else {
        log.error('Invalid target URL constructed', { targetUrl })
        window.location.href = '/nexus'
      }
    } else if (conversationId) {
      log.warn('Invalid conversation ID for navigation', { conversationId })
      window.location.href = '/nexus'
    } else {
      window.location.href = '/nexus'
    }
  } catch (error) {
    log.error('Error during navigation', { error, conversationId })
    // Fallback to safe navigation
    window.location.href = '/nexus'
  }
}

/**
 * Securely navigate to a new conversation
 */
export function navigateToNewConversation() {
  window.location.href = '/nexus'
}

/**
 * Securely navigate to a decision capture conversation with validation
 * @param conversationId - The conversation ID to navigate to (null for new session)
 */
export function navigateToDecisionCaptureConversation(conversationId: string | null) {
  try {
    if (conversationId && validateConversationId(conversationId)) {
      const targetUrl = `/nexus/decision-capture?id=${conversationId}`
      if (targetUrl.startsWith('/nexus/decision-capture')) {
        window.location.href = targetUrl
      } else {
        log.error('Invalid target URL constructed', { targetUrl })
        window.location.href = '/nexus/decision-capture'
      }
    } else if (conversationId) {
      log.warn('Invalid conversation ID for decision capture navigation', { conversationId })
      window.location.href = '/nexus/decision-capture'
    } else {
      window.location.href = '/nexus/decision-capture'
    }
  } catch (error) {
    log.error('Error during decision capture navigation', { error, conversationId })
    window.location.href = '/nexus/decision-capture'
  }
}

/**
 * Securely navigate to a new decision capture session
 */
export function navigateToNewDecisionCapture() {
  window.location.href = '/nexus/decision-capture'
}