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

/** A destination a published version can be made live at. */
export type PublishDestination =
  | "intranet"
  | "public_web"
  | "schoology"
  | "google";

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
