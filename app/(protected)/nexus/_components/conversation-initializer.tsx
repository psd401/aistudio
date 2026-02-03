'use client'

import { useState, useEffect } from 'react'
import { type UIMessage } from '@ai-sdk/react'
import { createLogger } from '@/lib/client-logger'

const log = createLogger({ moduleName: 'conversation-initializer' })

// UIMessage part types for AI SDK v5
// Static tool format: type is 'tool-{toolName}' (e.g., 'tool-show_chart')
// AISDKMessageConverter extracts toolName via type.replace("tool-", "")
type TextPart = { type: 'text'; text: string }
type StaticToolPart = {
  type: string;  // 'tool-{toolName}' format
  toolCallId: string;
  state: 'output-available' | 'output-error' | 'input-available';
  input: Record<string, unknown>;
  output?: unknown;
  errorText?: string;
}
type UIMessagePart = TextPart | StaticToolPart

// Helper to convert content parts to UIMessage parts format
// Converts tool-call to static tool format (type: 'tool-{toolName}')
export function convertContentToParts(
  content?: Array<{ type: string; text?: string; [key: string]: unknown }> | string
): UIMessagePart[] {
  if (Array.isArray(content)) {
    const parts: UIMessagePart[] = []

    for (const part of content) {
      // Convert tool-call to static tool format for AISDKMessageConverter
      // type: 'tool-{toolName}' -> converter extracts toolName via type.replace("tool-", "")
      if (part.type === 'tool-call' && part.toolName && part.toolCallId) {
        const toolName = part.toolName as string
        const args = (part.args as Record<string, unknown>) || {}
        const hasResult = part.result !== undefined
        const isError = part.isError === true

        const toolPart: StaticToolPart = {
          type: `tool-${toolName}`,  // e.g., 'tool-show_chart'
          toolCallId: part.toolCallId as string,
          state: isError ? 'output-error' : hasResult ? 'output-available' : 'input-available',
          input: args,
        }

        if (hasResult && !isError) {
          toolPart.output = part.result
        }
        if (isError) {
          toolPart.errorText = typeof part.result === 'string' ? part.result : JSON.stringify(part.result)
        }

        parts.push(toolPart)
      } else {
        // Convert text parts
        parts.push({
          type: 'text',
          text: part.text || ''
        })
      }
    }

    return parts
  }
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  return [{ type: 'text', text: '' }]
}

// Component to load conversation messages before creating runtime
export function ConversationInitializer({
  conversationId,
  children
}: {
  conversationId: string | null
  children: (messages: UIMessage[]) => React.ReactNode
}) {
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!conversationId) {
      setMessages([])
      setLoading(false)
      return
    }

    setLoading(true)
    log.debug('ConversationInitializer loading messages', { conversationId })

    fetch(`/api/nexus/conversations/${conversationId}/messages`)
      .then(res => {
        if (!res.ok) {
          throw new Error(`Failed to load messages: ${res.status}`)
        }
        return res.json()
      })
      .then(data => {
        const loadedMessages = data.messages || []
        log.debug('Messages loaded from API', { count: loadedMessages.length })

        // Convert to UIMessage format (required by useChatRuntime)
        const threadMessages = loadedMessages.map((msg: {
          id: string
          role: 'user' | 'assistant' | 'system'
          content?: Array<{ type: string; text?: string; [key: string]: unknown }> | string
          createdAt?: string | Date
        }) => ({
          id: msg.id,
          role: msg.role,
          parts: convertContentToParts(msg.content)
        }))

        setMessages(threadMessages)
        setLoading(false)
        log.debug('Messages converted and ready', { count: threadMessages.length })
      })
      .catch(error => {
        log.error('Failed to load conversation', {
          conversationId,
          error: error instanceof Error ? error.message : String(error)
        })
        setMessages([])
        setLoading(false)
      })
  }, [conversationId])

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
