/**
 * Unit tests for the shared Google Chat byte budget.
 *
 * The bug these lock down: every delivery path capped replies at 4,096
 * *characters* with `substring()`, roughly 8x below Google's real 32,000-*byte*
 * ceiling, and told the user the agent had chosen to stop.
 */
import { describe, expect, test } from 'bun:test';
import {
  CHAT_TRUNCATION_NOTICE,
  GOOGLE_CHAT_MESSAGE_BYTE_LIMIT,
  cutToByteBudget,
  fitChatMessageText,
  fitChatText,
  utf8Bytes,
  wireBytes,
} from './chat-text-budget';

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

describe('GOOGLE_CHAT_MESSAGE_BYTE_LIMIT', () => {
  test('is Google Chat’s documented per-message ceiling, not the old 4096', () => {
    expect(GOOGLE_CHAT_MESSAGE_BYTE_LIMIT).toBe(32_000);
  });
});

describe('cutToByteBudget', () => {
  test('keeps a reply that already fits byte-for-byte', () => {
    expect(cutToByteBudget('short reply', 100)).toBe('short reply');
  });

  test('never emits a partial code point when the cut lands mid-emoji', () => {
    // "🙂" is one astral code point: 2 UTF-16 units, 4 UTF-8 bytes. A budget of
    // 3 bytes must drop it entirely rather than half a surrogate pair.
    const cut = cutToByteBudget('ab🙂', 3);
    expect(cut).toBe('ab');
    expect(cut).not.toContain('�');
    expect([...cut].every(char => char.codePointAt(0)! !== 0xFFFD)).toBe(true);
  });

  test('keeps a multi-code-point grapheme whole or drops it whole', () => {
    // Family emoji: 4 people joined by ZWJ — 7 code points, 25 UTF-8 bytes.
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
    expect(bytes(family)).toBe(25);
    // A budget that lands inside the cluster must not leave a partial family.
    expect(cutToByteBudget(`x${family}`, 20)).toBe('x');
    expect(cutToByteBudget(`x${family}`, 26)).toBe(`x${family}`);
  });

  test('counts multi-byte prose in bytes, not characters', () => {
    // Each "é" is 2 bytes, so 10 characters are 20 bytes.
    const accented = 'é'.repeat(10);
    expect(bytes(cutToByteBudget(accented, 9))).toBeLessThanOrEqual(9);
    expect(cutToByteBudget(accented, 9)).toBe('é'.repeat(4));
  });

  test('keeps a base character and its combining mark together', () => {
    // NFD "á" is 'a' + U+0301: one grapheme, 3 UTF-8 bytes. Pre-slicing the
    // input to maxBytes code units before segmenting put the boundary INSIDE
    // the cluster, and the segmenter then reported the bare 'a' as a complete
    // grapheme — silently dropping the accent from the last visible character.
    const accented = 'á';
    expect(cutToByteBudget(accented, 1)).toBe('');
    expect(cutToByteBudget(accented, 2)).toBe('');
    expect(cutToByteBudget(accented, 3)).toBe(accented);
    // Same split one cluster into a longer, realistically NFD-encoded reply.
    const run = 'é'.repeat(100);
    const cut = cutToByteBudget(run, 10);
    expect(cut).toBe('é'.repeat(3));
    expect(cut.endsWith('e')).toBe(false);
  });

  test('returns empty for a non-positive budget', () => {
    expect(cutToByteBudget('anything', 0)).toBe('');
    expect(cutToByteBudget('anything', -5)).toBe('');
  });
});

describe('wireBytes', () => {
  test('counts what the string costs inside the JSON request body', () => {
    expect(wireBytes('plain')).toBe(5);
    // JSON escapes these, so they cost two bytes each, not one.
    expect(wireBytes('\n')).toBe(2);
    expect(wireBytes('"')).toBe(2);
    expect(wireBytes('\\')).toBe(2);
    // Non-ASCII is emitted literally, so it costs its UTF-8 length.
    expect(wireBytes('é')).toBe(bytes('é'));
    expect(wireBytes('🙂')).toBe(bytes('🙂'));
  });

  test('a newline-dense reply costs far more on the wire than decoded', () => {
    // The adversarial case: 32,000 decoded bytes serializing to 48,000. Budgeting
    // the decoded length would have "fitted" this to the limit and had Google
    // reject the whole request — losing the reply and dead-lettering the retry.
    const alternating = 'a\n'.repeat(16_000);
    expect(bytes(alternating)).toBe(32_000);
    expect(wireBytes(alternating)).toBe(48_000);

    const fitted = fitChatText(alternating);
    expect(fitted.truncated).toBe(true);
    expect(wireBytes(fitted.text)).toBeLessThanOrEqual(
      GOOGLE_CHAT_MESSAGE_BYTE_LIMIT
    );
  });
});

