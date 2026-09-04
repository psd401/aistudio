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
 * The ONE destination that carries an object's LIVE state (#1726).
 *
 * Publication used to be an *audience* choice — `intranet` vs `public_web` —
 * which put "where it's published" in direct competition with the object's
 * visibility Level. Reconciling the two needed a widen prompt that was false
 * (`/c/[slug]` runs `canView` before it looks at the publication, so a
 * group-scoped published object opens fine for its grantees), UI-only (the same
 * dialog could narrow one save later), and destructive (it wiped the author's
 * grants).
 *
 * The two axes are now separated: **Level alone decides the audience**, and
 * publication is a single Live/Draft state. That state is recorded as ONE
 * `content_publications` row, at this destination. The reader URL is derived
 * from the two — `/c/{slug}` for any Live object, plus `/p/{slug}` when the
 * object is also `public`.
 */
export const LIVE_DESTINATION = "intranet" satisfies PublishDestination;

/**
 * The destinations that count as "this object is Live".
 *
 * `intranet` is the one the live switch writes. `public_web` is here only for
 * rows written BEFORE #1726 (migration 180 folds them into an `intranet` row);
 * accepting it keeps a legacy row serving its readers even if the migration and
 * the deploy land out of order. Nothing writes `public_web` any more.
 */
export const LIVE_SURFACE_DESTINATIONS: readonly PublishDestination[] = [
  LIVE_DESTINATION,
  "public_web",
];

/**
 * Whether a set of an object's live publication destinations means the object is
 * LIVE. The list form of the question, for surfaces that read publications
 * through `publishService.listLive` rather than the database.
 *
 * Lives here, beside the destination constants, rather than in
 * `lib/content/live-publication.ts`: that module imports drizzle and the schema
 * to build the SQL half of the same predicate, and the Share dialog — a client
 * component — would otherwise pull both into the browser bundle to ask a
 * question that is pure set membership.
 */
export function isLive(destinations: Iterable<string>): boolean {
  const live = new Set<string>(LIVE_SURFACE_DESTINATIONS);
  for (const destination of destinations) {
    if (live.has(destination)) return true;
  }
  return false;
}

/**
 * Collapse the two legacy live destinations onto the single live row (#1726).
 *
 * Every surface (server action, REST, MCP, agent bridge) still ACCEPTS
 * `public_web` — it is a published API value — but both mean the same thing now:
 * flip the live switch. Normalizing here, at the one point every surface funnels
 * through, is what keeps "Live" a single row rather than two that can disagree.
 * Connector destinations pass through untouched.
 */
export function normalizeLiveDestination(
  destination: PublishDestination
): PublishDestination {
  return destination === "public_web" ? LIVE_DESTINATION : destination;
}

/**
 * The destinations that push content into an EXTERNAL, family-facing system and
 * therefore require the §26.4 `content:publish_public` authority.
 *
 * Since #1726 this is the connector set ONLY. Making an object live no longer
 * changes who may read it — the Level does, and `visibilityService.setLevel`
 * carries the unchanged §26.4 gate for widening to `public`. Gating the live
 * switch as well would gate the *state*, not the *exposure*, which is what made
 * the old flow both wrong (it fired for a group-scoped intranet publish) and
 * bypassable (visibility could be narrowed one save later).
 *
 * `public_web` is deliberately absent: it is no longer a distinct exposure, only
 * a legacy alias for the live row (`normalizeLiveDestination`). `okf` is a
 * portable bundle carrying internal-publish authority (the §26.4 gate for OKF
 * lives on the COLLECTION exporter's `public` audience, not the destination).
 *
 * Single source of truth so the publish service, unpublish path, and any future
 * gate site classify destinations identically rather than hand-listing them.
 */
export const PUBLIC_DESTINATIONS: readonly PublishDestination[] = [
  "schoology",
  "google",
];

/**
 * Whether publishing to (or unpublishing from) `destination` requires the §26.4
 * public-publish authority. The live switch and `okf` → false; every connector in
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
