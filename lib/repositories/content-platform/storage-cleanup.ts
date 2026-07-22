import { eq } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { repositoryItemVersions } from "@/lib/db/schema";
import {
  deleteDocument,
  deleteRepositoryObjectsByPrefix,
} from "@/lib/aws/s3-client";

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

interface RepositoryStorageVersion {
  id: string;
  objectKey: string | null;
}

export interface RepositoryStorageCleanupDependencies {
  getVersions(itemId: number): Promise<RepositoryStorageVersion[]>;
  deleteObject(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
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
  deleteObject: deleteDocument,
  deletePrefix: deleteRepositoryObjectsByPrefix,
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

  const sourceDeletions = Array.from(sourceKeys, (key) =>
    dependencies.deleteObject(key)
  );
  const artifactDeletions = versions.map((version) =>
    dependencies.deletePrefix(
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
