/**
 * Drizzle Document Operations
 *
 * Document and document chunk CRUD operations migrated from RDS Data API to Drizzle ORM.
 * All functions use executeQuery() wrapper with circuit breaker and retry logic.
 *
 * **IMPORTANT - Authorization**: These are infrastructure-layer data access functions.
 * They do NOT perform authorization checks. Authorization MUST be handled at the
 * API route or server action layer before calling these functions.
 *
 * **Authorization Requirements**:
 * - Verify user owns the document (document.userId matches session.userId)
 * - Verify user has conversation access if conversationId is present
 * - Use @/lib/auth/server-session helpers: getServerSession(), validateDocumentOwnership()
 *
 * **Required Database Indexes** (for optimal query performance):
 * ```sql
 * -- Document queries use these indexes for efficient lookups and JOINs
 * CREATE INDEX idx_documents_user_id ON documents(user_id);
 * CREATE INDEX idx_documents_conversation_id ON documents(conversation_id);
 * CREATE INDEX idx_document_chunks_document_id ON document_chunks(document_id);
 * CREATE INDEX idx_document_chunks_chunk_index ON document_chunks(document_id, chunk_index);
 * ```
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #536 - Migrate Knowledge & Document queries to Drizzle ORM
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, desc, asc } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { documents, documentChunks } from "@/lib/db/schema";
import type { SelectDocument, SelectDocumentChunk } from "@/lib/db/types";
import { createLogger, sanitizeForLogging } from "@/lib/logger";

// ============================================
// Constants
// ============================================

/**
 * Maximum number of chunks that can be inserted in a single batch operation
 * Prevents memory issues and database connection timeouts
 */
const MAX_BATCH_SIZE = 1000;

// ============================================
// Types
// ============================================

/**
 * Document metadata stored in JSONB column
 */
export interface DocumentMetadata {
  pageCount?: number;
  extractedText?: boolean;
  s3Key?: string;
  mimeType?: string;
  uploadedFrom?: "nexus" | "repository" | "direct";
  [key: string]: unknown;
}

/**
 * Chunk metadata stored in JSONB column
 *
 * **Note on Embeddings**: For document chunks, vector embeddings are stored
 * within this metadata JSONB field. This differs from repository item chunks,
 * which use a dedicated pgvector column for better performance and indexing.
 */
export interface ChunkMetadata {
  pageNumber?: number;
  chunkType?: "text" | "table" | "image";
  confidence?: number;
  /** Vector embedding stored in metadata JSONB (not a dedicated vector column) */
  embedding?: number[];
  [key: string]: unknown;
}

/**
 * Data for creating a new document
 */
export interface CreateDocumentData {
  name: string;
  type: string;
  url: string;
  size: number;
  userId: number;
  conversationId?: number | null;
  metadata?: DocumentMetadata | null;
}

/**
 * Data for updating a document
 */
export interface UpdateDocumentData {
  name?: string;
  type?: string;
  url?: string;
  size?: number;
  conversationId?: number | null;
  metadata?: DocumentMetadata | null;
}

/**
 * Data for creating a document chunk
 */
export interface CreateChunkData {
  documentId: number;
  content: string;
  chunkIndex: number;
  pageNumber?: number | null;
  metadata?: ChunkMetadata | null;
}

// ============================================
// Query Operations
// ============================================

/**
 * Get a document by ID
 */
export async function getDocumentById(
  id: number
): Promise<SelectDocument | null> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(documents)
        .where(eq(documents.id, id))
        .limit(1),
    "getDocumentById"
  );

  return result[0] || null;
}

/**
 * Get documents by user ID
 * Returns documents ordered by created_at DESC (newest first)
 */
export async function getDocumentsByUserId(
  userId: number
): Promise<SelectDocument[]> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(documents)
        .where(eq(documents.userId, userId))
        .orderBy(desc(documents.createdAt)),
    "getDocumentsByUserId"
  );

  return result;
}

/**
 * Get documents by conversation ID
 */
export async function getDocumentsByConversationId(
  conversationId: number
): Promise<SelectDocument[]> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(documents)
        .where(eq(documents.conversationId, conversationId))
        .orderBy(desc(documents.createdAt)),
    "getDocumentsByConversationId"
  );

  return result;
}

// ============================================
// Document CRUD Operations
// ============================================

/**
 * Create a new document
 */
export async function createDocument(
  data: CreateDocumentData
): Promise<SelectDocument> {
  const log = createLogger({ module: "drizzle-documents" });

  const result = await executeQuery(
    (db) =>
      db
        .insert(documents)
        .values({
          name: data.name,
          type: data.type,
          url: data.url,
          size: data.size,
          userId: data.userId,
          conversationId: data.conversationId ?? null,
          metadata: data.metadata ?? null,
        })
        .returning(),
    "createDocument"
  );

  if (!result[0]) {
    log.error("Failed to create document", { data: sanitizeForLogging(data) });
    throw new Error("Failed to create document");
  }

  return result[0];
}

/**
 * Update a document by ID
 */
