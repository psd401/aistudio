/**
 * Server-Sent Events (SSE) type definitions for notification streaming API
 *
 * This module defines SSE event types used for real-time notification updates.
 * The notification stream sends lightweight events for:
 * - Connection lifecycle (establishment, timeout, ping)
 * - Notification updates
 *
 * @module types/notification-sse-events
 */

/**
 * Base interface for notification SSE events
 */
export interface NotificationSSEEvent {
  /** ISO 8601 timestamp of when the event was generated */
  timestamp: string;
}

/**
 * Emitted when SSE connection is successfully established
 */
export interface ConnectionEstablishedEvent extends NotificationSSEEvent {
  type: 'connection_established';
}

/**
 * Emitted every 30 seconds to keep the connection alive
 */
export interface PingEvent extends NotificationSSEEvent {
  type: 'ping';
}

/**
 * Emitted when the server gracefully closes the connection due to timeout
 * Clients should treat this as expected behavior and reconnect without exponential backoff
 */
export interface ConnectionTimeoutEvent extends NotificationSSEEvent {
  type: 'connection_timeout';
}

/**
 * Emitted when new notifications are available
 * Clients should refresh their notification list
 */
export interface NotificationUpdateEvent extends NotificationSSEEvent {
  type: 'notification_update';
}

/**
 * Union type of all possible notification SSE events
 */
export type NotificationSSEEventData =
  | ConnectionEstablishedEvent
  | PingEvent
  | ConnectionTimeoutEvent
  | NotificationUpdateEvent;

/**
 * Type guard for ConnectionEstablishedEvent
 */
export function isConnectionEstablishedEvent(
  event: unknown
): event is ConnectionEstablishedEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    event.type === 'connection_established' &&
    'timestamp' in event &&
    typeof event.timestamp === 'string'
  );
}

/**
 * Type guard for PingEvent
 */
export function isPingEvent(event: unknown): event is PingEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    event.type === 'ping' &&
    'timestamp' in event &&
    typeof event.timestamp === 'string'
  );
}

/**
 * Type guard for ConnectionTimeoutEvent
 */
export function isConnectionTimeoutEvent(
  event: unknown
): event is ConnectionTimeoutEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    event.type === 'connection_timeout' &&
    'timestamp' in event &&
    typeof event.timestamp === 'string'
  );
}

/**
 * Type guard for NotificationUpdateEvent
 */
export function isNotificationUpdateEvent(
  event: unknown
): event is NotificationUpdateEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    event.type === 'notification_update' &&
    'timestamp' in event &&
    typeof event.timestamp === 'string'
  );
}

/**
 * General type guard for any notification SSE event
 */
export function isNotificationSSEEvent(
  event: unknown
): event is NotificationSSEEventData {
  return (
    isConnectionEstablishedEvent(event) ||
    isPingEvent(event) ||
    isConnectionTimeoutEvent(event) ||
    isNotificationUpdateEvent(event)
  );
}
