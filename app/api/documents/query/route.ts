import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/auth/server-session';
import { getCurrentUserAction } from '@/actions/db/get-current-user-action';
import { getDocumentsByConversationId, getDocumentChunksByDocumentId } from '@/lib/db/queries/documents';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';

// Escape special regex characters to prevent regex injection
// Matches the behavior of lodash's escapeRegExp
function escapeRegExp(string: string): string {
  return string.replace(/[$()*+.?[\]^{|}\\-]/g, '\\$&');
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
    const { conversationId, query } = body;

    if (!conversationId) {
      log.warn("Conversation ID is required");
      timer({ status: "error", reason: "missing_conversation_id" });
      return NextResponse.json({ error: 'Conversation ID is required' }, { status: 400, headers: { "X-Request-Id": requestId } });
    }

    if (!query || typeof query !== 'string') {
      log.warn("Query is required and must be a string");
      timer({ status: "error", reason: "invalid_query" });
      return NextResponse.json({ error: 'Query is required and must be a string' }, { status: 400, headers: { "X-Request-Id": requestId } });
    }

    // Validate query length to prevent DoS attacks
    if (query.length > 1000) {
      log.warn("Query too long", { queryLength: query.length });
      timer({ status: "error", reason: "query_too_long" });
      return NextResponse.json({ error: 'Query is too long (max 1000 characters)' }, { status: 400, headers: { "X-Request-Id": requestId } });
    }
    
    log.debug("Processing query", { conversationId, queryLength: query.length });

    // Get documents for the conversation
    const documents = await getDocumentsByConversationId({ conversationId: Number.parseInt(conversationId) });
    
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