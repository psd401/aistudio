"use server"

/**
 * Atrium content-audit viewer server action (Epic #1059 completion)
 *
 * Read-only, admin-gated window over `content_audit_logs` (migration 090) — the
 * append-only trail every MCP/REST content mutation writes (§27). Until now the
 * table had no viewer; this action backs the Audit tab of /admin/atrium.
 *
 * Newest-first, fixed page size of 50, filterable by action / surface / outcome
 * (exact match against the row's varchar columns) and a free-text object-id
 * filter: a full UUID matches exactly, any other text matches as a
 * case-insensitive substring of the id (so a pasted id fragment still finds the
 * trail).
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import {
  createSuccess,
  handleError,
  ErrorFactories,
} from "@/lib/error-utils";
import { executeQuery } from "@/lib/db/drizzle-client";
import { contentAuditLogs } from "@/lib/db/schema";
import type { ActionState } from "@/types";
import { getUserRequester } from "./requester";

// NOT exported: a "use server" module may only export async functions; the
// value travels to the client in the response's `pageSize` field instead.
const CONTENT_AUDIT_PAGE_SIZE = 50;

export interface ContentAuditFilter {
  /** Exact match on the audit `action` (create | publish | …). */
  action?: string;
  /** Exact match on the surface (mcp | rest). */
  surface?: string;
  /** Exact match on the outcome (ok | error | approval_required). */
  outcome?: string;
  /** Full UUID (exact) or id fragment (substring) of the object. */
  objectId?: string;
  /** 1-based page number; defaults to 1. */
  page?: number;
}

export interface ContentAuditRowDTO {
  id: string;
  objectId: string | null;
  action: string;
  surface: string;
  actorKind: "human" | "agent";
  actorUserId: number | null;
  agentLabel: string | null;
  destination: string | null;
  outcome: string;
  error: string | null;
  requestId: string | null;
  createdAt: string | null;
}

export interface ContentAuditPage {
  rows: ContentAuditRowDTO[];
  total: number;
  page: number;
  pageSize: number;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Build the WHERE clause for one filter set (undefined = unfiltered). */
function buildAuditWhere(filter: ContentAuditFilter) {
  const conditions = [];
  if (filter.action?.trim()) {
    conditions.push(eq(contentAuditLogs.action, filter.action.trim()));
  }
  if (filter.surface?.trim()) {
    conditions.push(eq(contentAuditLogs.surface, filter.surface.trim()));
  }
  if (filter.outcome?.trim()) {
    conditions.push(eq(contentAuditLogs.outcome, filter.outcome.trim()));
  }
  const objectQuery = filter.objectId?.trim();
  if (objectQuery) {
    if (UUID_RE.test(objectQuery)) {
      conditions.push(eq(contentAuditLogs.objectId, objectQuery));
    } else {
      // Substring match against the uuid's text form. Escape LIKE wildcards
      // so a pasted `%`/`_` is treated literally (drizzle parameterizes the
      // value itself, so there is no injection surface here).
      const escaped = objectQuery.replace(/[\\%_]/g, (m) => `\\${m}`);
      conditions.push(
        sql`${contentAuditLogs.objectId}::text ILIKE ${`%${escaped}%`}`
      );
    }
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/**
 * List a page of the content audit trail (admin only), newest first.
 */
export async function listContentAuditAction(
  filter: ContentAuditFilter = {}
): Promise<ActionState<ContentAuditPage>> {
  const requestId = generateRequestId();
  const timer = startTimer("listContentAuditAction");
  const log = createLogger({ requestId, action: "listContentAuditAction" });

  try {
    const requester = await getUserRequester(requestId);
    if (requester.kind !== "user" || !requester.isAdmin) {
      throw ErrorFactories.authzAdminRequired("listContentAudit");
    }

    const where = buildAuditWhere(filter);

    const page = Math.max(1, Math.floor(filter.page ?? 1));
    const offset = (page - 1) * CONTENT_AUDIT_PAGE_SIZE;

    // Two independent pooled reads (rows + total) — safe to run in parallel
    // because neither is inside a transaction.
    const [rows, totalRows] = await Promise.all([
      executeQuery(
        (db) =>
          db
            .select()
            .from(contentAuditLogs)
            .where(where)
            .orderBy(desc(contentAuditLogs.createdAt))
            .limit(CONTENT_AUDIT_PAGE_SIZE)
            .offset(offset),
        "atrium.audit.listPage"
      ),
      executeQuery(
        (db) =>
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(contentAuditLogs)
            .where(where),
        "atrium.audit.countPage"
      ),
    ]);

    const data: ContentAuditPage = {
      rows: rows.map((row) => ({
        id: row.id,
        objectId: row.objectId,
        action: row.action,
        surface: row.surface,
        actorKind: row.actorKind,
        actorUserId: row.actorUserId,
        agentLabel: row.agentLabel,
        destination: row.destination,
        outcome: row.outcome,
        error: row.error,
        requestId: row.requestId,
        createdAt: row.createdAt ? row.createdAt.toISOString() : null,
      })),
      total: Number(totalRows[0]?.count ?? 0),
      page,
      pageSize: CONTENT_AUDIT_PAGE_SIZE,
    };

    timer({ status: "success" });
    log.info("Listed content audit page", {
      page,
      rowCount: data.rows.length,
      total: data.total,
    });
    return createSuccess(data, "Audit log loaded");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to load content audit log", {
      context: "listContentAuditAction",
      requestId,
      operation: "listContentAuditAction",
    });
  }
}
