import { executeQuery } from "@/lib/db/drizzle-client"
import { sql } from "drizzle-orm"
import { generateEmbedding } from "@/lib/ai-helpers"
import type { RepositorySourceLocator } from "@/lib/db/schema"

export interface SearchCitation {
  itemStableId: string
  itemVersionId: string
  versionNumber: number
  sourceLocator: RepositorySourceLocator
}

export interface SearchResult {
  chunkId: number
  itemId: number
  itemName: string
  content: string
  similarity: number
  chunkIndex: number
  metadata: Record<string, unknown>
  citation?: SearchCitation
}

export interface SearchOptions {
  limit?: number
  threshold?: number
  repositoryId?: number
  canonicalOnly?: boolean
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>
  return (value as Record<string, unknown> | null) ?? {}
}

function mapSearchRow(row: Record<string, unknown>, scoreKey: 'similarity' | 'rank'): SearchResult {
  const sourceLocator = parseJsonRecord(row.source_locator) as RepositorySourceLocator
  const hasCitation =
    typeof row.item_stable_id === 'string' &&
    typeof row.item_version_id === 'string' &&
    Number(row.version_number) > 0

  return {
    chunkId: Number(row.chunk_id) || 0,
    itemId: Number(row.item_id) || 0,
    itemName: String(row.item_name || ''),
    content: String(row.content || ''),
    similarity: Number(row[scoreKey]) || 0,
    chunkIndex: Number(row.chunk_index) || 0,
    metadata: parseJsonRecord(row.metadata),
    citation: hasCitation
      ? {
          itemStableId: String(row.item_stable_id),
          itemVersionId: String(row.item_version_id),
          versionNumber: Number(row.version_number),
          sourceLocator,
        }
      : undefined,
  }
}


/**
 * Perform vector similarity search using cosine similarity
 */
export async function vectorSearch(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const { limit = 10, threshold = 0.7, repositoryId, canonicalOnly = false } = options
  
  // Generate embedding for the query
  const queryEmbedding = await generateEmbedding(query)
  
  // Build the SQL query using pgvector
  // Convert embedding array to pgvector format string: '[1,2,3]'
  const embeddingString = `[${queryEmbedding.join(',')}]`

  // Use Drizzle with raw SQL for pgvector operators
  const results = await executeQuery(
    (db) => {
      if (repositoryId && canonicalOnly) {
        return db.execute(sql`
          SELECT
            c.id as chunk_id,
            c.item_id,
            i.stable_id as item_stable_id,
            i.name as item_name,
            c.item_version_id,
            v.version_number,
            c.source_locator,
            c.content,
            c.chunk_index,
            c.metadata,
            1 - (c.embedding <=> ${embeddingString}::vector) as similarity
          FROM repository_item_chunks c
          JOIN repository_items i ON i.id = c.item_id
          JOIN repository_item_versions v ON v.id = c.item_version_id
          JOIN knowledge_repositories r ON r.id = i.repository_id
          WHERE c.embedding IS NOT NULL
            AND i.repository_id = ${repositoryId}
            AND i.lifecycle_status = 'active'
            AND i.current_version_id = c.item_version_id
            AND r.lifecycle_status = 'active'
            AND r.active_index_generation_id = c.index_generation_id
            AND v.storage_status = 'available'
            AND v.inspection_status IN ('clean', 'not_required')
            AND v.processing_status = 'completed'
            AND 1 - (c.embedding <=> ${embeddingString}::vector) >= ${threshold}
          ORDER BY similarity DESC
          LIMIT ${limit}
        `)
      } else if (repositoryId) {
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

  // postgres.js returns result directly as array-like object (no .rows property)
  const rows = results as unknown as Array<Record<string, unknown>>
  return rows.map((row) => mapSearchRow(row, 'similarity'))
}

/**
 * Perform keyword search using PostgreSQL full-text search
 */
export async function keywordSearch(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const { limit = 10, repositoryId, canonicalOnly = false } = options

  // Use Drizzle with raw SQL for full-text search operators
  const results = await executeQuery(
    (db) => {
      if (repositoryId && canonicalOnly) {
        return db.execute(sql`
          SELECT
            c.id as chunk_id,
            c.item_id,
            i.stable_id as item_stable_id,
            i.name as item_name,
            c.item_version_id,
            v.version_number,
            c.source_locator,
            c.content,
            c.chunk_index,
            c.metadata,
            ts_rank(to_tsvector('english', c.content), plainto_tsquery('english', ${query})) as rank
          FROM repository_item_chunks c
          JOIN repository_items i ON i.id = c.item_id
          JOIN repository_item_versions v ON v.id = c.item_version_id
          JOIN knowledge_repositories r ON r.id = i.repository_id
          WHERE to_tsvector('english', c.content) @@ plainto_tsquery('english', ${query})
            AND i.repository_id = ${repositoryId}
            AND i.lifecycle_status = 'active'
            AND i.current_version_id = c.item_version_id
            AND r.lifecycle_status = 'active'
            AND r.active_index_generation_id = c.index_generation_id
            AND v.storage_status = 'available'
            AND v.inspection_status IN ('clean', 'not_required')
            AND v.processing_status = 'completed'
          ORDER BY rank DESC
          LIMIT ${limit}
        `)
      } else if (repositoryId) {
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

  // postgres.js returns result directly as array-like object (no .rows property)
  const rows = results as unknown as Array<Record<string, unknown>>
  return rows.map((row) => mapSearchRow(row, 'rank'))
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

  // postgres.js returns result directly as array-like object (no .rows property)
  const rows = results as unknown as Array<{ content: string }>
  return rows.map(row => row.content).join('\n\n')
}
