/**
 * Atrium content service types
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0). See docs/features/atrium-design-spec.md §11.1.
 *
 * The `Requester` is the uniform caller context every service method takes so
 * identity and permission checks are identical across surfaces (server actions,
 * REST v1, MCP). Three kinds:
 * - `user`            — a logged-in human (server-action / UI surface).
 * - `agent-delegated` — an agent acting on behalf of a user; inherits exactly that
 *                       user's permissions (Phase 5).
 * - `agent-autonomous`— a service/skill identity with its own role + scopes
 *                       (Phase 5).
 *
 * Phase 0 ships the full type contract but the service implementation focuses on
 * the `user` path (server actions); the agent paths are wired in Phase 5.
 */

import type { SourceRef } from "@/lib/db/schema";

/**
 * A grant value to widen `group` visibility along one dimension. `group` (Epic
 * #1202 Phase 2, #1205) keys on a synced Google Directory group email — see
 * `content-visibility-grants.ts` for the per-kind `grant_value` semantics.
 */
export type GrantKind =
  | "role"
  | "building"
  | "department"
  | "grade"
  | "user"
  | "group";

export interface VisibilityGrant {
  kind: GrantKind;
  value: string;
}

export type VisibilityLevel = "private" | "group" | "internal" | "public";

export type CollectionScope = "district" | "private";
/**
 * `view` = may enter the collection; `create` = may put content in it;
 * `approve` (migration 178) = may clear the publish queue of a collection whose
 * `requiresApproval` flag is set.
 *
 * Must stay in lockstep with the identically-named type on the schema table
 * module — they are structurally compared at the service boundary, so a value
 * added to one and not the other is a compile error rather than a silent
 * divergence.
 */
export type CollectionGrantAccess = "view" | "create" | "approve";

export interface CollectionGrant {
  access: CollectionGrantAccess;
  kind: GrantKind;
  value: string;
}

export interface CreateCollectionInput {
  name: string;
  scope: CollectionScope;
  parentId?: string | null;
  position?: number;
  defaultVisibilityLevel?: VisibilityLevel;
  inheritGrants?: boolean;
  grants?: CollectionGrant[];
}

export interface UpdateCollectionInput {
  name?: string;
  /**
   * Section hero copy (migration 175). `null` clears it.
   *
   * Together with `landingObjectId`, this is the ONLY part of a district
   * collection a non-administrator can change, and only when they hold `create`
   * access to it — see `assertMayManage`. Describing the section you contribute
   * to should not require an administrator; restructuring it still does.
   */
  description?: string | null;
  /** Pinned "start here" object for the landing page; `null` unpins. */
  landingObjectId?: string | null;
  parentId?: string | null;
  position?: number;
  defaultVisibilityLevel?: VisibilityLevel;
  inheritGrants?: boolean;
  grants?: CollectionGrant[];
  /** Section hero image S3 key; `null` clears it (and its alt text). */
  heroImageKey?: string | null;
  /** Alt text for the hero image; `null` clears it. */
  heroImageAlt?: string | null;
  /** Route publishes out of this collection through the approval queue. */
  requiresApproval?: boolean;
  archived?: boolean;
}

export interface CollectionDTO {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  path: string[];
  scope: CollectionScope;
  ownerUserId: number | null;
  ownerName: string | null;
  defaultVisibilityLevel: VisibilityLevel;
  inheritGrants: boolean;
  position: number;
  archivedAt: string | null;
  /** Section hero copy (migration 175), or null. */
  description: string | null;
  /** Pinned "start here" object for the landing page, or null. */
  landingObjectId: string | null;
  /** Section hero image S3 key (migration 178), or null. */
  heroImageKey: string | null;
  /** Alt text for the hero image; null whenever there is no image. */
  heroImageAlt: string | null;
  /**
   * Publishing out of this collection needs approval (migration 178). False
   * everywhere by default — the district-wide policy is unchanged.
   */
  requiresApproval: boolean;
  directContentCount: number;
  subtreeContentCount: number;
  grants: CollectionGrant[];
  selectableForCreate: boolean;
}

export interface VisibilityInput {
  level: VisibilityLevel;
  /** Required (and only meaningful) when `level === "group"`. */
  grants?: VisibilityGrant[];
}

export type ContentKind = "document" | "artifact";
export type BodyFormat = "markdown" | "html" | "jsx";

/**
 * The principal attributes used by `canView` and the permission-pushed `list`.
 * Assembled from the session + DB for users, from the consent token for delegated
 * agents, and from `agent_identities` for autonomous agents.
 */
