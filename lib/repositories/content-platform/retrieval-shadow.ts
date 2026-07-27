import { executeQuery } from "@/lib/db/drizzle-client";
import { repositoryRetrievalShadowObservations } from "@/lib/db/schema";
import { sql } from "drizzle-orm";

export interface RepositoryRetrievalShadowInput {
  repositoryId: number;
  product: "repository_manager" | "nexus" | "assistant_architect";
  searchMode: "vector" | "keyword" | "hybrid";
  legacyItemIds: number[];
  canonicalItemIds: number[];
  legacyDurationMs: number;
  canonicalDurationMs: number;
}

export function overlappingMigrationItemCount(
  legacyItemIds: number[],
  canonicalItemIds: number[],
): number {
  const canonical = new Set(canonicalItemIds);
  return new Set(legacyItemIds.filter((itemId) => canonical.has(itemId))).size;
}

export interface RetrievalParityEvaluation {
  canonicalResultDelta: number;
  latencyDeltaMs: number;
  overlapRatio: number;
}

export function evaluateRepositoryRetrievalParity(input: {
  legacyItemIds: number[];
  canonicalItemIds: number[];
  legacyDurationMs: number;
  canonicalDurationMs: number;
}): RetrievalParityEvaluation {
  const overlap = overlappingMigrationItemCount(
    input.legacyItemIds,
    input.canonicalItemIds,
  );
  const denominator = Math.max(
    new Set(input.legacyItemIds).size,
    new Set(input.canonicalItemIds).size,
  );
  return {
    canonicalResultDelta:
      input.canonicalItemIds.length - input.legacyItemIds.length,
    latencyDeltaMs:
      Math.max(0, Math.floor(input.canonicalDurationMs)) -
      Math.max(0, Math.floor(input.legacyDurationMs)),
    overlapRatio: denominator === 0 ? 1 : overlap / denominator,
  };
}

export async function recordRepositoryRetrievalShadow(
  input: RepositoryRetrievalShadowInput,
): Promise<void> {
  await executeQuery(
    (db) =>
      db.insert(repositoryRetrievalShadowObservations).values({
        repositoryId: input.repositoryId,
        product: input.product,
        searchMode: input.searchMode,
        legacyResultCount: input.legacyItemIds.length,
        canonicalResultCount: input.canonicalItemIds.length,
        overlappingItemCount: overlappingMigrationItemCount(
          input.legacyItemIds,
          input.canonicalItemIds,
        ),
        legacyDurationMs: Math.max(0, Math.floor(input.legacyDurationMs)),
        canonicalDurationMs: Math.max(0, Math.floor(input.canonicalDurationMs)),
      }),
    "contentMigration.recordRetrievalShadow",
  );
}

export async function cleanupRepositoryRetrievalShadow(
  retentionDays = 30,
): Promise<number> {
  const safeRetentionDays = Math.min(
    365,
    Math.max(1, Math.floor(retentionDays)),
  );
  const deleted = await executeQuery(
    (db) =>
      db
        .delete(repositoryRetrievalShadowObservations)
        .where(
          // Keep interval construction server-side but parameterize the only
          // value; the bounded integer cannot become SQL syntax.
          sql`${repositoryRetrievalShadowObservations.createdAt} < NOW() - (${safeRetentionDays} * INTERVAL '1 day')`,
        )
        .returning({ id: repositoryRetrievalShadowObservations.id }),
    "contentMigration.cleanupRetrievalShadow",
  );
  return deleted.length;
}
