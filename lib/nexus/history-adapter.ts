'use client'

import { useRef, useMemo } from 'react'
import { createLogger } from '@/lib/client-logger'
import type {
  ThreadHistoryAdapter,
  ThreadMessage,
  MessageFormatAdapter,
  MessageFormatRepository,
  MessageFormatItem,
  GenericThreadHistoryAdapter
} from '@assistant-ui/react'
import { INTERNAL } from '@assistant-ui/react'

// Import ExportedMessageRepository type and utility
type ExportedMessageRepository = {
  headId?: string | null
  messages: Array<{
    message: ThreadMessage
    parentId: string | null
  }>
}

// Type for incoming message data from API
type MessageData = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content?: Array<{ type: 'text'; text?: string; [key: string]: unknown }> | string
  createdAt?: string | Date
  [key: string]: unknown
}

// Helper to convert a content part to text format
// Handles text, image, and other part types by converting to displayable text
const convertPartToText = (part: { type: string; text?: string; imageUrl?: string; [key: string]: unknown }): string => {
  if (part.type === 'text') {
    return part.text || ''
  }
  if (part.type === 'image' && part.imageUrl) {
    // Convert image parts to markdown image syntax
    return `![Generated Image](${part.imageUrl})`
  }
  // Skip step-start, step-finish, and other control types
  if (part.type === 'step-start' || part.type === 'step-finish') {
    return ''
  }
  return ''
}

// JSON object type for tool arguments (matches assistant-ui's ReadonlyJSONObject)
type JSONObject = { readonly [key: string]: JSONValue }
type JSONValue = string | number | boolean | null | JSONObject | readonly JSONValue[]

// Type for assistant-ui content parts
// Uses tool-call format for fromThreadMessageLike compatibility (Issue #798)
type ContentPartLike =
  | { type: 'text'; text: string }
  | {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      args: JSONObject;
      argsText: string;
      result?: unknown;
      isError?: boolean;
    }

// We'll use a simple implementation since ExportedMessageRepository.fromArray may not be accessible
const createExportedMessageRepository = (messages: MessageData[]): ExportedMessageRepository => ({
  messages: messages.map((msg, index) => {
    // Ensure content is in the correct format for assistant-ui
    // Content can include text parts and static tool parts for UI rendering
    let content: ContentPartLike[] = []

    if (Array.isArray(msg.content)) {
      // Process each part - text becomes text, tool-call converts to static tool, images become markdown
      const processedParts = msg.content
        .map((part): ContentPartLike | null => {
          const partData = part as { type: string; text?: string; imageUrl?: string; toolCallId?: string; toolName?: string; args?: unknown; argsText?: string; result?: unknown; isError?: boolean }

          if (partData.type === 'text') {
            return { type: 'text', text: partData.text || '' }
          }
          if (partData.type === 'tool-call' && partData.toolName && partData.toolCallId) {
            // Use tool-call format (not static tool-{name} format) so that
            // fromThreadMessageLike processes it correctly. The static format
            // (type: 'tool-show_chart') is not handled by fromThreadMessageLike's
            // switch and throws "Unsupported assistant message part type". (Issue #798)
            const args: JSONObject = (partData.args ?? {}) as JSONObject

            const toolPart: ContentPartLike = {
              type: 'tool-call',
              toolCallId: partData.toolCallId,
              toolName: partData.toolName,
              args,
              argsText: JSON.stringify(args),
              result: partData.result,
              isError: partData.isError === true,
            }
            return toolPart
          }
          if (partData.type === 'image' && partData.imageUrl) {
            return { type: 'text', text: `![Generated Image](${partData.imageUrl})` }
          }
          // Skip step-start, step-finish, tool-result (legacy), and other control types
          return null
        })
        .filter((part): part is ContentPartLike => part !== null)

      content = processedParts

      // Ensure at least one content part
      if (content.length === 0) {
        content = [{ type: 'text', text: '' }]
      }
    } else if (typeof msg.content === 'string') {
      content = [{ type: 'text', text: msg.content }]
    } else {
      content = [{ type: 'text', text: '' }]
    }

    return {
      // Cast content to unknown to allow tool-result parts (assistant-ui handles them internally)
      message: INTERNAL.fromThreadMessageLike({
        id: msg.id,
        role: msg.role,
        content: content as unknown as string,  // Cast needed for tool-result parts
        ...(msg.createdAt && { createdAt: new Date(msg.createdAt) }),
      }, msg.id, { type: 'complete', reason: 'unknown' }),
      parentId: index === 0 ? null : messages[index - 1]?.id || null
    }
  })
})

// ExportedMessageRepositoryItem is not exported from the main module, so we'll define it based on the expected structure
type ExportedMessageRepositoryItem = {
  message: ThreadMessage
  parentId: string | null
}

const log = createLogger({ moduleName: 'nexus-history-adapter' })

/**
 * Manages conversation context with stable state across renders.
 * Returns a memoized object with a ref-backed conversation ID,
 * so callers can read/write the ID without triggering re-renders.
 */
