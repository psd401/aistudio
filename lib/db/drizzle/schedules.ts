/**
 * Drizzle Schedule Operations
 *
 * Schedule management and execution result CRUD operations migrated from
 * RDS Data API to Drizzle ORM. All functions use executeQuery() wrapper
 * with circuit breaker and retry logic.
 *
 * **IMPORTANT - Authorization**: These are infrastructure-layer data access functions.
 * They do NOT perform authorization checks. Authorization MUST be handled at the
 * API route or server action layer before calling these functions.
 *
 * **Authorization Requirements**:
 * - Verify user owns the schedule (schedule.userId matches session.userId)
 * - Verify user has assistant-architect tool access
 * - Use @/lib/auth/server-session helpers
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #537 - Migrate remaining database tables to Drizzle ORM
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, and, desc, sql } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import {
  scheduledExecutions,
  executionResults,
  assistantArchitects,
} from "@/lib/db/schema";
import { createLogger, sanitizeForLogging } from "@/lib/logger";
import { getUserIdByCognitoSubAsNumber } from "./utils";
import { safeJsonbStringify } from "@/lib/db/json-utils";

// Re-export ScheduleConfig from jsonb types (used in schema)
import type { ScheduleConfig } from "@/lib/db/types/jsonb";
export type { ScheduleConfig } from "@/lib/db/types/jsonb";

// ============================================
// Types
// ============================================

/**
 * Data for creating a new schedule
 */
export interface CreateScheduleData {
  userId: number;
  assistantArchitectId: number;
  name: string;
  scheduleConfig: ScheduleConfig;
  inputData: Record<string, string>;
  updatedBy?: string;
}

/**
 * Data for updating a schedule
 */
export interface UpdateScheduleData {
  name?: string;
  assistantArchitectId?: number;
  scheduleConfig?: ScheduleConfig;
  inputData?: Record<string, string>;
  active?: boolean;
  updatedBy?: string;
}

/**
 * Schedule with last execution info
 */
export interface ScheduleWithExecution {
  id: number;
  userId: number;
  assistantArchitectId: number;
  name: string;
  scheduleConfig: ScheduleConfig;
  inputData: Record<string, string>;
  active: boolean | null;
  createdAt: Date | null;
  updatedAt: Date;
  updatedBy: string | null;
  lastExecutedAt?: Date | null;
  lastExecutionStatus?: string | null;
}

/**
 * Execution result data
 */
export interface CreateExecutionResultData {
  scheduledExecutionId: number;
  resultData: Record<string, unknown>;
  status: string;
  executionDurationMs?: number;
  errorMessage?: string;
}

// ============================================
// Schedule Query Operations
// ============================================

/**
 * Get a schedule by ID with last execution info
 * Uses single LEFT JOIN query for better performance
 */
export async function getScheduleById(
  id: number
): Promise<ScheduleWithExecution | null> {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          id: scheduledExecutions.id,
          userId: scheduledExecutions.userId,
          assistantArchitectId: scheduledExecutions.assistantArchitectId,
          name: scheduledExecutions.name,
          scheduleConfig: scheduledExecutions.scheduleConfig,
          inputData: scheduledExecutions.inputData,
          active: scheduledExecutions.active,
          createdAt: scheduledExecutions.createdAt,
          updatedAt: scheduledExecutions.updatedAt,
          updatedBy: scheduledExecutions.updatedBy,
          lastExecutedAt: executionResults.executedAt,
          lastExecutionStatus: executionResults.status,
        })
        .from(scheduledExecutions)
        .leftJoin(
          executionResults,
          and(
            eq(executionResults.scheduledExecutionId, scheduledExecutions.id),
            sql`${executionResults.executedAt} = (
              SELECT MAX(executed_at)
              FROM execution_results
              WHERE scheduled_execution_id = ${scheduledExecutions.id}
            )`
          )
        )
        .where(eq(scheduledExecutions.id, id))
        .limit(1),
    "getScheduleById"
  );

  if (!result[0]) {
    return null;
  }

  return result[0];
}

/**
 * Get schedules by user ID with last execution info
 * Uses optimized LEFT JOIN with subquery to get latest execution per schedule
 */
