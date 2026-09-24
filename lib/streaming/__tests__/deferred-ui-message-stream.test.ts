/**
 * @jest-environment node
 *
 * #1698 — a prompt-chain assistant runs every prompt but the last to
 * completion before its streaming Response exists, so a slow earlier prompt
 * left the socket with no bytes at all until the ALB idled it out.
 *
 * Node environment for the same reason as sse-keepalive.test.ts: production
 * runs on the Node stream globals.
 *
 * @see ../deferred-ui-message-stream.ts
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
  DEFERRED_STREAM_FALLBACK_ERROR,
  deferUIMessageStreamResponse,
  uiMessageErrorFrame,
} from '../deferred-ui-message-stream';
import { SSE_KEEP_ALIVE_FRAME, SSE_KEEP_ALIVE_INTERVAL_MS } from '../sse-keep-alive';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const HEADERS = { 'X-Execution-Id': '42', 'X-Prompt-Count': '3' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sseResponse(frames: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream', ...HEADERS } }
  );
}

function jsonError(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Read the whole body while timers advance, as the HTTP layer would. */
function readAll(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  return (async () => {
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text;
      text += decoder.decode(value, { stream: true });
    }
  })();
}

const neverCalled = () => {
  throw new Error('onLateError must not run for a failure inside the grace period');
};

describe('deferUIMessageStreamResponse', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns the real Response untouched when it is ready in time', async () => {
    const real = sseResponse(['data: {"type":"start"}\n\n']);

    const response = await deferUIMessageStreamResponse(Promise.resolve(real), {
      headers: HEADERS,
      onLateError: neverCalled,
    });

    expect(response).toBe(real);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('propagates a failure inside the grace period so the route maps it as before', async () => {
    await expect(
      deferUIMessageStreamResponse(Promise.reject(new Error('bad config')), {
        headers: HEADERS,
        onLateError: neverCalled,
      })
    ).rejects.toThrow('bad config');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('commits to a kept-alive stream when the chain is slow, then delivers the answer', async () => {
    const work = deferred<Response>();

    const pendingResponse = deferUIMessageStreamResponse(work.promise, {
      headers: HEADERS,
      onLateError: neverCalled,
    });
    await jest.advanceTimersByTimeAsync(SSE_KEEP_ALIVE_INTERVAL_MS);
    const response = await pendingResponse;

    // Headers the client reads to track the execution are present up front.
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    expect(response.headers.get('X-Execution-Id')).toBe('42');

    const body = readAll(response);
    // An earlier prompt keeps running for three more intervals.
    await jest.advanceTimersByTimeAsync(SSE_KEEP_ALIVE_INTERVAL_MS * 3);
    work.resolve(sseResponse(['data: {"type":"text-delta","delta":"answer"}\n\n']));
    await jest.advanceTimersByTimeAsync(0);

    const text = await body;
    expect(text.split(SSE_KEEP_ALIVE_FRAME).length - 1).toBe(3);
    expect(text.endsWith('data: {"type":"text-delta","delta":"answer"}\n\n')).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    ['internal route shape', { error: 'Access denied' }, 'Access denied'],
    ['v1 API shape', { error: { code: 'CONTENT_BLOCKED', message: 'Blocked by policy' } }, 'Blocked by policy'],
    ['no usable message', { detail: 'x' }, DEFERRED_STREAM_FALLBACK_ERROR],
  ])('turns a late failure into an in-stream error chunk (%s)', async (_label, errorBody, expected) => {
    const work = deferred<Response>();
    const onLateError = jest.fn((_error: unknown) => jsonError(500, errorBody));

    const pendingResponse = deferUIMessageStreamResponse(work.promise, {
      headers: HEADERS,
      onLateError,
    });
    await jest.advanceTimersByTimeAsync(SSE_KEEP_ALIVE_INTERVAL_MS);
    const response = await pendingResponse;
    const body = readAll(response);

    const failure = new Error('prompt 2 failed');
    work.reject(failure);
    await jest.advanceTimersByTimeAsync(0);

    expect(await body).toBe(uiMessageErrorFrame(expected));
    expect(onLateError).toHaveBeenCalledWith(failure);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('releases the real body when the client leaves before the chain finishes', async () => {
    const work = deferred<Response>();
    let realCancelled = false;
    const real = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          realCancelled = true;
        },
      }),
      { status: 200 }
    );

    const pendingResponse = deferUIMessageStreamResponse(work.promise, {
      headers: HEADERS,
      onLateError: neverCalled,
    });
    await jest.advanceTimersByTimeAsync(SSE_KEEP_ALIVE_INTERVAL_MS);
    const response = await pendingResponse;

    await response.body!.cancel('client disconnected');
    work.resolve(real);
    await jest.advanceTimersByTimeAsync(0);

    expect(realCancelled).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });
});
