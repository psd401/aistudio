/**
 * The shared grant-list read (#1763), used by the REST v1
 * `GET /content/:id/visibility` route and the agent broker's
 * `GET /<id>/visibility` branch.
 *
 * Its own module rather than a `surface-helpers.ts` export: that file is a leaf
 * imported by callers that mock only the collection tables, and pulling
 * `content-service` into its graph would drag the whole object-mapper/schema
 * surface along with it (same reason `reader-links.ts` was split out).
 */

import { contentService } from "./content-service";
import { visibilityService } from "./visibility-service";
import type { Requester, VisibilityGrant, VisibilityLevel } from "./types";

/**
 * The current audience of an object: its level plus the ACTUAL grant entries,
 * in the one shape every non-UI surface returns.
 */
export interface VisibilityRead {
  id: string;
  visibility: { visibilityLevel: VisibilityLevel; grants: VisibilityGrant[] };
}

/**
 * Read an object's level + grant entries for a caller who may EDIT it (#1763).
 *
 * `GET /content/:id` exposes only a `grantCount` integer and the visibility
 * write REPLACES the grant set, so without this read the only way to narrow or
 * widen an object is to re-send a guessed list — and a wrong guess silently
 * drops access that no audit trail can restore.
 *
 * Gated on EDIT, not view: the grant set names every principal with access,
 * including the numeric `users.id` behind a `user` grant, which an owner never
 * intended to expose to grantees. `loadForEdit` 404-masks a non-viewable object
 * before it 403s a viewer, so neither outcome confirms the object exists.
 *
 * Shared by both surfaces so they stay authorization- and shape-identical; each
 * wraps the result in its own response envelope. Reading your own audience is
 * not authoring, so neither caller gates it on
 * `assertContentAuthoringCapability`.
 */
export async function readVisibilityForEdit(
  req: Requester,
  idOrSlug: string
): Promise<VisibilityRead> {
  const obj = await contentService.loadForEdit(req, idOrSlug);
  const grants = await visibilityService.grantsFor(obj.id);
  return {
    id: obj.id,
    visibility: { visibilityLevel: obj.visibilityLevel, grants },
  };
}