export interface Principal {
  /** The acting/owning user id; absent for unauthenticated callers. */
  userId?: number;
  roles: string[];
  building?: string | null;
  department?: string | null;
  gradeLevels?: string[] | null;
  /**
   * The synced Google Directory group EMAILS (lowercased) the principal belongs
   * to — the match set for a `group`-kind visibility grant (Epic #1202 Phase 2,
   * #1205). Populated by `principalOf` from the requester's `groups`; always a
   * concrete array (empty for guests / autonomous agents, so a missing membership
   * fails closed rather than throwing).
   */
  groups: string[];
  isAdmin: boolean;
}

export type Requester =
  | {
      kind: "user";
      /**
       * Integer `users.id`, or `null` for an unauthenticated guest. A guest
       * requester carries no userId and no roles, so `canView` admits only
       * `public` content (visibility-service.ts §11.2). Guests reach read
       * actions only; write paths (`ownerFor`, `authorUserIdOf`) reject a null
       * userId rather than silently coercing it.
       */
      userId: number | null;
      roles: string[];
      building?: string | null;
      department?: string | null;
      gradeLevels?: string[] | null;
      /**
       * Synced Google group emails (lowercased) the user belongs to — the match
       * set for `group`-kind grants (#1205). Optional: a resolver that omits it
       * (or a test double) yields no group access via `principalOf`'s `?? []`
       * default, so a missing lookup fails closed. The two production resolvers
       * (`resolveAuthenticatedRequester`, `loadUserContext`) always populate it.
       */
      groups?: string[];
      isAdmin: boolean;
    }
  | {
      kind: "agent-delegated";
      actingForUserId: number;
      roles: string[];
      building?: string | null;
      department?: string | null;
      gradeLevels?: string[] | null;
      /** The human's synced group emails — a delegated agent inherits them (#1205). */
      groups?: string[];
      scopes: string[];
      agentLabel: string;
    }
  | {
      kind: "agent-autonomous";
      agentId: string;
      roleId?: number | null;
      roles: string[];
      scopes: string[];
      agentLabel: string;
    };

export interface CreateObjectInput {
  kind: ContentKind;
  title: string;
  collectionId?: string;
  /** markdown (document) | code (artifact). When omitted, no v1 is created. */
  body?: string;
  bodyFormat?: BodyFormat;
  /** Defaults to the collection's default visibility, else "private". */
  visibility?: VisibilityInput;
  tags?: string[];
  sourceRef?: SourceRef;
  /**
   * Artifact sandbox data-bridge mode (#1705). Defaults to `records` (the column
   * default) when omitted, which is what every non-artifact create wants.
   */
  dataAccess?: ContentDataAccess;
}

/**
 * Which sandbox data-bridge operation an artifact may use (#1705, migration 179).
 *
 * MUTUALLY EXCLUSIVE by design, and the exclusivity is the security control that
 * lets viewer-scoped queries ship without per-artifact review:
 *  - `records` — `AtriumData.submit` / `.list` (the #1516 store). The DEFAULT.
 *  - `query`   — `AtriumData.query`: read-only PSD Data MCP reads executed as the
 *                VIEWER, with the viewer's row-level permissions.
 *  - `none`    — no data bridge operation at all.
 *
 * A single artifact may never hold both `records` and `query`: records are
 * readable by the author out-of-band, so combining them would turn the records
 * table into an exfiltration channel for whatever the viewer can see. See
 * `docs/features/atrium-artifact-data.md` (Locked decisions).
 */
export const CONTENT_DATA_ACCESS_MODES = ["records", "query", "none"] as const;
export type ContentDataAccess = (typeof CONTENT_DATA_ACCESS_MODES)[number];

/**
 * Coerce an unvalidated `data_access` value into the enum, FAILING CLOSED.
 *
 * Every surface that pins a mode into `<ArtifactSandbox>` (#1712) reads the
 * column through some projection, and a projection types it as `string` (see
 * `rowToObjectDTO`) or `unknown`. A value outside the enum — a row predating
 * migration 179 read through a widened column, or a DB enum that has drifted
 * ahead of this union — must never be forwarded verbatim to the sandbox: the
 * pin compares by equality, so an unrecognized string would match no operation
 * on one code path while looking "set" on another. `none` is the safe answer
 * because it permits nothing.
 */
export function normalizeDataAccess(value: unknown): ContentDataAccess {
  return isContentDataAccess(value) ? value : "none";
}

/**
 * The membership test behind `normalizeDataAccess`, as a type predicate.
 *
 * Widening the tuple to `readonly string[]` is what lets an `unknown` be tested
 * against it at all; doing that here, once, keeps the narrowing on the caller's
 * return path derived from the runtime check rather than from asserting the very
 * type the check exists to establish.
 */
