import { getServerSession } from '@/lib/auth/server-session'
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from '@/lib/logger'
import { getCurrentUserAction } from '@/actions/db/get-current-user-action'
import { NextRequest } from 'next/server'
import {
  getConversationById,
  updateConversation,
} from '@/lib/db/drizzle/nexus-conversations'

/**
 * PATCH /api/nexus/conversations/[id] - Update a conversation
 *
 * Migrated to Drizzle ORM as part of Epic #526, Issue #533
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId()
  const timer = startTimer('nexus.conversations.update')
  const log = createLogger({ requestId, route: 'nexus.conversations.update' })

  try {
    const resolvedParams = await params
    const conversationId = resolvedParams.id

    log.info('PATCH /api/nexus/conversations/[id]', { conversationId })

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
    const { title, isArchived, isPinned, metadata } = body

    log.debug('Update conversation request', sanitizeForLogging({
      conversationId,
      title: title ? `${String(title).substring(0, 20)}...` : undefined,
      isArchived,
      isPinned
    }))

    // Build update object with provided fields only
    const updates: Record<string, unknown> = {}
    let fieldCount = 0

    if (title !== undefined) {
      updates.title = title
      fieldCount++
    }

    if (isArchived !== undefined) {
      updates.isArchived = isArchived
      fieldCount++
    }

    if (isPinned !== undefined) {
      updates.isPinned = isPinned
      fieldCount++
    }

    if (metadata !== undefined) {
      updates.metadata = metadata
      fieldCount++
    }

    if (fieldCount === 0) {
      log.warn('No fields to update')
      return Response.json({ message: 'No fields to update' })
    }

    // Update using Drizzle ORM (ownership is verified in updateConversation)
    const updatedConversation = await updateConversation(
      conversationId,
      userId,
      updates
    )

    if (!updatedConversation) {
      log.warn('Conversation not found or access denied', { conversationId, userId })
      timer({ status: 'error', reason: 'not_found' })
      return new Response('Conversation not found', { status: 404 })
    }

    timer({ status: 'success' })
    log.info('Conversation updated successfully', {
      requestId,
      conversationId,
      userId,
      updatedFields: fieldCount
    })

    return Response.json(updatedConversation)

  } catch (error) {
    timer({ status: 'error' })
    log.error('Failed to update conversation', {
      error: error instanceof Error ? error.message : String(error)
    })

    return new Response(
      JSON.stringify({
        error: 'Failed to update conversation'
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    )
  }
}