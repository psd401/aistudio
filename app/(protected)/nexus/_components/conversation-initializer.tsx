'use client'

import { useState, useEffect, startTransition } from 'react'
import { type UIMessage } from '@ai-sdk/react'
import { useSession } from 'next-auth/react'
import { createLogger } from '@/lib/client-logger'
import type { MessagePart } from '@/lib/db/drizzle/nexus-messages'

const log = createLogger({ moduleName: 'conversation-initializer' })

// UIMessage part types for AI SDK v5
// Static tool format: type is 'tool-{toolName}' (e.g., 'tool-show_chart')
// AISDKMessageConverter extracts toolName via type.replace("tool-", "")
type TextPart = { type: 'text'; text: string }

// Discriminated union for tool states
type StaticToolPartBase = {
  type: `tool-${string}`;  // Template literal type for 'tool-{toolName}' format
  toolCallId: string;
  input: Record<string, unknown>;
}

type StaticToolPartOutputAvailable = StaticToolPartBase & {
  state: 'output-available';
  output: unknown;
  errorText?: undefined;
}

type StaticToolPartOutputError = StaticToolPartBase & {
  state: 'output-error';
  errorText: string;
  output?: undefined;
}

type StaticToolPartInputAvailable = StaticToolPartBase & {
  state: 'input-available';
  output?: undefined;
  errorText?: undefined;
}

type StaticToolPart = StaticToolPartOutputAvailable | StaticToolPartOutputError | StaticToolPartInputAvailable
type UIMessagePart = TextPart | StaticToolPart

// API response type - explicitly matches MessagePart structure from database
type ApiMessageContent = MessagePart[] | string

// Type guard for tool-call parts
function isToolCallPart(part: MessagePart): part is MessagePart & {
  type: 'tool-call';
  toolName: string;
  toolCallId: string
} {
  return part.type === 'tool-call' &&
         typeof part.toolName === 'string' &&
         typeof part.toolCallId === 'string'
}

/**
 * Helper to convert content parts to UIMessage parts format
 * Converts tool-call to static tool format (type: 'tool-{toolName}')
 */
export function convertContentToParts(content?: ApiMessageContent): UIMessagePart[] {
  if (Array.isArray(content)) {
    const parts: UIMessagePart[] = []

    for (const part of content) {
      // Convert tool-call to static tool format for AISDKMessageConverter
      // type: 'tool-{toolName}' -> converter extracts toolName via type.replace("tool-", "")
      if (isToolCallPart(part)) {
        const args = part.args ?? {}
        const hasResult = part.result !== undefined
        const isError = part.isError === true
        const input = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}

        let toolPart: StaticToolPart

        if (isError) {
          // Error state
          let errorText: string
          if (typeof part.result === 'string') {
            errorText = part.result
          } else if (part.result instanceof Error) {
            errorText = part.result.message
          } else {
            try {
              errorText = JSON.stringify(part.result)
            } catch {
              errorText = String(part.result ?? 'Unknown error')
            }
          }
          toolPart = {
            type: `tool-${part.toolName}`,
            toolCallId: part.toolCallId,
            state: 'output-error',
            input,
            errorText,
          }
        } else if (hasResult) {
          // Output available state
          toolPart = {
            type: `tool-${part.toolName}`,
            toolCallId: part.toolCallId,
            state: 'output-available',
            input,
            output: part.result,
          }
        } else {
          // Input available state (no result yet)
          toolPart = {
            type: `tool-${part.toolName}`,
            toolCallId: part.toolCallId,
            state: 'input-available',
            input,
          }
        }

        parts.push(toolPart)
      } else if (part.type === 'text') {
        // Convert text parts
        parts.push({
          type: 'text',
          text: part.text ?? ''
        })
      }
      // Skip other part types (image, tool-result)
    }

    return parts
  }
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  return [{ type: 'text', text: '' }]
}

// Type for API response message
interface ApiMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content?: ApiMessageContent
  createdAt?: string | Date
}

/**
 * Component to load conversation messages before creating runtime
 *
 * CRITICAL: Pass `stableConversationId` (not `conversationId`) to prevent
 * remounting when conversation ID is assigned during runtime.
 * See /docs/features/nexus-conversation-architecture.md
 */
export function ConversationInitializer({
  conversationId,
  children
}: {
  conversationId: string | null
  children: (messages: UIMessage[]) => React.ReactNode
}) {
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [loading, setLoading] = useState(true)
  const { status, data: session } = useSession()

  useEffect(() => {
    // Verify authentication before making API call
    if (status === 'loading') {
      startTransition(() => { setLoading(true) })
      return
    }

    if (status === 'unauthenticated') {
      log.warn('User not authenticated, skipping conversation load')
      startTransition(() => {
        setMessages([])
        setLoading(false)
      })
      return
    }

    // Guard against authenticated status with missing user data
    if (status === 'authenticated' && !session?.user) {
      log.warn('Authenticated but no user data, skipping conversation load')
      startTransition(() => {
        setMessages([])
        setLoading(false)
      })
      return
    }

    if (!conversationId) {
      startTransition(() => {
        setMessages([])
        setLoading(false)
      })
      return
    }

    const abortController = new AbortController()
    startTransition(() => { setLoading(true) })
    log.debug('ConversationInitializer loading messages', { conversationId })

    fetch(`/api/nexus/conversations/${conversationId}/messages`, {
      signal: abortController.signal,
    })
      .then(res => {
        if (!res.ok) {
          throw new Error(`Failed to load messages: ${res.status}`)
        }
        return res.json() as Promise<{ messages: ApiMessage[] }>
      })
      .then(data => {
        const loadedMessages = data.messages || []
        log.debug('Messages loaded from API', { count: loadedMessages.length })

        // Convert to UIMessage format (required by useChatRuntime)
        const threadMessages: UIMessage[] = loadedMessages.map((msg) => ({
          id: msg.id,
          role: msg.role,
          parts: convertContentToParts(msg.content)
        }))

        setMessages(threadMessages)
        setLoading(false)
        log.debug('Messages converted and ready', { count: threadMessages.length })
      })
      .catch(error => {
        if (error instanceof DOMException && error.name === 'AbortError') return

        log.error('Failed to load conversation', {
          conversationId,
          error: error instanceof Error ? error.message : String(error)
        })
        setMessages([])
        setLoading(false)
      })

    return () => {
      abortController.abort()
    }
  }, [conversationId, status, session])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent mx-auto mb-4" />
          <div className="text-lg text-muted-foreground">Loading conversation...</div>
        </div>
      </div>
    )
  }

  return <>{children(messages)}</>
}
