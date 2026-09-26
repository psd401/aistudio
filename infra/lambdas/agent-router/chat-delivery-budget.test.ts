/**
 * Delivery-path tests for the Google Chat byte budget.
 *
 * Two regressions live here:
 *   1. the router truncated a reply *before* lifting the rich-card envelope out
 *      of it, so a long card reply lost its closing sentinel and the user got
 *      raw JSON (`rich_envelope_malformed`);
 *   2. the durable outbox's own size bounds were tighter than the primary Chat
 *      path's, so a retried long reply was silently dropped instead of resent.
 */
import { describe, expect, test } from 'bun:test';
import { agentRouterTestHelpers, createLogger } from './index';
import {
  CHAT_TRUNCATION_NOTICE,
  GOOGLE_CHAT_MESSAGE_BYTE_LIMIT,
} from './chat-text-budget';
import {
  RICH_ENVELOPE_CLOSE,
  RICH_ENVELOPE_OPEN,
  extractRichEnvelope,
  recomposeRichText,
} from './rich-envelope';
import { formatJobChatResponse } from './job-promotion';

const {
  prepareGoogleChatMessage,
  buildDeferredChatDeliveryEnvelope,
  parseDeferredChatDelivery,
} = agentRouterTestHelpers;

const SPACE = 'spaces/AAAA';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

function silentLog() {
  const log = createLogger({ requestId: 'chat-delivery-budget-test' });
  const warnings: { message: string; meta?: unknown }[] = [];
  const spy = {
    ...log,
    info: () => undefined,
    error: () => undefined,
    warn: (message: string, meta?: unknown) => {
      warnings.push({ message, meta });
    },
  } as unknown as ReturnType<typeof createLogger>;
  return { log: spy, warnings };
}

function card(label: string) {
  return {
    cardsV2: [
      {
        cardId: 'c1',
        card: {
          header: { title: label },
          sections: [{ widgets: [{ textParagraph: { text: label } }] }],
        },
      },
    ],
    textFallback: label,
  };
}

function wrapped(prose: string, envelope: Record<string, unknown>) {
  return `${prose}\n${RICH_ENVELOPE_OPEN}${JSON.stringify(
    envelope
  )}${RICH_ENVELOPE_CLOSE}`;
}

describe('prepareGoogleChatMessage — envelope before truncation', () => {
  test('a reply well past the old 4096 cap keeps its card intact', () => {
    const prose = 'Here is the quarterly rollup. '.repeat(400); // ~12 KB
    expect(prose.length).toBeGreaterThan(4096);
    const { log, warnings } = silentLog();

    const prepared = prepareGoogleChatMessage(
      SPACE,
      wrapped(prose, card('Q3 enrollment')),
      log
    );

    expect(prepared.hasCards).toBe(true);
    expect(prepared.messageBody.cardsV2).toBeDefined();
    expect(prepared.truncated).toBe(false);
    expect(prepared.messageBody.text).toBe(prose.trim());
    expect(
      warnings.some(entry => entry.message.includes('rich_envelope_malformed'))
    ).toBe(false);
  });

  test('a 40 KB reply with a card delivers the card and a bounded text field', () => {
    const { log } = silentLog();

    const prepared = prepareGoogleChatMessage(
      SPACE,
      wrapped('x'.repeat(40_000), card('Big board')),
      log
    );

    expect(prepared.hasCards).toBe(true);
    expect(prepared.truncated).toBe(true);
    const text = prepared.messageBody.text as string;
    expect(text.endsWith(CHAT_TRUNCATION_NOTICE)).toBe(true);
    // Text plus the card payload must fit in one request: the prose is what
    // gives way, not the card.
    const cardBytes = Buffer.byteLength(
      JSON.stringify({ cardsV2: prepared.messageBody.cardsV2 }),
      'utf8'
    );
    expect(Buffer.byteLength(text, 'utf8') + cardBytes).toBeLessThanOrEqual(
      GOOGLE_CHAT_MESSAGE_BYTE_LIMIT
    );
  });

  test('a plain 40 KB reply is cut once, at the byte ceiling', () => {
    const { log, warnings } = silentLog();

    const prepared = prepareGoogleChatMessage(SPACE, 'y'.repeat(40_000), log);

    expect(prepared.truncated).toBe(true);
    expect(
      Buffer.byteLength(prepared.messageBody.text as string, 'utf8')
    ).toBeLessThanOrEqual(GOOGLE_CHAT_MESSAGE_BYTE_LIMIT);
    expect(
      warnings.some(entry => entry.message === 'chat_text_truncated_at_cap')
    ).toBe(true);
  });

  test('re-preparing the canonical text is a no-op, so retries match attempt one', () => {
    const { log } = silentLog();
    const first = prepareGoogleChatMessage(
      SPACE,
      wrapped('z'.repeat(40_000), card('Rerun')),
      log
    );
    const second = prepareGoogleChatMessage(SPACE, first.deliverableText, log);

    expect(second.messageBody).toEqual(first.messageBody);
    expect(second.deliverableText).toBe(first.deliverableText);
  });
});

