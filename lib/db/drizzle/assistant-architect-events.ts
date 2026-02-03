/**
 * Drizzle Assistant Architect Events Operations
 *
 * Event storage operations for assistant architect executions.
 * Provides audit trail and debugging capabilities for tool executions.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #541 - Remove Legacy RDS Data API Code
 *
 * @see https://orm.drizzle.team/docs/insert
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, and, asc, sql } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { assistantArchitectEvents } from "@/lib/db/schema";
import type { SSEEventType, SSEEventMap } from "@/types/sse-events";

// ============================================
// Types
// ============================================

export interface ExecutionEvent<K extends SSEEventType = SSEEventType> {
  id: number;
  executionId: number;
  eventType: K;
  eventData: SSEEventMap[K];
  createdAt: Date;
}

// ============================================
// Event Storage Operations
// ============================================

/**
 * Store an execution event in the database
 *
 * Events are stored in the assistant_architect_events table for:
 * - Audit trail and debugging
 * - Post-execution analysis
 * - Future real-time SSE streaming
 *
 * CRITICAL: Drizzle's AWS Data API driver doesn't properly serialize JSONB.
 * Must use raw SQL with db.execute() to bypass broken parameter binding.
 * See: Issue #599, https://github.com/drizzle-team/drizzle-orm/issues/724
 *
 * @param executionId - The tool execution ID
 * @param eventType - The type of event
 * @param eventData - The event data payload
 */
export async function storeExecutionEvent<K extends SSEEventType>(
  executionId: number,
  eventType: K,
  eventData: Omit<SSEEventMap[K], "timestamp" | "eventId">
): Promise<void> {
  // Add timestamp to event data
  const fullEventData = {
    ...eventData,
    timestamp: new Date().toISOString(),
  };
  const eventDataJson = JSON.stringify(fullEventData);

  // CRITICAL: Drizzle's AWS Data API driver has issues with JSONB and ENUM parameter serialization.
  // Even with db.execute(), parameters go through the driver which can corrupt values.
  // Using sql.raw() to embed values directly in the SQL, bypassing parameter binding.
  // Single quotes in JSON are escaped by replacing ' with '' (SQL escape).
  // See: Issue #599, https://github.com/drizzle-team/drizzle-orm/issues/724
  const escapedJson = eventDataJson.replace(/'/g, "''");

  await executeQuery(
    (db) => db.execute(sql`
      INSERT INTO assistant_architect_events (execution_id, event_type, event_data)
      VALUES (${executionId}, ${sql.raw(`'${eventType}'::assistant_event_type`)}, ${sql.raw(`'${escapedJson}'::jsonb`)})
    `),
    "storeExecutionEvent"
  );
}

/**
 * Retrieve all events for an execution
 *
 * @param executionId - The tool execution ID
 * @returns Array of events in chronological order
 */
export async function getExecutionEvents(
  executionId: number
): Promise<
  Array<{
    id: number;
    eventType: SSEEventType;
    eventData: SSEEventMap[SSEEventType];
    createdAt: string;
  }>
> {
  const results = await executeQuery(
    (db) =>
      db
        .select()
        .from(assistantArchitectEvents)
        .where(eq(assistantArchitectEvents.executionId, executionId))
        .orderBy(asc(assistantArchitectEvents.createdAt)),
    "getExecutionEvents"
  );

  return results.map((row) => ({
    id: row.id,
    eventType: row.eventType as SSEEventType,
    eventData: row.eventData as unknown as SSEEventMap[SSEEventType],
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * Get events of a specific type for an execution
 *
 * @param executionId - The tool execution ID
 * @param eventType - The event type to filter by
 * @returns Array of matching events
 */
export async function getExecutionEventsByType<K extends SSEEventType>(
  executionId: number,
  eventType: K
): Promise<
  Array<{
    id: number;
    eventData: SSEEventMap[K];
    createdAt: string;
  }>
> {
  const results = await executeQuery(
    (db) =>
      db
        .select({
          id: assistantArchitectEvents.id,
          eventData: assistantArchitectEvents.eventData,
          createdAt: assistantArchitectEvents.createdAt,
        })
        .from(assistantArchitectEvents)
        .where(
          and(
            eq(assistantArchitectEvents.executionId, executionId),
            eq(assistantArchitectEvents.eventType, eventType)
          )
        )
        .orderBy(asc(assistantArchitectEvents.createdAt)),
    "getExecutionEventsByType"
  );

  return results.map((row) => ({
    id: row.id,
    eventData: row.eventData as unknown as SSEEventMap[K],
    createdAt: row.createdAt.toISOString(),
  }));
}
