import { NextRequest } from 'next/server';
import { z } from 'zod';
import { linkDocumentToConversation, getDocumentById } from '@/lib/db/queries/documents';
import { getConversationById } from '@/lib/db/drizzle/nexus-conversations';
import { withErrorHandling, unauthorized } from '@/lib/api-utils';
import { createError } from '@/lib/error-utils';
import { ErrorLevel } from '@/types/actions-types';
import { getServerSession } from '@/lib/auth/server-session';
import { getCurrentUserAction } from '@/actions/db/get-current-user-action';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';

// Request validation schema
// Note: conversationId is a UUID string linking to nexus_conversations.id (Issue #549)
const LinkDocumentRequestSchema = z.object({
  documentId: z.number().positive(),
  conversationId: z.string().uuid()
});
export async function POST(request: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer("api.documents.link");
  const log = createLogger({ requestId, route: "api.documents.link" });
  
  log.info("POST /api/documents/link - Linking document to conversation");
  
  const session = await getServerSession();
  if (!session) {
    log.warn("User not authenticated");
    timer({ status: "error", reason: "unauthorized" });
    return unauthorized('User not authenticated');
  }
  
  const currentUser = await getCurrentUserAction();
  if (!currentUser.isSuccess || !currentUser.data?.user) {
    log.warn("User not found");
    timer({ status: "error", reason: "user_not_found" });
    return unauthorized('User not found');
  }
  
  const userId = currentUser.data.user.id;
  log.debug("Processing link for user", { userId, userIdType: typeof userId });

  return withErrorHandling(async () => {
    const body = await request.json();

    // Validate request body using Zod schema
    const validationResult = LinkDocumentRequestSchema.safeParse(body);
    if (!validationResult.success) {
      const firstError = validationResult.error.issues[0];
      log.warn("Request validation failed", { error: firstError });
      timer({ status: "error", reason: "validation_failed" });
      throw createError(
        firstError.message,
        {
          code: 'VALIDATION',
          level: ErrorLevel.WARN,
          details: {
            validationErrors: validationResult.error.issues.map(issue => ({
              path: issue.path.join('.'),
              message: issue.message
            }))
          }
        }
      );
    }

    const { documentId, conversationId } = validationResult.data;

    // Verify the document belongs to the user
    const document = await getDocumentById({ id: documentId });
    if (!document) {
      log.warn("Document not found", { documentId });
      timer({ status: "error", reason: "document_not_found" });
      throw createError('Document not found', {
        code: 'NOT_FOUND',
        level: ErrorLevel.WARN,
        details: { documentId }
      });
    }

    log.debug("Document ownership check", {
      documentUserId: document.userId,
      documentUserIdType: typeof document.userId,
      currentUserId: userId,
      currentUserIdType: typeof userId,
      comparison: document.userId !== userId
    });

    if (document.userId !== userId) {
      log.warn("Access denied to document", { documentId, userId, documentUserId: document.userId });
      timer({ status: "error", reason: "forbidden" });
      throw createError('Access denied to document', {
        code: 'FORBIDDEN',
        level: ErrorLevel.WARN,
        details: { documentId, userId, documentUserId: document.userId }
      });
    }

    // Verify conversation exists and user owns it (prevents linking to others' conversations)
    const conversation = await getConversationById(conversationId, userId);
    if (!conversation) {
      log.warn("Conversation not found or access denied", { conversationId, userId });
      timer({ status: "error", reason: "conversation_not_found" });
      throw createError('Conversation not found', {
        code: 'NOT_FOUND',
        level: ErrorLevel.WARN,
        details: { conversationId }
      });
    }

    // Link the document to the conversation
    const updatedDocument = await linkDocumentToConversation(documentId, conversationId);
    
    if (!updatedDocument) {
      log.error("Failed to link document to conversation", { documentId, conversationId });
      timer({ status: "error", reason: "link_failed" });
      throw createError('Failed to link document to conversation', {
        code: 'INTERNAL_ERROR',
        level: ErrorLevel.ERROR,
        details: { documentId, conversationId }
      });
    }

    log.info("Document linked successfully", { documentId, conversationId });
    timer({ status: "success" });
    
    return {
      success: true,
      document: updatedDocument
    };
  });
}