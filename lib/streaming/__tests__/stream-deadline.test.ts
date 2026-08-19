/**
 * @jest-environment node
 *
 * Unit tests for the step-aware stream wall-clock budget.
 *
 * Runs in the node environment: `buildAbortAwareResponse` pipes through a
 * `TransformStream`, and jsdom's `ReadableStream` is a different class from the
 * one Node's `TransformStream` accepts ("transform.readable must be an instance
 * of ReadableStream"). Production runs on the Node globals, so node is the
 * faithful environment here.
 *
 * The previous implementation was a plain `AbortSignal.timeout(timeoutMs)` over
 * the whole `streamText` call. That clock covered tool execution as well as model
 * calls, so with multi-step tool use a slow tool silently spent the model's time
 * to answer. In production a Nexus attachment turn called a retrieval tool that
 * returned at +7s, and the run was aborted at exactly +30s having produced no
 * text at all.
 *
 * `buildStreamDeadline` gives each step its own budget, pushed forward at every
 * step boundary, with an absolute ceiling still bounding a runaway loop.
 *
 * @see ../provider-adapters/base-adapter.ts
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { BaseProviderAdapter, type StreamDeadline } from '../provider-adapters/base-adapter';
import { createLogger } from '@/lib/logger';

/** Minimal concrete adapter exposing the protected budget builder. */
class TestAdapter extends BaseProviderAdapter {
  protected providerName = 'test';
  async createModel(): Promise<never> {
    throw new Error('not used — these tests never stream');
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
  build(timeoutMs: number | undefined, maxSteps?: number): StreamDeadline {
    return this.buildStreamDeadline(timeoutMs, maxSteps, createLogger({ module: 'test' }));
  }
}

const adapter = new TestAdapter();

describe('buildStreamDeadline', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('is inert when no timeout is configured', () => {
    for (const value of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const deadline = adapter.build(value as number | undefined);
      expect(deadline.signal).toBeUndefined();
      expect(deadline.timedOut()).toBe(false);
      // extend()/dispose() must be safe to call on the inert handle.
      deadline.extend();
      deadline.dispose();
    }
  });

  it('aborts a single-step run once its budget elapses', () => {
    const deadline = adapter.build(30_000);
    expect(deadline.signal?.aborted).toBe(false);

    jest.advanceTimersByTime(29_999);
    expect(deadline.signal?.aborted).toBe(false);
    expect(deadline.timedOut()).toBe(false);

    jest.advanceTimersByTime(2);
    expect(deadline.signal?.aborted).toBe(true);
    expect(deadline.timedOut()).toBe(true);

    deadline.dispose();
  });

  it('does NOT charge tool-execution time to the next step — the prod bug', () => {
    // Reproduces the incident's shape: a 30s budget, a tool round-trip that
    // finishes at +7s, then the model writing its answer. Under the old
    // single-clock behaviour the answer was cut off 23s later at exactly +30s.
    const deadline = adapter.build(30_000, 10);

    jest.advanceTimersByTime(7_000); // tool call + tool execution
    deadline.extend(); // step boundary

    // The old clock would fire here (T0+30s). The step-aware one must not.
    jest.advanceTimersByTime(23_001);
    expect(deadline.signal?.aborted).toBe(false);
    expect(deadline.timedOut()).toBe(false);

    // The answering step still gets its own full 30s from the boundary at T0+7s,
    // so the budget now runs to T0+37s rather than T0+30s.
    jest.advanceTimersByTime(6_998); // T0+36_999
    expect(deadline.signal?.aborted).toBe(false);

    jest.advanceTimersByTime(2); // T0+37_001
    expect(deadline.signal?.aborted).toBe(true);

    deadline.dispose();
  });

  it('still bounds a runaway loop at timeout x maxSteps', () => {
    const deadline = adapter.build(10_000, 3); // ceiling 30s

    // A loop that keeps producing step boundaries cannot extend forever.
    for (let i = 0; i < 10; i += 1) {
      jest.advanceTimersByTime(5_000);
      deadline.extend();
    }

    expect(deadline.signal?.aborted).toBe(true);
    expect(deadline.timedOut()).toBe(true);
    deadline.dispose();
  });

  it('caps the ceiling regardless of how large maxSteps is', () => {
    const deadline = adapter.build(120_000, 1000); // would be 120000s uncapped

    // ABSOLUTE_STREAM_CEILING_MS is 10 minutes.
    for (let i = 0; i < 200; i += 1) {
      jest.advanceTimersByTime(60_000);
      deadline.extend();
    }
    expect(deadline.signal?.aborted).toBe(true);
    deadline.dispose();
  });

  it('ignores extend() after it has already fired', () => {
    const deadline = adapter.build(1_000);
    jest.advanceTimersByTime(1_001);
    expect(deadline.timedOut()).toBe(true);

    deadline.extend();
    jest.advanceTimersByTime(10_000);
    // Still aborted — a late step boundary must not resurrect the run.
    expect(deadline.signal?.aborted).toBe(true);
    expect(deadline.timedOut()).toBe(true);
    deadline.dispose();
  });

  it('stops the timer on dispose so a finished stream leaves nothing pending', () => {
    const deadline = adapter.build(5_000);
    deadline.dispose();
    jest.advanceTimersByTime(60_000);
    expect(deadline.signal?.aborted).toBe(false);
    expect(deadline.timedOut()).toBe(false);
    // Repeated dispose is safe.
    deadline.dispose();
  });

  it('carries an explanatory abort reason', () => {
    const deadline = adapter.build(1_000);
    jest.advanceTimersByTime(1_001);
    expect(String((deadline.signal as AbortSignal).reason)).toContain('budget');
    deadline.dispose();
  });
});

