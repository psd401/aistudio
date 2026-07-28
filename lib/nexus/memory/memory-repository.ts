import { and, desc, eq, isNull, sql } from "drizzle-orm"
import {
  executeQuery,
  executeTransaction,
  toPgRows,
} from "@/lib/db/drizzle-client"
import {
  nexusConversations,
  nexusUserMemories,
  type NexusMemoryCategory,
  type NexusMemorySource,
} from "@/lib/db/schema"

export interface StoredNexusMemory {
  id: string
  userId: number
  content: string
  category: NexusMemoryCategory
  source: NexusMemorySource
  sourceConversationId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface MemoryWriteRecord {
  userId: number
  content: string
  category: NexusMemoryCategory
  source: NexusMemorySource
  sourceConversationId?: string
  embedding: number[]
}

export interface MemoryWriteResult {
  memory: StoredNexusMemory
  action: "inserted" | "updated"
}

export interface MemoryRepository {
  saveWithDedup(
    record: MemoryWriteRecord,
    threshold: number,
  ): Promise<MemoryWriteResult>
  updateOwned(
    memoryId: string,
    userId: number,
    record: Pick<MemoryWriteRecord, "content" | "category" | "embedding">,
  ): Promise<StoredNexusMemory | null>
  listProfileMemories(
    userId: number,
    limit: number,
  ): Promise<StoredNexusMemory[]>
  findRelevantMemories(
    userId: number,
    embedding: number[],
    threshold: number,
    limit: number,
    excludedMemoryIds: readonly string[],
  ): Promise<StoredNexusMemory[]>
  softDeleteOwned(memoryId: string, userId: number): Promise<boolean>
  conversationIsOwned(
    conversationId: string,
    userId: number,
  ): Promise<boolean>
}

interface SimilarMemoryRow {
  id: string
  similarity: number | string
}

interface RelevantMemoryRow {
  id: string
  user_id: number
  content: string
  category: NexusMemoryCategory
  source: NexusMemorySource
  source_conversation_id: string | null
  created_at: Date
  updated_at: Date
}

const NEXUS_MEMORY_DEDUP_LOCK_NAMESPACE = 1314210707

export function shouldUpdateSimilarMemory(
  similarity: number | string | undefined,
  threshold: number,
): boolean {
  if (similarity === undefined) return false
  const numericSimilarity = Number(similarity)
  return Number.isFinite(numericSimilarity) && numericSimilarity >= threshold
}

function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`
}

function selectedMemoryColumns() {
  return {
    id: nexusUserMemories.id,
    userId: nexusUserMemories.userId,
    content: nexusUserMemories.content,
    category: nexusUserMemories.category,
    source: nexusUserMemories.source,
    sourceConversationId: nexusUserMemories.sourceConversationId,
    createdAt: nexusUserMemories.createdAt,
    updatedAt: nexusUserMemories.updatedAt,
  }
}

function rawMemory(row: RelevantMemoryRow): StoredNexusMemory {
  return {
    id: row.id,
    userId: row.user_id,
    content: row.content,
    category: row.category,
    source: row.source,
    sourceConversationId: row.source_conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const drizzleMemoryRepository: MemoryRepository = {
  async saveWithDedup(record, threshold) {
    // Embedding is deliberately generated before entering this transaction.
    // The transaction contains database work only, so retry cannot duplicate an
    // external Bedrock call.
    return executeTransaction(
      async (tx) => {
        // FOR UPDATE cannot lock a missing nearest row, so serialize the
        // check-then-insert decision per user even when the memory set is empty.
        // READ COMMITTED below is intentional: after waiting for this lock, the
        // nearest-row query must take a fresh snapshot that sees the prior save.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(
            ${NEXUS_MEMORY_DEDUP_LOCK_NAMESPACE},
            ${record.userId}
          )`,
        )
        const literal = vectorLiteral(record.embedding)
        const nearestResult = await tx.execute(sql`
          WITH owner_memories AS MATERIALIZED (
            SELECT id, embedding
            FROM nexus_user_memories
            WHERE user_id = ${record.userId}
              AND deleted_at IS NULL
              AND embedding IS NOT NULL
            FOR UPDATE
          )
          SELECT id, 1 - (embedding <=> ${literal}::vector) AS similarity
          FROM owner_memories
          ORDER BY embedding <=> ${literal}::vector
          LIMIT 1
        `)
        const [nearest] = toPgRows<SimilarMemoryRow>(nearestResult)
        const shouldUpdate = shouldUpdateSimilarMemory(
          nearest?.similarity,
          threshold,
        )

        if (shouldUpdate) {
          const [updated] = await tx
            .update(nexusUserMemories)
            .set({
              content: record.content,
              category: record.category,
              source: record.source,
              sourceConversationId: record.sourceConversationId ?? null,
              embedding: record.embedding,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(nexusUserMemories.id, nearest.id),
                eq(nexusUserMemories.userId, record.userId),
                isNull(nexusUserMemories.deletedAt),
              ),
            )
            .returning(selectedMemoryColumns())
          if (!updated) {
            throw new Error("The matching Nexus memory could not be updated")
          }
          return { memory: updated, action: "updated" as const }
        }

        const [inserted] = await tx
          .insert(nexusUserMemories)
          .values({
            userId: record.userId,
            content: record.content,
            category: record.category,
            source: record.source,
            sourceConversationId: record.sourceConversationId,
            embedding: record.embedding,
          })
          .returning(selectedMemoryColumns())
        if (!inserted) {
          throw new Error("The Nexus memory could not be inserted")
        }
        return { memory: inserted, action: "inserted" as const }
      },
      "saveNexusUserMemory",
      { isolationLevel: "read committed" },
    )
  },

  async updateOwned(memoryId, userId, record) {
    const [updated] = await executeQuery(
      (db) =>
        db
          .update(nexusUserMemories)
          .set({
            content: record.content,
            category: record.category,
            embedding: record.embedding,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(nexusUserMemories.id, memoryId),
              eq(nexusUserMemories.userId, userId),
              isNull(nexusUserMemories.deletedAt),
            ),
          )
          .returning(selectedMemoryColumns()),
      "updateOwnedNexusMemory",
    )
    return updated ?? null
  },

  listProfileMemories(userId, limit) {
    return executeQuery(
      (db) =>
        db
          .select(selectedMemoryColumns())
          .from(nexusUserMemories)
          .where(
            and(
              eq(nexusUserMemories.userId, userId),
              eq(nexusUserMemories.category, "profile"),
              isNull(nexusUserMemories.deletedAt),
            ),
          )
          .orderBy(desc(nexusUserMemories.updatedAt))
          .limit(limit),
      "listNexusProfileMemories",
    )
  },

  async findRelevantMemories(
    userId,
    embedding,
    threshold,
    limit,
    excludedMemoryIds,
  ) {
    const literal = vectorLiteral(embedding)
    const exclusion =
      excludedMemoryIds.length === 0
        ? sql``
        : sql`AND id NOT IN (${sql.join(
            excludedMemoryIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
    const result = await executeQuery(
      (db) =>
        db.execute(sql`
          WITH owner_memories AS MATERIALIZED (
            SELECT
              id,
              user_id,
              content,
              category,
              source,
              source_conversation_id,
              embedding,
              created_at,
              updated_at
            FROM nexus_user_memories
            WHERE user_id = ${userId}
              AND category IN ('profile', 'preference', 'context')
              AND deleted_at IS NULL
              AND embedding IS NOT NULL
              ${exclusion}
          )
          SELECT
            id,
            user_id,
            content,
            category,
            source,
            source_conversation_id,
            created_at,
            updated_at
          FROM owner_memories
          WHERE 1 - (embedding <=> ${literal}::vector) >= ${threshold}
          ORDER BY embedding <=> ${literal}::vector
          LIMIT ${limit}
        `),
      "findRelevantNexusMemories",
    )
    return toPgRows<RelevantMemoryRow>(result).map(rawMemory)
  },

  async softDeleteOwned(memoryId, userId) {
    const [deleted] = await executeQuery(
      (db) =>
        db
          .update(nexusUserMemories)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(nexusUserMemories.id, memoryId),
              eq(nexusUserMemories.userId, userId),
              isNull(nexusUserMemories.deletedAt),
            ),
          )
          .returning({ id: nexusUserMemories.id }),
      "softDeleteOwnedNexusMemory",
    )
    return deleted !== undefined
  },

  async conversationIsOwned(conversationId, userId) {
    const [owned] = await executeQuery(
      (db) =>
        db
          .select({ id: nexusConversations.id })
          .from(nexusConversations)
          .where(
            and(
              eq(nexusConversations.id, conversationId),
              eq(nexusConversations.userId, userId),
            ),
          )
          .limit(1),
      "verifyNexusMemoryConversationOwnership",
    )
    return owned !== undefined
  },
}
