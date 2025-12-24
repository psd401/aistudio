/**
 * Drizzle Model Comparison Operations
 *
 * Side-by-side AI model comparison CRUD operations migrated from
 * RDS Data API to Drizzle ORM. All functions use executeQuery() wrapper
 * with circuit breaker and retry logic.
 *
 * **IMPORTANT - Authorization**: These are infrastructure-layer data access functions.
 * They do NOT perform authorization checks. Authorization MUST be handled at the
 * API route or server action layer before calling these functions.
 *
 * **Authorization Requirements**:
 * - Verify user owns the comparison (comparison.userId matches session.userId)
 * - Verify user has model-compare tool access
 * - Use @/lib/auth/server-session helpers
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #537 - Migrate remaining database tables to Drizzle ORM
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, and, desc } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { modelComparisons } from "@/lib/db/schema";
import { getUserIdByCognitoSub as getUserIdStringByCognitoSub } from "./users";

// ============================================
// Types
// ============================================

/**
 * Data for updating comparison results
 */
export interface UpdateComparisonResultsData {
  response1?: string;
  response2?: string;
  executionTimeMs1?: number;
  executionTimeMs2?: number;
  tokensUsed1?: number;
  tokensUsed2?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Model comparison with all fields
 */
export interface ModelComparison {
  id: number;
  userId: number | null;
  prompt: string;
  model1Id: number | null;
  model2Id: number | null;
  model1Name: string | null;
  model2Name: string | null;
  response1: string | null;
  response2: string | null;
  executionTimeMs1: number | null;
  executionTimeMs2: number | null;
  tokensUsed1: number | null;
  tokensUsed2: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

// ============================================
// Query Operations
// ============================================

/**
 * Get a model comparison by ID
 */
export async function getComparisonById(
  id: number
): Promise<ModelComparison | null> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(modelComparisons)
        .where(eq(modelComparisons.id, id))
        .limit(1),
    "getComparisonById"
  );

  return result[0] ?? null;
}

/**
 * Get a model comparison by ID for a specific user
 * Validates ownership
 */
export async function getComparisonByIdForUser(
  id: number,
  userId: number
): Promise<ModelComparison | null> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(modelComparisons)
        .where(
          and(eq(modelComparisons.id, id), eq(modelComparisons.userId, userId))
        )
        .limit(1),
    "getComparisonByIdForUser"
  );

  return result[0] ?? null;
}

/**
 * Get model comparisons by user ID with pagination
 */
export async function getComparisonsByUserId(
  userId: number,
  limit = 20,
  offset = 0
): Promise<ModelComparison[]> {
  return executeQuery(
    (db) =>
      db
        .select()
        .from(modelComparisons)
        .where(eq(modelComparisons.userId, userId))
        .orderBy(desc(modelComparisons.createdAt))
        .limit(limit)
        .offset(offset),
    "getComparisonsByUserId"
  );
}

/**
 * Get user ID by Cognito sub (number type for model comparison operations)
 * Wraps the users module getUserIdByCognitoSub and converts string to number
 */
export async function getUserIdByCognitoSub(
  cognitoSub: string
): Promise<number | null> {
  const userIdString = await getUserIdStringByCognitoSub(cognitoSub);
  return userIdString ? Number(userIdString) : null;
}

// ============================================
// CRUD Operations
// ============================================

// Note: createComparison is not needed as model comparisons are created
// through API routes during the comparison execution process, not through
// server actions. The table uses a database-generated sequence for the id.

/**
 * Update comparison results
 */
export async function updateComparisonResults(
  id: number,
  userId: number,
  data: UpdateComparisonResultsData
): Promise<ModelComparison | null> {
  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (data.response1 !== undefined) {
    updateData.response1 = data.response1;
  }
  if (data.response2 !== undefined) {
    updateData.response2 = data.response2;
  }
  if (data.executionTimeMs1 !== undefined) {
    updateData.executionTimeMs1 = data.executionTimeMs1;
  }
  if (data.executionTimeMs2 !== undefined) {
    updateData.executionTimeMs2 = data.executionTimeMs2;
  }
  if (data.tokensUsed1 !== undefined) {
    updateData.tokensUsed1 = data.tokensUsed1;
  }
  if (data.tokensUsed2 !== undefined) {
    updateData.tokensUsed2 = data.tokensUsed2;
  }
  if (data.metadata !== undefined) {
    updateData.metadata = data.metadata;
  }

  const result = await executeQuery(
    (db) =>
      db
        .update(modelComparisons)
        .set(updateData)
        .where(
          and(eq(modelComparisons.id, id), eq(modelComparisons.userId, userId))
        )
        .returning(),
    "updateComparisonResults"
  );

  return result[0] ?? null;
}

/**
 * Delete a model comparison
 * @returns true if deleted, false if not found
 */
export async function deleteComparison(
  id: number,
  userId: number
): Promise<boolean> {
  const result = await executeQuery(
    (db) =>
      db
        .delete(modelComparisons)
        .where(
          and(eq(modelComparisons.id, id), eq(modelComparisons.userId, userId))
        )
        .returning({ id: modelComparisons.id }),
    "deleteComparison"
  );

  return result.length > 0;
}
