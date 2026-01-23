import { getServerSession } from '@/lib/auth/server-session'
import { createLogger, generateRequestId, startTimer } from '@/lib/logger'
import { getCurrentUserAction } from '@/actions/db/get-current-user-action'
import { NextRequest } from 'next/server'
import {
  getMessagesByConversation,
  getMessageCount,
  getConversationById,
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  type MessagePart,
} from '@/lib/db/drizzle'

// Broader content type for API response (less strict than MessagePart)
type ContentPart = { type: string; text?: string; [key: string]: unknown }

interface NexusMessageResponse {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: ContentPart[]
  createdAt: Date
  metadata?: Record<string, unknown>
}

/**
 * GET /api/nexus/conversations/[id]/messages - Get messages for a conversation
 *
 * Migrated to Drizzle ORM as part of Epic #526
 * Issue #534 - Migrate Nexus Messages & Artifacts to Drizzle ORM
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId()
  const timer = startTimer('nexus.conversations.messages.get')
  const log = createLogger({ requestId, route: 'nexus.conversations.messages.get' })

  let conversationId: string | undefined

  try {
    const resolvedParams = await params
    conversationId = resolvedParams.id

    log.info('GET /api/nexus/conversations/[id]/messages', { conversationId })

    // Authenticate user
    const session = await getServerSession()
    if (!session) {
      log.warn('Unauthorized request')
      timer({ status: 'error', reason: 'unauthorized' })
      return new Response('Unauthorized', { status: 401 })
    }

    // Get current user with integer ID
    const currentUser = await getCurrentUserAction()
    if (!currentUser.isSuccess) {
      log.error('Failed to get current user')
      timer({ status: 'error', reason: 'user_lookup_failed' })
      return new Response('Unauthorized', { status: 401 })
    }

    const userId = currentUser.data.user.id

    // Verify user owns this conversation using Drizzle
    const conversation = await getConversationById(conversationId, userId)

    if (!conversation) {
      log.warn('Conversation not found or access denied', { conversationId, userId })
      timer({ status: 'error', reason: 'not_found' })
      return new Response('Conversation not found', { status: 404 })
    }

    // Parse and validate query parameters
    const url = new URL(req.url)
    const limitParam = url.searchParams.get('limit') || String(DEFAULT_MESSAGE_LIMIT)
    const offsetParam = url.searchParams.get('offset') || '0'

    // Validate and bound limit parameter (1-1000)
    const parsedLimit = Number.parseInt(limitParam, 10)
    const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? DEFAULT_MESSAGE_LIMIT : parsedLimit, 1), MAX_MESSAGE_LIMIT)

    // Validate and bound offset parameter (0 or positive)
    const parsedOffset = Number.parseInt(offsetParam, 10)
    const offset = Math.max(Number.isNaN(parsedOffset) ? 0 : parsedOffset, 0)

    // Additional validation to prevent potential abuse
    if (Number.isNaN(parsedLimit) || Number.isNaN(parsedOffset) ||
        limitParam !== parsedLimit.toString() ||
        offsetParam !== parsedOffset.toString()) {
      log.warn('Invalid pagination parameters', {
        limitParam,
        offsetParam,
        conversationId
      })
      return new Response(
        JSON.stringify({ error: 'Invalid pagination parameters' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    }

    // Query messages using Drizzle
    const messages = await getMessagesByConversation(conversationId, {
      limit,
      offset,
      includeModel: false, // Model info not needed for UI display
    })

    // Get total message count for pagination
    const totalCount = await getMessageCount(conversationId)

    // Helper function to truncate content to prevent memory issues
    const MAX_CONTENT_LENGTH = 50000 // 50KB per content field
    const truncateContent = (content: string): string => {
      if (typeof content === 'string' && content.length > MAX_CONTENT_LENGTH) {
        return content.substring(0, MAX_CONTENT_LENGTH) + '...[content truncated for size]'
      }
      return content
    }

    // Convert a part to content format, handling images as markdown and passing through tool parts
    // Note: Database parts can have various types beyond the strict MessagePart type
    const convertPartToTextContent = (part: MessagePart): ContentPart | null => {
      const partType = part.type as string // Database may have additional part types

      if (partType === 'text') {
        const text = part.text && typeof part.text === 'string' && part.text.length > MAX_CONTENT_LENGTH
          ? part.text.substring(0, MAX_CONTENT_LENGTH) + '...[content truncated for size]'
          : part.text || ''
        return { type: 'text', text }
      }
      if (partType === 'image') {
        // Convert image parts to markdown image syntax
        const imageUrl = (part as unknown as { imageUrl?: string }).imageUrl
        if (imageUrl) {
          return { type: 'text', text: `![Generated Image](${imageUrl})` }
        }
        return null
      }
      // Pass through tool-call and tool-result parts as-is for UI rendering (charts, etc.)
      if (partType === 'tool-call' || partType === 'tool-result') {
        return part as unknown as ContentPart
      }
      // Skip step-start, step-finish, and other control types
      if (partType === 'step-start' || partType === 'step-finish') {
        return null
      }
      // For other types, try to extract text if available
      if (part.text) {
        return { type: 'text', text: part.text }
      }
      return null
    }

    const truncatePartsContent = (parts: MessagePart[]): ContentPart[] => {
      const converted = parts
        .map(part => convertPartToTextContent(part))
        .filter((part): part is ContentPart => part !== null)

      // Ensure at least one content part
      return converted.length > 0 ? converted : [{ type: 'text', text: '' }]
    }

    // Convert to AI SDK format with content size limits
    const aiSdkMessages: NexusMessageResponse[] = messages.map(msg => {
      // Apply content truncation
      let truncatedContent = msg.content
      let truncatedParts: ContentPart[] | null = null

      if (truncatedContent) {
        truncatedContent = truncateContent(truncatedContent)
      }

      if (msg.parts && Array.isArray(msg.parts)) {
        truncatedParts = truncatePartsContent(msg.parts)
      }

      const baseMessage = {
        id: msg.id,
        role: msg.role as 'user' | 'assistant' | 'system',
        createdAt: msg.createdAt || new Date(),
        ...(msg.metadata && { metadata: msg.metadata })
      }

      // Handle content format - prefer parts over plain content
      if (truncatedParts && truncatedParts.length > 0) {
        return {
          ...baseMessage,
          content: truncatedParts
        }
      } else if (truncatedContent) {
        return {
          ...baseMessage,
          content: [{ type: 'text', text: truncatedContent }]
        }
      } else {
        return {
          ...baseMessage,
          content: [{ type: 'text', text: '' }]
        }
      }
    })

    timer({ status: 'success' })
    log.info('Messages retrieved', {
      requestId,
      conversationId,
      userId,
      messageCount: messages.length
    })

    return Response.json({
      messages: aiSdkMessages,
      conversation: {
        id: conversation.id,
        title: conversation.title
      },
      pagination: {
        limit,
        offset,
        total: totalCount
      }
    })

  } catch (error) {
    timer({ status: 'error' })
    log.error('Failed to get messages', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      conversationId,
      requestId
    })

    // Determine error type and appropriate response
    let statusCode = 500
    let errorCode = 'MESSAGES_FETCH_ERROR'
    let errorMessage = 'Failed to retrieve messages'

    if (error instanceof Error) {
      // Handle specific error types
      if (error.message.includes('invalid input syntax for type uuid')) {
        statusCode = 400
        errorCode = 'INVALID_CONVERSATION_ID'
        errorMessage = 'Invalid conversation ID format'
      } else if (error.message.includes('connection')) {
        errorCode = 'DATABASE_CONNECTION_ERROR'
        errorMessage = 'Database connection error'
      } else if (error.message.includes('timeout')) {
        errorCode = 'REQUEST_TIMEOUT'
        errorMessage = 'Request timed out'
      }
    }

    return new Response(
      JSON.stringify({
        error: errorMessage,
        code: errorCode,
        requestId
      }),
      {
        status: statusCode,
        headers: { 'Content-Type': 'application/json' }
      }
    )
  }
}