export async function getSchedulesByUserId(
  userId: number
): Promise<ScheduleWithExecution[]> {
  const schedules = await executeQuery(
    (db) =>
      db
        .select({
          id: scheduledExecutions.id,
          userId: scheduledExecutions.userId,
          assistantArchitectId: scheduledExecutions.assistantArchitectId,
          name: scheduledExecutions.name,
          scheduleConfig: scheduledExecutions.scheduleConfig,
          inputData: scheduledExecutions.inputData,
          active: scheduledExecutions.active,
          createdAt: scheduledExecutions.createdAt,
          updatedAt: scheduledExecutions.updatedAt,
          updatedBy: scheduledExecutions.updatedBy,
          lastExecutedAt: executionResults.executedAt,
          lastExecutionStatus: executionResults.status,
        })
        .from(scheduledExecutions)
        .leftJoin(
          executionResults,
          and(
            eq(executionResults.scheduledExecutionId, scheduledExecutions.id),
            sql`${executionResults.executedAt} = (
              SELECT MAX(executed_at)
              FROM execution_results
              WHERE scheduled_execution_id = ${scheduledExecutions.id}
            )`
          )
        )
        .where(eq(scheduledExecutions.userId, userId))
        .orderBy(desc(scheduledExecutions.createdAt)),
    "getSchedulesByUserId"
  );

  return schedules;
}


/**
 * Get user ID by Cognito sub (number type for schedule operations)
 * Re-exported from utils for backward compatibility
 */
export const getUserIdByCognitoSub = getUserIdByCognitoSubAsNumber;

/**
 * Get schedule by ID for a specific user with last execution info
 * Validates ownership. Uses single LEFT JOIN query for better performance
 */
export async function getScheduleByIdForUser(
  id: number,
  userId: number
): Promise<ScheduleWithExecution | null> {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          id: scheduledExecutions.id,
          userId: scheduledExecutions.userId,
          assistantArchitectId: scheduledExecutions.assistantArchitectId,
          name: scheduledExecutions.name,
          scheduleConfig: scheduledExecutions.scheduleConfig,
          inputData: scheduledExecutions.inputData,
          active: scheduledExecutions.active,
          createdAt: scheduledExecutions.createdAt,
          updatedAt: scheduledExecutions.updatedAt,
          updatedBy: scheduledExecutions.updatedBy,
          lastExecutedAt: executionResults.executedAt,
          lastExecutionStatus: executionResults.status,
        })
        .from(scheduledExecutions)
        .leftJoin(
          executionResults,
          and(
            eq(executionResults.scheduledExecutionId, scheduledExecutions.id),
            sql`${executionResults.executedAt} = (
              SELECT MAX(executed_at)
              FROM execution_results
              WHERE scheduled_execution_id = ${scheduledExecutions.id}
            )`
          )
        )
        .where(
          and(eq(scheduledExecutions.id, id), eq(scheduledExecutions.userId, userId))
        )
        .limit(1),
    "getScheduleByIdForUser"
  );

  if (!result[0]) {
    return null;
  }

  return result[0];
}

/**
 * Check if user owns the assistant architect
 */
export async function checkAssistantArchitectOwnership(
  assistantArchitectId: number,
  userId: number
): Promise<boolean> {
  const result = await executeQuery(
    (db) =>
      db
        .select({ id: assistantArchitects.id })
        .from(assistantArchitects)
        .where(
          and(
            eq(assistantArchitects.id, assistantArchitectId),
            eq(assistantArchitects.userId, userId)
          )
        )
        .limit(1),
    "checkAssistantArchitectOwnership"
  );

  return result.length > 0;
}

// ============================================
// Schedule CRUD Operations
// ============================================

/**
 * Create a new schedule
 */
export async function createSchedule(
  data: CreateScheduleData
): Promise<ScheduleWithExecution> {
  const log = createLogger({ module: "drizzle-schedules" });

  const result = await executeQuery(
    (db) =>
      db
        .insert(scheduledExecutions)
        .values({
          userId: data.userId,
          assistantArchitectId: data.assistantArchitectId,
          name: data.name,
          scheduleConfig: sql`${safeJsonbStringify(data.scheduleConfig)}::jsonb`,
          inputData: sql`${safeJsonbStringify(data.inputData)}::jsonb`,
          active: true,
          updatedBy: data.updatedBy ?? null,
        })
        .returning(),
    "createSchedule"
  );

  if (!result[0]) {
    log.error("Failed to create schedule", { data: sanitizeForLogging(data) });
    throw new Error("Failed to create schedule");
  }

  return {
    ...result[0],
    lastExecutedAt: null,
    lastExecutionStatus: null,
  };
}

