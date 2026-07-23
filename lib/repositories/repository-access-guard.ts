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
 * 2. **Repository product boundaries.** Generic Repository Manager actions are
 *    only for active, unexpired, user-managed durable repositories. Ephemeral
 *    Nexus repositories and system-managed indexes have their own lifecycle and
 *    authorization surfaces and must not be readable or mutable through generic
 *    repository actions. `assertUserManagedDurableRepository` establishes that
 *    boundary for both read and write paths.
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
  checkUserRoleByCognitoSub,
  isSystemManagedRepository,
} from "@/lib/db/drizzle";
import { ErrorFactories } from "@/lib/error-utils";

// ── Per-repository read authorization (IDOR fix) ─────────────────────────────

function repositoryNotFound(repositoryId: number): Error {
  return ErrorFactories.dbRecordNotFound(
    "knowledge_repositories",
    repositoryId
  );
}

/**
 * Throw `dbRecordNotFound` unless this is an active, unexpired,
 * user-managed durable repository.
 *
 * Generic Repository Manager actions must never become a second management
 * surface for Nexus ephemeral repositories or system indexes. Keep this guard
 * separate from retrieval accessors, which intentionally include a caller's
 * active ephemeral repositories for Nexus retrieval.
 */
export async function assertUserManagedDurableRepository(
  repositoryId: number
): Promise<void> {
  const repo = await getRepositoryById(repositoryId);
  const expiresAt = repo?.expiresAt?.getTime();
  const isExpired =
    expiresAt !== undefined &&
    (Number.isNaN(expiresAt) || expiresAt <= Date.now());

  if (
    !repo ||
    repo.repositoryKind !== "durable" ||
    repo.lifecycleStatus !== "active" ||
    isExpired ||
    isSystemManagedRepository(repo)
  ) {
    throw repositoryNotFound(repositoryId);
  }
}

/**
 * Throw `dbRecordNotFound` unless the caller (`cognitoSub`) can access the
 * active durable repository (public / owner / `repository_access` grant).
 * Administrators may inspect any durable repository through Repository Manager,
 * including private repositories they do not own.
 */
export async function assertRepositoryReadAccess(
  repositoryId: number,
  cognitoSub: string
): Promise<void> {
  await assertUserManagedDurableRepository(repositoryId);

  const [repo] = await getAccessibleRepositoriesByCognitoSub(
    [repositoryId],
    cognitoSub
  );
  if (repo?.isAccessible) {
    return;
  }

  if (await checkUserRoleByCognitoSub(cognitoSub, "administrator")) {
    return;
  }

  throw repositoryNotFound(repositoryId);
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

// ── Durable repository boundary (WRITE/DELETE paths) ─────────────────────────

/**
 * Backward-compatible name used throughout the generic write surface. This now
 * enforces the complete Repository Manager product boundary, not only the
 * historical system-managed exclusion.
 */
export async function assertNotSystemManagedRepository(
  repositoryId: number
): Promise<void> {
  await assertUserManagedDurableRepository(repositoryId);
}

/**
 * Deletion retries deliberately remain addressable after the repository has
 * entered `deleting`. Storage cleanup is idempotent, while restoring `active`
 * after a partial S3 sweep would expose a corrupt repository and let producers
 * recreate objects. All other Repository Manager boundaries remain unchanged.
 */
export async function assertUserManagedDurableRepositoryForDeletion(
  repositoryId: number
): Promise<void> {
  const repo = await getRepositoryById(repositoryId);
  const expiresAt = repo?.expiresAt?.getTime();
  const activeAndCurrent =
    repo?.lifecycleStatus === "active" &&
    (expiresAt === undefined ||
      (!Number.isNaN(expiresAt) && expiresAt > Date.now()));
  if (
    !repo ||
    repo.repositoryKind !== "durable" ||
    (!activeAndCurrent && repo.lifecycleStatus !== "deleting") ||
    isSystemManagedRepository(repo)
  ) {
    throw repositoryNotFound(repositoryId);
  }
}
