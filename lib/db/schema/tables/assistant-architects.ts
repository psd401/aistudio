/**
 * Assistant Architects Table Schema
 * AI-powered assistants. Two runtime modes (Issue #926, Epic #922 workstream #4):
 *   - `prompt_chain` (default): form inputs -> ordered prompt-template execution
 *     -> text output. No model autonomy. The original behavior, kept unchanged.
 *   - `agentic`: form inputs -> model loop with tool access -> output. The model
 *     decides which tools to call, in what order, until done. Tools are resolved
 *     from the unified tool catalog (#924) + per-user MCP connectors (#774),
 *     intersected with the caller's scopes at execution time.
 */

import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { toolStatusEnum } from "../enums";
import { users } from "./users";

/**
 * Assistant runtime mode. Stored as TEXT with a DB CHECK constraint (migration
 * 082) rather than a pg enum, so adding a future mode needs no enum migration.
 */
export type AssistantArchitectMode = "prompt_chain" | "agentic";

/**
 * Atrium Phase 6 (Issue #1056) retrieval scope: narrows
 * `retrievalService.search` candidates for this assistant before
 * `visibilityService.canView` is enforced per requester (spec §16.4). `null`/
 * unset = unscoped (any published content the requester can view).
 */
export interface AssistantRetrievalScope {
  collectionId?: string | null;
  tags?: string[];
  maxVisibilityLevel?: "private" | "group" | "internal" | "public";
}

export const assistantArchitects = pgTable("assistant_architects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  status: toolStatusEnum("status").default("draft").notNull(),
  isParallel: boolean("is_parallel").default(false).notNull(),
  timeoutSeconds: integer("timeout_seconds"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  imagePath: text("image_path"),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),

  // ── Agentic mode (Issue #926) ──────────────────────────────────────────────
  /** Runtime mode. Defaults to `prompt_chain` for backward compatibility. */
  mode: text("mode").$type<AssistantArchitectMode>().default("prompt_chain").notNull(),
  /**
   * Tool identifiers (catalog `domain.action` form) the author enabled for the
   * agent loop. Resolved against the unified catalog and intersected with the
   * caller's scopes at execution time. Empty for prompt-chain assistants.
   */
  agentEnabledTools: jsonb("agent_enabled_tools")
    .$type<string[]>()
    .default([])
    .notNull(),
  /**
   * MCP connector server IDs (Nexus #774) the author enabled. Per-user tools are
   * resolved from these connectors at execution time (same path as Nexus chat).
   */
  agentEnabledConnectors: jsonb("agent_enabled_connectors")
    .$type<string[]>()
    .default([])
    .notNull(),
  /** Max tool-use round-trips per run (1–50, DB-checked). Prevents runaway loops. */
  agentMaxSteps: integer("agent_max_steps").default(10).notNull(),
  /** Per-run wall-clock limit in seconds (1–900, DB-checked). */
  agentTimeoutSeconds: integer("agent_timeout_seconds").default(300).notNull(),
  /** Per-run cost cap in whole US cents. NULL = no cap. */
  agentCostCapCents: integer("agent_cost_cap_cents"),
  /**
   * Per-ASSISTANT rate limit: max agentic runs of this assistant per rolling hour
   * (separate from any per-user limit). NULL = no per-assistant cap. Author-set;
   * no platform-imposed default (Issue #926).
   */
  agentMaxRequestsPerHour: integer("agent_max_requests_per_hour"),

  // ── Retrieval scoping (Atrium Phase 6, Issue #1056) ────────────────────────
  retrievalScope: jsonb("retrieval_scope").$type<AssistantRetrievalScope>(),
});
