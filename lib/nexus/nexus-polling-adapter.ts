import type { ChatModelAdapter } from '@assistant-ui/react'
import { createLogger } from '@/lib/client-logger'
import { generateUUID } from '@/lib/utils/uuid'

const log = createLogger({ moduleName: 'nexus-polling-adapter' })

export interface NexusJobResponse {
  jobId: string
  conversationId: string
  status: 'pending' | 'processing' | 'streaming' | 'completed' | 'failed' | 'cancelled'
  partialContent?: string
  responseData?: {
    text: string
    type?: 'text' | 'image'
    s3Key?: string // S3 key for generated images (secure access via API)
    mediaType?: string // MIME type for images
    prompt?: string // Original prompt for image generation
    size?: string // Image size
    style?: string // Image style
    model?: string // Model used for generation
    usage?: {
      promptTokens: number
      completionTokens: number
      totalTokens: number
    }
    finishReason: string
    metadata?: Record<string, unknown> // Additional metadata
  }
  errorMessage?: string
  pollingInterval: number
  shouldContinuePolling: boolean
  requestId: string
}

export interface NexusPollingAdapterOptions {
  apiUrl: string
  bodyFn?: () => Record<string, unknown>
  maxPollAttempts?: number
  pollTimeoutMs?: number
  conversationId?: string
  onConversationIdChange?: (conversationId: string) => void
}

/**
 * Nexus Polling Adapter for assistant-ui
 * 
 * Converts the universal polling architecture into a streaming interface
 * that's compatible with assistant-ui's LocalRuntime.
 * 
 * Flow:
 * 1. Submit chat request → get 202 + jobId
 * 2. Poll job status endpoint → get progressive updates
 * 3. Convert polling updates → streaming format for assistant-ui
 * 4. Handle completion/errors → final response
 */
