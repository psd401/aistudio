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
 *   - measured in **serialized** bytes, because the budget is spent on the
 *     request body and JSON escaping is not free (see `wireBytes`);
 *   - grapheme-safe, because `substring()` splits surrogate pairs, emoji ZWJ
 *     sequences and combining marks into replacement characters or bare bases;
 *   - reservation-aware, because cardsV2/accessoryWidgets and the request's own
 *     metadata come out of the same 32,000 bytes as the text.
 *
 * COPY: infra/lambdas/agent-cron/chat-text-budget.ts is the same file with a
 * different header. Keep the two in lockstep — chat-text-budget.lockstep.test.ts
 * fails if they drift.
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
 * Held back for request fields added after the body is built — `thread`
 * foremost, which the delivery path splices in for a threaded reply. A thread
 * name is validated at no more than 1,024 characters upstream; this covers that
 * plus the surrounding `"thread":{"name":""}` scaffolding and a little slack.
 *
 * 1,200 of 32,000 bytes is under 4% of the budget, which is a cheap price for
 * never having Google reject the assembled request outright — a rejection costs
 * the entire reply and then dead-letters every retry of it.
 */
const REQUEST_METADATA_RESERVE_BYTES = 1_200;

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
  /** The text to send. Its `wireBytes` never exceed the remaining budget. */
  text: string;
  /** True when content was dropped, i.e. the notice is present. */
  truncated: boolean;
  /** Serialized size of the input body, per `wireBytes`. */
  originalBytes: number;
  /** Serialized size of `text`, per `wireBytes`. */
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

/** Plain UTF-8 byte length. For logging and for sizing already-serialized JSON. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Bytes this string costs **inside the JSON request body**, excluding its
 * surrounding quotes.
 *
 * This is what the budget is actually spent on, and it is not the same as the
 * UTF-8 length: JSON escapes `"`, `\` and the control characters, so a newline
 * costs two bytes, not one. A markdown reply is a few percent larger on the
 * wire; a newline-dense one is far larger — an alternating `a\n` reply measures
 * 32,000 UTF-8 bytes and serializes to 48,000. Budgeting the decoded length
 * would have let that reply be "fitted" to the limit and then rejected whole,
 * which is worse than truncating it: a rejection loses the entire response and
 * dead-letters every durable retry of it.
 */
export function wireBytes(text: string): number {
  // The 2 removed bytes are the opening and closing quotes JSON.stringify adds.
  return Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
}

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * Cut `text` so it costs at most `maxBytes` on the wire, without splitting a
 * grapheme cluster. A family emoji, a flag, or a base character plus its
 * combining accent is kept whole or dropped whole — never turned into a run of
 * U+FFFD or a bare unaccented letter.
 *
 * `text` is segmented directly rather than pre-sliced. Slicing to `maxBytes`
 * code units first looks like a safe over-approximation of the answer, and for
 * byte counting it is — but it can put the slice boundary *inside* a cluster,
 * and the segmenter then reports the truncated head as a complete grapheme:
 * `cutToByteBudget('á', 1)` returned `'a'`, dropping the accent from the
 * last visible character. `Intl.Segmenter` iterates lazily, so segmenting the
 * whole reply costs no more — the loop still stops after at most `maxBytes`
 * clusters regardless of how long the reply is.
 */
export function cutToByteBudget(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (wireBytes(text) <= maxBytes) return text;
  let used = 0;
  let end = 0;
  for (const { segment, index } of segmenter.segment(text)) {
    const size = wireBytes(segment);
    if (used + size > maxBytes) break;
    used += size;
    end = index + segment.length;
  }
  return text.slice(0, end);
}

/**
 * Fit a composed reply (prefix already applied) into the request budget.
 *
 * The body is cut from the tail, so a shared-space attribution prefix such as
 * `[Kris's Agent] ` survives as long as the budget is larger than the prefix
 * itself. `reservedBytes` is what the rest of the request already claims.
 */
export function fitChatText(
  body: string,
  reservedBytes = 0
): FitChatTextResult {
  const reserved = Math.max(reservedBytes, 0);
  const originalBytes = wireBytes(body);
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

  const bodyBudget = available - wireBytes(CHAT_TRUNCATION_NOTICE);
  if (bodyBudget <= 0) {
    // The reservation is so large that even the notice does not fit cleanly.
    // Send as much of the notice as there is room for: the user at least
    // learns the message was cut rather than silently receiving a fragment.
    const text = cutToByteBudget(CHAT_TRUNCATION_NOTICE.trimStart(), available);
    return {
      text,
      truncated: true,
      originalBytes,
      deliveredBytes: wireBytes(text),
      budgetExhausted: true,
    };
  }

  const text = cutToByteBudget(body, bodyBudget) + CHAT_TRUNCATION_NOTICE;
  return {
    text,
    truncated: true,
    originalBytes,
    deliveredBytes: wireBytes(text),
    budgetExhausted: false,
  };
}

/**
 * Fit the prose of a Chat message whose request also carries rich parts
 * (cardsV2 / accessoryWidgets / actionResponse).
 *
 * The reservation is the serialized body with an empty text field — which
 * prices the card payload *and* the JSON scaffolding of keys, braces and commas
 * around it — plus a held-back allowance for request fields the delivery path
 * adds afterwards. Both Lambdas call this so the arithmetic cannot drift
 * between them.
 */
export function fitChatMessageText(
  prose: string,
  richParts: Record<string, unknown>
): FitChatMessageResult {
  const reservedBytes =
    utf8Bytes(JSON.stringify({ ...richParts, text: '' })) +
    REQUEST_METADATA_RESERVE_BYTES;
  return { ...fitChatText(prose, reservedBytes), reservedBytes };
}
