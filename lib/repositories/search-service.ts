import { executeQuery } from "@/lib/db/drizzle-client"
import { sql } from "drizzle-orm"
import { generateEmbedding } from "@/lib/ai-helpers"

export interface SearchResult {
  chunkId: number
  itemId: number
  itemName: string
  content: string
  similarity: number
  chunkIndex: number
  metadata: Record<string, unknown>
}

export interface SearchOptions {
  limit?: number
  threshold?: number
  repositoryId?: number
}


/**
 * Perform vector similarity search using cosine similarity
 */
export async function vectorSearch(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const { limit = 10, threshold = 0.7, repositoryId } = options
  
  // Generate embedding for the query
  const queryEmbedding = await generateEmbedding(query)
  
  // Build the SQL query using pgvector
  // Convert embedding array to pgvector format string: '[1,2,3]'
  const embeddingString = `[${queryEmbedding.join(',')}]`

  // Use Drizzle with raw SQL for pgvector operators
  const results = await executeQuery(
    (db) => {
      if (repositoryId) {
        return db.execute(sql`
          SELECT
            c.id as chunk_id,
            c.item_id,
            i.name as item_name,
            c.content,
            c.chunk_index,
            c.metadata,
            1 - (c.embedding <=> ${embeddingString}::vector) as similarity
          FROM repository_item_chunks c
          JOIN repository_items i ON i.id = c.item_id
          WHERE c.embedding IS NOT NULL
            AND i.repository_id = ${repositoryId}
            AND 1 - (c.embedding <=> ${embeddingString}::vector) >= ${threshold}
          ORDER BY similarity DESC
          LIMIT ${limit}
        `)
      } else {
        return db.execute(sql`
          SELECT
            c.id as chunk_id,
            c.item_id,
            i.name as item_name,
            c.content,
            c.chunk_index,
            c.metadata,
            1 - (c.embedding <=> ${embeddingString}::vector) as similarity
          FROM repository_item_chunks c
          JOIN repository_items i ON i.id = c.item_id
          WHERE c.embedding IS NOT NULL
            AND 1 - (c.embedding <=> ${embeddingString}::vector) >= ${threshold}
          ORDER BY similarity DESC
          LIMIT ${limit}
        `)
      }
    },
    "vectorSearch"
  )

  return (results.rows as Array<Record<string, unknown>>).map((row) => ({
    chunkId: Number(row.chunk_id) || 0,
    itemId: Number(row.item_id) || 0,
    itemName: String(row.item_name || ''),
    content: String(row.content || ''),
    similarity: Number(row.similarity) || 0,
    chunkIndex: Number(row.chunk_index) || 0,
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata as Record<string, unknown> || {})
  }))
}

/**
 * Perform keyword search using PostgreSQL full-text search
 */
export async function keywordSearch(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const { limit = 10, repositoryId } = options

  // Use Drizzle with raw SQL for full-text search operators
  const results = await executeQuery(
    (db) => {
      if (repositoryId) {
        return db.execute(sql`
          SELECT
            c.id as chunk_id,
            c.item_id,
            i.name as item_name,
            c.content,
            c.chunk_index,
            c.metadata,
            ts_rank(to_tsvector('english', c.content), plainto_tsquery('english', ${query})) as rank
          FROM repository_item_chunks c
          JOIN repository_items i ON i.id = c.item_id
          WHERE to_tsvector('english', c.content) @@ plainto_tsquery('english', ${query})
            AND i.repository_id = ${repositoryId}
          ORDER BY rank DESC
          LIMIT ${limit}
        `)
      } else {
        return db.execute(sql`
          SELECT
            c.id as chunk_id,
            c.item_id,
            i.name as item_name,
            c.content,
            c.chunk_index,
            c.metadata,
            ts_rank(to_tsvector('english', c.content), plainto_tsquery('english', ${query})) as rank
          FROM repository_item_chunks c
          JOIN repository_items i ON i.id = c.item_id
          WHERE to_tsvector('english', c.content) @@ plainto_tsquery('english', ${query})
          ORDER BY rank DESC
          LIMIT ${limit}
        `)
      }
    },
    "keywordSearch"
  )

  return (results.rows as Array<Record<string, unknown>>).map((row) => ({
    chunkId: Number(row.chunk_id) || 0,
    itemId: Number(row.item_id) || 0,
    itemName: String(row.item_name || ''),
    content: String(row.content || ''),
    similarity: Number(row.rank) || 0, // Use rank as similarity score
    chunkIndex: Number(row.chunk_index) || 0,
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata as Record<string, unknown> || {})
  }))
}

/**
 * Perform hybrid search combining vector and keyword search
 */
export async function hybridSearch(
  query: string,
  options: SearchOptions & { vectorWeight?: number } = {}
): Promise<SearchResult[]> {
  const { limit = 10, vectorWeight = 0.7 } = options
  const keywordWeight = 1 - vectorWeight
  
  // Perform both searches in parallel
  const [vectorResults, keywordResults] = await Promise.all([
    vectorSearch(query, { ...options, limit: limit * 2 }), // Get more results for merging
    keywordSearch(query, { ...options, limit: limit * 2 })
  ])
  
  // Create a map to merge results by chunk ID
  const resultMap = new Map<number, SearchResult>()
  
  // Add vector results with weighted scores
  for (const result of vectorResults) {
    resultMap.set(result.chunkId, {
      ...result,
      similarity: result.similarity * vectorWeight
    })
  }
  
  // Merge keyword results
  for (const result of keywordResults) {
    const existing = resultMap.get(result.chunkId)
    if (existing) {
      // Combine scores if chunk appears in both results
      existing.similarity += result.similarity * keywordWeight
    } else {
      // Add new result with weighted score
      resultMap.set(result.chunkId, {
        ...result,
        similarity: result.similarity * keywordWeight
      })
    }
  }
  
  // Sort by combined score and return top results
  return Array.from(resultMap.values())
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit)
}

/**
 * Get surrounding context for a chunk
 */
export async function getChunkContext(
  itemId: number,
  chunkIndex: number,
  contextSize: number = 1
): Promise<string> {
  const startIndex = Math.max(0, chunkIndex - contextSize)
  const endIndex = chunkIndex + contextSize

  const results = await executeQuery(
    (db) => db.execute(sql`
      SELECT content
      FROM repository_item_chunks
      WHERE item_id = ${itemId}
        AND chunk_index BETWEEN ${startIndex} AND ${endIndex}
      ORDER BY chunk_index
    `),
    "getChunkContext"
  )

  return (results.rows as Array<{ content: string }>).map(row => row.content).join('\n\n')
}