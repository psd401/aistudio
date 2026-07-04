/**
 * Shared guards that keep SYSTEM-MANAGED repositories (the Atrium retrieval
 * index, Issue #1056) unreachable through the generic repository actions.
 *
 * Atrium content is stored in the shared `repository_items` /
 * `repository_item_chunks` tables but governed by a finer-grained permission
 * model (per-object `visibilityService.canView`, spec §16.2). The generic
 * repository actions enforce only repository-level access (or a blanket
 * capability), so any action that reaches those tables by `repositoryId` or
 * `itemId` must refuse a system-managed repo — otherwise a caller could read /
 * mutate the shared index directly and bypass `canView`. All Atrium reads go
 * through `retrievalService`, which re-checks `canView` per hit and calls the
 * search pipeline by id, so it is unaffected by these action-layer guards.
 *
 * Both guards throw `dbRecordNotFound` (masking existence so the id is not
 * enumerable) when the target is missing OR system-managed.
 */

import {
  getRepositoryById,
  getRepositoryItemById,
  isSystemManagedRepository,
} from "@/lib/db/drizzle";
import { ErrorFactories } from "@/lib/error-utils";

/**
 * Throw `dbRecordNotFound` if the repository is missing or system-managed.
 * Use in every generic action that takes a client-supplied `repositoryId`.
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

/**
 * Throw `dbRecordNotFound` if the item is missing or belongs to a
 * system-managed repository. Use in every generic action that takes a
 * client-supplied `itemId` and reads/mutates the shared item/chunk tables
 * (e.g. `getItemChunks`, `getDocumentDownloadUrl`, `removeRepositoryItem`).
 */
export async function assertItemNotInSystemManagedRepository(
  itemId: number
): Promise<void> {
  const item = await getRepositoryItemById(itemId);
  if (!item) {
    throw ErrorFactories.dbRecordNotFound("repository_items", itemId);
  }
  await assertNotSystemManagedRepository(item.repositoryId);
}
