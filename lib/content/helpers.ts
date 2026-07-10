/**
 * Atrium content service helpers
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0). Small helpers used across the
 * content services. Almost all are side-effect-free (they unit-test without a
 * database); the one exception is the §26.4 approval-queue pair at the bottom
 * (`raisePublishApprovalRequired` + `persistPublishApprovalRequest`), which
 * best-effort-writes the durable `content_publish_requests` row — the DB access
 * mirrors `./audit.ts` (`recordContentAudit`), the other best-effort writer in
 * this layer.
 *
 * See docs/features/atrium-design-spec.md §11 / §26.3 / §26.4.
 */

import { executeQuery } from "@/lib/db/drizzle-client";
import {
  contentPublishRequests,
  type ContentPublishRequestContext,
  type ContentPublishRequestKind,
} from "@/lib/db/schema";
import { ErrorFactories } from "@/lib/error-utils";
import { createLogger } from "@/lib/logger";
import { ApprovalRequiredError, ForbiddenError } from "./errors";
import { contentEvents } from "./events";
import {
  isPublicDestination,
  type PublishDestination,
} from "./publish-adapters/types";
import type { Principal, Requester } from "./types";

/**
 * The configured system user id that owns autonomous-agent content (§26.5), or
 * `null` when unset/invalid. Use this on read/permission paths where a missing
 * config should deny rather than throw.
 */
