import { getServerSession } from '@/lib/auth/server-session';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { ErrorFactories } from '@/lib/error-utils';
import { getCurrentUserAction } from '@/actions/db/get-current-user-action';
import {
  getConversations,
  getConversationCount,
  createConversation,
  recordConversationEvent,
} from '@/lib/db/drizzle/nexus-conversations';

// Valid provider values matching database schema constraints
const VALID_PROVIDERS = [
  'openai',
  'google',
  'bedrock',
  'azure',
  'assistant-architect',
  'decision-capture',
] as const;

/**
 * GET /api/nexus/conversations - List user's conversations
 *
 * Migrated to Drizzle ORM as part of Epic #526, Issue #533
 */
export async function GET(req: Request) {
  const requestId = generateRequestId();
  const timer = startTimer('nexus.conversations.list');
  const log = createLogger({ requestId, route: 'nexus.conversations.list' });

  log.info('GET /api/nexus/conversations - Listing conversations');

  try {
    // Authenticate user
    const session = await getServerSession();
    if (!session) {
      log.warn('Unauthorized request');
      timer({ status: 'error', reason: 'unauthorized' });
      return new Response('Unauthorized', { status: 401 });
    }

    // Get current user with integer ID
    const currentUser = await getCurrentUserAction();
    if (!currentUser.isSuccess) {
      log.error('Failed to get current user');
      timer({ status: 'error', reason: 'user_lookup_failed' });
      return new Response('Unauthorized', { status: 401 });
    }

    const userId = currentUser.data.user.id;

    // Parse query parameters
    const url = new URL(req.url);

    // Validate and constrain limit/offset to prevent DoS (OWASP Input Validation)
    const rawLimit = Number.parseInt(url.searchParams.get('limit') || '20');
    const rawOffset = Number.parseInt(url.searchParams.get('offset') || '0');
    const limit = Number.isNaN(rawLimit) || rawLimit < 1 ? 20 : Math.min(rawLimit, 500);
    const offset = Number.isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

    const includeArchived = url.searchParams.get('includeArchived') === 'true';

    // Validate provider filter against whitelist
    const rawProvider = url.searchParams.get('provider')?.trim();
    const provider = rawProvider && VALID_PROVIDERS.includes(rawProvider as typeof VALID_PROVIDERS[number])
      ? rawProvider
      : undefined;

    // Log invalid provider attempts for monitoring
    if (rawProvider && !provider) {
      log.warn('Invalid provider filter attempted', {
        provider: rawProvider.substring(0, 20), // Truncate to prevent log injection
        userId
      });
    }

    // Validate excludeProviders filter against whitelist
    const excludeProvidersParam = url.searchParams.get('excludeProviders');
    const excludeProviders = excludeProvidersParam
      ? excludeProvidersParam
          .split(',')
          .map((p) => p.trim())
          .filter((p) => VALID_PROVIDERS.includes(p as typeof VALID_PROVIDERS[number]))
      : undefined;

    const queryOptions = {
      limit,
      offset,
      includeArchived,
      provider,
      excludeProviders,
    };

    // Query conversations using Drizzle ORM
    const conversations = await getConversations(userId, queryOptions);

    // Get total count (same filters, no pagination)
    const total = await getConversationCount(userId, {
      includeArchived,
      provider,
      excludeProviders,
    });

    timer({ status: 'success' });
    log.info('Conversations retrieved', {
      requestId,
      userId,
      count: conversations.length,
      total
    });

    return Response.json({
      conversations,
      pagination: {
        limit,
        offset,
        total,
        hasMore: offset + limit < total
      }
    });

  } catch (error) {
    timer({ status: 'error' });
    log.error('Failed to list conversations', {
      error: error instanceof Error ? error.message : String(error)
    });

    return new Response(
      JSON.stringify({
        error: 'Failed to retrieve conversations'
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

/**
 * POST /api/nexus/conversations - Create a new conversation
 *
 * Migrated to Drizzle ORM as part of Epic #526, Issue #533
 */
export async function POST(req: Request) {
  const requestId = generateRequestId();
  const timer = startTimer('nexus.conversations.create');
  const log = createLogger({ requestId, route: 'nexus.conversations.create' });

  log.info('POST /api/nexus/conversations - Creating conversation');

  try {
    // Authenticate user
    const session = await getServerSession();
    if (!session) {
      log.warn('Unauthorized request');
      timer({ status: 'error', reason: 'unauthorized' });
      return new Response('Unauthorized', { status: 401 });
    }

    // Get current user with integer ID
    const currentUser = await getCurrentUserAction();
    if (!currentUser.isSuccess) {
      log.error('Failed to get current user');
      timer({ status: 'error', reason: 'user_lookup_failed' });
      return new Response('Unauthorized', { status: 401 });
    }

    const userId = currentUser.data.user.id;

    // Parse request body
    const body = await req.json();
    const {
      title = 'New Conversation',
      provider = 'openai',
      modelId,
      metadata = {}
    } = body;

    // Create conversation using Drizzle ORM
    const conversation = await createConversation({
      userId,
      title,
      provider,
      modelId,
      metadata,
    });

    if (!conversation) {
      throw ErrorFactories.dbQueryFailed('createConversation');
    }

    // Record creation event (non-blocking, errors are logged but don't fail creation)
    // CloudWatch monitoring approach:
    // 1. startTimer emits CloudWatch metrics via @/lib/logger (nexus.conversation.event.record)
    // 2. ERROR-level logs are indexed for alerting via CloudWatch Logs metric filters
    // 3. Failures are acceptable for audit trail - conversation creation succeeds regardless
    const eventTimer = startTimer('nexus.conversation.event.record');
    recordConversationEvent(
      conversation.id,
      'conversation_created',
      userId,
      {
        provider,
        modelId,
        title
      }
    ).then(() => {
      eventTimer({ status: 'success', eventType: 'conversation_created' });
    }).catch((error) => {
      eventTimer({ status: 'error', eventType: 'conversation_created' });
      log.error('Failed to record conversation event', {
        conversationId: conversation.id,
        error: error instanceof Error ? error.message : String(error),
      })
    });

    timer({ status: 'success' });
    log.info('Conversation created', {
      requestId,
      userId,
      conversationId: conversation.id,
      provider,
      modelId
    });

    return Response.json(conversation);

  } catch (error) {
    timer({ status: 'error' });
    log.error('Failed to create conversation', {
      error: error instanceof Error ? error.message : String(error)
    });

    return new Response(
      JSON.stringify({
        error: 'Failed to create conversation'
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}