/**
 * An aborted run must become VISIBLE to the person watching the thread.
 *
 * ai@6.0.208 enqueues an `abort` UI chunk on abort but raises no client-side
 * error, so the browser just sees the stream stop — the "it died mid-response"
 * symptom. An `error` chunk DOES reach the client and renders through
 * `MessagePrimitive.Error`, so the adapter appends one when the run was cut short.
 */
describe('buildAbortAwareResponse', () => {
  class ResponseAdapter extends TestAdapter {
    build(): StreamDeadline {
      throw new Error('unused in this suite');
    }
    respond(chunks: unknown[], aborted: boolean, timedOut: boolean): Response {
      const stream = new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(c);
          controller.close();
        },
      });
      return this.buildAbortAwareResponse(
        {
          toUIMessageStream: () => stream as ReadableStream<never>,
          toTextStreamResponse: () => new Response('unused'),
        },
        () => aborted,
        () => timedOut
      );
    }
  }

  const responder = new ResponseAdapter();
  const okChunks = [
    { type: 'start' },
    { type: 'text-delta', id: 't', delta: 'Here is the schedule.' },
    { type: 'finish' },
  ];

  /** Decode the SSE body back into UI message chunks. */
  async function readChunks(res: Response): Promise<Array<Record<string, unknown>>> {
    const body = await res.text();
    return body
      .split('\n\n')
      .map(frame => frame.replace(/^data: /, '').trim())
      .filter(payload => payload.length > 0 && payload !== '[DONE]')
      .map(payload => JSON.parse(payload) as Record<string, unknown>);
  }

  it('adds nothing to a run that completed normally', async () => {
    const chunks = await readChunks(responder.respond(okChunks, false, false));
    expect(chunks.some(c => c.type === 'error')).toBe(false);
    expect(chunks.map(c => c.type)).toEqual(['start', 'text-delta', 'finish']);
  });

  it('appends a terminal error chunk explaining a timed-out run', async () => {
    const chunks = await readChunks(responder.respond(okChunks, true, true));
    const error = chunks.at(-1) as { type: string; errorText: string };

    expect(error.type).toBe('error');
    // The client renders errorText verbatim, so it must read as an explanation,
    // not a stack trace or an error code.
    expect(error.errorText).toContain('cut off');
    expect(error.errorText).toContain('ran out of time');
  });

  it('distinguishes an interruption from a timeout', async () => {
    const chunks = await readChunks(responder.respond(okChunks, true, false));
    const error = chunks.at(-1) as { type: string; errorText: string };

    expect(error.type).toBe('error');
    expect(error.errorText).toContain('interrupted');
    expect(error.errorText).not.toContain('ran out of time');
  });

  it('explains an empty response even when the run was NOT aborted', async () => {
    // A run that ends cleanly having emitted nothing is still a dead end: the
    // route refuses to persist it, so without a notice the stream would simply
    // stop and reload as though the turn never happened. (PR #1686 review.)
    const chunks = await readChunks(
      responder.respond([{ type: 'start' }, { type: 'finish' }], false, false)
    );
    const last = chunks.at(-1) as { type: string; errorText: string };
    expect(last.type).toBe('error');
    expect(last.errorText).toContain('empty response');
  });

  it('stays silent for a tool-only turn, which the thread still renders', async () => {
    const chunks = await readChunks(
      responder.respond(
        [
          { type: 'start' },
          { type: 'tool-input-start', toolCallId: 'c1', toolName: 'searchNexusAttachments' },
          { type: 'tool-output-available', toolCallId: 'c1', output: { ok: true } },
          { type: 'finish' },
        ],
        false,
        false
      )
    );
    expect(chunks.some(c => c.type === 'error')).toBe(false);
  });

  it('leaves already-streamed content intact and only appends', async () => {
    const chunks = await readChunks(responder.respond(okChunks, true, true));
    // Everything the model produced still arrives, in order, ahead of the notice.
    expect(chunks.slice(0, 3).map(c => c.type)).toEqual(['start', 'text-delta', 'finish']);
    expect(chunks).toHaveLength(4);
  });
});
