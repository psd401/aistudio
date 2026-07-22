import { randomUUID } from "node:crypto";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Return whether an S3 key is an immutable source object owned by one
 * repository. Processor artifacts deliberately use a different namespace.
 */
export function isRepositorySourceObjectKey(
  repositoryId: number,
  objectKey: string
): boolean {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) return false;
  const prefix = `repositories/${repositoryId}/`;
  if (!objectKey.startsWith(prefix) || objectKey.includes("..")) return false;
  const pathParts = objectKey.slice(prefix.length).split("/");
  return (
    pathParts.length === 2 &&
    UUID_PATTERN.test(pathParts[0] ?? "") &&
    (pathParts[1]?.length ?? 0) > 0
  );
}

/** Build the canonical repository source namespace accepted by the worker. */
export function buildRepositorySourceObjectKey(
  repositoryId: number,
  fileName: string,
  sourceId: string = randomUUID()
): string {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new Error("A valid repository id is required for a source object key");
  }
  if (!UUID_PATTERN.test(sourceId)) {
    throw new Error("A valid source id is required for a source object key");
  }
  if (
    !fileName.trim() ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("..")
  ) {
    throw new Error("A safe file name is required for a source object key");
  }
  return `repositories/${repositoryId}/${sourceId}/${fileName}`;
}
