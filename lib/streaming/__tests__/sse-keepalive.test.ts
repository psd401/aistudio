/**
 * @jest-environment node
 *
 * Regression tests for FS#164150 / #1698 — "chat appears to have been ingested,
 * but then abandoned".
 *
 * A reasoning-tier turn emits `start` immediately and can then go silent for
 * the whole think/tool phase. The ALB idles out at 300s
 * (`infra/lib/constructs/ecs-service.ts`) and the `gpt-5*` per-step budget is
 * also 300s, so the transport died at or before the app-level abort fired: the
 * terminal `error` chunk appended by `buildAbortAwareResponse` (#1686) went
 * into a socket nobody was reading. The user saw nothing at all.
 *
 * Runs in the node environment for the same reason as stream-deadline.test.ts:
 * jsdom's `ReadableStream` is a different class from the one Node's stream
 * primitives accept, and production runs on the Node globals.
 *
 * @see ../sse-keep-alive.ts
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { BaseProviderAdapter } from '../provider-adapters/base-adapter';
import {
  SSE_KEEP_ALIVE_INTERVAL_MS,
  withSseKeepAlive,
  withSseKeepAliveResponse,
} from '../sse-keep-alive';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A source stream whose emissions the test drives by hand. */
function controllableSource() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    emit: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    wasCancelled: () => cancelled,
  };
}

/** Read everything currently queued without blocking on an open stream. */
async function drain(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number
): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(decoder.decode(value));
  }
  return out;
}

describe('withSseKeepAlive', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('emits a keep-alive frame for every silent interval', async () => {
    const source = controllableSource();
    const reader = withSseKeepAlive(source.stream).getReader();

    await jest.advanceTimersByTimeAsync(SSE_KEEP_ALIVE_INTERVAL_MS * 3);

    const frames = await drain(reader, 3);
    expect(frames).toEqual([': keep-alive\n\n', ': keep-alive\n\n', ': keep-alive\n\n']);
  });

  it('stays byte-identical while the model is actually producing output', async () => {
    const source = controllableSource();
    const reader = withSseKeepAlive(source.stream).getReader();

    // Real bytes arriving comfortably inside the interval must suppress the
    // filler entirely — an actively-streaming response is unchanged.
    for (let i = 0; i < 4; i++) {
      source.emit(`data: {"type":"text-delta","delta":"${i}"}\n\n`);
      await jest.advanceTimersByTimeAsync(SSE_KEEP_ALIVE_INTERVAL_MS - 1);
    }
    source.close();

    const frames = await drain(reader, 10);
    expect(frames.some(frame => frame.startsWith(':'))).toBe(false);
    expect(frames).toHaveLength(4);
  });

  it('resumes filling once output goes quiet again', async () => {
    const source = controllableSource();
    const reader = withSseKeepAlive(source.stream).getReader();

    source.emit('data: {"type":"start"}\n\n');
    await jest.advanceTimersByTimeAsync(SSE_KEEP_ALIVE_INTERVAL_MS * 2);

    const frames = await drain(reader, 3);
    expect(frames[0]).toBe('data: {"type":"start"}\n\n');
    expect(frames.slice(1)).toEqual([': keep-alive\n\n', ': keep-alive\n\n']);
  });

  it('releases the timer when the source ends', async () => {
    const source = controllableSource();
    const reader = withSseKeepAlive(source.stream).getReader();

    source.emit('data: [DONE]\n\n');
    source.close();
    await drain(reader, 1);
    expect(await reader.read()).toEqual({ done: true, value: undefined });

    expect(jest.getTimerCount()).toBe(0);
  });

  it('releases the timer and cancels the source when the consumer gives up', async () => {
    const source = controllableSource();
    const wrapped = withSseKeepAlive(source.stream);

    await wrapped.cancel('client disconnected');
    await jest.advanceTimersByTimeAsync(SSE_KEEP_ALIVE_INTERVAL_MS * 5);

    expect(jest.getTimerCount()).toBe(0);
    expect(source.wasCancelled()).toBe(true);
  });

  it('releases the timer when the source errors', async () => {
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('upstream exploded'));
      },
    });
    const reader = withSseKeepAlive(failing).getReader();

    await expect(reader.read()).rejects.toThrow('upstream exploded');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('fires well before the ALB idle timeout so a long gap survives', () => {
    // `infra/lib/constructs/ecs-service.ts` → idleTimeout 300s. The margin must
    // leave room for several missed frames, not just one.
    expect(SSE_KEEP_ALIVE_INTERVAL_MS).toBeLessThanOrEqual(30_000);
    expect(SSE_KEEP_ALIVE_INTERVAL_MS).toBeGreaterThan(0);
  });
});

