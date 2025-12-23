import { getServerSession } from '@/lib/auth/server-session'
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from '@/lib/logger'
import { getCurrentUserAction } from '@/actions/db/get-current-user-action'
import { NextRequest } from 'next/server'
import {
  upsertMessageWithStats,
  getConversationById,
  type MessagePart,
  type TokenUsage,
} from '@/lib/db/drizzle'

/**
 * POST /api/nexus/messages - Save a message to a conversation
 *
 * Migrated to Drizzle ORM as part of Epic #526
 * Issue #534 - Migrate Nexus Messages & Artifacts to Drizzle ORM
 */
export async function POST(req: NextRequest) {
  const requestId = generateRequestId()
  const timer = startTimer('nexus.messages.create')
  const log = createLogger({ requestId, route: 'nexus.messages.create' })

  log.info('POST /api/nexus/messages - Saving message')

  try {
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

    // Parse request body
    const body = await req.json()
    const {
      conversationId,
      messageId,
      role,
      content,
      parts,
      modelId,
      reasoningContent,
      tokenUsage,
      finishReason,
      metadata = {}
    } = body as {
      conversationId: string
      messageId: string
      role: 'user' | 'assistant' | 'system'
      content?: string
      parts?: MessagePart[]
      modelId?: number
      reasoningContent?: string
      tokenUsage?: TokenUsage
      finishReason?: string
      metadata?: Record<string, unknown>
    }

    log.debug('Message save request', sanitizeForLogging({
      conversationId,
      messageId,
      role,
      contentLength: content?.length || 0,
      partsCount: Array.isArray(parts) ? parts.length : 0
    }))

    // Validate required fields
    if (!conversationId || !messageId || !role) {
      log.warn('Missing required fields', { conversationId, messageId, role })
      timer({ status: 'error', reason: 'validation' })
      return new Response(
        JSON.stringify({ error: 'Missing required fields: conversationId, messageId, role' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Verify user owns this conversation using Drizzle
    const conversation = await getConversationById(conversationId, userId)

    if (!conversation) {
      log.warn('Conversation not found or access denied', { conversationId, userId })
      timer({ status: 'error', reason: 'not_found' })
      return new Response('Conversation not found', { status: 404 })
    }

    // Upsert message and update conversation stats using Drizzle
    await upsertMessageWithStats(messageId, conversationId, {
      role,
      content: content || undefined,
      parts: parts || undefined,
      modelId: modelId || undefined,
      reasoningContent: reasoningContent || undefined,
      tokenUsage: tokenUsage || undefined,
      finishReason: finishReason || undefined,
      metadata: metadata,
    })

    log.debug('Message saved', { messageId, conversationId })

    timer({ status: 'success' })
    log.info('Message saved successfully', {
      requestId,
      messageId,
      conversationId,
      userId,
      role
    })

    return Response.json({
      success: true,
      messageId,
      conversationId
    })

  } catch (error) {
    timer({ status: 'error' })
    log.error('Failed to save message', {
      error: error instanceof Error ? error.message : String(error)
    })

    return new Response(
      JSON.stringify({
        error: 'Failed to save message'
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    )
  }
}
