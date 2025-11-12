import type { ChatModelAdapter } from '@assistant-ui/react'
import { createLogger } from '@/lib/client-logger'
import { generateUUID } from '@/lib/utils/uuid'

const log = createLogger({ moduleName: 'nexus-streaming-adapter' })

export interface NexusStreamingAdapterOptions {
  apiUrl: string
  bodyFn?: () => Record<string, unknown>
  conversationId?: string
  onConversationIdChange?: (conversationId: string) => void
}

/**
 * Nexus Streaming Adapter for assistant-ui
 *
 * Uses native Server-Sent Events (SSE) streaming instead of polling
 * for real-time AI responses with sub-100ms time-to-first-token.
 *
 * Flow:
 * 1. Submit chat request → receive SSE stream
 * 2. Process streaming updates → yield to assistant-ui
 * 3. Handle completion → final response
 */
export function createNexusStreamingAdapter(options: NexusStreamingAdapterOptions): ChatModelAdapter {
  const {
    apiUrl,
    bodyFn = () => ({}),
    conversationId: initialConversationId,
    onConversationIdChange
  } = options

  // Maintain conversation state within the adapter
  let currentConversationId: string | null = initialConversationId || null

  return {
    async *run({ messages, abortSignal }) {
      log.info('NEXUS STREAMING ADAPTER - Starting chat request', {
        messageCount: messages.length,
        apiUrl,
        currentConversationId,
        messagesStructure: messages.map(msg => ({
          role: msg.role,
          hasContent: !!msg.content,
          contentType: typeof msg.content,
          contentLength: Array.isArray(msg.content) ? msg.content.length : 0,
          contentTypes: Array.isArray(msg.content) ? msg.content.map(p => (p as { type?: string })?.type) : []
        }))
      })

      try {
        // Convert ThreadMessages to AI SDK v5 UIMessages format
        const processedMessages = messages.map(message => {
          const parts = []

          // Process message content
          if (Array.isArray(message.content)) {
            for (const contentPart of message.content) {
              // Handle different content part types from assistant-ui
              if (contentPart.type === 'text') {
                parts.push({ type: 'text', text: contentPart.text })
              } else if (contentPart.type === 'image') {
                parts.push({ type: 'image', image: contentPart.image })
              } else if (contentPart.type === 'file') {
                parts.push({ type: 'file', url: contentPart.url, mediaType: contentPart.mediaType })
              } else {
                // Pass through other types
                parts.push(contentPart)
              }
            }
          } else if (typeof message.content === 'string') {
            // Simple string content
            parts.push({ type: 'text', text: message.content })
          }

          // Process attachments and merge their content into parts
          const messageWithAttachments = message as { attachments?: Array<{ content?: Array<{ type: string; image?: string; url?: string; mediaType?: string }> }> }
          if (Array.isArray(messageWithAttachments.attachments)) {
            for (const attachment of messageWithAttachments.attachments) {
              if (Array.isArray(attachment.content)) {
                for (const attachmentPart of attachment.content) {
                  if (attachmentPart.type === 'image' && attachmentPart.image) {
                    parts.push({ type: 'image', image: attachmentPart.image })
                  } else if (attachmentPart.type === 'file' && attachmentPart.url) {
                    parts.push({ type: 'file', url: attachmentPart.url, mediaType: attachmentPart.mediaType })
                  } else {
                    // Pass through other attachment content
                    parts.push(attachmentPart)
                  }
                }
              }
            }
          }

          return {
            id: message.id || generateUUID(),
            role: message.role,
            parts: parts.length > 0 ? parts : [{ type: 'text', text: '' }]
          }
        })

        log.debug('Processed messages for streaming API', {
          originalCount: messages.length,
          processedCount: processedMessages.length,
          processedStructure: processedMessages.map(msg => ({
            role: msg.role,
            partsCount: msg.parts?.length || 0,
            partsTypes: msg.parts?.map(p => p.type) || []
          }))
        })

        // Get additional body parameters from the callback
        const additionalBody = bodyFn()

        // Prepare request body
        const requestBody = {
          messages: processedMessages,
          conversationId: currentConversationId,
          ...additionalBody
        }

        log.debug('Sending streaming request', {
          url: apiUrl,
          bodyKeys: Object.keys(requestBody),
          messageCount: processedMessages.length
        })

        // Submit chat request to streaming endpoint
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: abortSignal,
        })

        if (!response.ok) {
          const errorText = await response.text()
          log.error('Streaming request failed', {
            status: response.status,
            statusText: response.statusText,
            errorText
          })
          throw new Error(`Streaming request failed: ${response.status} ${response.statusText}`)
        }

        // Extract conversation ID from headers if this is a new conversation
        const conversationIdHeader = response.headers.get('X-Conversation-Id')
        if (conversationIdHeader && !currentConversationId) {
          currentConversationId = conversationIdHeader
          log.info('New conversation ID received', { conversationId: currentConversationId })

          if (onConversationIdChange) {
            onConversationIdChange(currentConversationId)
          }
        }

        // Process the streaming response
        if (!response.body) {
          throw new Error('Response body is null')
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let accumulatedText = ''

        try {
          while (true) {
            const { done, value } = await reader.read()

            if (done) {
              log.debug('Stream completed', {
                totalLength: accumulatedText.length,
                conversationId: currentConversationId
              })
              break
            }

            // Decode the chunk
            buffer += decoder.decode(value, { stream: true })

            // Process lines from the buffer
            const lines = buffer.split('\n')
            buffer = lines.pop() || '' // Keep the last incomplete line in the buffer

            for (const line of lines) {
              if (!line.trim() || line.startsWith(':')) {
                continue // Skip empty lines and comments
              }

              if (line.startsWith('data: ')) {
                const data = line.slice(6) // Remove 'data: ' prefix

                if (data === '[DONE]') {
                  log.debug('Received [DONE] marker')
                  break
                }

                try {
                  const parsed = JSON.parse(data)

                  // Handle text deltas from AI SDK UIMessageStream format
                  if (parsed.type === 'text-delta' && parsed.textDelta) {
                    accumulatedText += parsed.textDelta

                    // Yield text delta to assistant-ui
                    yield {
                      content: [{
                        type: 'text' as const,
                        text: accumulatedText
                      }]
                    }

                    log.debug('Streamed text delta', {
                      deltaLength: parsed.textDelta.length,
                      totalLength: accumulatedText.length
                    })
                  }
                  // Handle tool calls
                  else if (parsed.type === 'tool-call' || parsed.type === 'tool-call-delta') {
                    log.debug('Tool call received', {
                      toolName: parsed.toolName,
                      type: parsed.type
                    })
                    // Tool calls are handled by the UI components
                  }
                  // Handle errors
                  else if (parsed.type === 'error') {
                    log.error('Stream error received', {
                      error: parsed.error
                    })
                    throw new Error(parsed.error || 'Stream error')
                  }
                } catch (parseError) {
                  log.warn('Failed to parse SSE data', {
                    data,
                    error: parseError instanceof Error ? parseError.message : String(parseError)
                  })
                }
              }
            }
          }

          // Final yield with complete accumulated text
          if (accumulatedText) {
            yield {
              content: [{
                type: 'text' as const,
                text: accumulatedText
              }]
            }
          }

          log.info('Streaming completed successfully', {
            conversationId: currentConversationId,
            totalLength: accumulatedText.length
          })

        } finally {
          try {
            reader.releaseLock()
          } catch (releaseError) {
            log.warn('Failed to release reader lock', {
              error: releaseError instanceof Error ? releaseError.message : String(releaseError)
            })
          }
        }

      } catch (error) {
        log.error('Streaming adapter error', {
          error: error instanceof Error ? {
            message: error.message,
            name: error.name
          } : String(error),
          conversationId: currentConversationId
        })

        // Yield error message to user
        yield {
          content: [{
            type: 'text' as const,
            text: `Error: ${error instanceof Error ? error.message : 'An unknown error occurred'}`
          }]
        }

        throw error
      }
    }
  }
}
