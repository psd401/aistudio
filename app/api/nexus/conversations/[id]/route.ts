import { getServerSession } from '@/lib/auth/server-session'
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from '@/lib/logger'
import { getCurrentUserAction } from '@/actions/db/get-current-user-action'
import { NextRequest } from 'next/server'
import {
  getConversationById,
  updateConversation,
  type UpdateConversationData,
} from '@/lib/db/drizzle/nexus-conversations'
import { hasCapabilityAccess } from '@/lib/db/drizzle/capabilities'
import type { NexusConversationMetadata } from '@/lib/db/types/jsonb'

/**
 * isSaved and isPinned both gate irreversible retention deletion — the sweep's
 * eligibility predicate is `is_saved = false AND is_pinned IS NOT TRUE`.
 * Every boolean PATCH flag is therefore validated strictly rather than
 * coerced. A truthy string must not silently alter retention or memory state.
 *
 * Returns the name of the first offending field, or null when all are fine.
 */
function findInvalidBooleanFlag(flags: Record<string, unknown>): string | null {
  for (const [field, value] of Object.entries(flags)) {
    if (value !== undefined && typeof value !== 'boolean') return field
  }
  return null
}

interface ParsedConversationUpdate {
  updates: UpdateConversationData
  memoryDisabled?: boolean
  fieldCount: number
  error?: {
    message: string
    reason: string
  }
}

function parseConversationUpdate(
  body: Record<string, unknown>,
): ParsedConversationUpdate {
  const { title, isArchived, isPinned, isSaved, metadata, memoryDisabled } =
    body
  const fieldCount = Object.values({
    title,
    isArchived,
    isPinned,
    isSaved,
    metadata,
    memoryDisabled,
  }).filter((value) => value !== undefined).length
  const invalidFlag = findInvalidBooleanFlag({
    isArchived,
    isSaved,
    isPinned,
    memoryDisabled,
  })
  if (invalidFlag) {
    return {
      updates: {},
      fieldCount,
      error: {
        message: `${invalidFlag} must be a boolean`,
        reason: `invalid_${invalidFlag}`,
      },
    }
  }
  if (memoryDisabled !== undefined && metadata !== undefined) {
    return {
      updates: {},
      fieldCount,
      error: {
        message: 'memoryDisabled and metadata cannot be updated together',
        reason: 'ambiguous_metadata',
      },
    }
  }
  if (
    metadata !== undefined &&
    (typeof metadata !== 'object' ||
      metadata === null ||
      Array.isArray(metadata))
  ) {
    return {
      updates: {},
      fieldCount,
      error: {
        message: 'metadata must be an object',
        reason: 'invalid_metadata',
      },
    }
  }

  const updates: UpdateConversationData = {}
  if (title !== undefined) updates.title = title as string
  if (isArchived !== undefined) updates.isArchived = isArchived as boolean
  if (isPinned !== undefined) updates.isPinned = isPinned as boolean
  if (isSaved !== undefined) updates.isSaved = isSaved as boolean
  if (metadata !== undefined) {
    updates.metadata = metadata as NexusConversationMetadata
  }
  return {
    updates,
    memoryDisabled: memoryDisabled as boolean | undefined,
    fieldCount,
  }
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
    const body = await req.json() as Record<string, unknown>
    const {
      updates,
      memoryDisabled,
      fieldCount,
      error: parseError,
    } = parseConversationUpdate(body)

    log.debug('Update conversation request', sanitizeForLogging({
      conversationId,
      title: body.title
        ? `${String(body.title).substring(0, 20)}...`
        : undefined,
      isArchived: body.isArchived,
      isPinned: body.isPinned,
      isSaved: body.isSaved,
      memoryDisabled,
    }))

    if (parseError) {
      log.warn('Invalid conversation update', {
        conversationId,
        reason: parseError.reason,
      })
      timer({ status: 'error', reason: parseError.reason })
      return new Response(parseError.message, { status: 400 })
    }

    if (memoryDisabled !== undefined) {
      if (!(await hasCapabilityAccess(session.sub, 'nexus-memory'))) {
        log.warn('Nexus memory toggle denied', {
          conversationId,
          userId,
        })
        timer({ status: 'error', reason: 'memory_capability_denied' })
        return new Response('Forbidden', { status: 403 })
      }
      const existing = await getConversationById(conversationId, userId)
      if (!existing) {
        log.warn('Conversation not found for memory toggle', {
          conversationId,
          userId,
        })
        timer({ status: 'error', reason: 'not_found' })
        return new Response('Conversation not found', { status: 404 })
      }
      updates.metadata = {
        ...(existing.metadata ?? {}),
        memoryDisabled,
      }
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
