import type { RepositorySourceLocator } from "@/lib/db/schema";

function boundedLabel(
  singular: string,
  first: number,
  last: number | undefined
): string {
  return last && last !== first ? `${singular}s ${first}–${last}` : `${singular} ${first}`;
}

/** Human-readable citation label shared by repository result surfaces. */
export function formatRepositorySourceLocator(
  locator: RepositorySourceLocator
): string | null {
  if (locator.page) return boundedLabel("Page", locator.page, locator.pageEnd);
  if (locator.paragraph) {
    return boundedLabel("Paragraph", locator.paragraph, locator.paragraphEnd);
  }
  if (locator.slide) return `Slide ${locator.slide}`;
  if (locator.sheet) {
    return locator.cellRange
      ? `${locator.sheet}!${locator.cellRange}`
      : `Sheet ${locator.sheet}`;
  }
  if (locator.headingPath?.length) return locator.headingPath.join(" › ");
  if (locator.timeStartMs != null) {
    const startSeconds = Math.floor(locator.timeStartMs / 1000);
    const endSeconds =
      locator.timeEndMs != null ? Math.floor(locator.timeEndMs / 1000) : null;
    return endSeconds != null && endSeconds !== startSeconds
      ? `${startSeconds}s–${endSeconds}s`
      : `${startSeconds}s`;
  }
  if (locator.regions?.length) {
    return locator.regions.length === 1
      ? "Image region"
      : `${locator.regions.length} image regions`;
  }
  return null;
}
