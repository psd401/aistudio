import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDocumentSignedUrl, deleteDocument } from '@/lib/aws/s3-client';
import {
  getDocumentsByConversationId,
  getDocumentById,
  deleteDocumentById
} from '@/lib/db/queries/documents';
import { getConversationById } from '@/lib/db/drizzle/nexus-conversations';
import { getServerSession } from '@/lib/auth/server-session';
import { getCurrentUserAction } from '@/actions/db/get-current-user-action';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { legacyContentRetirementResponse } from '@/lib/repositories/content-platform/legacy-retirement-response';

// Query parameter validation schemas
// Note: conversationId is a UUID string linking to nexus_conversations.id (Issue #549)
const GetDocumentByIdSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid document ID').transform(Number)
});

const GetDocumentsByConversationSchema = z.object({
  conversationId: z.string().uuid({ message: 'Invalid conversation ID format (expected UUID)' })
});

type DocumentRouteLogger = ReturnType<typeof createLogger>;
type DocumentRouteTimer = ReturnType<typeof startTimer>;

interface DocumentRouteContext {
  log: DocumentRouteLogger;
  timer: DocumentRouteTimer;
  requestId: string;
  userId: number;
}

function documentJson(
  body: object,
  status: number,
  requestId: string,
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "X-Request-Id": requestId },
  });
}

async function getDocumentResponse(
  documentId: string,
  context: DocumentRouteContext,
): Promise<NextResponse> {
  const validation = GetDocumentByIdSchema.safeParse({ id: documentId });
  if (!validation.success) {
    const firstError = validation.error.issues[0];
    context.log.warn("Invalid document ID format", { documentId, error: firstError });
    context.timer({ status: "error", reason: "invalid_id" });
    return documentJson(
      { success: false, error: firstError.message },
      400,
      context.requestId,
    );
  }

  const document = await getDocumentById({ id: validation.data.id });
  if (!document) {
    context.log.warn("Document not found", { documentId });
    context.timer({ status: "error", reason: "not_found" });
    return documentJson(
      { success: false, error: "Document not found" },
      404,
      context.requestId,
    );
  }
  if (document.userId !== context.userId) {
    context.log.warn("Unauthorized document access attempt", {
      documentId,
      userId: context.userId,
    });
    context.timer({ status: "error", reason: "access_denied" });
    return documentJson(
      { success: false, error: "Unauthorized access to document" },
      403,
      context.requestId,
    );
  }

  try {
    const signedUrl = await getDocumentSignedUrl({
      key: document.url,
      expiresIn: 3600,
    });
    context.log.info("Document retrieved successfully", { documentId });
    context.timer({ status: "success" });
    return documentJson(
      { success: true, document: { ...document, url: signedUrl } },
      200,
      context.requestId,
    );
  } catch (error) {
    context.log.error("Failed to generate signed URL", { error, documentId });
    context.timer({ status: "error", reason: "url_generation_failed" });
    return documentJson(
      { success: false, error: "Failed to generate document access URL" },
      500,
      context.requestId,
    );
  }
}

async function getConversationDocumentsResponse(
  conversationId: string,
  context: DocumentRouteContext,
): Promise<NextResponse> {
  const validation = GetDocumentsByConversationSchema.safeParse({ conversationId });
  if (!validation.success) {
    const firstError = validation.error.issues[0];
    context.log.warn("Invalid conversation ID format", {
      conversationId,
      error: firstError,
    });
    context.timer({ status: "error", reason: "invalid_id" });
    return documentJson(
      { success: false, error: firstError.message },
      400,
      context.requestId,
    );
  }

  const validatedConversationId = validation.data.conversationId;
  const conversation = await getConversationById(
    validatedConversationId,
    context.userId,
  );
  if (!conversation) {
    context.log.warn("Unauthorized conversation documents access attempt", {
      conversationId,
      userId: context.userId,
    });
    context.timer({ status: "error", reason: "conversation_not_found" });
    return documentJson(
      { success: false, error: "Conversation not found" },
      404,
      context.requestId,
    );
  }

  const documents = await getDocumentsByConversationId({
    conversationId: validatedConversationId,
  });
  const documentsWithSignedUrls = await Promise.all(
    documents.map(async (document) => {
      try {
        return {
          ...document,
          url: await getDocumentSignedUrl({
            key: document.url,
            expiresIn: 3600,
          }),
        };
      } catch {
        return document;
      }
    }),
  );
  context.log.info("Documents retrieved successfully", {
    conversationId,
    count: documentsWithSignedUrls.length,
  });
  context.timer({ status: "success" });
  return documentJson(
    { success: true, documents: documentsWithSignedUrls },
    200,
    context.requestId,
  );
}

