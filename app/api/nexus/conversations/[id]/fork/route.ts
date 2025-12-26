import { getServerSession } from '@/lib/auth/server-session';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import {
  getConversationById,
  recordConversationEvent,
  updateConversation,
  getUserIdByCognitoSubAsNumber,
} from '@/lib/db/drizzle';
import { executeQuery } from '@/lib/db/drizzle-client';
import { nexusConversations } from '@/lib/db/schema';


interface ForkRequest {
  atMessageId?: string;
  newTitle?: string;
  metadata?: Record<string, unknown>;
}

/**
 * POST /api/nexus/conversations/[id]/fork - Fork a conversation
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer('nexus.conversation.fork');
  const { id: originalConversationId } = await params;
  const log = createLogger({ 
    requestId, 
    route: 'nexus.conversation.fork',
    originalConversationId 
  });
  
  log.info('POST /api/nexus/conversations/[id]/fork - Forking conversation');
  
  try {
    // Authenticate user
    const session = await getServerSession();
    if (!session) {
      log.warn('Unauthorized request');
      timer({ status: 'error', reason: 'unauthorized' });
      return new Response('Unauthorized', { status: 401 });
    }
    
    const userCognitoSub = session.sub;

    // Get numeric user ID
    const userId = await getUserIdByCognitoSubAsNumber(userCognitoSub);
    if (!userId) {
      log.warn('User not found', { cognitoSub: userCognitoSub });
      timer({ status: 'error', reason: 'user_not_found' });
      return new Response('User not found', { status: 404 });
    }

    // Parse request body
    const body: ForkRequest = await req.json();

    // Get original conversation
    const original = await getConversationById(originalConversationId, userId);

    if (!original) {
      log.warn('Original conversation not found', {
        originalConversationId,
        userId
      });
      timer({ status: 'error', reason: 'not_found' });
      return new Response('Conversation not found', { status: 404 });
    }
    
    // Create forked conversation
    const newTitle = body.newTitle || `${original.title} (Fork)`;
    const newMetadata = {
      ...(original.metadata || {}),
      ...(body.metadata || {}),
      forkedFrom: originalConversationId,
      forkedAt: new Date().toISOString(),
      atMessageId: body.atMessageId
    };

    // Create the forked conversation using Drizzle
    const [forkedConversation] = await executeQuery(
      (db) =>
        db
          .insert(nexusConversations)
          .values({
            userId,
            title: newTitle,
            provider: original.provider,
            modelUsed: original.modelUsed,
            externalId: null, // New external_id will be set on first message
            cacheKey: null, // New cache_key will be generated
            messageCount: 0,
            totalTokens: 0,
            metadata: newMetadata,
          })
          .returning({
            id: nexusConversations.id,
            title: nexusConversations.title,
            provider: nexusConversations.provider,
            modelUsed: nexusConversations.modelUsed,
            metadata: nexusConversations.metadata,
            createdAt: nexusConversations.createdAt,
            updatedAt: nexusConversations.updatedAt,
          }),
      "forkConversation"
    );
    
    // Record fork events for both conversations
    await Promise.all([
      recordConversationEvent(
        originalConversationId,
        'conversation_forked',
        userId,
        {
          forkedTo: forkedConversation.id,
          atMessageId: body.atMessageId,
          forkedBy: userId,
        }
      ),
      recordConversationEvent(
        forkedConversation.id,
        'conversation_created_from_fork',
        userId,
        {
          forkedFrom: originalConversationId,
          atMessageId: body.atMessageId,
          createdBy: userId,
        }
      ),
    ]);
    
    // If OpenAI with external_id, handle forking at provider level
    if (original.provider === 'openai' && original.externalId && body.atMessageId) {
      // Store the fork point for later use when continuing the conversation
      const updatedMetadata = {
        ...forkedConversation.metadata,
        forkPoint: {
          originalResponseId: original.externalId,
          atMessageId: body.atMessageId,
        },
      };

      await updateConversation(forkedConversation.id, userId, {
        metadata: updatedMetadata,
      });
    }
    
    timer({ status: 'success' });
    log.info('Conversation forked successfully', {
      requestId,
      originalConversationId,
      forkedConversationId: forkedConversation.id,
      provider: original.provider
    });

    return Response.json({
      originalConversationId,
      forkedConversation,
      forkMetadata: {
        atMessageId: body.atMessageId,
        timestamp: new Date().toISOString(),
        provider: original.provider,
        supportsNativeFork: original.provider === 'openai' && !!original.externalId
      }
    });
    
  } catch (error) {
    timer({ status: 'error' });
    log.error('Failed to fork conversation', {
      originalConversationId,
      error: error instanceof Error ? error.message : String(error)
    });
    
    return new Response(
      JSON.stringify({
        error: 'Failed to fork conversation'
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}