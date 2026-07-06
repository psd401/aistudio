/**
 * Atrium publish adapter contract
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1). A `PublishAdapter` abstracts *where a
 * published version becomes live* for one destination. The publish service
 * (`lib/content/publish-service.ts`) owns the canonical
 * `content_publications` row (the durable record that "version V of object O is
 * live at destination D"); the adapter performs whatever destination-specific
 * side effect makes that live and hands back the destination's external
 * identifier.
 *
 * The split keeps the service identical across destinations: it always upserts
 * the publication row inside a transaction, then — outside the transaction —
 * calls the adapter for the external side effect (the drizzle-client anti-pattern
 * is doing external IO inside a transaction). Phase 1 ships only the
 * reader-backed `intranet` adapter (a no-op, see `./intranet`); the
 * `public_web` / `schoology` / `google` adapters land in later phases.
 *
 * See docs/features/atrium-design-spec.md §15 (publishing).
 */

/**
 * Every destination a published version can be made live at — the canonical
 * list. `PublishDestination` is DERIVED from this array, so the type cannot gain
 * a member without this list (and every validator set built from it in
 * `lib/content/validators.ts`) picking it up in the same edit.
 */
export const PUBLISH_DESTINATIONS = [
  "intranet",
  "public_web",
  "schoology",
  "google",
  // Open Knowledge Format export (Phase 8, #1103, §36) — a portable bundle, not a
  // live reader/connector. NOT in `PUBLIC_DESTINATIONS`: a single-object bundle
  // carries the internal-publish authority (the object's owner already views/edits
  // it); the §26.4 public gate applies to the COLLECTION exporter's `public`
  // audience (`lib/content/okf/export.ts`), not the destination.
  "okf",
] as const;

/** A destination a published version can be made live at. */
export type PublishDestination = (typeof PUBLISH_DESTINATIONS)[number];

/**
 * The destinations that expose content to a PUBLIC / family-facing audience and
 * therefore require the §26.4 `content:publish_public` authority (Phase 7, #1057).
 *
 * `intranet` is the ONLY internal-audience destination (`content:publish_internal`
 * suffices for it). `public_web` renders at an anonymous reader route; `schoology`
 * / `google` push into external family-facing systems (§26.2 — "publish to
 * public_web / family-facing destinations"). All three are the highest-governance
 * paths: an unauthorized caller (including EVERY autonomous agent) is routed
 * through the approval gate before the destination adapter ever runs.
 *
 * Single source of truth so the publish service, unpublish path, and any future
 * gate site classify destinations identically rather than hand-listing them.
 */
export const PUBLIC_DESTINATIONS: readonly PublishDestination[] = [
  "public_web",
  "schoology",
  "google",
];

/**
 * Whether publishing to (or unpublishing from) `destination` requires the §26.4
 * public-publish authority. `intranet` → false; every destination in
 * `PUBLIC_DESTINATIONS` → true.
 */
export function isPublicDestination(destination: PublishDestination): boolean {
  return PUBLIC_DESTINATIONS.includes(destination);
}

/** A publish request's destination target. */
export interface PublishTarget {
  destination: PublishDestination;
}

/**
 * The outcome of an adapter's `publish` side effect.
 *
 * `externalRef` is the destination-specific identifier (a public URL, a
 * Schoology/Google resource id, …) the service persists on
 * `content_publications.external_ref`. It is `null` for destinations that have no
 * external system (e.g. `intranet`, which is served by the in-app reader directly
 * from the publication row).
 */
export interface PublishResult {
  externalRef: string | null;
}

/**
 * A destination adapter. `publish` is called by the publish service *after* the
 * `content_publications` row has been upserted and the transaction has committed,
 * so a failing external side effect never rolls back the canonical row.
 * `unpublish` (optional) tears the external side effect down for destinations
 * that have one; reader-backed destinations omit it.
 */
export interface PublishAdapter {
  /** The single destination this adapter handles. */
  destination: PublishDestination;

  /**
   * `false` for a not-yet-implemented destination stub (public_web/schoology/
   * google land in later phases). The publish service checks this BEFORE its
   * status/visibility transaction so an unimplemented destination fails without
   * committing anything (see publish-service). Omitted/undefined means the
   * adapter is live.
   */
  implemented?: boolean;

  /**
   * Make `versionId` of object `objectId` live at this destination. `slug` is the
   * object's URL slug (the reader/public address); `title` and `collectionId`
   * let a destination place the object in its information architecture (the
   * intranet adapter uses them to label/parent the auto-created nav item — §21).
   * Returns the external identifier to persist, or `{ externalRef: null }` when
   * the destination has no external system.
   */
  publish(input: {
    objectId: string;
    slug: string;
    versionId: string;
    title: string;
    collectionId: string | null;
  }): Promise<PublishResult>;

  /**
   * Tear down the external side effect for a previously published object. The
   * intranet adapter uses `objectId` to deactivate the object's nav item (§21).
   * Optional only for destinations with literally nothing to undo; the intranet
   * adapter implements it.
   */
  unpublish?(input: {
    objectId: string;
    externalRef: string | null;
  }): Promise<void>;
}
