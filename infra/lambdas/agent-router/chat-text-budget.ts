/**
 * chat-text-budget.ts — fit an agent reply into one Google Chat message.
 *
 * Google Chat rejects `spaces.messages.create` when the request's text plus
 * card payload exceeds 32,000 **bytes** (not characters). Every delivery path
 * in this Lambda used to cap replies at 4,096 *characters* — a stale limit
 * roughly 8x below the real one — and appended "(Response truncated -- ask me
 * to continue)" after AgentCore had already returned. The agent's transcript
 * therefore held the full text, so when a user said "you cut that off" the
 * agent truthfully answered that it had not truncated anything: the transport
 * did, downstream of the model.
 *
 * This module is the single place that decides what fits:
 *   - byte-aware, because the limit is bytes and prose is often non-ASCII;
 *   - grapheme-safe, because `substring()` splits surrogate pairs and emoji
 *     ZWJ sequences into replacement characters;
 *   - reservation-aware, because cardsV2/accessoryWidgets count against the
 *     same request budget as the text field.
 *
 * COPY: infra/lambdas/agent-cron/chat-text-budget.ts is the same file with a
 * different header. Keep the two in lockstep.
 */

/**
 * Google Chat's documented per-message ceiling for text + cards, in bytes.
 * https://developers.google.com/workspace/chat/limits
 */
export const GOOGLE_CHAT_MESSAGE_BYTE_LIMIT = 32_000;

/**
 * Appended when a reply genuinely did not fit. The old wording ("ask me to
 * continue") implied the agent had chosen to stop, which is what made the
 * follow-up denials so confusing. This wording names the transport as the
 * cause and offers the two things that actually recover the rest.
 */
export const CHAT_TRUNCATION_NOTICE =
  '\n\n_(Cut off here — a single Google Chat message can only carry 32,000 ' +
  'bytes, so the rest was not delivered. Ask me to send the remainder, or to ' +
  'publish the full version and share a link.)_';

export interface FitChatTextOptions {
  /** Total request budget. Defaults to Google Chat's 32,000-byte limit. */
  limitBytes?: number;
  /**
   * Bytes already claimed by non-text parts of the same request — the JSON
   * cost of cardsV2 / accessoryWidgets / actionResponse.
   */
  reservedBytes?: number;
  /** Notice appended when the body is cut. Defaults to CHAT_TRUNCATION_NOTICE. */
  notice?: string;
}

export interface FitChatTextResult {
  /** The text to send. Never exceeds `limitBytes - reservedBytes`. */
  text: string;
  /** True when content was dropped, i.e. the notice is present. */
  truncated: boolean;
  /** UTF-8 size of the input body. */
  originalBytes: number;
  /** UTF-8 size of `text`. */
  deliveredBytes: number;
  /**
   * True when the reserved payload (or an oversized notice) left no room for
   * the body at all. Callers should log this: the request will very likely be
   * rejected by Google no matter what we do with the prose.
   */
  budgetExhausted: boolean;
}

/** UTF-8 byte length of a string. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('en', { granularity: 'grapheme' })
    : null;

/**
 * Cut `text` to at most `maxBytes` UTF-8 bytes without splitting a grapheme
 * cluster. A family emoji or a flag is kept whole or dropped whole — never
 * turned into a run of U+FFFD.
 */
export function cutToByteBudget(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Bytes(text) <= maxBytes) return text;
  // A string of N UTF-16 code units is at least N bytes in UTF-8, so the first
  // `maxBytes` code units are a superset of any answer. Segmenting that slice
  // instead of the whole reply keeps this bounded on multi-megabyte input.
  const candidate = text.slice(0, maxBytes);
  let used = 0;
  let end = 0;
  if (segmenter) {
    for (const { segment, index } of segmenter.segment(candidate)) {
      const size = utf8Bytes(segment);
      if (used + size > maxBytes) break;
      used += size;
      end = index + segment.length;
    }
    return candidate.slice(0, end);
  }
  // Intl.Segmenter is present on every Node runtime this Lambda targets; the
  // fallback only guarantees code-point safety (no split surrogate pairs).
  for (const codePoint of candidate) {
    const size = utf8Bytes(codePoint);
    if (used + size > maxBytes) break;
    used += size;
    end += codePoint.length;
  }
  return candidate.slice(0, end);
}

/**
 * Fit a composed reply (prefix already applied) into the request budget.
 *
 * The body is cut from the tail, so a shared-space attribution prefix such as
 * `[Kris's Agent] ` survives as long as the budget is larger than the prefix
 * itself.
 */
export function fitChatText(
  body: string,
  options: FitChatTextOptions = {}
): FitChatTextResult {
  const limitBytes = options.limitBytes ?? GOOGLE_CHAT_MESSAGE_BYTE_LIMIT;
  const reservedBytes = Math.max(options.reservedBytes ?? 0, 0);
  const notice = options.notice ?? CHAT_TRUNCATION_NOTICE;
  const originalBytes = utf8Bytes(body);
  const available = limitBytes - reservedBytes;

  if (available <= 0) {
    return {
      text: '',
      truncated: originalBytes > 0,
      originalBytes,
      deliveredBytes: 0,
      budgetExhausted: true,
    };
  }
  if (originalBytes <= available) {
    return {
      text: body,
      truncated: false,
      originalBytes,
      deliveredBytes: originalBytes,
      budgetExhausted: false,
    };
  }

  const bodyBudget = available - utf8Bytes(notice);
  if (bodyBudget <= 0) {
    // The reservation is so large that even the notice does not fit cleanly.
    // Send as much of the notice as there is room for: the user at least
    // learns the message was cut rather than silently receiving a fragment.
    const text = cutToByteBudget(notice.trimStart(), available);
    return {
      text,
      truncated: true,
      originalBytes,
      deliveredBytes: utf8Bytes(text),
      budgetExhausted: true,
    };
  }

  const text = cutToByteBudget(body, bodyBudget) + notice;
  return {
    text,
    truncated: true,
    originalBytes,
    deliveredBytes: utf8Bytes(text),
    budgetExhausted: false,
  };
}
