import { InsertDocument, SelectDocument, InsertDocumentChunk, SelectDocumentChunk } from "@/types/db-types";
import logger from "@/lib/logger"
import { executeQuery } from "@/lib/db/drizzle-client"
import { eq, desc } from "drizzle-orm"
import { documents, documentChunks } from "@/lib/db/schema"
/**
 * Saves a document to the database
 */
export async function saveDocument(document: InsertDocument): Promise<SelectDocument> {
  try {
    const results = await executeQuery(
      (db) => db.insert(documents)
        .values({
          id: document.id,
          name: document.name,
          type: document.type,
          url: document.url,
          size: document.size ?? 0,
          userId: document.userId,
          conversationId: document.conversationId ?? null,
          metadata: document.metadata ?? null
        })
        .returning({
          id: documents.id,
          name: documents.name,
          type: documents.type,
          url: documents.url,
          size: documents.size,
          userId: documents.userId,
          conversationId: documents.conversationId,
          metadata: documents.metadata,
          createdAt: documents.createdAt,
          updatedAt: documents.updatedAt
        }),
      "saveDocument"
    )

    if (results.length === 0) {
      throw new Error('Failed to save document');
    }

    return results[0];
  } catch (error) {
    logger.error("Error saving document", { document, error });
    throw error;
  }
}

/**
 * Gets a document by id
 */
export async function getDocumentById({ id }: { id: number }): Promise<SelectDocument | undefined> {
  try {
    const results = await executeQuery(
      (db) => db.select({
        id: documents.id,
        name: documents.name,
        type: documents.type,
        url: documents.url,
        size: documents.size,
        userId: documents.userId,
        conversationId: documents.conversationId,
        metadata: documents.metadata,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt
      })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1),
      "getDocumentById"
    )

    return results[0];
  } catch (error) {
    logger.error("Error fetching document by ID", { id, error });
    return undefined;
  }
}

/**
 * Gets documents by user id
 */
export async function getDocumentsByUserId({ userId }: { userId: number }): Promise<SelectDocument[]> {
  try {
    const results = await executeQuery(
      (db) => db.select({
        id: documents.id,
        name: documents.name,
        type: documents.type,
        url: documents.url,
        size: documents.size,
        userId: documents.userId,
        conversationId: documents.conversationId,
        metadata: documents.metadata,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt
      })
      .from(documents)
      .where(eq(documents.userId, userId))
      .orderBy(desc(documents.createdAt)),
      "getDocumentsByUserId"
    )

    return results;
  } catch (error) {
    logger.error("Error fetching documents by user ID", { userId, error });
    return [];
  }
}

/**
 * Gets documents by conversation id
 */
export async function getDocumentsByConversationId({
  conversationId
}: {
  conversationId: number
}): Promise<SelectDocument[]> {
  try {
    const results = await executeQuery(
      (db) => db.select({
        id: documents.id,
        name: documents.name,
        type: documents.type,
        url: documents.url,
        size: documents.size,
        userId: documents.userId,
        conversationId: documents.conversationId,
        metadata: documents.metadata,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt
      })
      .from(documents)
      .where(eq(documents.conversationId, conversationId)),
      "getDocumentsByConversationId"
    )

    return results;
  } catch (error) {
    logger.error("Error fetching documents by conversation ID", { conversationId, error });
    return [];
  }
}

/**
 * Deletes a document by id
 */
export async function deleteDocumentById({ id }: { id: number }): Promise<void> {
  try {
    await executeQuery(
      (db) => db.delete(documents)
        .where(eq(documents.id, id)),
      "deleteDocumentById"
    )
  } catch (error) {
    logger.error("Error deleting document", { id, error });
    throw error;
  }
}

/**
 * Saves a document chunk to the database
 */
