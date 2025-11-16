import { InsertDocument, SelectDocument, InsertDocumentChunk, SelectDocumentChunk } from "@/types/db-types";
import logger from "@/lib/logger"
import { executeSQL, FormattedRow } from "@/lib/db/data-api-adapter"
import { Field } from "@aws-sdk/client-rds-data"
/**
 * Saves a document to the database
 */
export async function saveDocument(document: InsertDocument): Promise<SelectDocument> {
  try {
    // Build query and parameters based on whether id is provided
    const fields = ['name', 'type', 'url', 'size', 'user_id', 'conversation_id', 'metadata'];
    const placeholders = [':name', ':type', ':url', ':size', ':userId', ':conversationId', ':metadata'];
    const parameters = [
      { name: 'name', value: { stringValue: document.name } as Field },
      { name: 'type', value: { stringValue: document.type } as Field },
      { name: 'url', value: { stringValue: document.url } as Field },
      { name: 'size', value: (document.size ?? 0) > 0 ? { longValue: document.size ?? 0 } as Field : { isNull: true } as Field },
      { name: 'userId', value: { longValue: document.userId } as Field },
      { name: 'conversationId', value: document.conversationId ? { longValue: document.conversationId } as Field : { isNull: true } as Field },
      { name: 'metadata', value: document.metadata ? { stringValue: JSON.stringify(document.metadata) } as Field : { isNull: true } as Field }
    ];

    // Add id if provided
    if (document.id) {
      fields.unshift('id');
      placeholders.unshift(':id');
      parameters.unshift({ name: 'id', value: { longValue: document.id } as Field });
    }

    // Apply proper type casting for PostgreSQL
    const valuesWithCast = placeholders.map((placeholder, index) => {
      const field = fields[index];
      if (field === 'id' && placeholder === ':id') return ':id';
      if (field === 'metadata' && placeholder === ':metadata') return ':metadata::jsonb';
      return placeholder;
    });
    
    const query = `
      INSERT INTO documents (${fields.join(', ')})
      VALUES (${valuesWithCast.join(', ')})
      RETURNING id, name, type, url, size, user_id, conversation_id, metadata, created_at
    `;
    
    const results = await executeSQL<SelectDocument>(query, parameters);
    if (results.length === 0) {
      throw new Error('Failed to save document');
    }
    
    // Parse metadata back from JSON string
    const result = results[0];
    if (result.metadata && typeof result.metadata === 'string') {
      try {
        result.metadata = JSON.parse(result.metadata);
      } catch {
        // If parsing fails, leave as string
      }
    }
    
    return result;
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
    const query = `
      SELECT id, name, type, url, size, user_id, conversation_id, created_at
      FROM documents
      WHERE id = :id
      LIMIT 1
    `;
    const parameters = [
      { name: 'id', value: { longValue: id } as Field }
    ];
    
    const results = await executeSQL<SelectDocument>(query, parameters);
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
    const query = `
      SELECT id, name, type, url, size, user_id, conversation_id, created_at
      FROM documents
      WHERE user_id = :userId
      ORDER BY created_at DESC
    `;
    const parameters = [
      { name: 'userId', value: { longValue: userId } as Field }
    ];
    
    const results = await executeSQL<SelectDocument>(query, parameters);
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
  // Fetching documents
  try {
    const query = `
      SELECT id, name, type, url, size, user_id, conversation_id, created_at
      FROM documents
      WHERE conversation_id = :conversationId
    `;
    const parameters = [
      { name: 'conversationId', value: { longValue: conversationId } as Field }
    ];
    
    const results = await executeSQL<SelectDocument>(query, parameters);
    // Documents fetched
    return results;
  } catch (error) {
    logger.error("Error fetching documents by conversation ID", { conversationId, error });
    return [];
  }
}

/**
 * Deletes a document by id
 */
export async function deleteDocumentById({ id }: { id: string }): Promise<void> {
  try {
    const query = `
      DELETE FROM documents
      WHERE id = :id
    `;
    const parameters = [
      { name: 'id', value: { longValue: Number.parseInt(id, 10) } as Field }
    ];
    
    await executeSQL<FormattedRow>(query, parameters);
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
    // Build query and parameters based on whether id is provided
    const fields = ['document_id', 'content', 'chunk_index'];
    const placeholders = [':documentId', ':content', ':chunkIndex'];
    const parameters = [
      { name: 'documentId', value: { longValue: chunk.documentId } as Field },
      { name: 'content', value: { stringValue: chunk.content } as Field },
      { name: 'chunkIndex', value: { longValue: chunk.chunkIndex } as Field }
    ];

    // Add optional fields if provided
    if (chunk.id) {
      fields.unshift('id');
      placeholders.unshift(':id');
      parameters.unshift({ name: 'id', value: { longValue: chunk.id } as Field });
    }
    
    if (chunk.metadata) {
      fields.push('metadata');
      placeholders.push(':metadata');
      parameters.push({ name: 'metadata', value: { stringValue: JSON.stringify(chunk.metadata) } as Field });
    }

    // Apply proper type casting for PostgreSQL
    const valuesWithCast = placeholders.map((placeholder, index) => {
      const field = fields[index];
      if (field === 'id' && placeholder === ':id') return ':id';
      if (field === 'document_id' && placeholder === ':documentId') return ':documentId';
      if (field === 'metadata' && placeholder === ':metadata') return ':metadata::jsonb';
      return placeholder;
    });
    
    const query = `
      INSERT INTO document_chunks (${fields.join(', ')})
      VALUES (${valuesWithCast.join(', ')})
      RETURNING id, document_id, content, chunk_index, metadata, created_at
    `;
    
    const results = await executeSQL<SelectDocumentChunk>(query, parameters);
    if (results.length === 0) {
      throw new Error('Failed to save document chunk');
    }
    
    const result = results[0];
    // Parse metadata back from JSON string
    if (result.metadata && typeof result.metadata === 'string') {
      try {
        result.metadata = JSON.parse(result.metadata);
      } catch {
        // If parsing fails, leave as string
      }
    }
    
    return result;
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
    const query = `
      SELECT id, document_id, content, chunk_index, created_at
      FROM document_chunks
      WHERE document_id = :documentId
      ORDER BY chunk_index ASC
    `;
    const parameters = [
      { name: 'documentId', value: { longValue: documentId } as Field }
    ];
    
    const results = await executeSQL<SelectDocumentChunk>(query, parameters);
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
    const savedChunks: SelectDocumentChunk[] = [];
    
    // RDS Data API doesn't support batch inserts with RETURNING, so we need to insert one by one
    for (const chunk of chunks) {
      // Build query and parameters based on whether id is provided
      const fields = ['document_id', 'content', 'chunk_index'];
      const placeholders = [':documentId', ':content', ':chunkIndex'];
      const parameters = [
        { name: 'documentId', value: { longValue: chunk.documentId } as Field },
        { name: 'content', value: { stringValue: chunk.content } as Field },
        { name: 'chunkIndex', value: { longValue: chunk.chunkIndex } as Field }
      ];

      // Add optional fields if provided
      if (chunk.id) {
        fields.unshift('id');
        placeholders.unshift(':id');
        parameters.unshift({ name: 'id', value: { longValue: chunk.id } as Field });
      }
      
      if (chunk.metadata) {
        fields.push('metadata');
        placeholders.push(':metadata');
        parameters.push({ name: 'metadata', value: { stringValue: JSON.stringify(chunk.metadata) } as Field });
      }

      // Apply proper type casting for PostgreSQL
      const valuesWithCast = placeholders.map((placeholder, index) => {
        const field = fields[index];
        if (field === 'id' && placeholder === ':id') return ':id';
        if (field === 'document_id' && placeholder === ':documentId') return ':documentId';
        if (field === 'metadata' && placeholder === ':metadata') return ':metadata::jsonb';
        return placeholder;
      });
      
      const query = `
        INSERT INTO document_chunks (${fields.join(', ')})
        VALUES (${valuesWithCast.join(', ')})
        RETURNING id, document_id, content, chunk_index, metadata, created_at
      `;
      
      const results = await executeSQL<SelectDocumentChunk>(query, parameters);
      if (results.length > 0) {
        const result = results[0];
        // Parse metadata back from JSON string
        if (result.metadata && typeof result.metadata === 'string') {
          try {
            result.metadata = JSON.parse(result.metadata);
          } catch {
            // If parsing fails, leave as string
          }
        }
        savedChunks.push(result);
      }
    }
    
    return savedChunks;
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
    const query = `
      DELETE FROM document_chunks
      WHERE document_id = :documentId
    `;
    const parameters = [
      { name: 'documentId', value: { longValue: documentId } as Field }
    ];
    
    await executeSQL<FormattedRow>(query, parameters);
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
    const query = `
      UPDATE documents
      SET conversation_id = :conversationId
      WHERE id = :documentId
      RETURNING id, name, type, url, size, user_id, conversation_id, created_at
    `;
    const parameters = [
      { name: 'documentId', value: { longValue: documentId } as Field },
      { name: 'conversationId', value: { longValue: conversationId } as Field }
    ];
    
    const results = await executeSQL<SelectDocument>(query, parameters);
    return results[0];
  } catch (error) {
    logger.error('Error linking document to conversation', { documentId, conversationId, error });
    // Handle error appropriately, maybe return undefined or throw
    return undefined;
  }
} 