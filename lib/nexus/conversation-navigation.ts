/**
 * Utility functions for secure conversation navigation and validation
 */

import { createLogger } from '@/lib/client-logger'

const log = createLogger({ moduleName: 'conversation-navigation' })

/**
 * Validates a conversation ID format
 * @param conversationId - The conversation ID to validate
 * @returns true if the conversation ID is valid, false otherwise
 */
export function validateConversationId(conversationId: string | null | undefined): conversationId is string {
  if (!conversationId) return false
  return /^[\w-]{1,50}$/.test(conversationId)
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