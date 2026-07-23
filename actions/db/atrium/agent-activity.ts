"use server"

/**
 * Atrium AGENT ACTIVITY feed (Epic #1059 Meridian redesign, slice A)
 *
 * Read-only feed powering the workspace nav column's "AGENT ACTIVITY" panel: the
 * most recent AI-agent mutations on content THE CALLER CAN SEE. It reuses the
 * append-only `content_audit_logs` trail (migration 090) — no new schema.
 *
 * SECURITY — visibility gate: audit rows reference object ids the caller may not
 * be allowed to view, so surfacing them raw would leak the existence of hidden
 * objects. Instead of duplicating the visibility SQL (which `visibility-service`
 * warns must stay in lockstep with `canView`), we first resolve the caller's
 * visible objects through the vetted `contentService.list` path and restrict the
 * audit query to exactly those ids. A row is shown only for an object already
 * proven viewable; the feed can never over-show.
 *
 * The `IN (visibleIds)` set is capped at the caller's most-recently-updated
 * objects (VISIBLE_SCAN_LIMIT). Agent activity older than that window is not
 * surfaced in this glanceable sidebar — an acceptable, always-safe bound.
 */

import { and, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger";
import { createSuccess, handleError } from "@/lib/error-utils";
import { executeQuery } from "@/lib/db/drizzle-client";
import { contentAuditLogs } from "@/lib/db/schema";
import { contentService } from "@/lib/content";
import type { ActionState } from "@/types";
import { getOptionalRequester } from "./requester";

/** How many of the caller's most-recent visible objects bound the audit scan. */
const VISIBLE_SCAN_LIMIT = 200;
/** Default number of activity rows returned. */
const DEFAULT_ACTIVITY_LIMIT = 8;
/** Hard cap so a caller-supplied limit can't request an unbounded page. */
const MAX_ACTIVITY_LIMIT = 25;

/**
 * Agent actions worth surfacing as "activity" (edits/creations/publishes).
 * Excludes read-only / administrative actions (set_visibility, export/import).
 */
const ACTIVITY_ACTIONS = [
  "create",
  "update",
  "create_version",
  "publish",
] as const;

export interface AgentActivityItemDTO {
  /** Audit row id (stable list key). */
  id: string;
  /** The affected content object (always viewable by the caller). */
  objectId: string;
  /** The object's current title, for the feed label. */
  title: string;
  /** The object kind, so the feed can link to the right surface. */
  kind: "document" | "artifact";
  /** Which agent action occurred (create | update | create_version | publish). */
  action: string;
  /** Human-readable agent label when the audit row carried one. */
  agentLabel: string | null;
  /** ISO-8601 timestamp of the action (newest first). */
  createdAt: string | null;
}

/**
 * List the most recent AI-agent mutations on content the caller can view.
 * Newest first. Returns `[]` (never an error) when there is no visible content
 * or no agent activity yet — the panel renders a quiet empty state.
 */
export async function listAgentActivityAction(
  limit: number = DEFAULT_ACTIVITY_LIMIT
): Promise<ActionState<AgentActivityItemDTO[]>> {
  const requestId = generateRequestId();
  const timer = startTimer("listAgentActivityAction");
  const log = createLogger({ requestId, action: "listAgentActivityAction" });

  try {
    const safeLimit = Math.min(
      MAX_ACTIVITY_LIMIT,
      Math.max(1, Math.floor(Number.isFinite(limit) ? limit : DEFAULT_ACTIVITY_LIMIT))
    );

    // 1) Resolve the caller's visible objects through the vetted permission path.
    const requester = await getOptionalRequester(requestId);
    const visible = await contentService.list(requester, {
      limit: VISIBLE_SCAN_LIMIT,
    });
    if (visible.length === 0) {
      timer({ status: "success" });
      return createSuccess([], "No visible content");
    }

    const titleById = new Map(visible.map((o) => [o.id, o]));
    const visibleIds = visible.map((o) => o.id);

    // 2) Fetch recent agent audit rows restricted to those ids.
    const rows = await executeQuery(
      (db) =>
        db
          .select({
            id: contentAuditLogs.id,
            objectId: contentAuditLogs.objectId,
            action: contentAuditLogs.action,
            agentLabel: contentAuditLogs.agentLabel,
            createdAt: contentAuditLogs.createdAt,
          })
          .from(contentAuditLogs)
          .where(
            and(
              // Any AI-agent action, whether autonomous or delegated. A delegated
              // agent (REST/MCP token acting for a user) records provenance as the
              // human it acts for — `actorKind = 'human'` — but still carries an
              // `agent_label`; only pure-human actions have a null label. Filtering
              // on `actorKind = 'agent'` alone would drop the entire common
              // delegated-agent path from the feed.
              or(
                eq(contentAuditLogs.actorKind, "agent"),
                isNotNull(contentAuditLogs.agentLabel)
              ),
              eq(contentAuditLogs.outcome, "ok"),
              inArray(contentAuditLogs.action, [...ACTIVITY_ACTIONS]),
              inArray(contentAuditLogs.objectId, visibleIds)
            )
          )
          .orderBy(desc(contentAuditLogs.createdAt))
          .limit(safeLimit),
      "atrium.agentActivity.list"
    );

    const items: AgentActivityItemDTO[] = [];
    for (const row of rows) {
      if (!row.objectId) continue;
      const obj = titleById.get(row.objectId);
      if (!obj) continue; // defensive: only viewable objects (already guaranteed)
      items.push({
        id: row.id,
        objectId: row.objectId,
        title: obj.title,
        kind: obj.kind,
        action: row.action,
        agentLabel: row.agentLabel,
        createdAt: row.createdAt ? row.createdAt.toISOString() : null,
      });
    }

    timer({ status: "success" });
    log.info("Listed agent activity", { count: items.length });
    return createSuccess(items, "Agent activity loaded");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to load agent activity", {
      context: "listAgentActivityAction",
      requestId,
      operation: "listAgentActivityAction",
    });
  }
}
