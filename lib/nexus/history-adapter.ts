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

// Allow only https: image URLs to prevent javascript:/data: XSS via stored imageUrl values.
const isSafeImageUrl = (url: string): boolean => {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

// Helper to convert a content part to text format
// Handles text, image, and other part types by converting to displayable text
const convertPartToText = (part: { type: string; text?: string; imageUrl?: string; [key: string]: unknown }): string => {
  if (part.type === 'text') {
    return part.text || ''
  }
  if (part.type === 'image' && part.imageUrl && isSafeImageUrl(part.imageUrl)) {
    // Convert image parts to markdown image syntax (URL already validated as https: only)
    return `![Generated Image](${part.imageUrl})`
  }
  // Skip step-start, step-finish, and other control types
  if (part.type === 'step-start' || part.type === 'step-finish') {
    return ''
  }
  return ''
}

// Validated role set — guards against non-standard roles from partial writes or migrations.
const VALID_ROLES = new Set(['user', 'assistant', 'system'] as const)
type ValidRole = 'user' | 'assistant' | 'system'
const safeRole = (role: string | undefined): ValidRole =>
  VALID_ROLES.has(role as ValidRole) ? (role as ValidRole) : 'user'

// Returns a valid Date if the value is parseable and finite, otherwise undefined.
const safeDate = (value: string | Date | undefined): Date | undefined => {
  if (!value) return undefined
  const d = new Date(value)
  return isFinite(d.getTime()) ? d : undefined
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
      // AI SDK v6 UIMessage fields required by convertToModelMessages (Issue #977)
      state: 'input-available' | 'output-available' | 'output-error';
      input: JSONObject;
    }

// We'll use a simple implementation since ExportedMessageRepository.fromArray may not be accessible
const createExportedMessageRepository = (messages: MessageData[]): ExportedMessageRepository => {
  // Filter out null/undefined entries and messages with malformed IDs before processing.
  // This guards against partially-persisted messages (e.g. from expired-session writes)
  // that would cause fromThreadMessageLike to throw and crash the whole conversation load.
  const validMessages = messages.filter(
    (msg): msg is MessageData => msg != null && typeof msg.id === 'string'
  )

  return {
    messages: validMessages.map((msg, index) => {
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

              // Derive state from result so convertToModelMessages emits paired
              // tool_result blocks on conversation replay. Without state+input,
              // convertToModelMessages emits tool_use without tool_result, causing
              // AI_MissingToolResultsError on follow-up messages. (Issue #977)
              const hasResult = partData.result != null
              const isError = partData.isError === true
              // Prefer the stored state field — a part persisted with state 'output-error'
              // but isError=false and a non-null result would be wrongly classified as
              // 'output-available' if we only checked isError and hasResult.
              const rawState = (partData as unknown as Record<string, unknown>).state
              const state: 'input-available' | 'output-available' | 'output-error' =
                rawState === 'input-available' || rawState === 'output-available' || rawState === 'output-error'
                  ? rawState
                  : isError ? 'output-error' : hasResult ? 'output-available' : 'input-available'

              const toolPart: ContentPartLike = {
                type: 'tool-call',
                toolCallId: partData.toolCallId,
                toolName: partData.toolName,
                args,
                argsText: JSON.stringify(args),
                result: partData.result,
                isError,
                state,
                input: args,
              }
              return toolPart
            }
            if (partData.type === 'image' && partData.imageUrl && isSafeImageUrl(partData.imageUrl)) {
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

      // Validate role and createdAt before passing to fromThreadMessageLike.
      // msg.role arrives from the DB and may be non-standard in partial-write scenarios;
      // msg.createdAt may be an unparseable or extreme string — both must be sanitised.
      const msgRole = safeRole(msg.role)
      const msgDate = safeDate(msg.createdAt as string | Date | undefined)

      try {
        const converted = INTERNAL.fromThreadMessageLike({
          id: msg.id,
          role: msgRole,
          content: content as unknown as string,  // Cast needed for tool-result parts
          ...(msgDate && { createdAt: msgDate }),
        }, msg.id, { type: 'complete', reason: 'unknown' })
        // Guard against a falsy return (library contract is to throw, but defensive check
        // prevents downstream crashes in withFormat.load which reads .message.id).
        if (!converted) {
          throw new Error('fromThreadMessageLike returned falsy')
        }
        return {
          message: converted,
          parentId: index === 0 ? null : validMessages[index - 1]?.id || null
        }
      } catch (error) {
        // fromThreadMessageLike can throw when a message part structure is incompatible
        // with the current runtime (e.g. image-gen message loaded under a chat runtime).
        // Fall back to a safe placeholder so the rest of the conversation still loads.
        log.warn('Failed to convert message, using placeholder', {
          messageId: msg.id,
          messageIndex: index,
          // Truncate error message to avoid forwarding arbitrary content to logs (L-2)
          error: error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200),
        })
        // Guard the fallback construction too — if INTERNAL.fromThreadMessageLike itself
        // is the source of the failure (e.g. null dereference on msg.id), the same call
        // with a static content array could throw again and escape the outer catch.
        try {
          return {
            message: INTERNAL.fromThreadMessageLike({
              id: msg.id,
              role: msgRole,
              content: [{ type: 'text', text: '[Message could not be loaded]' }] as unknown as string,
            }, msg.id, { type: 'complete', reason: 'unknown' }),
            parentId: index === 0 ? null : validMessages[index - 1]?.id || null
          }
        } catch (fallbackError) {
          log.error('Fallback message construction failed, skipping message', {
            messageId: msg.id,
            messageIndex: index,
            error: fallbackError instanceof Error ? fallbackError.message.substring(0, 200) : String(fallbackError).substring(0, 200),
          })
          return null
        }
      }
    }).filter((item): item is NonNullable<typeof item> => item !== null)
  }
}

// ExportedMessageRepositoryItem is not exported from the main module, so we'll define it based on the expected structure
type ExportedMessageRepositoryItem = {
  message: ThreadMessage
  parentId: string | null
}

const log = createLogger({ moduleName: 'nexus-history-adapter' })

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