export async function saveDocumentChunk(chunk: InsertDocumentChunk): Promise<SelectDocumentChunk> {
  try {
    const results = await executeQuery(
      (db) => db.insert(documentChunks)
        .values({
          id: chunk.id,
          documentId: chunk.documentId,
          content: chunk.content,
          chunkIndex: chunk.chunkIndex,
          metadata: chunk.metadata ?? null,
          pageNumber: chunk.pageNumber ?? null
        })
        .returning({
          id: documentChunks.id,
          documentId: documentChunks.documentId,
          content: documentChunks.content,
          chunkIndex: documentChunks.chunkIndex,
          metadata: documentChunks.metadata,
          embedding: documentChunks.embedding,
          pageNumber: documentChunks.pageNumber,
          createdAt: documentChunks.createdAt,
          updatedAt: documentChunks.updatedAt
        }),
      "saveDocumentChunk"
    )

    if (results.length === 0) {
      throw new Error('Failed to save document chunk');
    }

    return results[0];
  } catch (error) {
    logger.error("Error saving document chunk", { chunk, error });
    throw error;
  }
}

/**
 * Gets document chunks by document id
 */
export async function getDocumentChunksByDocumentId({
  documentId
}: {
  documentId: number
}): Promise<SelectDocumentChunk[]> {
  try {
    const results = await executeQuery(
      (db) => db.select({
        id: documentChunks.id,
        documentId: documentChunks.documentId,
        content: documentChunks.content,
        chunkIndex: documentChunks.chunkIndex,
        metadata: documentChunks.metadata,
        embedding: documentChunks.embedding,
        pageNumber: documentChunks.pageNumber,
        createdAt: documentChunks.createdAt,
        updatedAt: documentChunks.updatedAt
      })
      .from(documentChunks)
      .where(eq(documentChunks.documentId, documentId))
      .orderBy(documentChunks.chunkIndex),
      "getDocumentChunksByDocumentId"
    )

    return results;
  } catch (error) {
    logger.error("Error fetching document chunks", { documentId, error });
    return [];
  }
}

/**
 * Batch inserts multiple document chunks
 */
export async function batchInsertDocumentChunks(chunks: InsertDocumentChunk[]): Promise<SelectDocumentChunk[]> {
  try {
    // Guard against empty array - Drizzle throws on empty .values()
    if (chunks.length === 0) {
      return [];
    }

    // Drizzle supports true batch inserts with RETURNING
    const results = await executeQuery(
      (db) => db.insert(documentChunks)
        .values(chunks.map(chunk => ({
          id: chunk.id,
          documentId: chunk.documentId,
          content: chunk.content,
          chunkIndex: chunk.chunkIndex,
          metadata: chunk.metadata ?? null,
          pageNumber: chunk.pageNumber ?? null
        })))
        .returning({
          id: documentChunks.id,
          documentId: documentChunks.documentId,
          content: documentChunks.content,
          chunkIndex: documentChunks.chunkIndex,
          metadata: documentChunks.metadata,
          embedding: documentChunks.embedding,
          pageNumber: documentChunks.pageNumber,
          createdAt: documentChunks.createdAt,
          updatedAt: documentChunks.updatedAt
        }),
      "batchInsertDocumentChunks"
    )

    return results;
  } catch (error) {
    logger.error("Error batch inserting document chunks", { chunkCount: chunks.length, error });
    throw error;
  }
}

/**
 * Deletes document chunks by document id
 */
export async function deleteDocumentChunksByDocumentId({
  documentId
}: {
  documentId: number
}): Promise<void> {
  try {
    await executeQuery(
      (db) => db.delete(documentChunks)
        .where(eq(documentChunks.documentId, documentId)),
      "deleteDocumentChunksByDocumentId"
    )
  } catch (error) {
    logger.error("Error deleting document chunks", { documentId, error });
    throw error;
  }
}

/**
 * Update the conversation ID for a given document ID
 */
export async function linkDocumentToConversation(
  documentId: number,
  conversationId: number
): Promise<SelectDocument | undefined> {
  try {
    const results = await executeQuery(
      (db) => db.update(documents)
        .set({ conversationId })
        .where(eq(documents.id, documentId))
        .returning({
          id: documents.id,
          name: documents.name,
          type: documents.type,
          url: documents.url,
          size: documents.size,
          userId: documents.userId,
          conversationId: documents.conversationId,
          metadata: documents.metadata,
          createdAt: documents.createdAt,
          updatedAt: documents.updatedAt
        }),
      "linkDocumentToConversation"
    )

    return results[0];
  } catch (error) {
    logger.error('Error linking document to conversation', { documentId, conversationId, error });
    return undefined;
  }
} 