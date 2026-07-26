/**
 * Atrium public-publish policy for the IN-APP AUTHORING SURFACE (#1336)
 *
 * Product decision (Hagel, 2026-07-25): **any author may publish publicly — no
 * admin approval gate.** Every non-admin public exposure records an
 * admin-visible notification instead of blocking on a queue.
 *
 * Before #1336 a non-admin who set visibility to Public, or published to
 * `public_web`, silently entered the §26.4 approval queue: the chip flipped,
 * nothing else happened, and no one was notified in either direction. The public
 * URL 404'd until an admin happened to look at /admin/atrium.
 *
 * ## What actually changed, and what did NOT
 *
 * The §26.4 machinery is untouched. The service still evaluates the same gate,
 * in the same place, inside the same transaction against the same FOR-UPDATE
 * locked row — this module only supplies the surface-resolved
 * `hasPublishPublicCapability` input that the service has always accepted for
 * exactly this purpose (it is how the REST/MCP surfaces pass a caller's
 * `content:publish_public` scope through). There is no new write path and no
 * bypass: `canView` → 404-before-403 masking and `assertCanEdit` still run
 * first, so the authority granted here is only ever exercised by an
 * authenticated human who already holds the `atrium-content` capability AND is
 * the object's owner (or an admin).
 *
 * This applies to the AUTHORING SURFACE ONLY. API, MCP, and agent-delegated
 * callers keep the unchanged scope-based gate — an agent still needs an explicit
 * `content:publish_public` scope, and `canPublishPublic` is untouched for them.
 *
 * ## The notification
 *
 * Recorded as a `content_audit_logs` row (surface `ui`), which is exactly what
 * the Audit tab of /admin/atrium already renders — so this needs no migration,
 * no new table, and no new admin UI. Best-effort like every other audit write:
 * the mutation has already committed, and losing the notification must not fail
 * the author's request.
 */

import { createLogger } from "@/lib/logger";
import { recordContentAudit } from "@/lib/content/audit";
import type {
  ContentAuditAction,
  ContentAuditSurface,
} from "@/lib/content/audit";
import type { PublishDestination } from "@/lib/content/publish-adapters/types";
import type { Requester } from "@/lib/content/types";

const log = createLogger({ context: "public-publish-policy" });

/**
 * The authority the in-app authoring actions hand to the §26.4 gate. Always
 * `true` — see the module docblock. A named constant (rather than a bare `true`
 * literal at three call sites) so the policy has one documented home and
 * reverting it is a one-line change.
 */
export const IN_APP_PUBLISH_PUBLIC_CAPABILITY = true;

/**
 * Record the admin-visible notification for a public exposure made by a
 * NON-ADMIN author through the in-app surface. Best-effort and never throws:
 * the caller's mutation has already committed.
 *
 * Admin actions are not recorded here — an admin publishing publicly was always
 * allowed and needs no "an author bypassed the queue" notice.
 */
export async function notifyPublicExposure(args: {
  req: Requester;
  action: Extract<
    ContentAuditAction,
    "publish" | "unpublish" | "set_visibility" | "create"
  >;
  objectId: string;
  destination?: PublishDestination | null;
  /** Short human-readable note stored in the audit row's details. */
  note: string;
  requestId?: string;
}): Promise<void> {
  const { req, action, objectId, destination, note, requestId } = args;
  // Admins already hold the authority; only the newly-granted author path is
  // noteworthy.
  if (req.kind === "user" && req.isAdmin) return;

  const surface: ContentAuditSurface = "ui";
  try {
    await recordContentAudit({
      req,
      action,
      surface,
      objectId,
      destination: destination ?? null,
      outcome: "ok",
      details: { publicExposure: true, note },
      requestId: requestId ?? null,
    });
  } catch (error) {
    // `recordContentAudit` is itself best-effort and swallows its own DB
    // errors, so this should be unreachable — but it is awaited on a path that
    // runs AFTER the publish/visibility change has already committed, so a
    // future change that let it throw would turn a successful mutation into a
    // failed action. Fail closed on the notification, never on the mutation.
    log.error("public-exposure notification failed", {
      objectId,
      action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
