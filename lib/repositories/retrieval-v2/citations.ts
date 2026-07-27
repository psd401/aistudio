import type { RepositorySourceLocator } from "@/lib/db/schema";
import { formatRepositorySourceLocator } from "@/lib/repositories/citation-label";
import type { RetrievalCandidate, RetrievalCitation } from "./types";

function isValidRegion(region: {
  x: number;
  y: number;
  width: number;
  height: number;
}): boolean {
  const coordinates = [region.x, region.y, region.width, region.height];
  return (
    coordinates.every(Number.isFinite) &&
    coordinates.every((value) => value >= 0) &&
    region.x + region.width <= 1.000_001 &&
    region.y + region.height <= 1.000_001
  );
}

function validPage(locator: RepositorySourceLocator): boolean {
  return (
    locator.page !== null &&
    locator.page !== undefined &&
    locator.page > 0 &&
    (locator.pageEnd == null || locator.pageEnd >= locator.page)
  );
}

function validParagraph(locator: RepositorySourceLocator): boolean {
  return (
    locator.paragraph !== null &&
    locator.paragraph !== undefined &&
    locator.paragraph > 0 &&
    (locator.paragraphEnd == null || locator.paragraphEnd >= locator.paragraph)
  );
}

function validTimeRange(locator: RepositorySourceLocator): boolean {
  return (
    locator.timeStartMs !== null &&
    locator.timeStartMs !== undefined &&
    locator.timeStartMs >= 0 &&
    locator.timeEndMs != null &&
    locator.timeEndMs >= locator.timeStartMs
  );
}

export function isValidSourceLocator(
  locator: RepositorySourceLocator,
): boolean {
  if (locator.page != null) return validPage(locator);
  if (locator.paragraph != null) return validParagraph(locator);
  if (locator.slide != null) return locator.slide > 0;
  if (locator.sheet)
    return locator.cellRange == null || locator.cellRange.length > 0;
  if (locator.headingPath?.length) return locator.headingPath.every(Boolean);
  if (locator.timeStartMs != null) return validTimeRange(locator);
  if (locator.regions?.length) {
    return locator.regions.every(isValidRegion);
  }
  return false;
}

export function resolveRetrievalCitation(
  candidate: RetrievalCandidate,
): RetrievalCitation {
  if (!isValidSourceLocator(candidate.sourceLocator)) {
    throw new Error(`Chunk ${candidate.chunkId} has no valid source citation`);
  }
  const label = formatRepositorySourceLocator(candidate.sourceLocator);
  if (!label)
    throw new Error(`Chunk ${candidate.chunkId} has no citation label`);
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
