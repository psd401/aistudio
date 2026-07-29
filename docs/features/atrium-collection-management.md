# Atrium collection management

Issue #1438 adds one shared collection-management model across the Atrium UI,
REST v1, and the owner-bound `psd-atrium` skill.

## Authority and privacy

- A row with `owner_user_id IS NULL` is a district/shared collection.
  Administrators may create, rename, move, reorder, archive, restore, and set
  its defaults/grants.
- A row with `owner_user_id = users.id` is an owner-bound private collection.
  Every Atrium author may manage their own private hierarchy. Private collections
  are forced to `default_visibility_level = 'private'`,
  `inherit_grants = false`, and carry no grants. Empty private collection trees
  cascade away with a deleted owner account; content retains its independent
  ownership foreign-key protections.
- District administrators can inspect private collection metadata, owner, policy,
  direct/subtree counts, and collection audit events. They cannot enter, read,
  create in, or mutate another user's private collection. This is an additional
  boundary around the existing object visibility rules.

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

`content_collection_grants` distinguishes `view` from `create` access and uses
the existing Atrium grant kinds (`role`, `group`, `building`, `department`,
`grade`, and `user`). District children inherit ancestor grants while
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
object's group-visibility grants. Private collection content is always private.

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

Every mutation uses `collectionManagementService` and records
`collection_create`, `collection_update`, `collection_archive`, or
`collection_restore` in `content_audit_logs`.
