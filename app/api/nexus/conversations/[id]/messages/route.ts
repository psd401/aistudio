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
import { getDocumentSignedUrl } from '@/lib/aws/s3-client'

// Broader content type for API response (less strict than MessagePart)
type ContentPart = { type: string; text?: string; [key: string]: unknown }

interface NexusMessageResponse {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: ContentPart[]
  createdAt: Date
  metadata?: Record<string, unknown>
}

// Content size limits
const MAX_CONTENT_LENGTH = 50000

/**
 * Truncate content to prevent memory issues
 */
function truncateContent(content: string): string {
  if (typeof content === 'string' && content.length > MAX_CONTENT_LENGTH) {
    return content.substring(0, MAX_CONTENT_LENGTH) + '...[content truncated for size]'
  }
  return content
}

/**
 * Convert a part to content format, handling images as markdown and passing through tool parts.
 * For image parts with s3Key, generates a fresh presigned URL to replace expired ones.
 */
async function convertPartToTextContent(part: MessagePart): Promise<ContentPart | null> {
  const partType = part.type as string

  if (partType === 'text') {
    const text = part.text && typeof part.text === 'string' && part.text.length > MAX_CONTENT_LENGTH
      ? part.text.substring(0, MAX_CONTENT_LENGTH) + '...[content truncated for size]'
      : part.text || ''
    return { type: 'text', text }
  }

  if (partType === 'image') {
    // Refresh presigned URL from s3Key if available (fixes expired URL issue)
    const s3Key = part.s3Key
    if (s3Key) {
      try {
        const freshUrl = await getDocumentSignedUrl({ key: s3Key, expiresIn: 3600 })
        return { type: 'text', text: `![Generated Image](${freshUrl})` }
      } catch (error) {
        // Log error and fall through to stored imageUrl if URL generation fails
        const log = createLogger({ context: 'convertPartToTextContent' })
        log.warn('Failed to refresh presigned URL from s3Key', {
          s3Key,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    // Fallback to stored imageUrl if no s3Key or URL generation failed
    const imageUrl = part.imageUrl
    return imageUrl ? { type: 'text', text: `![Generated Image](${imageUrl})` } : null
  }

  // Pass through tool-call and tool-result parts as-is for UI rendering
  if (partType === 'tool-call' || partType === 'tool-result') {
    return part as unknown as ContentPart
  }

  // Skip control types
  if (partType === 'step-start' || partType === 'step-finish') {
    return null
  }

  // For other types, try to extract text if available
  return part.text ? { type: 'text', text: part.text } : null
}

/**
 * Truncate parts content and ensure at least one part.
 * Async to support presigned URL refresh for image parts.
 */
async function truncatePartsContent(parts: MessagePart[]): Promise<ContentPart[]> {
  const results = await Promise.all(parts.map(part => convertPartToTextContent(part)))
  const converted = results.filter((part): part is ContentPart => part !== null)
  return converted.length > 0 ? converted : [{ type: 'text', text: '' }]
}

/**
 * Validate pagination parameters
 */
function validatePagination(limitParam: string, offsetParam: string): {
  valid: boolean
  limit: number
  offset: number
} {
  const parsedLimit = Number.parseInt(limitParam, 10)
  const parsedOffset = Number.parseInt(offsetParam, 10)

  const isValid = !Number.isNaN(parsedLimit) && !Number.isNaN(parsedOffset) &&
    limitParam === parsedLimit.toString() && offsetParam === parsedOffset.toString()

  const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? DEFAULT_MESSAGE_LIMIT : parsedLimit, 1), MAX_MESSAGE_LIMIT)
  const offset = Math.max(Number.isNaN(parsedOffset) ? 0 : parsedOffset, 0)

  return { valid: isValid, limit, offset }
}

/**
 * Determine error response details
 */
function getErrorDetails(error: unknown): { statusCode: number; errorCode: string; errorMessage: string } {
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

  return { statusCode, errorCode, errorMessage }
}

/**
 * Convert message to AI SDK format.
 * Async to support presigned URL refresh for image parts.
 */
async function convertMessageToAiSdk(msg: {
  id: string
  role: string
  content?: string | null
  parts?: MessagePart[] | null
  createdAt?: Date | null
  metadata?: Record<string, unknown> | null
}): Promise<NexusMessageResponse> {
  const truncatedContent = msg.content ? truncateContent(msg.content) : null
  let truncatedParts: ContentPart[] | null = null

  if (msg.parts && Array.isArray(msg.parts)) {
    truncatedParts = await truncatePartsContent(msg.parts)
  }

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

    const currentUser = await getCurrentUserAction()
    if (!currentUser.isSuccess) {
      log.error('Failed to get current user')
      timer({ status: 'error', reason: 'user_lookup_failed' })
      return new Response('Unauthorized', { status: 401 })
    }

    const userId = currentUser.data.user.id
    const conversation = await getConversationById(conversationId, userId)

    if (!conversation) {
      log.warn('Conversation not found or access denied', { conversationId, userId })
      timer({ status: 'error', reason: 'not_found' })
      return new Response('Conversation not found', { status: 404 })
    }

    // Parse and validate pagination parameters
    const url = new URL(req.url)
    const limitParam = url.searchParams.get('limit') || String(DEFAULT_MESSAGE_LIMIT)
    const offsetParam = url.searchParams.get('offset') || '0'
    const pagination = validatePagination(limitParam, offsetParam)

    if (!pagination.valid) {
      log.warn('Invalid pagination parameters', { limitParam, offsetParam, conversationId })
      return new Response(
        JSON.stringify({ error: 'Invalid pagination parameters' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Query messages and total count
    const messages = await getMessagesByConversation(conversationId, {
      limit: pagination.limit,
      offset: pagination.offset,
      includeModel: false,
    })
    const totalCount = await getMessageCount(conversationId)

    // Convert to AI SDK format (async for presigned URL refresh)
    const aiSdkMessages = await Promise.all(messages.map(convertMessageToAiSdk))

    timer({ status: 'success' })
    log.info('Messages retrieved', { conversationId, userId, messageCount: messages.length })

    return Response.json({
      messages: aiSdkMessages,
      conversation: { id: conversation.id, title: conversation.title },
      pagination: { limit: pagination.limit, offset: pagination.offset, total: totalCount }
    })

  } catch (error) {
    timer({ status: 'error' })
    log.error('Failed to get messages', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      conversationId,
      requestId
    })

    const { statusCode, errorCode, errorMessage } = getErrorDetails(error)

    return new Response(
      JSON.stringify({ error: errorMessage, code: errorCode, requestId }),
      { status: statusCode, headers: { 'Content-Type': 'application/json' } }
    )
  }
}
