/**
 * chat-text-budget.ts — fit an agent reply into one Google Chat message.
 *
 * COPY of infra/lambdas/agent-router/chat-text-budget.ts. The cron Lambda is a
 * separate bundling target with its own package.json, so we duplicate the file
 * rather than wire up a cross-package import (same arrangement as
 * rich-envelope.ts). Keep the two byte-identical except for this header —
 * chat-text-budget.lockstep.test.ts fails if they drift.
 */

/**
 * Google Chat's documented per-message ceiling. Verbatim from
 * https://developers.google.com/workspace/chat/create-messages :
 * "The maximum message size (including any text or cards) is 32,000 bytes."
 *
 * Note that it is one combined budget for text *and* cards, which is why
 * fitChatMessageText reserves the card payload out of it rather than treating
 * the text field as having a ceiling of its own.
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

export interface FitChatTextResult {
  /** The text to send. Never exceeds the budget left after `reservedBytes`. */
  text: string;
  /** True when content was dropped, i.e. the notice is present. */
  truncated: boolean;
  /** UTF-8 size of the input body. */
  originalBytes: number;
  /** UTF-8 size of `text`. */
  deliveredBytes: number;
  /**
   * True when the reserved payload left no room for the body at all. Callers
   * should log this: the request will very likely be rejected by Google no
   * matter what we do with the prose.
   */
  budgetExhausted: boolean;
}

/** `FitChatTextResult` plus the reservation `fitChatMessageText` computed. */
export interface FitChatMessageResult extends FitChatTextResult {
  reservedBytes: number;
}

/** UTF-8 byte length of a string. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

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
  for (const { segment, index } of segmenter.segment(candidate)) {
    const size = utf8Bytes(segment);
    if (used + size > maxBytes) break;
    used += size;
    end = index + segment.length;
  }
  return candidate.slice(0, end);
}

/**
 * Fit a composed reply (prefix already applied) into the request budget.
 *
 * The body is cut from the tail, so a shared-space attribution prefix such as
 * `[Kris's Agent] ` survives as long as the budget is larger than the prefix
 * itself. `reservedBytes` is what the rest of the request already claims — the
 * JSON cost of cardsV2/accessoryWidgets and the body scaffolding around them.
 */
export function fitChatText(
  body: string,
  reservedBytes = 0
): FitChatTextResult {
  const reserved = Math.max(reservedBytes, 0);
  const originalBytes = utf8Bytes(body);
  const available = GOOGLE_CHAT_MESSAGE_BYTE_LIMIT - reserved;

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

  const bodyBudget = available - utf8Bytes(CHAT_TRUNCATION_NOTICE);
  if (bodyBudget <= 0) {
    // The reservation is so large that even the notice does not fit cleanly.
    // Send as much of the notice as there is room for: the user at least
    // learns the message was cut rather than silently receiving a fragment.
    const text = cutToByteBudget(CHAT_TRUNCATION_NOTICE.trimStart(), available);
    return {
      text,
      truncated: true,
      originalBytes,
      deliveredBytes: utf8Bytes(text),
      budgetExhausted: true,
    };
  }

  const text = cutToByteBudget(body, bodyBudget) + CHAT_TRUNCATION_NOTICE;
  return {
    text,
    truncated: true,
    originalBytes,
    deliveredBytes: utf8Bytes(text),
    budgetExhausted: false,
  };
}

/**
 * Fit the prose of a Chat message whose request also carries rich parts
 * (cardsV2 / accessoryWidgets / actionResponse).
 *
 * Reserving the serialized body with an empty text field accounts for the JSON
 * scaffolding — keys, braces, commas — as well as the card payload itself. Both
 * Lambdas call this so the reservation arithmetic cannot drift between them.
 */
export function fitChatMessageText(
  prose: string,
  richParts: Record<string, unknown>
): FitChatMessageResult {
  const reservedBytes = utf8Bytes(JSON.stringify({ ...richParts, text: '' }));
  return { ...fitChatText(prose, reservedBytes), reservedBytes };
}