export function systemUserIdOrNull(): number | null {
  const id = Number(process.env.ATRIUM_SYSTEM_USER_ID);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * The configured system user id that owns autonomous-agent content (§26.5).
 * Throws a system *configuration* error (HTTP 500) when unset/invalid: a missing
 * server-side env var is an operator misconfiguration, not bad client input, so
 * it must not surface to callers as a 400. Use on the write path.
 */
export function systemUserId(): number {
  const id = systemUserIdOrNull();
  if (id == null) {
    throw ErrorFactories.sysConfigurationError(
      "ATRIUM_SYSTEM_USER_ID must be configured for autonomous-agent content"
    );
  }
  return id;
}

/**
 * Slugify a title into a URL-safe, lowercase, hyphenated string capped at the
 * `content_objects.slug` column length (200). Returns "untitled" for input that
 * reduces to empty (e.g. all punctuation), so a slug is always non-empty.
 */
export function slugifyTitle(title: string): string {
  const base = title
    .normalize("NFKD")
    // Strip combining marks (accents) without relying on \p escapes.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200)
    // A trailing hyphen can reappear after the slice; strip it.
    .replace(/-+$/g, "");
  return base || "untitled";
}

/**
 * Compose a candidate slug for a given attempt number. Attempt 0 is the bare
 * slug; later attempts append `-{n}` while staying within the 200-char cap.
 */
export function slugCandidate(base: string, attempt: number): string {
  if (attempt <= 0) return base;
  const suffix = `-${attempt}`;
  const room = 200 - suffix.length;
  return `${base.slice(0, room).replace(/-+$/g, "")}${suffix}`;
}

/**
 * The actor kind a requester writes as.
 *
 * Only an *autonomous* agent records as `'agent'` — it has a stable
 * `agent_identities` id (`agentIdOf`) and no human principal. A *delegated*
 * agent acts on behalf of a human (its `author_user_id` is that human, via
 * `authorUserIdOf`) and has no agent-identity id, so it records as `'human'`.
 * This keeps the invariant `actor === 'agent'` ⟺ `author_agent_id IS NOT NULL`,
 * which downstream provenance/audit queries rely on; the prior mapping recorded
 * delegated writes as `'agent'` with a null `author_agent_id`.
 */
export function actorKindOf(req: Requester): "human" | "agent" {
  return req.kind === "agent-autonomous" ? "agent" : "human";
}

/**
 * Whether the requester is a MACHINE writer (autonomous OR delegated), regardless
 * of how the content is ATTRIBUTED. This is deliberately distinct from
 * `actorKindOf`: a delegated agent records provenance as the human it acts for
 * (`actorKindOf → 'human'`), but it is still an agent generating content, so
 * content-safety screening (§28.3) must apply to it. Screening keys off machine
 * authorship, not provenance attribution — a human typing in the editor is never
 * screened, but any agent-authored write (autonomous or delegated) is.
 */
export function isAgentRequester(req: Requester): boolean {
  return req.kind === "agent-autonomous" || req.kind === "agent-delegated";
}

/** The autonomous agent identity id for a requester, or null. */
export function agentIdOf(req: Requester): string | null {
  return req.kind === "agent-autonomous" ? req.agentId : null;
}

/** The author user id a version should record for this requester, or null. */
export function authorUserIdOf(req: Requester): number | null {
  if (req.kind === "user") return req.userId;
  if (req.kind === "agent-delegated") return req.actingForUserId;
  return null;
}

/** The scopes a requester holds (users hold none — they are capability-gated). */
export function scopesOf(req: Requester): string[] {
  return req.kind === "user" ? [] : req.scopes;
}

/**
 * Reduce a requester to the principal attributes `canView` / `list` evaluate.
 * Autonomous agents have no user id; their access is role-driven.
 */
export function principalOf(req: Requester): Principal {
  switch (req.kind) {
    case "user":
      return {
        // A guest user requester carries a null userId; the Principal model uses
        // `undefined` for "no user", and canView treats both identically.
        userId: req.userId ?? undefined,
        roles: req.roles,
        building: req.building,
        department: req.department,
        gradeLevels: req.gradeLevels,
        isAdmin: req.isAdmin,
      };
    case "agent-delegated":
      return {
        userId: req.actingForUserId,
        roles: req.roles,
        building: req.building,
        department: req.department,
        gradeLevels: req.gradeLevels,
        // A delegated agent never exceeds the human; admin is not inferred here.
        isAdmin: false,
      };
    case "agent-autonomous":
      return {
        userId: undefined,
        roles: req.roles,
        building: null,
        department: null,
        gradeLevels: null,
        isAdmin: false,
      };
  }
}

/**
 * §26.3 — every non-user caller must hold `content:create`. UI users are gated by
 * the feature capability at the surface, not here.
 */
export function assertCanCreate(req: Requester): void {
  if (req.kind === "user") return;
  if (!req.scopes.includes("content:create")) {
    throw new ForbiddenError("content:create scope required", {
      agentLabel: req.agentLabel,
    });
  }
}

/**
 * Whether a requester may edit an object's body/metadata: the owner, an admin,
 * or a delegated agent acting for the owner. Requires the `content:update` scope
 * for any agent caller.
 *
 * Autonomous agents have no `userId` (their access is role-driven), so the
 * owner-equality branch can never fire for them; they own content via the
 * configured system user, so their ownership is checked explicitly against
 * `systemUserId()`.
 */
export function canEdit(req: Requester, ownerUserId: number): boolean {
  const principal = principalOf(req);
  if (principal.isAdmin) return true;

  if (req.kind === "agent-autonomous") {
    // Owns via the system user; must also hold the update scope. A missing
    // system-user config denies rather than throws (read/permission path).
    const sysId = systemUserIdOrNull();
    return (
      sysId != null &&
      ownerUserId === sysId &&
      scopesOf(req).includes("content:update")
    );
  }

  if (principal.userId != null && principal.userId === ownerUserId) {
    if (req.kind === "user") return true;
    // Delegated agents additionally need the update scope.
    return scopesOf(req).includes("content:update");
  }
  return false;
}

/** Throw `ForbiddenError` unless the requester may edit the object. */
export function assertCanEdit(req: Requester, ownerUserId: number): void {
  if (!canEdit(req, ownerUserId)) {
    throw new ForbiddenError("Not permitted to edit this content");
  }
}

/**
 * §26.4 — only humans (admins or holders of the `content.publish_public`
 * capability) and delegated agents the human granted `content:publish_public`
 * may publish publicly. Autonomous agents never hold it. Phase 0 exposes this
 * predicate for the contract; the publish service that uses it lands in Phase 5/7.
 */
/**
 * The §26.4 authority check: may this requester publish/expose content publicly?
 *
 * NOTE `hasPublishPublicCapability` is consulted ONLY for `user`-kind requesters
 * (a human whose capability the surface resolved from their role). The other kinds
 * derive their own authority and IGNORE the parameter:
 *  - `agent-delegated` re-reads `content:publish_public` from its OWN token scopes
 *    (so a delegated agent can never exceed what its token was granted, regardless
 *    of what a surface computed), and
 *  - `agent-autonomous` can NEVER publish public (returns false unconditionally).
 * Call sites compute the boolean uniformly for all kinds for simplicity; it is
 * authoritative only for the `user` branch. Do NOT assume it gates the others.
 */
export function canPublishPublic(
  req: Requester,
  hasPublishPublicCapability: boolean
): boolean {
  if (req.kind === "user") return req.isAdmin || hasPublishPublicCapability;
  if (req.kind === "agent-delegated")
    return req.scopes.includes("content:publish_public");
  return false;
}

/**
 * Whether an authenticated API/MCP caller's token scopes include the EXPLICIT
 * `content:publish_public` scope — the value the REST/MCP surfaces pass to the
 * service's §26.4 gate as `hasPublishPublicCapability`.
 *
 * Every content REST route and MCP handler that resolves this authority computes
 * the same `scopes.includes("content:publish_public")`; this is the single point
 * of truth so the scope string is not hand-typed at ~7 call sites. A typo at a
 * call site would fail CLOSED (the scope would never be recognized, so an
 * authorized caller is wrongly gated), which is safe but a silent, hard-to-spot
 * bug — centralizing the literal removes that whole class of drift. A `.includes`
 * over the exact string, so a session wildcard `["*"]` deliberately does NOT
 * match: only an explicitly-granted `content:publish_public` scope passes (admins
 * still pass via `req.isAdmin` inside the service).
 */
export function hasPublishPublicScope(
  scopes: string[] | null | undefined
): boolean {
  // Null-safe: every call site passes a real `string[]` (auth/MCP `scopes`), but
  // accepting null/undefined defensively means a malformed auth context can never
  // turn this authority check into a runtime crash — it simply denies.
  return scopes?.includes("content:publish_public") ?? false;
}

/**
 * §26.4 — emit the approval-queue signal and throw `ApprovalRequiredError` for an
 * unauthorized public exposure. Shared by every §26.4 gate site (`publishService`'s
 * pre-tx destination check + in-tx visibility-widen check, and
 * `visibilityService.setLevel`'s in-tx widen check) so the emitted event shape and
 * fail-closed behavior stay identical everywhere this security boundary is
 * enforced — a future gate site cannot drift by hand-rolling its own emit-then-throw.
 *
 * `eventPayload`/`errorContext` are passed through as-is (rather than derived from
 * a single shape) because callers intentionally differ: `publishService` includes
 * `slug`/`destination` in the emitted event (readable in the approval-queue UI)
 * but only `destination`/`objectId` in the thrown error's `details`, while
 * `visibilityService.setLevel` has no destination concept and passes `objectId`
 * alone to both.
 *
 * `void` emit is fire-and-forget (best-effort; `emit` swallows its own errors and
 * never rejects), safe even right before a throw — including inside a
 * transaction, where the throw rolls the tx back.
 */
export function raisePublishApprovalRequired(
  req: Requester,
  message: string,
  eventPayload: {
    objectId: string;
    slug?: string;
    destination?: PublishDestination;
  },
  errorContext: Record<string, unknown>
): never {
  // Durable queue row (content_publish_requests, migration 096) — what the
  // /admin/atrium approvals page lists and replays. Fire-and-forget by
  // NECESSITY, not convenience:
  //  - This function's contract is a SYNCHRONOUS `never` — no call site awaits
  //    it. Making it async would turn the throw into a rejected promise the gate
  //    sites never surface: a silent §26.4 bypass.
  //  - Two gate sites raise INSIDE an executeTransaction holding the content row
  //    FOR UPDATE. The insert runs on its OWN pooled connection (executeQuery),
  //    so the tx rollback caused by this very throw cannot erase the queue row —
  //    but its FK check on content_objects (FOR KEY SHARE) blocks on that FOR
  //    UPDATE lock. Awaiting here would deadlock (tx waits on insert, insert
  //    waits on tx's lock); fire-and-forget lets the throw roll the tx back,
  //    releasing the lock, after which the insert proceeds.
  //  - Best-effort: `persistPublishApprovalRequest` NEVER rejects (it log.warns
  //    internally), and the ApprovalRequiredError below is thrown regardless —
  //    a DB hiccup must never mask the security gate.
  void persistPublishApprovalRequest(req, eventPayload, errorContext);
  void contentEvents.emit("content.public_publish_requested", {
    ...eventPayload,
    actorKind: actorKindOf(req),
    agentLabel: req.kind === "user" ? null : req.agentLabel,
  });
  throw new ApprovalRequiredError(message, errorContext);
}

/** The `content_publish_requests` columns derived from one §26.4 raise. */
export interface PublishApprovalRequestFields {
  objectId: string | null;
  requestKind: ContentPublishRequestKind;
  destination: string;
  context: ContentPublishRequestContext;
}

/**
 * Classify a §26.4 raise into a queue row (pure — exported for unit tests).
 * The kind is DERIVED from what each raise site passes (`eventPayload` +
 * `errorContext`); the discriminators are airtight per site:
 *
 * - okf/export.ts (collection exporter): `destination: "okf"` with NO object id
 *   (it raises with `objectId: ""` and `errorContext.collectionId`). → `export`,
 *   object-less, deduped on the collection. (A single-OBJECT publish to the
 *   `okf` destination carries a real objectId and falls through to `publish`.)
 * - publishService UNPUBLISH gate: passes an explicit `errorContext.requestKind
 *   === "unpublish"` (a publish and an unpublish gate carry the same
 *   destination+objectId shape, so the kind cannot be derived). → `unpublish`;
 *   replay = `publishService.unpublish` from that destination.
 * - publishService pre-tx PUBLISH gate: a PUBLIC destination (`isPublicDestination`)
 *   is itself the exposure. → `publish`. The raise-time head is pinned via
 *   `errorContext.versionId` so approve replays the REVIEWED version (issue
 *   #1118); the bundled visibility widen is recorded when the caller also asked
 *   to widen (`errorContext.wantsPublicWiden`).
 * - publishService in-tx PUBLISH gate: reachable only when the destination is NOT
 *   public (a public one throws pre-tx first), so the gated part was the bundled
 *   `visibility.level === "public"` widen — recorded for replay. → `publish` with
 *   `context.visibility` (and the pinned `versionId`).
 * - visibilityService.setLevel gate (and the create-as-private widen queue): no
 *   destination at all; the level being widened to is always `public`. →
 *   `visibility_widen`, destination `'public'` (the exposure target — recorded so
 *   the pending-dedupe key stays 3-column).
 */
export function approvalRequestFieldsOf(
  eventPayload: {
    objectId: string;
    slug?: string;
    destination?: PublishDestination;
  },
  errorContext: Record<string, unknown>
): PublishApprovalRequestFields {
  const { objectId, slug, destination } = eventPayload;
  const explicitKind =
    typeof errorContext.requestKind === "string"
      ? errorContext.requestKind
      : undefined;
  const versionId =
    typeof errorContext.versionId === "string"
      ? errorContext.versionId
      : undefined;
  const wantsPublicWiden = errorContext.wantsPublicWiden === true;

  if (destination === "okf" && !objectId) {
    const collectionId =
      typeof errorContext.collectionId === "string"
        ? errorContext.collectionId
        : undefined;
    return {
      objectId: null,
      requestKind: "export",
      destination: "okf",
      context: {
        ...(collectionId ? { collectionId } : {}),
        audience: "public",
      },
    };
  }

  // Unpublish is object+destination-shaped just like publish, so it MUST be
  // flagged explicitly by the raise site rather than derived.
  if (explicitKind === "unpublish" && destination) {
    return {
      objectId,
      requestKind: "unpublish",
      destination,
      context: { destination },
    };
  }

  if (destination) {
    // Record the visibility widen when the caller bundled one (in-tx gate, or a
    // public destination whose caller ALSO asked to widen) — a non-public
    // destination only ever reaches the gate via the widen, so it always records.
    const recordWiden = wantsPublicWiden || !isPublicDestination(destination);
    return {
      objectId,
      requestKind: "publish",
      destination,
      context: {
        destination,
        ...(slug ? { slug } : {}),
        ...(versionId ? { versionId } : {}),
        ...(recordWiden ? { visibility: { level: "public" as const } } : {}),
      },
    };
  }

  return {
    objectId,
    requestKind: "visibility_widen",
    destination: "public",
    context: { level: "public" },
  };
}

/**
 * Best-effort durable write of one §26.4 approval-queue row. NEVER rejects — a
 * failure is log.warned so the caller's throw (the actual gate) is unaffected.
 * `ON CONFLICT DO NOTHING` against the pending-dedupe partial indexes
 * (migration 096) collapses repeats of the same blocked request (agents retry)
 * into the one open row.
 */
export async function persistPublishApprovalRequest(
  req: Requester,
  eventPayload: {
    objectId: string;
    slug?: string;
    destination?: PublishDestination;
  },
  errorContext: Record<string, unknown>
): Promise<void> {
  const log = createLogger({ action: "content.publishApprovalRequest" });
  try {
    const fields = approvalRequestFieldsOf(eventPayload, errorContext);
    await executeQuery(
      (db) =>
        db
          .insert(contentPublishRequests)
          .values({
            objectId: fields.objectId,
            requestKind: fields.requestKind,
            destination: fields.destination,
            context: fields.context,
            requestedByUserId: authorUserIdOf(req),
            requestedByAgentId: agentIdOf(req),
            requesterLabel: req.kind === "user" ? null : req.agentLabel,
          })
          .onConflictDoNothing(),
      "content.publishApprovalRequest"
    );
  } catch (error) {
    log.warn("Failed to persist publish approval request", {
      objectId: eventPayload.objectId || null,
      destination: eventPayload.destination ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