export function createNexusPollingAdapter(options: NexusPollingAdapterOptions): ChatModelAdapter {
  const { 
    apiUrl, 
    bodyFn = () => ({}),
    maxPollAttempts = 300, // 5 minutes with 1s intervals
    pollTimeoutMs = 30000, // 30 seconds per poll
    conversationId: initialConversationId,
    onConversationIdChange
  } = options

  // Maintain conversation state within the adapter
  let currentConversationId: string | null = initialConversationId || null

  return {
    async *run({ messages, abortSignal }) {
      log.info('NEXUS POLLING ADAPTER - Starting chat request', { 
        messageCount: messages.length,
        apiUrl,
        messagesStructure: messages.map(msg => ({
          role: msg.role,
          hasContent: !!msg.content,
          contentType: typeof msg.content,
          contentLength: Array.isArray(msg.content) ? msg.content.length : 0,
          contentTypes: Array.isArray(msg.content) ? msg.content.map(p => (p as { type?: string })?.type) : []
          // Removed: rawMessages and fullContent to prevent PII exposure
        }))
      })


      let jobId: string | null = null
      let pollingInterval = 1000 // Start with 1 second
      let pollAttempts = 0

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
          
          // CRITICAL: Process attachments and merge their content into parts
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

        log.debug('Processed messages for API', {
          originalCount: messages.length,
          processedCount: processedMessages.length,
          processedStructure: processedMessages.map(msg => ({
            role: msg.role,
            partsCount: msg.parts?.length || 0,
            partsTypes: msg.parts?.map(p => p.type) || []
          }))
        })

        // 1. Submit chat request to get job ID
        const requestBody: Record<string, unknown> = {
          messages: processedMessages,
          ...bodyFn()
        }
        
        // Include conversationId if we have one for conversation continuity
        if (currentConversationId) {
          requestBody.conversationId = currentConversationId
        }

        log.debug('Sending request with conversation context', {
          hasConversationId: !!currentConversationId,
          conversationId: currentConversationId
        })

        const chatResponse = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: abortSignal,
        })

        if (!chatResponse.ok) {
          throw new Error(`Chat request failed: ${chatResponse.status} ${chatResponse.statusText}`)
        }

        const chatData = await chatResponse.json()
        jobId = chatData.jobId

        if (!jobId) {
          throw new Error('No jobId received from chat request')
        }

        // Extract conversationId from response headers for conversation continuity
        const responseConversationId = chatResponse.headers.get('X-Conversation-Id')
        if (responseConversationId && responseConversationId !== currentConversationId) {
          currentConversationId = responseConversationId
          // Notify parent component of conversation ID change
          if (onConversationIdChange) {
            onConversationIdChange(currentConversationId)
          }
          log.info('Conversation ID updated', { 
            previousId: currentConversationId, 
            newId: responseConversationId 
          })
        }

        log.info('Job created successfully', { 
          jobId, 
          conversationId: currentConversationId 
        })

        // 2. Poll for job updates
        while (pollAttempts < maxPollAttempts) {
          // Check for cancellation
          if (abortSignal.aborted) {
            // Cancel the job if possible
            try {
              await fetch(`${apiUrl}/jobs/${jobId}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' }
              })
              log.info('Job cancelled due to abort signal', { jobId })
            } catch (cancelError) {
              log.warn('Failed to cancel job', { jobId, error: cancelError })
            }
            return
          }

          // Wait before polling (except first attempt)
          if (pollAttempts > 0) {
            await new Promise(resolve => setTimeout(resolve, pollingInterval))
          }

          pollAttempts++

          try {
            // Poll job status
            const pollController = new AbortController()
            const pollTimeout = setTimeout(() => pollController.abort(), pollTimeoutMs)

            // Don't use the main abortSignal for individual polls to prevent React strict mode issues
            // Each poll has its own timeout via pollController
            const pollResponse = await fetch(`${apiUrl}/jobs/${jobId}`, {
              method: 'GET',
              headers: {
                'Content-Type': 'application/json',
              },
              signal: pollController.signal,
            })

            clearTimeout(pollTimeout)

            if (!pollResponse.ok) {
              if (pollResponse.status === 404) {
                throw new Error('Job not found - it may have expired')
              }
              throw new Error(`Poll request failed: ${pollResponse.status} ${pollResponse.statusText}`)
            }

            const jobData: NexusJobResponse = await pollResponse.json()

            log.debug('Poll response received', {
              jobId,
              status: jobData.status,
              hasPartialContent: !!jobData.partialContent,
              shouldContinuePolling: jobData.shouldContinuePolling
            })

            // Update polling interval from server response
            if (jobData.pollingInterval) {
              pollingInterval = jobData.pollingInterval
            }

            // Yield progressive updates if we have partial content
            if (jobData.partialContent) {
              yield {
                content: [{ 
                  type: 'text' as const, 
                  text: jobData.partialContent 
                }],
              }
            }

            // Handle job completion
            if (jobData.status === 'completed') {
              if (jobData.responseData) {
                // Handle image generation responses
                if (jobData.responseData.type === 'image' && jobData.responseData.s3Key) {
                  const { s3Key, prompt, size, model } = jobData.responseData
                  
                  // Convert S3 key to secure API URL
                  const imageUrl = `/api/images/${s3Key}`
                  
                  log.info('Image generation job completed', { 
                    jobId, 
                    prompt: prompt?.substring(0, 50) + (prompt && prompt.length > 50 ? '...' : ''),
                    size,
                    model,
                    s3Key,
                    imageUrl
                  })

                  yield {
                    content: [
                      // Show the image using secure API URL
                      { 
                        type: 'image' as const, 
                        image: imageUrl
                      }
                    ],
                  }
                } else {
                  // Handle regular text responses
                  const finalText = jobData.responseData.text || jobData.partialContent || 'Response completed.'
                  
                  log.info('Text job completed successfully', { 
                    jobId, 
                    textLength: finalText.length,
                    usage: jobData.responseData.usage
                  })

                  yield {
                    content: [{ 
                      type: 'text' as const, 
                      text: finalText 
                    }],
                  }
                }
              }
              return // Job completed successfully
            }

            // Handle job failure
            if (jobData.status === 'failed') {
              const errorMessage = jobData.errorMessage || 'Job processing failed'
              log.error('Job failed', { jobId, errorMessage })
              throw new Error(errorMessage)
            }

            // Handle job cancellation
            if (jobData.status === 'cancelled') {
              log.info('Job was cancelled', { jobId })
              return
            }

            // Continue polling if job is still in progress
            if (!jobData.shouldContinuePolling) {
              log.warn('Server indicated to stop polling but job not completed', { 
                jobId, 
                status: jobData.status 
              })
              break
            }

          } catch (pollError) {
            // Handle timeout or network errors during polling
            if (pollError instanceof Error && pollError.name === 'AbortError') {
              log.debug('Poll request timed out, will retry', { jobId, attempt: pollAttempts })
              continue // Retry on timeout
            }
            
            log.error('Poll request failed', { 
              jobId, 
              attempt: pollAttempts, 
              error: pollError instanceof Error ? pollError.message : String(pollError)
            })
            
            // For network errors, continue retrying up to max attempts
            if (pollAttempts < maxPollAttempts) {
              continue
            }
            throw pollError
          }
        }

        // If we exit the polling loop without completion, it's a timeout
        throw new Error(`Job polling timed out after ${pollAttempts} attempts`)

      } catch (error) {
        log.error('Nexus polling adapter error', { 
          jobId,
          error: error instanceof Error ? {
            message: error.message,
            name: error.name
          } : String(error)
        })

        // Re-throw the error so assistant-ui can display it
        throw error
      }
    }
  }
}