function isContentDataAccess(value: unknown): value is ContentDataAccess {
  return (
    typeof value === "string" &&
    (CONTENT_DATA_ACCESS_MODES as readonly string[]).includes(value)
  );
}

/** Metadata-only patch for `update`. Body changes go through versionService.snapshot. */
export interface UpdatePatch {
  title?: string;
  tags?: string[] | null;
  collectionId?: string | null;
  status?: "draft" | "published" | "archived";
  /** Cover-gradient preset key (slice F), or `null` to clear the cover band. */
  coverGradient?: string | null;
  /** Doc emoji icon (slice F), or `null` to clear it. */
  icon?: string | null;
  /** Artifact sandbox data-bridge mode (#1705). Never nullable — see the enum. */
  dataAccess?: ContentDataAccess;
}

export interface ListFilter {
  collectionId?: string;
  /**
   * Restrict to objects in ANY of these collections — the section landing
   * page's "include subsections" mode, where the caller has already resolved the
   * visible subtree (`collectionService.detail().subtreeIds`).
   *
   * This is a convenience over `collectionId`, not a widening: the collection
   * ACCESS predicate still applies independently, so passing a collection the
   * caller cannot enter yields nothing rather than its contents. An empty array
   * matches nothing (never "everything").
   */
  collectionIds?: string[];
  kind?: ContentKind;
  tag?: string;
  /**
   * How `tag` is matched. Defaults to `"exact"` — case-insensitive whole-tag
   * equality, the long-standing behaviour every REST/MCP caller was written
   * against, so this stays the default rather than silently widening their
   * result sets.
   *
   * `"prefix"` matches any tag STARTING WITH the supplied text, which is what
   * the library's tag box passes: typing `psd-staff-` used to collapse the list
   * to "No matches" until the whole tag was typed, because a partially-typed
   * tag equals nothing. Progressive narrowing as you type is the point of the
   * control, so the UI opts in.
   */
  tagMatch?: "exact" | "prefix";
  /**
   * Restrict to objects created by a human or by an agent
   * (`content_objects.created_by_actor`).
   *
   * Object-grain, matching the library card badge: it reflects who CREATED the
   * object, not who authored the version currently at head. An agent-created
   * doc later edited by a human still reads as agent-created here. The
   * per-version truth lives on `content_versions.author_actor` and is surfaced
   * by the provenance footer.
   *
   * Narrowing-only, like `owner` and `filed` — never a visibility rule.
   */
  actor?: "human" | "agent";
  /** Return objects updated at or after this ISO 8601 timestamp. */
  since?: string;
  /**
   * Case-insensitive substring search over the title OR any tag (#1336). The
   * service clamps it to 200 chars and LIKE-escapes `\`/`%`/`_`, so callers pass
   * raw user text. Distinct from `tag`, which is an exact whole-tag match.
   */
  query?: string;
  status?: "draft" | "published" | "archived";
  /**
   * Ownership scope for the "Shared with me" library filter. "shared" narrows to
   * objects the caller can see but does NOT own and that reached them via an
   * explicit grant (group/private visibility) — i.e. content someone shared with
   * them, not the public/internal firehose. It is an ADDITIONAL restriction on
   * top of the visibility gate (it can only narrow results, never widen them), so
   * it is not a visibility rule and needs no `canView` mirroring. Omitted / "all"
   * applies no ownership restriction; a guest (no user id) gets no rows under
   * "shared".
   *
   * "others" is the admin triage counterpart to "mine": everything visible that
   * the caller does NOT own, whatever route it became visible by. It is
   * deliberately broader than "shared" — an admin sees the whole district, and
   * the question they actually need answered is "what is everyone else's?", not
   * "what did someone hand me?". The two are not complements: "shared"
   * additionally requires group/private visibility, so "others" is a superset.
   */
  owner?: "all" | "shared" | "mine" | "others";
  /**
   * Whether the object sits in a collection. "unfiled" is `collection_id IS
   * NULL`; "filed" is its complement. Added for the library home, where an
   * admin's default view was every filed document in the district at once —
   * the things already put away are exactly what the home page should not lead
   * with. Like `owner`, this only ever narrows the authorized set.
   */
  filed?: "any" | "filed" | "unfiled";
  /**
   * Restrict to objects the CALLING USER has favorited (`content_user_favorites`).
   * A favorite grants no visibility of its own — this is an AND on top of the
   * visibility gate, so a favorited object that later became invisible to the
   * caller drops out. A guest has no favorites and gets no rows.
   */
  favorite?: boolean;
  limit?: number;
  offset?: number;
}