describe('recomposeRichText', () => {
  test('drops the unbudgeted textFallback so the outbox stays bounded', () => {
    const envelope = { ...card('Tiny'), textFallback: 'f'.repeat(300_000) };
    const recomposed = recomposeRichText('fitted prose', envelope);

    expect(recomposed).not.toContain('ffff');
    expect(recomposed.length).toBeLessThan(2_000);
    // Nothing is lost: a second extraction returns the prose as `remaining`,
    // so the fallback would never have been consulted again.
    const extracted = extractRichEnvelope(recomposed);
    expect(extracted.remaining).toBe('fitted prose');
    expect(extracted.envelope?.cardsV2).toEqual(envelope.cardsV2);
    expect(extracted.envelope?.textFallback).toBeUndefined();
  });

  test('round-trips prose and envelope through extraction', () => {
    const envelope = card('Round trip');
    const recomposed = recomposeRichText('some prose', envelope);
    const extracted = extractRichEnvelope(recomposed);

    expect(extracted.malformed).toBe(false);
    expect(extracted.remaining).toBe('some prose');
    expect(extracted.envelope?.cardsV2).toEqual(envelope.cardsV2);
  });

  test('returns the prose unchanged when there is no envelope', () => {
    expect(recomposeRichText('plain', null)).toBe('plain');
  });
});

describe('durable outbox accepts everything the primary path accepted', () => {
  const cases: { name: string; reply: string }[] = [
    { name: 'plain 40 KB reply', reply: 'a'.repeat(40_000) },
    { name: 'emoji-dense reply', reply: '🙂'.repeat(20_000) },
    { name: 'multi-byte prose', reply: 'é'.repeat(30_000) },
    {
      name: 'long reply carrying a card',
      reply: wrapped('b'.repeat(40_000), card('Outbox card')),
    },
    {
      // textFallback is not a field Google receives and nothing budgets it, so
      // re-wrapping it verbatim let an oversized one past the outbox bounds:
      // the primary call succeeded and the retry was dead-lettered on dequeue.
      name: 'card whose textFallback is enormous',
      reply: wrapped('', {
        ...card('Tiny card'),
        textFallback: 'f'.repeat(300_000),
      }),
    },
    {
      name: 'shared-space job reply',
      reply: formatJobChatResponse(
        { isDM: false, displayName: 'Kris Hagel' },
        'c'.repeat(40_000)
      ),
    },
  ];

  for (const { name, reply } of cases) {
    test(name, () => {
      const { log } = silentLog();
      const prepared = prepareGoogleChatMessage(SPACE, reply, log);
      const body = buildDeferredChatDeliveryEnvelope(
        {
          spaceName: SPACE,
          text: prepared.deliverableText,
          deliveryContext: {
            isSharedSpace: false,
            durableDelivery: false,
            deliveryRequestId: REQUEST_ID,
          },
        },
        REQUEST_ID
      );

      // The consumer must accept it back, otherwise the retry is dropped.
      const parsed = parseDeferredChatDelivery(body);
      expect(parsed).not.toBeNull();
      expect(parsed!.text).toBe(prepared.deliverableText);

      // And re-preparing the parsed text reproduces the same request body,
      // including any card.
      const replayed = prepareGoogleChatMessage(SPACE, parsed!.text, log);
      expect(replayed.messageBody).toEqual(prepared.messageBody);
      expect(replayed.hasCards).toBe(prepared.hasCards);
    });
  }
});