describe('fitChatText', () => {
  test('passes a 30 KB reply through untouched — the old cap would have cut 87% of it', () => {
    const reply = 'a'.repeat(30_000);
    const fitted = fitChatText(reply);

    expect(fitted.truncated).toBe(false);
    expect(fitted.text).toBe(reply);
    expect(fitted.deliveredBytes).toBe(30_000);
  });

  test('truncates only past the real ceiling, and stays within it', () => {
    const fitted = fitChatText('a'.repeat(40_000));

    expect(fitted.truncated).toBe(true);
    expect(fitted.originalBytes).toBe(40_000);
    expect(fitted.deliveredBytes).toBeLessThanOrEqual(
      GOOGLE_CHAT_MESSAGE_BYTE_LIMIT
    );
    expect(fitted.text.endsWith(CHAT_TRUNCATION_NOTICE)).toBe(true);
  });

  test('the truncation notice blames the transport, not the agent', () => {
    // The old wording ("ask me to continue") read as a choice the agent made,
    // which is why agents then truthfully denied truncating anything.
    expect(CHAT_TRUNCATION_NOTICE).toContain('Google Chat');
    expect(CHAT_TRUNCATION_NOTICE).toContain('not delivered');
    expect(CHAT_TRUNCATION_NOTICE).not.toContain('Response truncated');
  });

  test('reserves card bytes out of the same request budget', () => {
    const cardBytes = 12_000;
    const fitted = fitChatText('a'.repeat(30_000), cardBytes);

    expect(fitted.truncated).toBe(true);
    expect(fitted.deliveredBytes + cardBytes).toBeLessThanOrEqual(
      GOOGLE_CHAT_MESSAGE_BYTE_LIMIT
    );
  });

  test('a shared-space attribution prefix survives truncation', () => {
    const prefix = "[Kris Hagel's Agent] ";
    const fitted = fitChatText(`${prefix}${'a'.repeat(50_000)}`);

    expect(fitted.truncated).toBe(true);
    expect(fitted.text.startsWith(prefix)).toBe(true);
    expect(fitted.deliveredBytes).toBeLessThanOrEqual(
      GOOGLE_CHAT_MESSAGE_BYTE_LIMIT
    );
  });

  test('flags a reservation that leaves no room for prose at all', () => {
    const fitted = fitChatText('a'.repeat(1_000), GOOGLE_CHAT_MESSAGE_BYTE_LIMIT);

    expect(fitted.budgetExhausted).toBe(true);
    expect(fitted.truncated).toBe(true);
    expect(fitted.deliveredBytes).toBe(0);
  });

  test('still says the message was cut when only the notice fits', () => {
    const fitted = fitChatText(
      'a'.repeat(1_000),
      GOOGLE_CHAT_MESSAGE_BYTE_LIMIT - wireBytes(CHAT_TRUNCATION_NOTICE) + 10
    );

    expect(fitted.truncated).toBe(true);
    expect(fitted.budgetExhausted).toBe(true);
    expect(fitted.text.length).toBeGreaterThan(0);
    expect(fitted.deliveredBytes).toBeLessThanOrEqual(
      wireBytes(CHAT_TRUNCATION_NOTICE)
    );
  });

  test('fitChatMessageText reserves the card payload and its JSON scaffolding', () => {
    const richParts = { cardsV2: [{ cardId: 'c', card: { x: 'y'.repeat(500) } }] };
    const fitted = fitChatMessageText('a'.repeat(40_000), richParts);

    // Reservation covers the card JSON plus the body's keys/braces, so it is
    // strictly larger than the card payload measured on its own.
    expect(fitted.reservedBytes).toBeGreaterThan(
      utf8Bytes(JSON.stringify(richParts))
    );
    expect(fitted.deliveredBytes + fitted.reservedBytes).toBeLessThanOrEqual(
      GOOGLE_CHAT_MESSAGE_BYTE_LIMIT
    );
  });

  test('fitChatMessageText leaves a short reply with no card untouched', () => {
    const fitted = fitChatMessageText('hello', {});

    expect(fitted.truncated).toBe(false);
    expect(fitted.text).toBe('hello');
  });

  test('fitting an already-fitted reply is a no-op (the outbox re-runs it)', () => {
    const once = fitChatText('🙂'.repeat(20_000));
    const twice = fitChatText(once.text);

    expect(once.truncated).toBe(true);
    expect(twice.truncated).toBe(false);
    expect(twice.text).toBe(once.text);
  });
});
