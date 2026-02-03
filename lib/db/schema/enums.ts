/**
 * Drizzle ORM PostgreSQL Enum Definitions
 *
 * Generated from live database introspection via MCP tools.
 * Source: PostgreSQL information_schema + pg_type/pg_enum queries
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #528 - Generate Drizzle schema from live database
 *
 * DO NOT EDIT manually - regenerate from database if schema changes.
 * @see https://orm.drizzle.team/docs/column-types/pg#enum
 */

import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Assistant Architect event types for execution tracking
 * Used in: assistant_architect_events.event_type
 */
export const assistantEventTypeEnum = pgEnum("assistant_event_type", [
  "execution-start",
  "execution-complete",
  "execution-error",
  "prompt-start",
  "prompt-complete",
  "variable-substitution",
  "knowledge-retrieval-start",
  "knowledge-retrieved",
  "tool-execution-start",
  "tool-execution-complete",
  "progress",
]);

/**
 * Execution status for tool executions and prompt results
 * Used in: tool_executions.status, prompt_results.status
 */
export const executionStatusEnum = pgEnum("execution_status", [
  "pending",
  "running",
  "completed",
  "failed",
]);

/**
 * Field types for tool input fields
 * Used in: tool_input_fields.field_type
 */
export const fieldTypeEnum = pgEnum("field_type", [
  "short_text",
  "long_text",
  "select",
  "multi_select",
  "file_upload",
]);

/**
 * Job status for async jobs and AI streaming jobs
 * Used in: jobs.status, ai_streaming_jobs.status
 */
export const jobStatusEnum = pgEnum("job_status", [
  "pending",
  "running",
  "completed",
  "failed",
]);

/**
 * Navigation item types for the navigation system
 * Used in: navigation_items.type
 */
export const navigationTypeEnum = pgEnum("navigation_type", [
  "link",
  "section",
  "page",
]);

/**
 * Tool status for assistant architects
 * Used in: assistant_architects.status
 */
export const toolStatusEnum = pgEnum("tool_status", [
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "disabled",
]);
