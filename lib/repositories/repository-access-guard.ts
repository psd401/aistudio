/**
 * Repository-access guards for the generic repository actions.
 *
 * Two concerns, both closing holes onto the shared `repository_items` /
 * `repository_item_chunks` tables:
 *
 * 1. **Per-repository authorization (the IDOR fix).** The generic read actions
 *    (`searchRepository`, `listRepositoryItems`, `getItemChunks`, …) historically
 *    checked only `getServerSession()` or the blanket `knowledge-repositories`
 *    capability — never whether the caller can access the SPECIFIC repository. So
 *    any authenticated caller could pass an arbitrary (sequential, guessable)
 *    `repositoryId`/`itemId` and read a private repository they don't own and have
 *    no `repository_access` grant for. `assertRepositoryReadAccess` /
 *    `assertItemRepositoryReadAccess` require public / owner / grant access via the
 *    canonical `getAccessibleRepositoriesByCognitoSub` model (the same one
 *    `lib/tools/repository-tools.ts` uses).
 *
 * 2. **System-managed repositories** (the Atrium retrieval index, Issue #1056)
 *    hold content governed by per-object `visibilityService.canView`, not
 *    repository-level access. `getAccessibleRepositoriesByCognitoSub` already
 *    EXCLUDES them, so the read-access guards above cover Atrium isolation for
 *    free. The `assertNotSystemManagedRepository` / `assertItemNotInSystemManagedRepository`
 *    guards remain for the WRITE/DELETE paths (which gate on ownership via
 *    `canModifyRepository`, not read-access) so the shared index cannot be
 *    mutated / deleted out-of-band.
 *
 * All guards throw `dbRecordNotFound` (masking existence so ids are not
 * enumerable). `retrievalService` is the only intended reader of a system-managed
 * repo; it calls the search pipeline by id and re-checks `canView` per hit, so it
 * is unaffected by these action-layer guards.
 */

import {
  getRepositoryById,
  getRepositoryItemById,
  getAccessibleRepositoriesByCognitoSub,
  isSystemManagedRepository,
} from "@/lib/db/drizzle";
import { ErrorFactories } from "@/lib/error-utils";

// ── Per-repository read authorization (IDOR fix) ─────────────────────────────

/**
 * Throw `dbRecordNotFound` unless the caller (`cognitoSub`) can access the
 * repository (public / owner / `repository_access` grant). Also excludes
 * system-managed repos (the access query filters them), so this single check
 * closes both the generic-repository IDOR and Atrium isolation on read paths.
 */
export async function assertRepositoryReadAccess(
  repositoryId: number,
  cognitoSub: string
): Promise<void> {
  const [repo] = await getAccessibleRepositoriesByCognitoSub(
    [repositoryId],
    cognitoSub
  );
  if (!repo || !repo.isAccessible) {
    throw ErrorFactories.dbRecordNotFound(
      "knowledge_repositories",
      repositoryId
    );
  }
}

/**
 * Throw `dbRecordNotFound` unless the caller can access the repository the item
 * belongs to. Use in read actions keyed by `itemId` (`getItemChunks`,
 * `getDocumentDownloadUrl`).
 */
export async function assertItemRepositoryReadAccess(
  itemId: number,
  cognitoSub: string
): Promise<void> {
  const item = await getRepositoryItemById(itemId);
  if (!item) {
    throw ErrorFactories.dbRecordNotFound("repository_items", itemId);
  }
  await assertRepositoryReadAccess(item.repositoryId, cognitoSub);
}

// ── System-managed immutability (WRITE/DELETE paths) ─────────────────────────

/**
 * Throw `dbRecordNotFound` if the repository is missing or system-managed.
 * Use in generic WRITE/DELETE actions (which gate on ownership, not read-access)
 * so the shared Atrium index cannot be mutated/deleted through the generic API.
 */
export async function assertNotSystemManagedRepository(
  repositoryId: number
): Promise<void> {
  const repo = await getRepositoryById(repositoryId);
  if (!repo || isSystemManagedRepository(repo)) {
    throw ErrorFactories.dbRecordNotFound(
      "knowledge_repositories",
      repositoryId
    );
  }
}
