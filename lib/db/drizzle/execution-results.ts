/**
 * Drizzle Execution Results Operations
 *
 * Execution result queries with joined schedule and assistant architect data.
 * All functions use executeQuery() wrapper with circuit breaker and retry logic.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #541 - Remove Legacy RDS Data API Code
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, and, desc } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import {
  executionResults,
  scheduledExecutions,
  assistantArchitects,
} from "@/lib/db/schema";

// ============================================
// Query Operations
// ============================================

/**
 * Get recent execution results for a user
 */
export async function getRecentExecutionResults(
  userId: number,
  options: {
    limit?: number;
    status?: "success" | "failed" | "running";
  } = {}
) {
  const { limit = 20, status } = options;

  const conditions = [eq(scheduledExecutions.userId, userId)];
  if (status) {
    conditions.push(eq(executionResults.status, status));
  }

  return executeQuery(
    (db) =>
      db
        .select({
          id: executionResults.id,
          scheduledExecutionId: executionResults.scheduledExecutionId,
          resultData: executionResults.resultData,
          status: executionResults.status,
          executedAt: executionResults.executedAt,
          executionDurationMs: executionResults.executionDurationMs,
          errorMessage: executionResults.errorMessage,
          scheduleName: scheduledExecutions.name,
          userId: scheduledExecutions.userId,
          assistantArchitectName: assistantArchitects.name,
        })
        .from(executionResults)
        .innerJoin(
          scheduledExecutions,
          eq(executionResults.scheduledExecutionId, scheduledExecutions.id)
        )
        .innerJoin(
          assistantArchitects,
          eq(scheduledExecutions.assistantArchitectId, assistantArchitects.id)
        )
        .where(and(...conditions))
        .orderBy(desc(executionResults.executedAt))
        .limit(limit),
    "getRecentExecutionResults"
  );
}

/**
 * Get execution result by ID with access control check
 * Returns null if not found or user doesn't have access
 */
export async function getExecutionResultById(
  resultId: number,
  userId: number
) {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          id: executionResults.id,
          scheduledExecutionId: executionResults.scheduledExecutionId,
          resultData: executionResults.resultData,
          status: executionResults.status,
          executedAt: executionResults.executedAt,
          executionDurationMs: executionResults.executionDurationMs,
          errorMessage: executionResults.errorMessage,
          scheduleName: scheduledExecutions.name,
          userId: scheduledExecutions.userId,
          assistantArchitectName: assistantArchitects.name,
        })
        .from(executionResults)
        .innerJoin(
          scheduledExecutions,
          eq(executionResults.scheduledExecutionId, scheduledExecutions.id)
        )
        .innerJoin(
          assistantArchitects,
          eq(scheduledExecutions.assistantArchitectId, assistantArchitects.id)
        )
        .where(
          and(
            eq(executionResults.id, resultId),
            eq(scheduledExecutions.userId, userId)
          )
        )
        .limit(1),
    "getExecutionResultById"
  );
  return result[0];
}

/**
 * Get execution result with schedule data for download
 * Includes inputData and scheduleConfig from scheduled_executions
 * Returns null if not found or user doesn't have access
 */
export async function getExecutionResultForDownload(
  resultId: number,
  userId: number
) {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          id: executionResults.id,
          scheduledExecutionId: executionResults.scheduledExecutionId,
          resultData: executionResults.resultData,
          status: executionResults.status,
          executedAt: executionResults.executedAt,
          executionDurationMs: executionResults.executionDurationMs,
          errorMessage: executionResults.errorMessage,
          scheduleName: scheduledExecutions.name,
          userId: scheduledExecutions.userId,
          inputData: scheduledExecutions.inputData,
          scheduleConfig: scheduledExecutions.scheduleConfig,
          assistantArchitectName: assistantArchitects.name,
        })
        .from(executionResults)
        .innerJoin(
          scheduledExecutions,
          eq(executionResults.scheduledExecutionId, scheduledExecutions.id)
        )
        .innerJoin(
          assistantArchitects,
          eq(scheduledExecutions.assistantArchitectId, assistantArchitects.id)
        )
        .where(
          and(
            eq(executionResults.id, resultId),
            eq(scheduledExecutions.userId, userId)
          )
        )
        .limit(1),
    "getExecutionResultForDownload"
  );
  return result[0];
}

// ============================================
// Mutation Operations
// ============================================

/**
 * Delete execution result with access control check
 * Returns true if deleted, false if not found or access denied
 */
export async function deleteExecutionResult(
  resultId: number,
  userId: number
): Promise<boolean> {
  // First check if the execution result exists and belongs to the user
  const checkResult = await executeQuery(
    (db) =>
      db
        .select({ id: executionResults.id })
        .from(executionResults)
        .innerJoin(
          scheduledExecutions,
          eq(executionResults.scheduledExecutionId, scheduledExecutions.id)
        )
        .where(
          and(
            eq(executionResults.id, resultId),
            eq(scheduledExecutions.userId, userId)
          )
        )
        .limit(1),
    "deleteExecutionResult:check"
  );

  if (checkResult.length === 0) {
    return false;
  }

  // Delete the execution result
  await executeQuery(
    (db) => db.delete(executionResults).where(eq(executionResults.id, resultId)),
    "deleteExecutionResult:delete"
  );

  return true;
}