export async function GET(request: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer("api.documents.get");
  const log = createLogger({ requestId, route: "api.documents" });
  
  // Get URL parameters
  const searchParams = request.nextUrl.searchParams;
  const conversationId = searchParams.get('conversationId');
  const documentId = searchParams.get('id');
  
  log.info("GET /api/documents - Fetching documents", { conversationId, documentId });
  
  // Check authentication
  const session = await getServerSession();
  if (!session) {
    log.warn("Unauthorized access attempt to documents");
    timer({ status: "error", reason: "unauthorized" });
    return NextResponse.json(
      { error: 'Unauthorized' }, 
      { status: 401, headers: { "X-Request-Id": requestId } }
    );
  }
  
  log.debug("User authenticated", { userId: session.sub });
  
  const currentUser = await getCurrentUserAction();
  if (!currentUser.isSuccess) {
    log.warn("User not found");
    timer({ status: "error", reason: "user_not_found" });
    return NextResponse.json(
      { error: 'User not found' }, 
      { status: 401, headers: { "X-Request-Id": requestId } }
    );
  }

  const retired = await legacyContentRetirementResponse();
  if (retired) return retired;
  
  const userId = currentUser.data.user.id;
  
  const context = { log, timer, requestId, userId };
  try {
    if (documentId) {
      return await getDocumentResponse(documentId, context);
    }
    if (conversationId) {
      return await getConversationDocumentsResponse(conversationId, context);
    }
    log.warn("Missing required parameters");
    timer({ status: "error", reason: "missing_params" });
    return documentJson(
      {
        success: false,
        error: "Missing parameters. Please provide conversationId or id.",
      },
      400,
      requestId,
    );
  } catch (error) {
    timer({ status: "error" });
    log.error("Error fetching documents", error);
    // REV-COR-208: never echo raw exception detail to the client.
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch documents'
      },
      { status: 500, headers: { "X-Request-Id": requestId } }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer("api.documents.delete");
  const log = createLogger({ requestId, route: "api.documents" });
  
  // Get URL parameters
  const searchParams = request.nextUrl.searchParams;
  const documentId = searchParams.get('id');
  
  log.info("DELETE /api/documents - Deleting document", { documentId });
  
  // Check authentication
  const session = await getServerSession();
  if (!session) {
    log.warn("Unauthorized delete attempt");
    timer({ status: "error", reason: "unauthorized" });
    return NextResponse.json(
      { error: 'Unauthorized' }, 
      { status: 401, headers: { "X-Request-Id": requestId } }
    );
  }
  
  log.debug("User authenticated", { userId: session.sub });
  
  const currentUser = await getCurrentUserAction();
  if (!currentUser.isSuccess) {
    log.warn("User not found");
    timer({ status: "error", reason: "user_not_found" });
    return NextResponse.json(
      { error: 'User not found' }, 
      { status: 401, headers: { "X-Request-Id": requestId } }
    );
  }

  const retired = await legacyContentRetirementResponse();
  if (retired) return retired;
  
  const userId = currentUser.data.user.id;

  if (!documentId) {
    log.warn("Missing document ID in delete request");
    timer({ status: "error", reason: "missing_id" });
    return NextResponse.json(
      {
        success: false,
        error: 'Document ID is required'
      },
      { status: 400, headers: { "X-Request-Id": requestId } }
    );
  }

  // Validate document ID format
  const validationResult = GetDocumentByIdSchema.safeParse({ id: documentId });
  if (!validationResult.success) {
    const firstError = validationResult.error.issues[0];
    log.warn("Invalid document ID format", { documentId, error: firstError });
    timer({ status: "error", reason: "invalid_id" });
    return NextResponse.json(
      {
        success: false,
        error: firstError.message
      },
      { status: 400, headers: { "X-Request-Id": requestId } }
    );
  }

  const docId = validationResult.data.id;

  try {
    // First check if the document exists and belongs to the user
    const document = await getDocumentById({ id: docId });
    
    if (!document) {
      log.warn("Document not found for deletion", { documentId: docId });
      timer({ status: "error", reason: "not_found" });
      return NextResponse.json(
        { 
          success: false, 
          error: 'Document not found' 
        }, 
        { status: 404, headers: { "X-Request-Id": requestId } }
      );
    }
    
    // Check if the document belongs to the authenticated user
    if (document.userId !== userId) {
      log.warn("Unauthorized document delete attempt", { documentId: docId, userId });
      timer({ status: "error", reason: "access_denied" });
      return NextResponse.json(
        { 
          success: false, 
          error: 'Unauthorized access to document' 
        }, 
        { status: 403, headers: { "X-Request-Id": requestId } }
      );
    }

    // Delete the file from S3
    if (document.url) {
      try {
        await deleteDocument(document.url);
      } catch (storageError) {
        // Continue with database deletion even if storage deletion fails
        log.error('Failed to delete from S3:', storageError);
      }
    }
    
    // Delete the document from the database
    await deleteDocumentById({ id: docId });
    
    log.info("Document deleted successfully", { documentId: docId });
    timer({ status: "success" });
    return NextResponse.json(
      {
        success: true,
        message: 'Document deleted successfully'
      },
      { headers: { "X-Request-Id": requestId } }
    );
  } catch (error) {
    timer({ status: "error" });
    log.error("Error deleting document", error);
    // REV-COR-208: never echo raw exception detail to the client.
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to delete document'
      },
      { status: 500, headers: { "X-Request-Id": requestId } }
    );
  }
}
