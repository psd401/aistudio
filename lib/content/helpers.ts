/**
 * Atrium content service helpers (pure functions)
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0). Small, side-effect-free helpers used
 * across the content services. Kept pure so they unit-test without a database.
 *
 * See docs/features/atrium-design-spec.md §11 / §26.3.
 */

import { ErrorFactories } from "@/lib/error-utils";
import { ForbiddenError } from "./errors";
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