describe('keep-alive frames are invisible to the client parser', () => {
  it('produces no events through the SSE parser the AI SDK uses', async () => {
    // @ai-sdk/provider-utils' parseJsonEventStream pipes through
    // EventSourceParserStream with no `onComment` handler, so `:`-prefixed
    // lines are dropped before any chunk is materialised. This is the
    // assumption the whole approach rests on.
    const body =
      'data: {"type":"start"}\n\n' +
      ': keep-alive\n\n' +
      ': keep-alive\n\n' +
      'data: {"type":"text-delta","id":"t","delta":"hi"}\n\n' +
      'data: [DONE]\n\n';

    const events: string[] = [];
    const stream = new ReadableStream<string>({
      start(c) {
        c.enqueue(body);
        c.close();
      },
    }).pipeThrough(new EventSourceParserStream());

    for await (const event of stream as unknown as AsyncIterable<{ data: string }>) {
      events.push(event.data);
    }

    expect(events).toEqual([
      '{"type":"start"}',
      '{"type":"text-delta","id":"t","delta":"hi"}',
      '[DONE]',
    ]);
  });
});

describe('buildAbortAwareResponse keeps a silent turn alive', () => {
  /** Minimal concrete adapter exposing the protected response builder. */
  class ResponseAdapter extends BaseProviderAdapter {
    protected providerName = 'test';
    async createModel(): Promise<never> {
      throw new Error('not used — this test never streams from a provider');
    }
    getCapabilities() {
      return this.getDefaultCapabilities();
    }
    getSupportedTools(): string[] {
      return [];
    }
    supportsModel() {
      return true;
    }
    respond(chunkStream: ReadableStream<never>): Response {
      return this.buildAbortAwareResponse(
        {
          toUIMessageStream: () => chunkStream,
          toTextStreamResponse: () => new Response('unused'),
        },
        () => false,
        () => false
      );
    }
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fills a reasoning gap with comment frames and still delivers the chunks', async () => {
    let controller!: ReadableStreamDefaultController<unknown>;
    const chunks = new ReadableStream<unknown>({
      start(c) {
        controller = c;
      },
    });

    const response = new ResponseAdapter().respond(chunks as ReadableStream<never>);
    const reader = response.body!.getReader();

    // `start` goes out immediately — this is what resets the ALB idle timer
    // once and then never again while the model thinks.
    controller.enqueue({ type: 'start' });

    // Two full intervals of total silence, the shape of the reported failure.
    await jest.advanceTimersByTimeAsync(SSE_KEEP_ALIVE_INTERVAL_MS * 2);

    controller.enqueue({ type: 'text-delta', id: 't', delta: 'found it' });
    controller.close();
    await jest.advanceTimersByTimeAsync(0);

    let body = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }

    expect(body.match(/^: keep-alive$/gm)?.length).toBe(2);
    expect(body).toContain('"type":"start"');
    expect(body).toContain('found it');
    // The keep-alives sit in the gap, not after the answer.
    expect(body.indexOf(': keep-alive')).toBeLessThan(body.indexOf('found it'));
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('withSseKeepAliveResponse', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('preserves status and headers', () => {
    const source = controllableSource();
    const wrapped = withSseKeepAliveResponse(
      new Response(source.stream, {
        status: 200,
        headers: { 'x-vercel-ai-ui-message-stream': 'v1', 'x-request-id': 'abc' },
      })
    );

    expect(wrapped.status).toBe(200);
    expect(wrapped.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    expect(wrapped.headers.get('x-request-id')).toBe('abc');
    void wrapped.body?.cancel();
  });

  it('returns a body-less response untouched', () => {
    const original = new Response(null, { status: 204 });
    expect(withSseKeepAliveResponse(original)).toBe(original);
  });
});
