import { getServerSession } from '@/lib/auth/server-session';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { executeSQL } from '@/lib/streaming/nexus/db-helpers';
import { transformSnakeToCamel } from '@/lib/db/field-mapper';
import { getCurrentUserAction } from '@/actions/db/get-current-user-action';


interface ConversationListItem {
  id: string;
  title: string;
  provider: string;
  modelUsed: string;
  messageCount: number;
  totalTokens: number;
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
  isArchived: boolean;
  isPinned: boolean;
  externalId?: string;
  cacheKey?: string;
}

/**
 * GET /api/nexus/conversations - List user's conversations
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
    const limit = Number.parseInt(url.searchParams.get('limit') || '20');
    const offset = Number.parseInt(url.searchParams.get('offset') || '0');
    const includeArchived = url.searchParams.get('includeArchived') === 'true';
    
    // Query conversations 
    const query = `
      SELECT 
        id, title, provider, model_used, message_count, total_tokens, 
        last_message_at, created_at, updated_at, is_archived, is_pinned, 
        external_id, cache_key 
      FROM nexus_conversations 
      WHERE user_id = $1 
        ${includeArchived ? '' : 'AND (is_archived = false OR is_archived IS NULL)'}
      ORDER BY is_pinned DESC NULLS LAST, COALESCE(last_message_at, updated_at) DESC 
      LIMIT $2 OFFSET $3
    `;
    
    const result = await executeSQL(query, [userId, limit, offset]);
    
    // Transform snake_case to camelCase
    const conversations: ConversationListItem[] = result.map(row => 
      transformSnakeToCamel<ConversationListItem>(row)
    );
    
    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM nexus_conversations 
      WHERE user_id = $1 
        ${includeArchived ? '' : 'AND (is_archived = false OR is_archived IS NULL)'}
    `;
    
    const countResult = await executeSQL(countQuery, [userId]);
    const total = Number.parseInt((countResult[0].total as string) || '0');
    
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
    
    // Create conversation
    const result = await executeSQL(`
      INSERT INTO nexus_conversations (
        user_id,
        title,
        provider,
        model_used,
        message_count,
        total_tokens,
        metadata,
        created_at,
        updated_at
      ) VALUES (
        $1, $2, $3, $4, 0, 0, $5, NOW(), NOW()
      ) RETURNING 
        id,
        title,
        provider,
        model_used as model_id,
        created_at,
        updated_at
    `, [userId, title, provider, modelId, metadata]);
    
    const conversation = transformSnakeToCamel<{
      id: string;
      title: string;
      provider: string;
      modelId: string;
      createdAt: string;
      updatedAt: string;
    }>(result[0]);
    
    // Record creation event
    await executeSQL(`
      INSERT INTO nexus_conversation_events (
        conversation_id,
        event_type,
        event_data,
        created_at
      ) VALUES ($1, $2, $3, NOW())
    `, [
      conversation.id,
      'conversation_created',
      JSON.stringify({
        provider,
        modelId,
        title
      })
    ]);
    
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