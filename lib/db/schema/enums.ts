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
 *
 * Atrium (Issue #1058) lets a navigation item point at a content object via the
 * `navigation_items.content_object_id` column (migration 085). A dedicated
 * `content` enum value is intentionally NOT added: `ALTER TYPE ... ADD VALUE`
 * needs ownership of this enum, which is owned by `postgres` while migrations run
 * as `master` (fails 42501 on Aurora), and the fail-fast migration runner cannot
 * tolerate that error.
 *
 * RESOLVED (Phase 4, Issue #1054): this is now the FINAL design, not a deferral.
 * Content nav items are identified by `content_object_id IS NOT NULL` and stored
 * with `type='link'` (a content nav item is a link to the reader route). They are
 * EXCLUDED from the global navbar query (`lib/db/drizzle/navigation.ts`) because
 * that surface filters by role/capability, not by the object's `canView`
 * visibility; content is surfaced through the visibility-filtered reader sidebar
 * (`CollectionTree`) instead. See `lib/content/nav-item-service.ts`.
 */
export const navigationTypeEnum = pgEnum("navigation_type", [
  "link",
  "section",
  "page",
]);

// ============================================
// Atrium content workspace (Issue #1058, Epic #1059)
//
// The content layer's enums. See docs/features/atrium-design-spec.md §7.1 / §35.2.
// SQL types are created in migration 085-atrium-content.sql. Keep these value
// lists byte-for-byte identical to the migration so schema-drift detection and
// regeneration stay faithful.
// ============================================

/**
 * Content object kind — the two grains of Atrium content.
 * Used in: content_objects.kind
 */
export const contentKindEnum = pgEnum("content_kind", ["document", "artifact"]);

/**
 * Content lifecycle status.
 * Used in: content_objects.status
 */
export const contentStatusEnum = pgEnum("content_status", [
  "draft",
  "published",
  "archived",
]);

/**
 * Actor kind — every creation/edit is attributed to a human or an agent.
 * Used in: content_objects.created_by_actor, content_versions.author_actor
 */
export const actorKindEnum = pgEnum("actor_kind", ["human", "agent"]);

/**
 * Visibility level — who may consume an object.
 * Used in: content_objects.visibility_level, content_collections.default_visibility_level
 */
export const visibilityLevelEnum = pgEnum("visibility_level", [
  "private",
  "group",
  "internal",
  "public",
]);

/**
 * Grant kind — the dimension a group visibility grant keys on.
 * Used in: content_visibility_grants.grant_kind
 */
export const grantKindEnum = pgEnum("grant_kind", [
  "role",
  "building",
  "department",
  "grade",
  "user",
]);

/**
 * Body format — how a version's body is encoded.
 * Used in: content_versions.body_format
 */
export const bodyFormatEnum = pgEnum("body_format", ["markdown", "html", "jsx"]);

/**
 * Publish destination — where content is surfaced.
 * Used in: content_publications.destination
 *
 * `okf` (Phase 8, Issue #1103, §36) is the Open Knowledge Format export
 * destination — a portable markdown+frontmatter bundle, not a live reader/connector.
 * Added via migration 095 (`ALTER TYPE publish_destination ADD VALUE 'okf'`); the
 * enum is master-owned (created in the 085 Atrium migration), so `ADD VALUE`
 * succeeds under the migration role.
 */
export const publishDestinationEnum = pgEnum("publish_destination", [
  "intranet",
  "public_web",
  "schoology",
  "google",
  "okf",
]);

/**
 * Publication status — the lifecycle of a publication record.
 * Used in: content_publications.status
 */
export const publicationStatusEnum = pgEnum("publication_status", [
  "live",
  "scheduled",
  "unpublished",
  "failed",
]);

/**
 * Agent identity kind — the type of autonomous (non-delegated) agent.
 * Used in: agent_identities.kind
 */
export const agentIdentityKindEnum = pgEnum("agent_identity_kind", [
  "service",
  "skill",
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

// Agent skill scope/scan_status are NOT PostgreSQL enums — they are
// VARCHAR + CHECK constraints (see migration 070). Re-exported constants
// for runtime validation.
export {
  AGENT_SKILL_SCOPES,
  AGENT_SKILL_SCAN_STATUSES,
  type AgentSkillScope,
  type AgentSkillScanStatus,
} from "./tables/agent-skills";
