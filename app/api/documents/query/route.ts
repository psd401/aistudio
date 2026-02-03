import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from '@/lib/auth/server-session';
import { getCurrentUserAction } from '@/actions/db/get-current-user-action';
import { getDocumentsByConversationId, getDocumentChunksByDocumentId } from '@/lib/db/queries/documents';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';

// Request validation schema
// Note: conversationId is a UUID string linking to nexus_conversations.id (Issue #549)
const QueryDocumentsRequestSchema = z.object({
  conversationId: z.string().uuid({ message: "Invalid conversation ID format (expected UUID)" }),
  query: z.string().min(1, "Query is required").max(1000, "Query is too long (max 1000 characters)")
});

// Escape special regex characters to prevent regex injection
// Matches the behavior of lodash's escapeRegExp
function escapeRegExp(string: string): string {
  return string.replace(/[$()*+.?[\\\]^{|}-]/g, '\\$&');
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer("api.documents.query");
  const log = createLogger({ requestId, route: "api.documents.query" });
  
  log.info("POST /api/documents/query - Querying documents");
  
  // Check authentication
  const session = await getServerSession();
  if (!session) {
    log.warn("Unauthorized - No session");
    timer({ status: "error", reason: "unauthorized" });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { "X-Request-Id": requestId } });
  }
  
  const currentUser = await getCurrentUserAction();
  if (!currentUser.isSuccess) {
    log.warn("User not found");
    timer({ status: "error", reason: "user_not_found" });
    return NextResponse.json({ error: 'User not found' }, { status: 401, headers: { "X-Request-Id": requestId } });
  }

  try {
    const body = await request.json();

    // Validate request body using Zod schema
    const validationResult = QueryDocumentsRequestSchema.safeParse(body);
    if (!validationResult.success) {
      const firstError = validationResult.error.issues[0];
      log.warn("Request validation failed", { error: firstError });
      timer({ status: "error", reason: "validation_failed" });
      return NextResponse.json(
        {
          success: false,
          error: firstError.message
        },
        { status: 400, headers: { "X-Request-Id": requestId } }
      );
    }

    const { conversationId, query } = validationResult.data;
    log.debug("Processing query", { conversationId, queryLength: query.length });

    // Get documents for the conversation (conversationId is UUID string - Issue #549)
    const documents = await getDocumentsByConversationId({ conversationId });
    
    if (documents.length === 0) {
      log.info("No documents found for conversation", { conversationId });
      timer({ status: "success", results: 0 });
      return NextResponse.json({
        success: true,
        results: [],
        message: 'No documents found for this conversation'
      }, { headers: { "X-Request-Id": requestId } });
    }

    // Get document chunks for each document
    const documentChunksPromises = documents.map(doc => 
      getDocumentChunksByDocumentId({ documentId: doc.id })
    );
    const documentChunksArrays = await Promise.all(documentChunksPromises);
    
    // Flatten the array of document chunks
    const allDocumentChunks = documentChunksArrays.flat();

    // Normalize and escape the query once for performance
    const normalizedQuery = query.toLowerCase();
    const escapedQuery = escapeRegExp(normalizedQuery);

    // For now, implement a simple text search
    // In a real implementation, you would use embeddings and vector search
    const searchResults = allDocumentChunks
      .filter(chunk => chunk.content.toLowerCase().includes(normalizedQuery))
      .map(chunk => {
        const document = documents.find(doc => doc.id === chunk.documentId);
        return {
          documentId: chunk.documentId,
          documentName: document?.name || 'Unknown document',
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          // Calculate a simple relevance score based on occurrence count
          // eslint-disable-next-line security/detect-non-literal-regexp -- escapedQuery is sanitized via escapeRegExp function above
          relevance: (chunk.content.toLowerCase().match(new RegExp(escapedQuery, 'g')) || []).length
        };
      })
      .sort((a, b) => b.relevance - a.relevance) // Sort by relevance
      .slice(0, 5); // Limit to top 5 results

    log.info("Query completed", { resultsCount: searchResults.length });
    timer({ status: "success", results: searchResults.length });
    
    return NextResponse.json({
      success: true,
      results: searchResults,
      totalResults: searchResults.length
    }, { headers: { "X-Request-Id": requestId } });
  } catch (error) {
    timer({ status: "error" });
    log.error("Failed to query documents", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to query documents' },
      { status: 500, headers: { "X-Request-Id": requestId } }
    );
  }
} 