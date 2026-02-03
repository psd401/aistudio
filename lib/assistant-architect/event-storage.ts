/**
 * Assistant Architect Event Storage
 *
 * Utilities for storing execution events in the database for audit trail and debugging.
 * These events provide fine-grained visibility into execution progress.
 *
 * @module lib/assistant-architect/event-storage
 */

import {
  storeExecutionEvent as drizzleStoreEvent,
  getExecutionEvents as drizzleGetEvents,
  getExecutionEventsByType as drizzleGetEventsByType,
} from '@/lib/db/drizzle';
import type { SSEEventType, SSEEventMap } from '@/types/sse-events';
import { createLogger } from '@/lib/logger';

const log = createLogger({ module: 'event-storage' });

/**
 * Store an execution event in the database
 *
 * Events are stored in the assistant_architect_events table for:
 * - Audit trail and debugging
 * - Post-execution analysis
 * - Future real-time SSE streaming
 *
 * @param executionId - The tool execution ID
 * @param eventType - The type of event
 * @param eventData - The event data payload
 */
export async function storeExecutionEvent<K extends SSEEventType>(
  executionId: number,
  eventType: K,
  eventData: Omit<SSEEventMap[K], 'timestamp' | 'eventId'>
): Promise<void> {
  try {
    await drizzleStoreEvent(executionId, eventType, eventData);
    log.debug('Event stored', { executionId, eventType });
  } catch (error) {
    // Log error but don't throw - event storage shouldn't break execution
    log.error('Failed to store execution event', {
      error: error instanceof Error ? error.message : String(error),
      executionId,
      eventType
    });
  }
}

/**
 * Retrieve all events for an execution
 *
 * @param executionId - The tool execution ID
 * @returns Array of events in chronological order
 */
export async function getExecutionEvents(
  executionId: number
): Promise<Array<{
  id: number;
  eventType: SSEEventType;
  eventData: SSEEventMap[SSEEventType];
  createdAt: string;
}>> {
  try {
    return await drizzleGetEvents(executionId);
  } catch (error) {
    log.error('Failed to retrieve execution events', {
      error: error instanceof Error ? error.message : String(error),
      executionId
    });
    return [];
  }
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
): Promise<Array<{
  id: number;
  eventData: SSEEventMap[K];
  createdAt: string;
}>> {
  try {
    return await drizzleGetEventsByType(executionId, eventType);
  } catch (error) {
    log.error('Failed to retrieve execution events by type', {
      error: error instanceof Error ? error.message : String(error),
      executionId,
      eventType
    });
    return [];
  }
}
