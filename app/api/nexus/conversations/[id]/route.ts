import { getServerSession } from '@/lib/auth/server-session'
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from '@/lib/logger'
import { getCurrentUserAction } from '@/actions/db/get-current-user-action'
import { NextRequest } from 'next/server'
import {
  updateConversation,
} from '@/lib/db/drizzle/nexus-conversations'

/**
 * isSaved and isPinned BOTH gate irreversible retention deletion — the sweep's
 * eligibility predicate is `is_saved = false AND is_pinned IS NOT TRUE` — so
 * both are validated strictly rather than coerced. A truthy string must not
 * silently become "kept"/"pinned", and a non-boolean must not silently become
 * "not kept"/"not pinned".
 *
 * Returns the name of the first offending field, or null when both are fine.
 */
function findInvalidBooleanFlag(flags: Record<string, unknown>): string | null {
  for (const [field, value] of Object.entries(flags)) {
    if (value !== undefined && typeof value !== 'boolean') return field
  }
  return null
}

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
    const { title, isArchived, isPinned, isSaved, metadata } = body

    log.debug('Update conversation request', sanitizeForLogging({
      conversationId,
      title: title ? `${String(title).substring(0, 20)}...` : undefined,
      isArchived,
      isPinned,
      isSaved
    }))

    const invalidFlag = findInvalidBooleanFlag({ isSaved, isPinned })
    if (invalidFlag) {
      log.warn('Invalid boolean flag value', { conversationId, field: invalidFlag })
      timer({ status: 'error', reason: `invalid_${invalidFlag}` })
      return new Response(`${invalidFlag} must be a boolean`, { status: 400 })
    }

    // metadata was previously written through unvalidated. It lands in a JSONB
    // column that readers treat as an object, so an array or scalar produces a
    // row shape they do not expect. Closed here while the route is being
    // touched; the only in-app caller of this endpoint is the Keep toggle,
    // which never sends metadata.
    if (
      metadata !== undefined &&
      (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))
    ) {
      log.warn('Invalid metadata value', { conversationId, type: typeof metadata })
      timer({ status: 'error', reason: 'invalid_metadata' })
      return new Response('metadata must be an object', { status: 400 })
    }

    // Build update object with provided fields only
    const updates: Record<string, unknown> = {}
    for (const [field, value] of Object.entries({ title, isArchived, isPinned, isSaved, metadata })) {
      if (value !== undefined) updates[field] = value
    }
    const fieldCount = Object.keys(updates).length

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