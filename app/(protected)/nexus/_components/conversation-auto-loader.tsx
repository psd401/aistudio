'use client'

import { useEffect, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useThreadRuntime, INTERNAL } from '@assistant-ui/react'
import { toast } from 'sonner'
import { createLogger } from '@/lib/client-logger'
import { validateConversationId } from '@/lib/nexus/conversation-navigation'

const log = createLogger({ moduleName: 'conversation-auto-loader' })

// Type for incoming message data from API
type MessageData = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content?: Array<{ type: 'text'; text?: string; [key: string]: unknown }> | string
  createdAt?: string | Date
  [key: string]: unknown
}

// Helper to create ExportedMessageRepository from API messages
// Reuses pattern from history-adapter.ts
const createExportedMessageRepository = (messages: MessageData[]) => ({
  messages: messages.map((msg, index) => {
    // Ensure content is in the correct format for assistant-ui
    let content: Array<{ type: 'text'; text: string }> = []

    if (Array.isArray(msg.content)) {
      content = msg.content.map(part => ({
        type: 'text' as const,
        text: part.text || ''
      }))
    } else if (typeof msg.content === 'string') {
      content = [{ type: 'text', text: msg.content }]
    } else {
      content = [{ type: 'text', text: '' }]
    }

    return {
      message: INTERNAL.fromThreadMessageLike({
        id: msg.id,
        role: msg.role,
        content,
        ...(msg.createdAt && { createdAt: new Date(msg.createdAt) }),
      }, msg.id, { type: 'complete', reason: 'unknown' }),
      parentId: index === 0 ? null : messages[index - 1]?.id || null
    }
  })
})

/**
 * Component that automatically loads conversation history when the conversation ID
 * is present in the URL (?id=...).
 *
 * This mirrors the pattern from PromptAutoLoader and fixes the issue where
 * useChatRuntime doesn't automatically invoke historyAdapter.load().
 */
export function ConversationAutoLoader() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const runtime = useThreadRuntime()

  // Track which conversations we've already processed to prevent duplicate loads
  const processedConversationsRef = useRef<Set<string>>(new Set())

  const conversationId = searchParams.get('id')

  useEffect(() => {
    async function loadConversation() {
      if (!conversationId) return

      // Validate conversation ID format
      if (!validateConversationId(conversationId)) {
        log.warn('Invalid conversation ID format', { conversationId })
        // Clean up invalid ID from URL
        const params = new URLSearchParams(searchParams.toString())
        params.delete('id')
        router.replace(`/nexus?${params.toString()}`)
        return
      }

      // Don't process the same conversation twice
      if (processedConversationsRef.current.has(conversationId)) {
        log.debug('Conversation already processed, skipping', { conversationId })
        return
      }

      // Mark as processed IMMEDIATELY to prevent infinite loops on errors
      processedConversationsRef.current.add(conversationId)

      // Check if runtime is ready
      const runtimeState = runtime.getState()
      if (!runtimeState) {
        log.warn('Runtime not ready yet', { conversationId })
        // Remove from processed set so we can retry
        processedConversationsRef.current.delete(conversationId)
        return
      }

      log.info('Loading conversation history', { conversationId })

      try {
        // Fetch conversation messages from API
        const response = await fetch(`/api/nexus/conversations/${conversationId}/messages`)

        if (!response.ok) {
          if (response.status === 404) {
            log.warn('Conversation not found', { conversationId })
            toast.error('Conversation not found', {
              description: 'The conversation you are trying to load does not exist'
            })
            // Remove conversationId from URL on error
            const params = new URLSearchParams(searchParams.toString())
            params.delete('id')
            router.replace(`/nexus?${params.toString()}`)
            return
          } else if (response.status === 403) {
            log.warn('Unauthorized access to conversation', { conversationId })
            toast.error('Access denied', {
              description: 'You do not have permission to view this conversation'
            })
            // Remove conversationId from URL on error
            const params = new URLSearchParams(searchParams.toString())
            params.delete('id')
            router.replace(`/nexus?${params.toString()}`)
            return
          }
          throw new Error(`Failed to load conversation: ${response.status}`)
        }

        const data = await response.json()
        const { messages = [] } = data

        log.info('Conversation messages loaded', {
          conversationId,
          messageCount: messages.length
        })

        // Convert messages using the same pattern as history-adapter.ts
        const repository = createExportedMessageRepository(messages)

        // Import messages into the runtime
        runtime.import(repository)

        log.info('Conversation history imported successfully', {
          conversationId,
          messageCount: repository.messages.length
        })

      } catch (error) {
        log.error('Error loading conversation', {
          conversationId,
          error: error instanceof Error ? error.message : String(error)
        })
        toast.error('Error loading conversation', {
          description: 'An unexpected error occurred while loading the conversation'
        })
        // Remove conversationId from URL on error
        const params = new URLSearchParams(searchParams.toString())
        params.delete('id')
        router.replace(`/nexus?${params.toString()}`)
      }
    }

    loadConversation()
  }, [conversationId, runtime, router, searchParams])

  // This component doesn't render anything - it's purely for side effects
  return null
}
