/**
 * Atrium OKF v0.1 profile — Phase 8 (Issue #1103, Epic #1059, spec §36)
 *
 * [Open Knowledge Format (OKF)](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing)
 * is a portable serialization for agent context: a directory of markdown files
 * with YAML frontmatter, where each file is a *concept*, and two reserved
 * filenames carry structure — `index.md` (navigation) and `log.md` (change
 * history). OKF is "designed for growth", so this module PINS the exact v0.1
 * frontmatter set + reserved-filename semantics Atrium serializes against and
 * versions the exporter (`OKF_VERSION`), so a later OKF revision cannot silently
 * change our output (spec §36 "Pin a v0.1 profile").
 *
 * Nothing here touches the database — it is the pure vocabulary shared by the
 * exporter (`./export`, `./serialize`) and importer (`./import`, `./frontmatter`).
 */

import type { ContentKind } from "../types";

/** The OKF revision this exporter/importer targets. Bumped only on a profile change. */
export const OKF_VERSION = "0.1";

/** A stable producer id stamped on every bundle so a consumer can attribute it. */
export const OKF_GENERATOR = "psd-aistudio-atrium/okf-exporter@0.1";

/** Reserved OKF filename for a collection's navigation file. */
export const OKF_INDEX_FILE = "index.md";

/** Reserved OKF filename for an object's change history. */
export const OKF_LOG_FILE = "log.md";

/**
 * The pinned v0.1 frontmatter field set. `type` is the ONLY required field; every
 * other field is optional and emitted only when the source value is present.
 * Ordering is fixed so byte-for-byte output is stable across exports.
 */
export const OKF_FRONTMATTER_FIELDS = [
  "type",
  "title",
  "description",
  "resource",
  "tags",
  "timestamp",
] as const;

/** A single file in an OKF bundle: an OKF-relative path + its markdown content. */
export interface OkfFile {
  /** POSIX-relative path within the bundle, e.g. `sub/concept-slug.md`. */
  path: string;
  content: string;
}

/**
 * A portable OKF bundle. Transport-agnostic (spec §36.5): the exporter returns it
 * inline AND persists the same JSON to S3, so a consumer/importer can round-trip
 * it directly without unpacking an archive.
 */
export interface OkfBundle {
  okfVersion: string;
  generator: string;
  /** The collection subtree this bundle was exported from (null for a loose object). */
  rootCollectionId: string | null;
  rootCollectionSlug: string | null;
  /** `internal` (canView-scoped to the requester) or `public` (§26.4-gated, public-only). */
  audience: OkfAudience;
  objectCount: number;
  collectionCount: number;
  files: OkfFile[];
}

/** The two export audiences (see spec §36.2 — the permission boundary). */
export type OkfAudience = "internal" | "public";

/**
 * The pinned v0.1 frontmatter shape. All values are strings (or a string array
 * for `tags`); OKF frontmatter carries no nested objects.
 */
export interface OkfFrontmatter {
  /** Required. Mapped from `content_objects.kind`. */
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  /** ISO-8601 timestamp (from `content_objects.updated_at`). */
  timestamp?: string;
}

/** A parsed concept file: its frontmatter plus the markdown body after it. */
export interface OkfConcept {
  frontmatter: OkfFrontmatter;
  body: string;
}

/**
 * Map an OKF `type` back to an Atrium `content_kind` on import. Only the two grains
 * Atrium understands round-trip to their kind; any other producer's `type`
 * (OKF is cross-vendor) is imported as a `document` — the safe default that stores
 * the concept's markdown as a readable body rather than rejecting the bundle.
 *
 * The forward direction (`kind` → OKF `type`) is the identity mapping and is inlined
 * at its one call site (`serialize.ts` `conceptFrontmatter`): OKF's `type` is an open
 * string, so preserving the Atrium grain (document/artifact) round-trips losslessly.
 */
export function kindForOkfType(type: string | undefined): ContentKind {
  return type === "artifact" ? "artifact" : "document";
}

/** The concept filename for an object slug — `${slug}.md`. */
export function conceptFileName(slug: string): string {
  return `${slug}.md`;
}
