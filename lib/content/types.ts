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

/** A grant value to widen `group` visibility along one dimension. */
export type GrantKind = "role" | "building" | "department" | "grade" | "user";

export interface VisibilityGrant {
  kind: GrantKind;
  value: string;
}

export type VisibilityLevel = "private" | "group" | "internal" | "public";

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
      isAdmin: boolean;
    }
  | {
      kind: "agent-delegated";
      actingForUserId: number;
      roles: string[];
      building?: string | null;
      department?: string | null;
      gradeLevels?: string[] | null;
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
}

/** Metadata-only patch for `update`. Body changes go through versionService.snapshot. */
export interface UpdatePatch {
  title?: string;
  tags?: string[] | null;
  collectionId?: string | null;
  status?: "draft" | "published" | "archived";
}

export interface ListFilter {
  collectionId?: string;
  kind?: ContentKind;
  tag?: string;
  /**
   * Case-insensitive title substring search. The service clamps it to 200
   * chars and LIKE-escapes `\`/`%`/`_`, so callers pass raw user text.
   */
  query?: string;
  status?: "draft" | "published" | "archived";
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
  createdByActor: "human" | "agent";
  createdByAgentId: string | null;
  collectionId: string | null;
  visibilityLevel: VisibilityLevel;
  currentVersionId: string | null;
  sourceRef: SourceRef | null;
  tags: string[];
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
