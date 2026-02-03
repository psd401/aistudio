/**
 * Drizzle Notifications Operations
 *
 * User notification queries with joined execution results data.
 * All functions use executeQuery() wrapper with circuit breaker and retry logic.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #541 - Remove Legacy RDS Data API Code
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import {
  userNotifications,
  executionResults,
  scheduledExecutions,
  assistantArchitects,
} from "@/lib/db/schema";

// ============================================
// Query Operations
// ============================================

/**
 * Get notifications for a user with execution result details
 */
export async function getUserNotifications(
  userId: number,
  options: {
    limit?: number;
    offset?: number;
    type?: "email" | "in_app";
  } = {}
) {
  const { limit = 50, offset = 0, type } = options;

  const conditions = [eq(userNotifications.userId, userId)];
  if (type) {
    conditions.push(eq(userNotifications.type, type));
  }

  return executeQuery(
    (db) =>
      db
        .select({
          // Notification fields
          id: userNotifications.id,
          userId: userNotifications.userId,
          executionResultId: userNotifications.executionResultId,
          type: userNotifications.type,
          status: userNotifications.status,
          deliveryAttempts: userNotifications.deliveryAttempts,
          lastAttemptAt: userNotifications.lastAttemptAt,
          failureReason: userNotifications.failureReason,
          createdAt: userNotifications.createdAt,
          // Execution result fields
          resultId: executionResults.id,
          scheduledExecutionId: executionResults.scheduledExecutionId,
          resultData: executionResults.resultData,
          resultStatus: executionResults.status,
          executedAt: executionResults.executedAt,
          executionDurationMs: executionResults.executionDurationMs,
          resultErrorMessage: executionResults.errorMessage,
          // Scheduled execution fields
          scheduleName: scheduledExecutions.name,
          // Assistant architect fields
          assistantArchitectName: assistantArchitects.name,
        })
        .from(userNotifications)
        .leftJoin(
          executionResults,
          eq(userNotifications.executionResultId, executionResults.id)
        )
        .leftJoin(
          scheduledExecutions,
          eq(executionResults.scheduledExecutionId, scheduledExecutions.id)
        )
        .leftJoin(
          assistantArchitects,
          eq(scheduledExecutions.assistantArchitectId, assistantArchitects.id)
        )
        .where(and(...conditions))
        .orderBy(desc(userNotifications.createdAt))
        .limit(limit)
        .offset(offset),
    "getUserNotifications"
  );
}

/**
 * Mark a notification as read
 * Verifies the notification belongs to the user before updating
 */
export async function markNotificationAsRead(
  notificationId: number,
  userId: number
) {
  const result = await executeQuery(
    (db) =>
      db
        .update(userNotifications)
        .set({
          status: "read",
          lastAttemptAt: sql`NOW()`,
        })
        .where(
          and(
            eq(userNotifications.id, notificationId),
            eq(userNotifications.userId, userId),
            sql`${userNotifications.status} != 'read'`
          )
        )
        .returning({ id: userNotifications.id, status: userNotifications.status }),
    "markNotificationAsRead"
  );
  return result[0];
}

/**
 * Mark all notifications as read for a user
 */
export async function markAllNotificationsAsRead(userId: number) {
  return executeQuery(
    (db) =>
      db
        .update(userNotifications)
        .set({ status: "read" })
        .where(
          and(
            eq(userNotifications.userId, userId),
            inArray(userNotifications.status, ["sent", "delivered"])
          )
        )
        .returning({ id: userNotifications.id }),
    "markAllNotificationsAsRead"
  );
}

/**
 * Get notification by ID
 */
export async function getNotificationById(notificationId: number) {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(userNotifications)
        .where(eq(userNotifications.id, notificationId))
        .limit(1),
    "getNotificationById"
  );
  return result[0];
}
