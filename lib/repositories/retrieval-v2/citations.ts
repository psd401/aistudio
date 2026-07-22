import type { RepositorySourceLocator } from "@/lib/db/schema";
import { formatRepositorySourceLocator } from "@/lib/repositories/citation-label";
import type { RetrievalCandidate, RetrievalCitation } from "./types";

export function isValidSourceLocator(locator: RepositorySourceLocator): boolean {
  if (locator.page != null) {
    return locator.page > 0 && (locator.pageEnd == null || locator.pageEnd >= locator.page);
  }
  if (locator.paragraph != null) {
    return (
      locator.paragraph > 0 &&
      (locator.paragraphEnd == null || locator.paragraphEnd >= locator.paragraph)
    );
  }
  if (locator.slide != null) return locator.slide > 0;
  if (locator.sheet) return locator.cellRange == null || locator.cellRange.length > 0;
  if (locator.headingPath?.length) return locator.headingPath.every(Boolean);
  if (locator.timeStartMs != null) {
    return (
      locator.timeStartMs >= 0 &&
      locator.timeEndMs != null &&
      locator.timeEndMs >= locator.timeStartMs
    );
  }
  if (locator.regions?.length) {
    return locator.regions.every(
      (region) =>
        [region.x, region.y, region.width, region.height].every(Number.isFinite) &&
        region.x >= 0 &&
        region.y >= 0 &&
        region.width >= 0 &&
        region.height >= 0 &&
        region.x + region.width <= 1.000_001 &&
        region.y + region.height <= 1.000_001
    );
  }
  return false;
}

export function resolveRetrievalCitation(
  candidate: RetrievalCandidate
): RetrievalCitation {
  if (!isValidSourceLocator(candidate.sourceLocator)) {
    throw new Error(`Chunk ${candidate.chunkId} has no valid source citation`);
  }
  const label = formatRepositorySourceLocator(candidate.sourceLocator);
  if (!label) throw new Error(`Chunk ${candidate.chunkId} has no citation label`);
  return {
    repositoryId: candidate.repositoryId,
    repositoryName: candidate.repositoryName,
    itemId: candidate.itemId,
    itemStableId: candidate.itemStableId,
    itemName: candidate.itemName,
    itemVersionId: candidate.itemVersionId,
    versionNumber: candidate.versionNumber,
    artifactId: candidate.artifactId,
    chunkId: candidate.chunkId,
    chunkIndex: candidate.chunkIndex,
    modality: candidate.modality,
    sourceLocator: candidate.sourceLocator,
    label,
  };
}