export function useConversationContext() {
  const currentConversationIdRef = useRef<string | null>(null)

  return useMemo(() => ({
    setConversationId(id: string | null) {
      if (currentConversationIdRef.current !== id) {
        log.debug('Conversation context changed', {
          from: currentConversationIdRef.current,
          to: id
        })
        currentConversationIdRef.current = id
      }
    },
  }), [])
}

/**
 * Creates a ThreadHistoryAdapter that loads and saves conversation messages.
 *
 * Accepts a getter function for conversationId so the adapter instance can
 * remain stable (not recreated) when the ID transitions from null → UUID
 * during a new conversation. This prevents the runtime from re-calling
 * load() mid-stream, which would fetch already-displayed messages from
 * the database and cause duplicate message rendering. (Issue #868)
 */
export function createNexusHistoryAdapter(getConversationId: () => string | null): ThreadHistoryAdapter {
  const adapter: ThreadHistoryAdapter = {
    async load(): Promise<ExportedMessageRepository & { unstable_resume?: boolean }> {
      const conversationId = getConversationId()
      if (!conversationId) {
        log.debug('No conversation ID, returning empty repository')
        return { messages: [] }
      }

      try {
        log.debug('Loading conversation messages', { conversationId })

        const response = await fetch(`/api/nexus/conversations/${conversationId}/messages`)

        if (!response.ok) {
          if (response.status === 404) {
            log.warn('Conversation not found', { conversationId })
            return { messages: [] }
          }
          throw new Error(`Failed to load messages: ${response.status}`)
        }

        const data = await response.json()
        const { messages = [] } = data

        // Convert messages using our helper function
        const repository = createExportedMessageRepository(messages)

        log.debug('Messages loaded successfully', {
          conversationId,
          messageCount: repository.messages.length
        })

        return repository

      } catch (error) {
        log.error('Failed to load conversation messages', {
          conversationId,
          error: error instanceof Error ? error.message : String(error)
        })

        return { messages: [] }
      }
    },

    async append(item: ExportedMessageRepositoryItem): Promise<void> {
      // Messages are persisted server-side in the /api/nexus/chat route handler:
      // user messages by setupConversation() and assistant messages by onFinish().
      // This no-op prevents the runtime from double-saving through the history adapter.
      log.debug('Skipping message save - handled by chat route handler', {
        conversationId: getConversationId(),
        messageRole: item.message.role,
        messageId: item.message.id
      })
      return
    },

    withFormat<TMessage, TStorageFormat extends Record<string, unknown>>(
      formatAdapter: MessageFormatAdapter<TMessage, TStorageFormat>
    ): GenericThreadHistoryAdapter<TMessage> {
      return {
        async load(): Promise<MessageFormatRepository<TMessage>> {
          // Load from base adapter (returns ExportedMessageRepository with ThreadMessages)
          const exportedRepo = await adapter.load();

          log.debug('withFormat.load called', {
            conversationId: getConversationId(),
            messageCount: exportedRepo.messages.length
          });

          // Convert ThreadMessage format to storage format, then decode to TMessage
          return {
            headId: exportedRepo.headId || null,
            messages: exportedRepo.messages.map(item => {
              // ThreadMessage has .content (array of parts)
              // Storage format expects .parts (array of parts)
              const threadMessage = item.message;

              // Create MessageStorageEntry for the format adapter
              const storageEntry = {
                id: threadMessage.id,
                parent_id: item.parentId,
                format: formatAdapter.format,
                content: {
                  role: threadMessage.role,
                  parts: threadMessage.content, // Convert .content → .parts
                  ...(threadMessage.createdAt && { createdAt: threadMessage.createdAt }),
                } as unknown as TStorageFormat
              };

              // Use format adapter to decode into the expected message format
              return formatAdapter.decode(storageEntry);
            })
          };
        },

        async append(item: MessageFormatItem<TMessage>): Promise<void> {
          log.debug('withFormat.append called', { conversationId: getConversationId() });

          // Encode the message to storage format
          const encoded = formatAdapter.encode(item);
          // Parts may include AI SDK v5 control types (step-start, step-finish) that need filtering
          const encodedAny = encoded as unknown as {
            role: 'user' | 'assistant' | 'system';
            parts: Array<{ type: string; text?: string }>;
            createdAt?: Date;
          };

          // Convert storage format back to ThreadMessage format
          // Storage has .parts, ThreadMessage expects .content
          // Convert all parts to text format (handles images as markdown, filters control types)
          const textParts = encodedAny.parts
            .map(part => convertPartToText(part as { type: string; text?: string; imageUrl?: string }))
            .filter(text => text.length > 0)
            .map(text => ({ type: 'text' as const, text }))

          // Ensure at least one content part
          const content = textParts.length > 0 ? textParts : [{ type: 'text' as const, text: '' }]

          const threadMessage = INTERNAL.fromThreadMessageLike({
            id: formatAdapter.getId(item.message),
            role: encodedAny.role,
            content,
            ...(encodedAny.createdAt && {
              createdAt: encodedAny.createdAt
            }),
          }, formatAdapter.getId(item.message), { type: 'complete', reason: 'unknown' });

          // Delegate to base adapter
          await adapter.append({
            parentId: item.parentId,
            message: threadMessage
          });
        }
      };
    }
  };

  return adapter;
}

