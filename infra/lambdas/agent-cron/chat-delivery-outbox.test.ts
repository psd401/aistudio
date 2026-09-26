import { describe, expect, test } from 'bun:test';
import { agentCronTestHelpers } from './index';
import {
  CHAT_TRUNCATION_NOTICE,
  GOOGLE_CHAT_MESSAGE_BYTE_LIMIT,
} from './chat-text-budget';
import {
  RICH_ENVELOPE_CLOSE,
  RICH_ENVELOPE_OPEN,
  extractRichEnvelope,
} from './rich-envelope';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

const log = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const CARD_ENVELOPE = {
  cardsV2: [
    {
      cardId: 'brief',
      card: { header: { title: 'Morning brief' } },
    },
  ],
  textFallback: 'Morning brief',
};

function wrapped(prose: string, envelope: Record<string, unknown>) {
  return `${prose}\n${RICH_ENVELOPE_OPEN}${JSON.stringify(
    envelope
  )}${RICH_ENVELOPE_CLOSE}`;
}

describe('scheduled Chat delivery outbox', () => {
  test('uses the router delivery envelope with a stable Chat request id', () => {
    const envelope = JSON.parse(
      agentCronTestHelpers.buildScheduledChatDeliveryEnvelope(
        'spaces/AAAA',
        'scheduled answer',
        REQUEST_ID,
      ),
    ) as unknown;

    expect(envelope).toEqual({
      kind: 'agent-chat-delivery-v1',
      spaceName: 'spaces/AAAA',
      text: 'scheduled answer',
      deliveryContext: {
        isSharedSpace: false,
        durableDelivery: false,
        deliveryRequestId: REQUEST_ID,
      },
    });
  });

  test('a 30 KB brief is delivered whole — the old 4096-char cap dropped 87% of it', () => {
    const prepared = agentCronTestHelpers.prepareScheduledChatMessage(
      'spaces/AAAA',
      'x'.repeat(30_000),
      log,
    );

    expect(prepared.truncated).toBe(false);
    expect(prepared.responseBytes).toBe(30_000);
  });

  test('bounds the durable retry text against the real byte ceiling', () => {
    const prepared = agentCronTestHelpers.prepareScheduledChatMessage(
      'spaces/AAAA',
      'x'.repeat(40 * 1024),
      log,
    );
    const envelope = agentCronTestHelpers.buildScheduledChatDeliveryEnvelope(
      'spaces/AAAA',
      prepared.retryText,
      REQUEST_ID,
    );

    expect(prepared.truncated).toBe(true);
    expect(prepared.responseBytes).toBeLessThanOrEqual(
      GOOGLE_CHAT_MESSAGE_BYTE_LIMIT,
    );
    expect(prepared.retryText.endsWith(CHAT_TRUNCATION_NOTICE)).toBe(true);
    // The envelope guard must not reject what the primary call accepted.
    expect(Buffer.byteLength(envelope, 'utf8')).toBeLessThan(240 * 1024);
  });

  test('cuts on grapheme boundaries, never mid-emoji', () => {
    const prepared = agentCronTestHelpers.prepareScheduledChatMessage(
      'spaces/AAAA',
      '🙂'.repeat(20_000),
      log,
    );

    expect(prepared.truncated).toBe(true);
    expect(prepared.requestBody.text as string).not.toContain('�');
  });

  test('a card survives truncation and survives the retry path', () => {
    const prepared = agentCronTestHelpers.prepareScheduledChatMessage(
      'spaces/AAAA',
      wrapped('b'.repeat(40_000), CARD_ENVELOPE),
      log,
    );

    expect(prepared.hasCards).toBe(true);
    expect(prepared.truncated).toBe(true);
    expect(prepared.requestBody.cardsV2).toEqual(CARD_ENVELOPE.cardsV2);

    // The outbox carries the re-wrapped envelope, so the retry still renders a
    // card rather than degrading to plain prose.
    const replayed = extractRichEnvelope(prepared.retryText);
    expect(replayed.malformed).toBe(false);
    expect(replayed.envelope?.cardsV2).toEqual(CARD_ENVELOPE.cardsV2);
    expect(replayed.remaining).toBe(prepared.requestBody.text as string);
  });

  test('re-preparing the retry text reproduces the same request body', () => {
    const first = agentCronTestHelpers.prepareScheduledChatMessage(
      'spaces/AAAA',
      wrapped('c'.repeat(40_000), CARD_ENVELOPE),
      log,
    );
    const second = agentCronTestHelpers.prepareScheduledChatMessage(
      'spaces/AAAA',
      first.retryText,
      log,
    );

    expect(second.requestBody).toEqual(first.requestBody);
    expect(second.retryText).toBe(first.retryText);
  });
});