/**
 * Update a schedule and return updated record with last execution info
 * Uses optimized fetch after update for better performance
 */
export async function updateSchedule(
  id: number,
  userId: number,
  data: UpdateScheduleData
): Promise<ScheduleWithExecution | null> {
  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (data.name !== undefined) {
    updateData.name = data.name;
  }
  if (data.assistantArchitectId !== undefined) {
    updateData.assistantArchitectId = data.assistantArchitectId;
  }
  if (data.scheduleConfig !== undefined) {
    updateData.scheduleConfig = sql`${safeJsonbStringify(data.scheduleConfig)}::jsonb`;
  }
  if (data.inputData !== undefined) {
    updateData.inputData = sql`${safeJsonbStringify(data.inputData)}::jsonb`;
  }
  if (data.active !== undefined) {
    updateData.active = data.active;
  }
  if (data.updatedBy !== undefined) {
    updateData.updatedBy = data.updatedBy;
  }

  const result = await executeQuery(
    (db) =>
      db
        .update(scheduledExecutions)
        .set(updateData)
        .where(
          and(
            eq(scheduledExecutions.id, id),
            eq(scheduledExecutions.userId, userId)
          )
        )
        .returning({ id: scheduledExecutions.id }),
    "updateSchedule"
  );

  if (!result[0]) {
    return null;
  }

  // Fetch updated schedule with last execution using optimized single-query fetch
  return getScheduleByIdForUser(id, userId);
}

/**
 * Delete a schedule
 * @returns true if deleted, false if not found
 */
export async function deleteSchedule(
  id: number,
  userId: number
): Promise<boolean> {
  const result = await executeQuery(
    (db) =>
      db
        .delete(scheduledExecutions)
        .where(
          and(
            eq(scheduledExecutions.id, id),
            eq(scheduledExecutions.userId, userId)
          )
        )
        .returning({ id: scheduledExecutions.id }),
    "deleteSchedule"
  );

  return result.length > 0;
}

// ============================================
// Execution Results Operations
// ============================================

/**
 * Create an execution result
 */
export async function createExecutionResult(
  data: CreateExecutionResultData
): Promise<{
  id: number;
  scheduledExecutionId: number;
  resultData: Record<string, unknown>;
  status: string;
  executedAt: Date | null;
  executionDurationMs: number | null;
  errorMessage: string | null;
}> {
  const log = createLogger({ module: "drizzle-schedules" });

  const result = await executeQuery(
    (db) =>
      db
        .insert(executionResults)
        .values({
          scheduledExecutionId: data.scheduledExecutionId,
          resultData: sql`${safeJsonbStringify(data.resultData)}::jsonb`,
          status: data.status,
          executionDurationMs: data.executionDurationMs ?? null,
          errorMessage: data.errorMessage ?? null,
        })
        .returning(),
    "createExecutionResult"
  );

  if (!result[0]) {
    log.error("Failed to create execution result", {
      data: sanitizeForLogging(data),
    });
    throw new Error("Failed to create execution result");
  }

  return result[0];
}

/**
 * Get execution results for a schedule with pagination
 */
export async function getExecutionHistory(
  scheduledExecutionId: number,
  limit = 50,
  offset = 0
): Promise<{
  id: number;
  scheduledExecutionId: number;
  resultData: Record<string, unknown>;
  status: string;
  executedAt: Date | null;
  executionDurationMs: number | null;
  errorMessage: string | null;
}[]> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(executionResults)
        .where(eq(executionResults.scheduledExecutionId, scheduledExecutionId))
        .orderBy(desc(executionResults.executedAt))
        .limit(limit)
        .offset(offset),
    "getExecutionHistory"
  );

  return result;
}

/**
 * Get execution result count for a schedule
 */
export async function getExecutionHistoryCount(
  scheduledExecutionId: number
): Promise<number> {
  const result = await executeQuery(
    (db) =>
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(executionResults)
        .where(eq(executionResults.scheduledExecutionId, scheduledExecutionId)),
    "getExecutionHistoryCount"
  );

  return Number(result[0]?.count ?? 0);
}
