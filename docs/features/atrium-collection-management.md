# Atrium collection management

Issue #1438 adds one shared collection-management model across the Atrium UI,
REST v1, and the owner-bound `psd-atrium` skill.

## Authority and privacy

- A row with `owner_user_id IS NULL` is a district/shared collection.
  Administrators may create, rename, move, reorder, archive, restore, and set
  its defaults/grants.
- A row with `owner_user_id = users.id` is an owner-bound personal collection.
  Every Atrium author may manage their own hierarchy. Empty personal collection
  trees cascade away with a deleted owner account; content retains its
  independent ownership foreign-key protections.
- **Personal collections are shareable (migration 178).** Their owner may raise
  the default to `group` and attach `view` / `create` / `approve` grants, so
  "here is the collection I built for this project" is expressible without
  re-sharing every document in it. Two invariants are retained and enforced by
  `ck_collection_private_owner_policy` as well as the service:
  - the default may be `private` or `group`, never `internal` or `public` — a
    collection meant for everyone is a district section and belongs in the
    governed hierarchy;
  - `inherit_grants` stays `false` — a personal tree's access is exactly what
    its owner granted, never absorbed from an ancestor.

  Only the OWNER may change the grants (`assertMayManage`), so a grantee cannot
  re-share a collection shared with them. Zero grants means OWNER ONLY — the
  opposite of the district "zero grants = unrestricted" rule, and the inversion
  is load-bearing (see `tests/unit/atrium-shared-personal-collections.test.ts`).
- District administrators can inspect personal collection metadata, owner,
  policy, direct/subtree counts, and collection audit events. They cannot enter,
  read, create in, or mutate another user's personal collection — not even one
  that has been shared with other people. This is an additional boundary around
  the existing object visibility rules.

## Hierarchy and lifecycle

Collections form a self-referential tree. A private collection can nest only
under another collection with the same owner; district and private hierarchies
never mix. Moves reject cycles, archived parents, and case-insensitive sibling
name conflicts within the same district/private-owner hierarchy. Different
private owners may use the same top-level name. Serializable mutation
transactions prevent concurrent move or create operations from committing an
invalid hierarchy.

Renames retain the stable, globally unique slug. Private slugs use an owner
namespace so another owner's hidden name cannot be inferred from a collision
suffix. Reorder uses a non-negative `position`; ties remain deterministic by
name. Archive and restore recurse over the selected subtree and retain every
content row. A subtree can be restored only when its external parent is active.

Counts and content filtering intentionally use different, explicit meanings:

- `directContentCount`: objects filed directly in that collection.
- `subtreeContentCount`: direct objects plus all descendants.
- Library/API selection by `collectionId`: direct collection only.

## Grants and defaults

`content_collection_grants` distinguishes `view`, `create`, and `approve`
access and uses the existing Atrium grant kinds (`role`, `group`, `building`,
`department`, `grade`, and `user`). Matching is on the EXACT access level, so an
`approve` grant confers no view or create access — naming an approver does not
hand them the contents. District children inherit ancestor grants while
`inherit_grants` is true; turning it off makes the child a new grant boundary.
Matching is additive. Zero effective grants preserve the legacy unrestricted
district behavior. A `group` default is valid only when the collection has at
least one effective `view` grant; create/update rejects configurations that
would make every content creation attempt fail.

Collection access is enforced in both point reads and permission-pushed content
listing/count queries. An archived collection admits neither reads nor creates.
Content create/move performs a fast preflight, then re-resolves collection
access, effective grants, and defaults under locks in the same transaction as
the object write. Collection mutations take the conflicting lock before changing
lifecycle, hierarchy, defaults, or grants, so a concurrent revocation cannot
commit a stale placement.
Slug/UUID resolution for list filters and content placement is requester-aware;
an inaccessible private collection is reported exactly like an absent one.
If an accessible child cuts off inheritance beneath a denied ancestor,
collection discovery omits the denied ancestor and re-roots the child at the
nearest returned ancestor, so denied names, slugs, and ids are not exposed.
When a collection default is `group`, its effective `view` grants become the new
object's group-visibility grants. A personal collection left at the `private`
default still produces private content; one its owner has shared at `group`
seeds new objects with that collection's own grants.

## Publish review (migration 178)

`content_collections.requires_approval` is a per-collection OPT-IN, default
`false` on every row. The district-wide policy is unchanged and stays
allow-then-notify (Hagel, 2026-07-25): authors publish immediately everywhere
except the sections where review is the point — the staff intranet, the SOP set.

When it is set, `publishService.publish` routes a non-approver's publish into
the EXISTING `content_publish_requests` queue instead of publishing, pinned to
the version submitted so approval replays what was reviewed. No new table, no
new request kind: the pending-dedupe key is
`(object_id, request_kind, destination)`, so an intranet review request cannot
collide with a §26.4 public request for the same object.

Approvers are, additively:

- district administrators;
- the collection's owner (personal collections);
- anyone matching an `approve` grant on the collection — inherited down district
  trees like `view`/`create`, never inherited into a personal tree.

The first two are implicit so a gated collection can never reach a state where
nobody can clear its queue. **Nobody may decide their own request**, including
administrators; this cannot strand anything, because whoever raised a request
was by definition not an approver at raise time.

`/admin/atrium` therefore admits non-admin approvers, who see ONLY the Approvals
tab, filtered to their own sections. Collections and Audit remain
administrator-only in both the UI and their own actions; a caller who approves
nothing gets a 404 rather than a 403.

## Section hero images (migration 178)

`hero_image_key` / `hero_image_alt` hold raster header art for a section —
unlike the object-level `cover_gradient`, which is an allowlisted CSS gradient
preset with "no raster assets" as an explicit rule. Both fields join
`description` and `landing_object_id` in `SECTION_EDITOR_FIELDS`, so a non-admin
holding `create` access to a section can illustrate it without an administrator,
exactly as they can already write its description.

Images are uploaded or generated (through the same `generateImageForNexus`
service Nexus chat uses) and stored under `atrium/collections/{id}/hero/{uuid}`.
They are served ONLY by `GET /api/atrium/collections/{id}/hero`, which re-checks
collection access and reads the key from the row — the key is never accepted
from the caller. Replacing an image writes a new key rather than overwriting, so
a cached hero can never outlive its replacement — and the superseded object is
deleted once the row points at the new one (the bucket's lifecycle rules are
storage-class transitions and multi-year retention, not orphan cleanup, so
without that every replace would leak indefinitely).

Authorization runs BEFORE the store or the generation call, not after: both
spend real resources, so a check that rejected afterwards would still let any
signed-in account burn storage and paid model calls against any collection id.
Generated images are not guardrail-screened (Hagel, 2026-08-14); every change is
attributable through the audit log.

## Surfaces

- Library: **New private collection** opens the owner-only hierarchy editor.
- Admin → Atrium → **Collections** manages district collections and inspects all
  collection metadata.
- REST:
  - `GET /api/v1/content/collections`
  - `POST /api/v1/content/collections`
  - `PATCH /api/v1/content/collections/{id}`
- `psd-atrium`: `list-collections`, `create-collection`, `edit-collection`,
  `move-collection`, `archive-collection`, and `restore-collection`.
  `list-collections` combines active requester-visible rows with archived
  manageable rows and their grants and direct/subtree counts, so accessible
  district collections and restore targets both remain discoverable.

Every mutation uses `collectionManagementService` and records
`collection_create`, `collection_update`, `collection_archive`, or
`collection_restore` in `content_audit_logs`.