export async function updateDocument(
  id: number,
  data: UpdateDocumentData
): Promise<SelectDocument | null> {
  const updateData = {
    ...data,
    metadata: data.metadata ?? null,
    updatedAt: new Date(),
  };

  const result = await executeQuery(
    (db) =>
      db
        .update(documents)
        .set(updateData)
        .where(eq(documents.id, id))
        .returning(),
    "updateDocument"
  );

  return result[0] || null;
}

/**
 * Link a document to a conversation
 */
export async function linkDocumentToConversation(
  documentId: number,
  conversationId: number
): Promise<SelectDocument | null> {
  const result = await executeQuery(
    (db) =>
      db
        .update(documents)
        .set({
          conversationId,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, documentId))
        .returning(),
    "linkDocumentToConversation"
  );

  return result[0] || null;
}

/**
 * Delete a document by ID
 * Note: Document chunks are automatically deleted via ON DELETE CASCADE
 */
export async function deleteDocument(id: number): Promise<{ id: number } | null> {
  const result = await executeQuery(
    (db) =>
      db
        .delete(documents)
        .where(eq(documents.id, id))
        .returning({ id: documents.id }),
    "deleteDocument"
  );

  return result[0] || null;
}

// ============================================
// Document Chunk Operations
// ============================================

/**
 * Get chunks by document ID
 * Returns chunks ordered by chunkIndex ASC
 */
export async function getChunksByDocumentId(
  documentId: number
): Promise<SelectDocumentChunk[]> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(documentChunks)
        .where(eq(documentChunks.documentId, documentId))
        .orderBy(asc(documentChunks.chunkIndex)),
    "getChunksByDocumentId"
  );

  return result;
}

/**
 * Create a single document chunk
 */
export async function createChunk(
  data: CreateChunkData
): Promise<SelectDocumentChunk> {
  const log = createLogger({ module: "drizzle-documents" });

  const result = await executeQuery(
    (db) =>
      db
        .insert(documentChunks)
        .values({
          documentId: data.documentId,
          content: data.content,
          chunkIndex: data.chunkIndex,
          pageNumber: data.pageNumber ?? null,
          metadata: data.metadata ?? null,
        })
        .returning(),
    "createChunk"
  );

  if (!result[0]) {
    log.error("Failed to create document chunk", { data: sanitizeForLogging(data) });
    throw new Error("Failed to create document chunk");
  }

  return result[0];
}

/**
 * Batch insert document chunks
 * Drizzle ORM supports batch inserts with RETURNING natively
 */
export async function batchInsertChunks(
  chunks: CreateChunkData[]
): Promise<SelectDocumentChunk[]> {
  const log = createLogger({ module: "drizzle-documents" });

  if (chunks.length === 0) {
    return [];
  }

  if (chunks.length > MAX_BATCH_SIZE) {
    log.error("Batch size exceeds maximum", {
      requestedSize: chunks.length,
      maxSize: MAX_BATCH_SIZE,
    });
    throw new Error(
      `Batch insert size (${chunks.length}) exceeds maximum allowed (${MAX_BATCH_SIZE})`
    );
  }

  log.debug("Batch inserting document chunks", { count: chunks.length });

  // Transform chunks for insertion
  const values = chunks.map((chunk) => ({
    documentId: chunk.documentId,
    content: chunk.content,
    chunkIndex: chunk.chunkIndex,
    pageNumber: chunk.pageNumber ?? null,
    metadata: chunk.metadata ?? null,
  }));

  const result = await executeQuery(
    (db) => db.insert(documentChunks).values(values).returning(),
    "batchInsertChunks"
  );

  log.debug("Batch insert complete", {
    requestedCount: chunks.length,
    insertedCount: result.length,
  });

  return result;
}

/**
 * Delete chunks by document ID
 * Generally not needed since document deletion cascades to chunks,
 * but useful for re-processing a document
 */
export async function deleteChunksByDocumentId(
  documentId: number
): Promise<number> {
  const result = await executeQuery(
    (db) =>
      db
        .delete(documentChunks)
        .where(eq(documentChunks.documentId, documentId))
        .returning({ id: documentChunks.id }),
    "deleteChunksByDocumentId"
  );

  return result.length;
}

// ============================================
// Combined Operations
// ============================================

/**
 * Get a document with all its chunks
 * Uses a single query with LEFT JOIN for optimal performance
 */
export async function getDocumentWithChunks(
  documentId: number
): Promise<{ document: SelectDocument; chunks: SelectDocumentChunk[] } | null> {
  const results = await executeQuery(
    (db) =>
      db
        .select()
        .from(documents)
        .leftJoin(documentChunks, eq(documentChunks.documentId, documents.id))
        .where(eq(documents.id, documentId))
        .orderBy(asc(documentChunks.chunkIndex)),
    "getDocumentWithChunks"
  );

  if (results.length === 0) {
    return null;
  }

  // Extract document from first row (same in all rows due to JOIN)
  const document = results[0].documents;

  // Aggregate chunks, filtering out NULL values from LEFT JOIN
  const chunks = results
    .map((r) => r.document_chunks)
    .filter((chunk): chunk is SelectDocumentChunk => chunk !== null);

  return { document, chunks };
}
