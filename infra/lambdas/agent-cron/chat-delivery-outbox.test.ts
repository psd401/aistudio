import { describe, expect, test } from 'bun:test';
import { agentCronTestHelpers } from './index';

describe('scheduled Chat delivery outbox', () => {
  test('uses the router delivery envelope with a stable Chat request id', () => {
    const requestId = '11111111-1111-4111-8111-111111111111';
    const envelope = JSON.parse(
      agentCronTestHelpers.buildScheduledChatDeliveryEnvelope(
        'spaces/AAAA',
        'scheduled answer',
        requestId,
      ),
    ) as unknown;

    expect(envelope).toEqual({
      kind: 'agent-chat-delivery-v1',
      spaceName: 'spaces/AAAA',
      text: 'scheduled answer',
      deliveryContext: {
        isSharedSpace: false,
        durableDelivery: false,
        deliveryRequestId: requestId,
      },
    });
  });

  test('bounds the durable retry text before constructing the envelope', () => {
    const log = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    const prepared = agentCronTestHelpers.prepareScheduledChatMessage(
      'spaces/AAAA',
      'x'.repeat(40 * 1024),
      log,
    );
    const envelope = agentCronTestHelpers.buildScheduledChatDeliveryEnvelope(
      'spaces/AAAA',
      prepared.retryText,
      '11111111-1111-4111-8111-111111111111',
    );

    expect(prepared.retryText.length).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(envelope, 'utf8')).toBeLessThan(32 * 1024);
  });
});