/** A serialized content object (timestamps as ISO-8601 strings for surfaces). */
export interface ContentObjectDTO {
  id: string;
  kind: ContentKind;
  title: string;
  slug: string;
  ownerUserId: number;
  /**
   * The owner's display name (full name, or email fallback), for surfaces that
   * show "who owns this" — e.g. the library cards, visible to all viewers.
   *
   * LIST-ONLY PROJECTION: only `visibilityService.listVisible` populates this (via
   * a LEFT JOIN on `users`). Single-object loads (`content-service`) and every
   * other DTO path leave it `null` — it is presentation metadata, never an
   * authorization input (owner permission is always keyed on `ownerUserId`).
   */
  ownerName: string | null;
  /**
   * Whether the CALLING user has starred this object. LIST-ONLY, like
   * `ownerName`: only `visibilityService.listVisible` computes it; every other
   * DTO path leaves it `false`. Presentation state — a favorite confers no
   * access, so this is never an authorization input.
   */
  isFavorite: boolean;
  /**
   * The head version's summary, used as the one-line excerpt on library cards.
   * LIST-ONLY, like `ownerName` and `isFavorite`; null everywhere else, and null
   * for content whose author never wrote one.
   */
  summary: string | null;
  /**
   * How many explicit visibility grants this object carries, so a library card
   * can say "Shared · 3" without naming anyone.
   *
   * A COUNT, deliberately not the grant list. Who an object is shared with is
   * editor-only information (see `getVisibilityAction`) — surfacing the roster
   * on a card would show every grantee the whole roster, which the owner never
   * agreed to. A bare count answers the question the catalogue actually raises
   * ("is this shared, and roughly how widely?") without identifying anyone, and
   * only ever reaches viewers who can already see the object.
   *
   * LIST-ONLY, like `ownerName` / `isFavorite` / `summary`: 0 everywhere else.
   */
  grantCount: number;
  /**
   * A publish request for this object is pending in the approval queue.
   *
   * Derived from `content_publish_requests`, not stored on the object — the
   * queue is the single source of truth for "awaiting review", so there is no
   * second state that can drift out of sync with it.
   *
   * LIST-ONLY: false everywhere else.
   */
  pendingReview: boolean;
  createdByActor: "human" | "agent";
  createdByAgentId: string | null;
  collectionId: string | null;
  visibilityLevel: VisibilityLevel;
  currentVersionId: string | null;
  sourceRef: SourceRef | null;
  tags: string[];
  /**
   * Meridian slice F (migration 103). `coverGradient` is a preset key selecting one
   * of the fixed cover gradients (styles/meridian.css `--mer-grad-cover-*`),
   * or null for no cover band. `icon` is a single emoji shown on the library card /
   * cover tile, or null for the kind's default icon. Both presentation-only.
   */
  coverGradient: string | null;
  icon: string | null;
  /**
   * Which sandbox data-bridge operation this artifact may use (#1705). See
   * `ContentDataAccess`. `records` for every object created before migration 179
   * and for documents (which have no sandbox at all).
   */
  dataAccess: ContentDataAccess;
  status: "draft" | "published" | "archived";
  indexedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** A serialized content version. */
export interface ContentVersionDTO {
  id: string;
  objectId: string;
  versionNumber: number;
  authorActor: "human" | "agent";
  authorUserId: number | null;
  authorAgentId: string | null;
  bodyFormat: BodyFormat;
  bodyLocation: string;
  /**
   * Raw artifact code (HTML/JS/JSX) for small inline artifacts. SECURITY: this
   * is UNTRUSTED code. It must only be displayed in a code editor (CodeMirror)
   * or rendered inside the cross-origin sandboxed iframe (§28.1). Never pass it
   * to `dangerouslySetInnerHTML` and never serve it directly as text/html.
   */
  bodyInline: string | null;
  renderLocation: string | null;
  proofDocRef: string | null;
  summary: string | null;
  createdAt: string | null;
}

export interface ContentObjectWithVersion extends ContentObjectDTO {
  version: ContentVersionDTO | null;
}

/** Input for creating a new version (snapshot) of an existing object. */
export interface SnapshotInput {
  body: string;
  bodyFormat?: BodyFormat;
  summary?: string;
}

/** Exact canonical source for one committed immutable content version. */
export interface ContentSourceDTO {
  objectId: string;
  versionId: string;
  versionNumber: number;
  bodyFormat: BodyFormat;
  body: string;
  /** SHA-256 of the UTF-8 body, encoded as base64url. */
  sha256: string;
}
