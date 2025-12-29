import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDocumentSignedUrl, deleteDocument } from '@/lib/aws/s3-client';
import {
  getDocumentsByConversationId,
  getDocumentById,
  deleteDocumentById
} from '@/lib/db/queries/documents';
import { getServerSession } from '@/lib/auth/server-session';
import { getCurrentUserAction } from '@/actions/db/get-current-user-action';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
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
  
  const userId = currentUser.data.user.id;
  
  try {
    // If documentId is provided, fetch single document
    if (documentId) {
      const document = await getDocumentById({ id: Number.parseInt(documentId, 10) });
      
      if (!document) {
        log.warn("Document not found", { documentId });
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
        log.warn("Unauthorized document access attempt", { documentId, userId });
        timer({ status: "error", reason: "access_denied" });
        return NextResponse.json(
          { 
            success: false, 
            error: 'Unauthorized access to document' 
          }, 
          { status: 403, headers: { "X-Request-Id": requestId } }
        );
      }

      // Get a fresh signed URL for the document
      // document.url now contains the S3 key
      let signedUrl;
      try {
        signedUrl = await getDocumentSignedUrl({
          key: document.url,
          expiresIn: 3600 // 1 hour
        });
      } catch (error) {
        log.error("Failed to generate signed URL", { error, documentId });
        timer({ status: "error", reason: "url_generation_failed" });
        return NextResponse.json(
          {
            success: false,
            error: 'Failed to generate document access URL'
          }, 
          { status: 500, headers: { "X-Request-Id": requestId } }
        );
      }

      // Return document with fresh signed URL
      log.info("Document retrieved successfully", { documentId });
      timer({ status: "success" });
      return NextResponse.json(
        {
          success: true,
          document: {
            ...document,
            url: signedUrl
          }
        },
        { headers: { "X-Request-Id": requestId } }
      );
    }
    
    // If conversationId is provided, fetch documents for conversation
    // Note: conversationId is a UUID string linking to nexus_conversations.id (Issue #549)
    if (conversationId) {
      // Validate UUID format using Zod for consistency with other routes
      const validationResult = z.string().uuid({ message: "Invalid conversation ID format (expected UUID)" }).safeParse(conversationId);
      if (!validationResult.success) {
        const firstError = validationResult.error.issues[0];
        log.warn("Invalid conversation ID format", { conversationId, error: firstError });
        timer({ status: "error", reason: "invalid_id" });
        return NextResponse.json(
          {
            success: false,
            error: firstError.message
          },
          { status: 400, headers: { "X-Request-Id": requestId } }
        );
      }

      const documents = await getDocumentsByConversationId({
        conversationId
      });
      
      // Get fresh signed URLs for all documents
      const documentsWithSignedUrls = await Promise.all(
        documents.map(async (doc) => {
          try {
            const signedUrl = await getDocumentSignedUrl({
              key: doc.url,
              expiresIn: 3600 // 1 hour
            });
            return {
              ...doc,
              url: signedUrl
            };
          } catch {
            // If we can't generate a signed URL, return the document without it
            return doc;
          }
        })
      );
      
      log.info("Documents retrieved successfully", { 
        conversationId,
        count: documentsWithSignedUrls.length 
      });
      timer({ status: "success" });
      return NextResponse.json(
        {
          success: true,
          documents: documentsWithSignedUrls
        },
        { headers: { "X-Request-Id": requestId } }
      );
    }
    
    // If no parameters provided, return error
    log.warn("Missing required parameters");
    timer({ status: "error", reason: "missing_params" });
    return NextResponse.json(
      { 
        success: false, 
        error: 'Missing parameters. Please provide conversationId or id.' 
      }, 
      { status: 400, headers: { "X-Request-Id": requestId } }
    );
    
  } catch (error) {
    timer({ status: "error" });
    log.error("Error fetching documents", error);
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to fetch documents' 
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

  const docId = Number.parseInt(documentId, 10);
  if (Number.isNaN(docId)) {
    log.warn("Invalid document ID format", { documentId });
    timer({ status: "error", reason: "invalid_id" });
    return NextResponse.json(
      { 
        success: false, 
        error: 'Invalid document ID' 
      }, 
      { status: 400, headers: { "X-Request-Id": requestId } }
    );
  }

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
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to delete document' 
      },
      { status: 500, headers: { "X-Request-Id": requestId } }
    );
  }
} 