/**
 * User Notifications Table Schema
 * Notification delivery tracking
 */

import {
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { executionResults } from "./execution-results";

export const userNotifications = pgTable("user_notifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  executionResultId: integer("execution_result_id")
    .references(() => executionResults.id)
    .notNull(),
  type: text("type").notNull(),
  status: text("status").notNull(),
  deliveryAttempts: integer("delivery_attempts").default(0),
  lastAttemptAt: timestamp("last_attempt_at"),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at").defaultNow(),
});
