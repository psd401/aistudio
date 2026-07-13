/**
 * Atrium content audit (best-effort, append-only)
 *
 * Issue #1055 (Epic #1059, Atrium Phase 5 — Agent access). Writes one
 * `content_audit_logs` row per MCP/REST content mutation (§27). Derives the
 * actor fields (human vs agent) from the `Requester` so the trail is uniform
 * across surfaces.
 *
 * Best-effort by design: an audit-write failure MUST NOT break the request (the
 * mutation already committed), but sustained failures silently dropping
 * compliance records need to be alarmable — so we count and log them, mirroring
 * `connector-service.logToolCall`.
 */

import { executeQuery } from "@/lib/db/drizzle-client";
import { contentAuditLogs, type ContentAuditDetails } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import { actorKindOf, agentIdOf, authorUserIdOf } from "./helpers";
import type { PublishDestination } from "./publish-adapters/types";
import type { Requester } from "./types";

export type ContentAuditAction =
  | "create"
  | "update"
  | "create_version"
  | "set_visibility"
  | "publish"
  | "unpublish"
  // Hard delete (Epic #1059 follow-up). The object row disappears, so the delete
  // audit carries the removed object's identity in `details` (see below).
  | "delete"
  // OKF interoperability (Phase 8, #1103, §36.4). `export_okf` serializes a
  // collection to a portable bundle; `import_okf` writes a bundle into content.
  | "export_okf"
  | "import_okf";

/**
 * The surface the mutation arrived on. `ui` is a human acting through an in-app
 * server action (e.g. the Meridian delete affordance); `mcp`/`rest` are the
 * programmatic agent surfaces. The DB column is a plain varchar (not a pgEnum),
 * so widening this union is a code-only change.
 */
export type ContentAuditSurface = "mcp" | "rest" | "ui";
export type ContentAuditOutcome = "ok" | "error" | "approval_required";

export interface ContentAuditEntry {
  /** The caller, used to derive actor kind / user / agent. */
  req: Requester;
  action: ContentAuditAction;
  surface: ContentAuditSurface;
  /** The object acted on; null for a create that never produced an id. */
  objectId?: string | null;
  /** Set for publish/unpublish actions. */
  destination?: PublishDestination | null;
  outcome: ContentAuditOutcome;
  /** A short error message when `outcome !== "ok"`. */
  error?: string | null;
  /**
   * Structured, action-specific context. For a `delete` this records the removed
   * object's identity (`{ title, kind, ownerUserId, versionsDeleted }`) captured
   * before the row disappeared — the only durable record of what was deleted.
   */
  details?: ContentAuditDetails | null;
  requestId?: string | null;
}

/**
 * Build the `content_audit_logs` INSERT values for one audit entry. Pure (no IO),
 * so it is shared by the best-effort `recordContentAudit` AND the delete path,
 * which writes its audit row INSIDE the delete transaction (`tx.insert(...)`) so
 * the record and the removal commit atomically — no delete without an audit trail.
 */
export function contentAuditInsertValues(
  entry: ContentAuditEntry
): typeof contentAuditLogs.$inferInsert {
  const { req } = entry;
  return {
    objectId: entry.objectId ?? null,
    action: entry.action,
    surface: entry.surface,
    actorKind: actorKindOf(req),
    actorUserId: authorUserIdOf(req),
    agentId: agentIdOf(req),
    agentLabel: req.kind === "user" ? null : req.agentLabel,
    destination: entry.destination ?? null,
    outcome: entry.outcome,
    error: truncateError(entry.error),
    details: entry.details ?? null,
    requestId: entry.requestId ?? null,
  };
}

let auditFailureCount = 0;

/** Cap an error message so a runaway stack trace cannot bloat the audit row. */
function truncateError(error: string | null | undefined): string | null {
  if (!error) return null;
  return error.length > 2000 ? `${error.slice(0, 2000)}…` : error;
}

/**
 * Append a content-mutation audit row. Never throws — failures are logged and
 * counted, not propagated.
 */
export async function recordContentAudit(entry: ContentAuditEntry): Promise<void> {
  const log = createLogger({
    requestId: entry.requestId ?? undefined,
    action: "content.audit",
  });

  try {
    await executeQuery(
      (db) => db.insert(contentAuditLogs).values(contentAuditInsertValues(entry)),
      "recordContentAudit"
    );
  } catch (err) {
    auditFailureCount++;
    log.error("Failed to write content audit log", {
      error: err instanceof Error ? err.message : String(err),
      auditFailureCount,
      action: entry.action,
      surface: entry.surface,
      objectId: entry.objectId ?? null,
    });
  }
}
