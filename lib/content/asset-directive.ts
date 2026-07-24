/** Canonical immutable authored-asset directive (#1284). */

export const CONTENT_ASSET_DIRECTIVE_NAME = "atrium-asset";
export const CONTENT_ASSET_DATA_ATTR = "data-atrium-asset-id";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CONTENT_ASSET_LINE_RE =
  /^[ \t]*::atrium-asset\{([^}]*)\}[ \t]*$/;
const CONTENT_ASSET_BYTES_RE =
  /^\/api\/v1\/content\/assets\/([0-9a-f-]{36})\/bytes$/i;

export interface ContentAssetDirective {
  assetId: string;
  alt: string;
}

export function contentAssetBytesPath(assetId: string): string | null {
  return UUID_RE.test(assetId)
    ? `/api/v1/content/assets/${assetId.toLowerCase()}/bytes`
    : null;
}

export function assetIdFromBytesPath(path: string): string | null {
  const match = CONTENT_ASSET_BYTES_RE.exec(path);
  const id = match?.[1];
  return id && UUID_RE.test(id) ? id.toLowerCase() : null;
}

export function isContentAssetBytesPath(path: string): boolean {
  return assetIdFromBytesPath(path) !== null;
}

function cleanAlt(value: string): string {
  return value.replace(/[\r\n"]/g, " ").trim().slice(0, 500);
}

export function parseContentAssetDirectiveAttrs(
  attrs: string
): ContentAssetDirective | null {
  const idMatch = attrs.match(/\bid\s*=\s*"([0-9a-fA-F-]+)"/);
  const id = idMatch?.[1];
  if (!id || !UUID_RE.test(id)) return null;
  const altMatch = attrs.match(/\balt\s*=\s*"([^"]*)"/);
  return {
    assetId: id.toLowerCase(),
    alt: cleanAlt(altMatch?.[1] ?? ""),
  };
}

export function serializeContentAssetDirective(
  assetId: string,
  alt = ""
): string | null {
  if (!UUID_RE.test(assetId)) return null;
  return `::atrium-asset{id="${assetId.toLowerCase()}" alt="${cleanAlt(alt)}"}`;
}

interface Fence {
  char: string;
  length: number;
  hasTrailing: boolean;
}

function parseFence(line: string): Fence | null {
  const match = /^[ \t]*(`{3,}|~{3,})([^\n]*)$/.exec(line);
  if (!match) return null;
  return {
    char: match[1][0],
    length: match[1].length,
    hasTrailing: match[2].trim().length > 0,
  };
}

/** Parse ready-asset references outside CommonMark fenced code blocks. */
export function parseContentAssetIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  let open: Pick<Fence, "char" | "length"> | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const fence = parseFence(line);
    if (open) {
      if (
        fence &&
        fence.char === open.char &&
        fence.length >= open.length &&
        !fence.hasTrailing
      ) {
        open = null;
      }
      continue;
    }
    if (fence) {
      open = { char: fence.char, length: fence.length };
      continue;
    }
    const lineMatch = CONTENT_ASSET_LINE_RE.exec(line);
    const parsed = lineMatch
      ? parseContentAssetDirectiveAttrs(lineMatch[1])
      : null;
    if (parsed && !seen.has(parsed.assetId)) {
      seen.add(parsed.assetId);
      ids.push(parsed.assetId);
    }
  }
  return ids;
}
