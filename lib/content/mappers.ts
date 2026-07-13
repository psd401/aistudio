/**
 * Atrium row -> DTO mappers
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0). Converts Drizzle query rows into the
 * serialized DTOs surfaces return. Timestamp columns selected via
 * `pgTimestampAsText` arrive as JSON-quoted ISO strings, so they are unquoted
 * with `stripJsonQuotes`.
 */

import { pgTimestampAsText, stripJsonQuotes } from "@/lib/db/drizzle-helpers";
import { contentObjects, type SourceRef } from "@/lib/db/schema";
import type {
  BodyFormat,
  ContentKind,
  ContentObjectDTO,
  ContentVersionDTO,
  VisibilityLevel,
} from "./types";

/**
 * Drizzle `.select()` projection for a content object with timestamps rendered
 * as text (so they round-trip through `rowToObjectDTO` -> `ObjectRowAsText`).
 * Shared by `content-service` and `visibility-service.listVisible` so the two
 * projections cannot drift as columns are added.
 */
export const objectSelectFields = {
  id: contentObjects.id,
  kind: contentObjects.kind,
  title: contentObjects.title,
  slug: contentObjects.slug,
  ownerUserId: contentObjects.ownerUserId,
  createdByActor: contentObjects.createdByActor,
  createdByAgentId: contentObjects.createdByAgentId,
  collectionId: contentObjects.collectionId,
  visibilityLevel: contentObjects.visibilityLevel,
  currentVersionId: contentObjects.currentVersionId,
  sourceRef: contentObjects.sourceRef,
  tags: contentObjects.tags,
  // Meridian slice F cover band + doc icon (migration 103).
  coverGradient: contentObjects.coverGradient,
  icon: contentObjects.icon,
  status: contentObjects.status,
  indexedAt: pgTimestampAsText(contentObjects.indexedAt),
  createdAt: pgTimestampAsText(contentObjects.createdAt),
  updatedAt: pgTimestampAsText(contentObjects.updatedAt),
} as const;

/** Shape of a content-object row selected with timestamps as text. */
export interface ObjectRowAsText {
  id: string;
  kind: string;
  title: string;
  slug: string;
  ownerUserId: number;
  /**
   * Owner display name — present ONLY on the `listVisible` projection (which
   * LEFT JOINs `users`); absent on `objectSelectFields`-based single loads, hence
   * optional. `rowToObjectDTO` coalesces a missing value to null.
   */
  ownerName?: string | null;
  createdByActor: string;
  createdByAgentId: string | null;
  collectionId: string | null;
  visibilityLevel: string;
  currentVersionId: string | null;
  sourceRef: SourceRef | null;
  tags: string[];
  coverGradient: string | null;
  icon: string | null;
  status: string;
  indexedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

// The `as <union>` casts below narrow enum-backed columns that the row type
// carries as `string`. The values are constrained by the pgEnum column at the
// DB level, so the cast is sound unless the DB enum diverges from the TS union
// (which schema-drift detection guards).
export function rowToObjectDTO(row: ObjectRowAsText): ContentObjectDTO {
  return {
    id: row.id,
    kind: row.kind as ContentKind,
    title: row.title,
    slug: row.slug,
    ownerUserId: row.ownerUserId,
    // Present only on the list projection; null everywhere else (see ObjectRowAsText).
    ownerName: row.ownerName ?? null,
    createdByActor: row.createdByActor as "human" | "agent",
    createdByAgentId: row.createdByAgentId,
    collectionId: row.collectionId,
    visibilityLevel: row.visibilityLevel as VisibilityLevel,
    currentVersionId: row.currentVersionId,
    sourceRef: row.sourceRef,
    tags: row.tags ?? [],
    coverGradient: row.coverGradient,
    icon: row.icon,
    status: row.status as "draft" | "published" | "archived",
    indexedAt: stripJsonQuotes(row.indexedAt),
    createdAt: stripJsonQuotes(row.createdAt),
    updatedAt: stripJsonQuotes(row.updatedAt),
  };
}

/** Shape of a content-version row selected with timestamps as text. */
export interface VersionRowAsText {
  id: string;
  objectId: string;
  versionNumber: number;
  authorActor: string;
  authorUserId: number | null;
  authorAgentId: string | null;
  bodyFormat: string;
  bodyLocation: string;
  bodyInline: string | null;
  renderLocation: string | null;
  proofDocRef: string | null;
  summary: string | null;
  createdAt: string | null;
}

export function rowToVersionDTO(row: VersionRowAsText): ContentVersionDTO {
  return {
    id: row.id,
    objectId: row.objectId,
    versionNumber: row.versionNumber,
    authorActor: row.authorActor as "human" | "agent",
    authorUserId: row.authorUserId,
    authorAgentId: row.authorAgentId,
    bodyFormat: row.bodyFormat as BodyFormat,
    bodyLocation: row.bodyLocation,
    bodyInline: row.bodyInline,
    renderLocation: row.renderLocation,
    proofDocRef: row.proofDocRef,
    summary: row.summary,
    createdAt: stripJsonQuotes(row.createdAt),
  };
}
