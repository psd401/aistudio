'use client'

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

// We'll use a simple implementation since ExportedMessageRepository.fromArray may not be accessible
const createExportedMessageRepository = (messages: MessageData[]): ExportedMessageRepository => ({
  messages: messages.map((msg, index) => {
    // Ensure content is in the correct format for assistant-ui
    let content: Array<{ type: 'text'; text: string }> = []

    if (Array.isArray(msg.content)) {
      // Convert all parts to text, handling images as markdown
      const textParts = msg.content
        .map(part => convertPartToText(part as { type: string; text?: string; imageUrl?: string }))
        .filter(text => text.length > 0)

      content = textParts.map(text => ({
        type: 'text' as const,
        text
      }))

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

// ExportedMessageRepositoryItem is not exported from the main module, so we'll define it based on the expected structure
type ExportedMessageRepositoryItem = {
  message: ThreadMessage
  parentId: string | null
}

const log = createLogger({ moduleName: 'nexus-history-adapter' })

/**
 * Manages conversation context and provides utilities for loading/saving conversation data
 */
export function useConversationContext() {
  let currentConversationId: string | null = null
  let onConversationChange: ((conversationId: string) => void) | undefined = undefined
  
  return {
    setConversationId(id: string | null) {
      if (currentConversationId !== id) {
        log.debug('Conversation context changed', { 
          from: currentConversationId, 
          to: id 
        })
        currentConversationId = id
        if (id && onConversationChange) {
          onConversationChange(id)
        }
      }
    },
    
    setOnConversationChange(callback: (conversationId: string) => void) {
      onConversationChange = callback
    },
    
    getCurrentConversationId(): string | null {
      return currentConversationId
    }
  }
}

/**
 * Creates a ThreadHistoryAdapter that loads and saves conversation messages
 */
export function createNexusHistoryAdapter(conversationId: string | null): ThreadHistoryAdapter {
  const adapter: ThreadHistoryAdapter = {
    async load(): Promise<ExportedMessageRepository & { unstable_resume?: boolean }> {
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
      // Messages are already saved by the polling adapter in /api/nexus/chat
      // No need to save again - this prevents duplicates and API errors
      log.debug('Skipping message save - handled by polling adapter', {
        conversationId,
        messageRole: item.message.role,
        messageId: item.message.id
      })
      return
    },

    withFormat<TMessage, TStorageFormat>(
      formatAdapter: MessageFormatAdapter<TMessage, TStorageFormat>
    ): GenericThreadHistoryAdapter<TMessage> {
      return {
        async load(): Promise<MessageFormatRepository<TMessage>> {
          // Load from base adapter (returns ExportedMessageRepository with ThreadMessages)
          const exportedRepo = await adapter.load();

          log.debug('withFormat.load called', {
            conversationId,
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
          log.debug('withFormat.append called', { conversationId });

          // Encode the message to storage format
          const encoded = formatAdapter.encode(item);
          // Parts may include AI SDK v5 control types (step-start, step-finish) that need filtering
          const encodedAny = encoded as {
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

/**
 * Utilities for loading conversation messages and metadata
 */
export class ConversationLoader {
  static async loadConversation(conversationId: string) {
    try {
      log.debug('Loading conversation messages', { conversationId })
      
      const response = await fetch(`/api/nexus/conversations/${conversationId}/messages`)
      
      if (!response.ok) {
        if (response.status === 404) {
          log.warn('Conversation not found', { conversationId })
          return { messages: [], conversation: null }
        }
        throw new Error(`Failed to load messages: ${response.status}`)
      }
      
      const data = await response.json()
      const { messages = [], conversation } = data
      
      log.debug('Messages loaded successfully', { 
        conversationId,
        messageCount: messages.length,
        conversationTitle: conversation?.title
      })
      
      return { messages, conversation }
      
    } catch (error) {
      log.error('Failed to load conversation messages', {
        conversationId,
        error: error instanceof Error ? error.message : String(error)
      })
      
      return { messages: [], conversation: null }
    }
  }

  static async saveMessage(conversationId: string, messageData: {
    messageId: string
    role: string
    content: string
    parts?: Array<{ type: string; text?: string; [key: string]: unknown }>
    metadata?: Record<string, unknown>
  }) {
    try {
      log.debug('Saving message to conversation', { 
        conversationId,
        messageRole: messageData.role,
        messageId: messageData.messageId
      })
      
      const response = await fetch('/api/nexus/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          ...messageData
        })
      })
      
      if (!response.ok) {
        throw new Error(`Failed to save message: ${response.status}`)
      }
      
      log.debug('Message saved successfully', {
        conversationId,
        messageId: messageData.messageId
      })
      
      return true
      
    } catch (error) {
      log.error('Failed to save message', {
        conversationId,
        messageId: messageData.messageId,
        error: error instanceof Error ? error.message : String(error)
      })
      
      return false
    }
  }
}