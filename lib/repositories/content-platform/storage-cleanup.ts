import { eq } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { repositoryItemVersions } from "@/lib/db/schema";
import {
  deleteDocument,
  deleteDocumentVersions,
  deleteRepositoryObjectVersionsByPrefix,
} from "@/lib/aws/s3-client";
import { isRepositorySourceObjectKey } from "./object-key";

export interface RepositoryStorageItem {
  id: number;
  repositoryId: number;
  type: string;
  source: string;
}

export interface RepositoryStorageCleanupResult {
  sourceObjectCount: number;
  artifactObjectCount: number;
}

export interface RepositoryStorageTreeCleanupResult
  extends RepositoryStorageCleanupResult {
  itemCount: number;
  repositoryObjectCount: number;
}

interface RepositoryStorageVersion {
  id: string;
  objectKey: string | null;
}

export interface RepositoryStorageCleanupDependencies {
  getVersions(itemId: number): Promise<RepositoryStorageVersion[]>;
  deleteObjectVersions(key: string): Promise<number>;
  deleteLegacyObject(key: string): Promise<void>;
  deletePrefixVersions(prefix: string): Promise<number>;
}

const defaultDependencies: RepositoryStorageCleanupDependencies = {
  getVersions: (itemId) =>
    executeQuery(
      (db) =>
        db
          .select({
            id: repositoryItemVersions.id,
            objectKey: repositoryItemVersions.objectKey,
          })
          .from(repositoryItemVersions)
          .where(eq(repositoryItemVersions.itemId, itemId)),
      "contentPlatform.getItemStorageVersions"
    ),
  deleteObjectVersions: deleteDocumentVersions,
  deleteLegacyObject: deleteDocument,
  deletePrefixVersions: deleteRepositoryObjectVersionsByPrefix,
};

export interface RepositoryStorageTreeCleanupDependencies {
  deleteItemStorage(
    item: RepositoryStorageItem
  ): Promise<RepositoryStorageCleanupResult>;
  deletePrefixVersions(prefix: string): Promise<number>;
}

const defaultTreeDependencies: RepositoryStorageTreeCleanupDependencies = {
  deleteItemStorage: deleteRepositoryItemStorage,
  deletePrefixVersions: deleteRepositoryObjectVersionsByPrefix,
};

/**
 * Remove the source objects and every derived artifact for one stored item.
 * Version rows must be read before the item is deleted because their ids are
 * the durable namespaces for processor artifacts.
 */
export async function deleteRepositoryItemStorage(
  item: RepositoryStorageItem,
  dependencies: RepositoryStorageCleanupDependencies = defaultDependencies
): Promise<RepositoryStorageCleanupResult> {
  const versions = await dependencies.getVersions(item.id);

  const sourceKeys = new Set<string>();
  // URL and inline-text sources are user content, not object keys. Canonical
  // text still has an immutable version object below and is cleaned through the
  // version rows. File-backed legacy items may not have canonical versions yet,
  // so retain their stored source key as a fallback.
  if (
    ["document", "image", "audio", "video"].includes(item.type) &&
    item.source.trim()
  ) {
    sourceKeys.add(item.source);
  }
  for (const version of versions) {
    if (version.objectKey?.trim()) sourceKeys.add(version.objectKey);
  }

  const canonicalSourceKeys: string[] = [];
  const legacySourceKeys: string[] = [];
  for (const key of sourceKeys) {
    if (isRepositorySourceObjectKey(item.repositoryId, key)) {
      canonicalSourceKeys.push(key);
      continue;
    }
    // Never reinterpret a malformed or cross-repository canonical-looking key
    // as a legacy object. Historical keys predate repositories/* entirely;
    // anything in that namespace must belong to this repository or fail closed.
    if (key.startsWith("repositories/")) {
      throw new Error("Repository source object is outside its cleanup scope");
    }
    legacySourceKeys.push(key);
  }

  const sourceDeletions = [
    ...canonicalSourceKeys.map((key) =>
      dependencies.deleteObjectVersions(key)
    ),
    ...legacySourceKeys.map((key) => dependencies.deleteLegacyObject(key)),
  ];
  const artifactDeletions = versions.map((version) =>
    dependencies.deletePrefixVersions(
      `repositories/${item.repositoryId}/artifacts/${version.id}/`
    )
  );
  const [, artifactCounts] = await Promise.all([
    Promise.all(sourceDeletions),
    Promise.all(artifactDeletions),
  ]);

  return {
    sourceObjectCount: sourceKeys.size,
    artifactObjectCount: artifactCounts.reduce(
      (total, current) => total + current,
      0
    ),
  };
}

/**
 * Remove every item-owned source/artifact and then sweep the repository root.
 *
 * The final sweep removes abandoned upload objects and legacy or derived
 * objects that never gained a durable item/version manifest. Callers
 * must complete this operation before deleting the repository row: any storage
 * failure deliberately rejects so the manifests remain available for retry.
 */
export async function deleteRepositoryStorageTree(
  repositoryId: number,
  items: RepositoryStorageItem[],
  dependencies: RepositoryStorageTreeCleanupDependencies = defaultTreeDependencies
): Promise<RepositoryStorageTreeCleanupResult> {
  if (
    !Number.isSafeInteger(repositoryId) ||
    repositoryId < 1 ||
    items.some((item) => item.repositoryId !== repositoryId)
  ) {
    throw new Error("Invalid repository storage cleanup scope");
  }

  let sourceObjectCount = 0;
  let artifactObjectCount = 0;
  for (const item of items) {
    const result = await dependencies.deleteItemStorage(item);
    sourceObjectCount += result.sourceObjectCount;
    artifactObjectCount += result.artifactObjectCount;
  }

  const repositoryObjectCount = await dependencies.deletePrefixVersions(
    `repositories/${repositoryId}/`
  );

  return {
    itemCount: items.length,
    sourceObjectCount,
    artifactObjectCount,
    repositoryObjectCount,
  };
}
