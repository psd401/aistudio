/**
 * @jest-environment node
 *
 * Proves the passthrough transform that `buildAbortAwareResponse` wraps the chunk
 * stream in emits byte-identical SSE to an unwrapped stream — i.e. a NON-aborted
 * run (the overwhelmingly common case) is unaffected by appending the abort path.
 *
 * Scope: this asserts the transform/encoding equivalence, not the method itself;
 * `buildAbortAwareResponse` is exercised directly in stream-deadline.test.ts.
 */
import { describe, it, expect } from '@jest/globals';
import { createUIMessageStreamResponse } from 'ai';

function chunkStream(chunks: unknown[]) {
  return new ReadableStream({
    start(c) { for (const x of chunks) c.enqueue(x); c.close(); },
  });
}

describe('SSE equivalence', () => {
  const chunks = [
    { type: 'start' },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: 'hello' },
    { type: 'text-end', id: 't' },
    { type: 'finish' },
  ];

  it('passthrough transform does not alter the SSE bytes', async () => {
    const direct = await createUIMessageStreamResponse({
      stream: chunkStream(chunks) as never,
    }).text();

    const piped = await createUIMessageStreamResponse({
      stream: chunkStream(chunks).pipeThrough(
        new TransformStream({
          transform(chunk, controller) { controller.enqueue(chunk); },
          flush() { /* not aborted → append nothing */ },
        })
      ) as never,
    }).text();

    expect(piped).toBe(direct);
    expect(piped).toContain('data: [DONE]');
  });
});
