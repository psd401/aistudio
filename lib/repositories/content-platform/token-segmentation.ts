import { encodingForModel } from "js-tiktoken";

export const DEFAULT_SEGMENT_TOKEN_LIMIT = 480;
export const DEFAULT_SEGMENT_TOKEN_OVERLAP = 64;

let tokenizer: ReturnType<typeof encodingForModel> | null = null;

function getTokenizer(): ReturnType<typeof encodingForModel> {
  tokenizer ??= encodingForModel("gpt-3.5-turbo");
  return tokenizer;
}

/** Deterministic token count shared by ingestion, expansion, and prompt budgets. */
export function countRepositoryTokens(text: string): number {
  if (!text) return 0;
  try {
    return getTokenizer().encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

function largestPrefixWithinTokens(text: string, maximumTokens: number): number {
  let low = 1;
  let high = text.length;
  let best = 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (countRepositoryTokens(text.slice(0, middle)) <= maximumTokens) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function semanticSplitPoint(text: string, hardLimit: number): number {
  const preferredFloor = Math.floor(hardLimit * 0.6);
  for (const separator of ["\n\n", "\n", ". ", "; ", ", ", " "]) {
    const index = text.lastIndexOf(separator, hardLimit);
    if (index >= preferredFloor) return index + separator.length;
  }
  return hardLimit;
}

function overlapStart(text: string, maximumTokens: number): number {
  if (maximumTokens <= 0) return text.length;
  let low = 0;
  let high = text.length;
  let best = text.length;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (countRepositoryTokens(text.slice(middle)) <= maximumTokens) {
      best = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return best;
}

export interface TokenSegmentOptions {
  maximumTokens?: number;
  overlapTokens?: number;
}

/** Split at structural boundaries while enforcing tokenizer-counted ceilings. */
export function splitTokenizerAwareText(
  value: string,
  options: TokenSegmentOptions = {}
): string[] {
  const maximumTokens = options.maximumTokens ?? DEFAULT_SEGMENT_TOKEN_LIMIT;
  const overlapTokens = options.overlapTokens ?? DEFAULT_SEGMENT_TOKEN_OVERLAP;
  if (!Number.isSafeInteger(maximumTokens) || maximumTokens < 64) {
    throw new Error("maximumTokens must be an integer of at least 64");
  }
  if (
    !Number.isSafeInteger(overlapTokens) ||
    overlapTokens < 0 ||
    overlapTokens >= maximumTokens
  ) {
    throw new Error("overlapTokens must be smaller than maximumTokens");
  }

  const text = value.trim();
  if (!text) return [];
  const output: string[] = [];
  let start = 0;
  while (start < text.length) {
    const remaining = text.slice(start);
    if (countRepositoryTokens(remaining) <= maximumTokens) {
      output.push(remaining.trim());
      break;
    }
    const hardLimit = largestPrefixWithinTokens(remaining, maximumTokens);
    const splitAt = semanticSplitPoint(remaining, hardLimit);
    const content = remaining.slice(0, splitAt).trim();
    if (content) output.push(content);
    const overlapOffset = overlapStart(content, overlapTokens);
    const nextStart = start + splitAt - (content.length - overlapOffset);
    start = Math.max(start + 1, nextStart);
    while (start < text.length && /\s/.test(text[start] ?? "")) start += 1;
  }
  return output;
}

export function truncateToRepositoryTokens(
  value: string,
  maximumTokens: number
): string {
  if (countRepositoryTokens(value) <= maximumTokens) return value;
  return value.slice(0, largestPrefixWithinTokens(value, maximumTokens)).trimEnd();
}
