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

// Constants for content size limits
const MAX_CONTENT_LENGTH = 50000 // 50KB per content field

/**
 * Truncate content string to prevent memory issues
 */
function truncateContent(content: string): string {
  if (typeof content === 'string' && content.length > MAX_CONTENT_LENGTH) {
    return content.substring(0, MAX_CONTENT_LENGTH) + '...[content truncated for size]'
  }
  return content
}

/**
 * Convert a message part to content format for API response
 * Handles images as markdown, passes through tool parts, skips control types
 */
function convertPartToContentPart(part: MessagePart): ContentPart | null {
  const partType = part.type as string

  if (partType === 'text') {
    const text = part.text && typeof part.text === 'string' && part.text.length > MAX_CONTENT_LENGTH
      ? part.text.substring(0, MAX_CONTENT_LENGTH) + '...[content truncated for size]'
      : part.text || ''
    return { type: 'text', text }
  }
  if (partType === 'image') {
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

/**
 * Convert message parts array to content parts, ensuring at least one part
 */
function convertPartsToContent(parts: MessagePart[]): ContentPart[] {
  const converted = parts
    .map(part => convertPartToContentPart(part))
    .filter((part): part is ContentPart => part !== null)
  return converted.length > 0 ? converted : [{ type: 'text', text: '' }]
}

/**
 * Parse and validate pagination parameters
 * Returns validated values or null if invalid
 */
function parsePaginationParams(url: URL): { limit: number; offset: number } | null {
  const limitParam = url.searchParams.get('limit') || String(DEFAULT_MESSAGE_LIMIT)
  const offsetParam = url.searchParams.get('offset') || '0'

  const parsedLimit = Number.parseInt(limitParam, 10)
  const parsedOffset = Number.parseInt(offsetParam, 10)

  // Validate strict number parsing (no leading zeros, spaces, etc.)
  if (Number.isNaN(parsedLimit) || Number.isNaN(parsedOffset) ||
      limitParam !== parsedLimit.toString() ||
      offsetParam !== parsedOffset.toString()) {
    return null
  }

  return {
    limit: Math.min(Math.max(parsedLimit, 1), MAX_MESSAGE_LIMIT),
    offset: Math.max(parsedOffset, 0)
  }
}

/**
 * Build error response based on error type
 */
function buildErrorResponse(error: unknown, requestId: string): Response {
  let statusCode = 500
  let errorCode = 'MESSAGES_FETCH_ERROR'
  let errorMessage = 'Failed to retrieve messages'

  if (error instanceof Error) {
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
    JSON.stringify({ error: errorMessage, code: errorCode, requestId }),
    { status: statusCode, headers: { 'Content-Type': 'application/json' } }
  )
}

/**
 * Convert a database message to API response format
 */
function convertMessageToResponse(msg: {
  id: string
  role: string
  content: string | null
  parts: MessagePart[] | null
  createdAt: Date | null
  metadata: Record<string, unknown> | null
}): NexusMessageResponse {
  const truncatedContent = msg.content ? truncateContent(msg.content) : null
  const truncatedParts = msg.parts ? convertPartsToContent(msg.parts) : null

  const baseMessage = {
    id: msg.id,
    role: msg.role as 'user' | 'assistant' | 'system',
    createdAt: msg.createdAt || new Date(),
    ...(msg.metadata && { metadata: msg.metadata })
  }

  if (truncatedParts && truncatedParts.length > 0) {
    return { ...baseMessage, content: truncatedParts }
  }
  if (truncatedContent) {
    return { ...baseMessage, content: [{ type: 'text', text: truncatedContent }] }
  }
  return { ...baseMessage, content: [{ type: 'text', text: '' }] }
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
    const pagination = parsePaginationParams(new URL(req.url))
    if (!pagination) {
      log.warn('Invalid pagination parameters', { conversationId })
      return new Response(
        JSON.stringify({ error: 'Invalid pagination parameters' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }
    const { limit, offset } = pagination

    // Query messages using Drizzle
    const messages = await getMessagesByConversation(conversationId, {
      limit,
      offset,
      includeModel: false, // Model info not needed for UI display
    })

    // Get total message count for pagination
    const totalCount = await getMessageCount(conversationId)

    // Convert to AI SDK format with content size limits
    const aiSdkMessages = messages.map(convertMessageToResponse)

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
    return buildErrorResponse(error, requestId)
  }
}
