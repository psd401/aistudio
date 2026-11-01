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
import type { StreamConfig } from '../types';
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
  /** Exposes the protected config enhancement for the #1899 regression below. */
  enhance(config: StreamConfig): StreamConfig {
    return this.enhanceStreamConfig(config);
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
      // extend()/touch()/dispose() must be safe to call on the inert handle.
      deadline.extend();
      deadline.touch();
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

  /**
   * #1791: a SINGLE step that streams a large artifact (a 50-60 KB dashboard
   * through `update_workspace_artifact`) produces no step boundary until it is
   * done, so the per-step budget could abort a run that was visibly producing
   * output the whole time. `touch()` makes the budget an idle timeout.
   */
  it('does not abort a single step that keeps streaming past the step budget', () => {
    const deadline = adapter.build(30_000, 10); // ceiling 300s

    // 90s of continuous chunks inside ONE step — three times the step budget.
    for (let i = 0; i < 90; i += 1) {
      jest.advanceTimersByTime(1_000);
      deadline.touch();
    }

    expect(deadline.signal?.aborted).toBe(false);
    expect(deadline.timedOut()).toBe(false);
    deadline.dispose();
  });

  it('still aborts once the stream goes quiet for a full budget', () => {
    const deadline = adapter.build(30_000, 10);

    jest.advanceTimersByTime(10_000);
    deadline.touch(); // last chunk at T0+10s

    jest.advanceTimersByTime(29_999); // T0+39_999 — 29.999s of silence
    expect(deadline.signal?.aborted).toBe(false);

    jest.advanceTimersByTime(2); // T0+40_001 — silence exceeded the budget
    expect(deadline.signal?.aborted).toBe(true);
    expect(deadline.timedOut()).toBe(true);
    deadline.dispose();
  });

  it('keeps the absolute ceiling even under a continuous chunk stream', () => {
    const deadline = adapter.build(10_000, 3); // ceiling 30s

    // A wedged stream that emits forever must still be bounded.
    for (let i = 0; i < 100; i += 1) {
      jest.advanceTimersByTime(1_000);
      deadline.touch();
    }

    expect(deadline.signal?.aborted).toBe(true);
    expect(deadline.timedOut()).toBe(true);
    deadline.dispose();
  });

  it('ignores touch() after it has already fired', () => {
    const deadline = adapter.build(1_000);
    jest.advanceTimersByTime(1_001);
    expect(deadline.timedOut()).toBe(true);

    deadline.touch();
    jest.advanceTimersByTime(10_000);
    expect(deadline.signal?.aborted).toBe(true);
    deadline.dispose();
  });

  it('throttles touch() so per-token calls do not churn the timer', () => {
    const deadline = adapter.build(30_000, 10);

    // 500 touches inside the same throttle window cost one re-arm; the deadline
    // therefore still runs from the first touch, not the 500th.
    for (let i = 0; i < 500; i += 1) {
      deadline.touch();
    }

    jest.advanceTimersByTime(30_001);
    expect(deadline.signal?.aborted).toBe(true);
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
/* Shared fixtures for the two buildAbortAwareResponse suites below. */
class ResponseAdapter extends TestAdapter {
  build(): StreamDeadline {
    throw new Error('unused in this suite');
  }
  /** Captures the options `buildAbortAwareResponse` passes to toUIMessageStream. */
  lastStreamOptions: { onError?: (error: unknown) => string } | undefined;

  respond(
    chunks: unknown[],
    aborted: boolean,
    timedOut: boolean,
    maxSteps?: number,
    /** Nexus semantics by default; the suite below covers the other callers. */
    requireTextPart = true
  ): Response {
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    return this.buildAbortAwareResponse(
      {
        toUIMessageStream: options => {
          this.lastStreamOptions = options;
          return stream as ReadableStream<never>;
        },
        toTextStreamResponse: () => new Response('unused'),
      },
      () => aborted,
      () => timedOut,
      undefined,
      { requireTextPart, maxSteps }
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

describe('buildAbortAwareResponse', () => {
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
});

describe('buildAbortAwareResponse — answer-less turns (#1899)', () => {
  /**
   * #1899: the three answer-less shapes that used to render a blank bubble with
   * no notice at all, because `isVisibleChunkType` counted their chunks as
   * visible output. Tool cards do render, but a wall of them with no answer is
   * still a dead end, and the Nexus Thread registers NO Reasoning and NO File
   * renderer — those two drew literally nothing.
   */
  it('explains a tool-only turn that never wrote an answer', async () => {
    const chunks = await readChunks(
      responder.respond(
        [
          { type: 'start' },
          { type: 'tool-input-start', toolCallId: 'c1', toolName: 'web_fetch' },
          { type: 'tool-output-available', toolCallId: 'c1', output: { ok: true } },
          { type: 'finish-step' },
          { type: 'finish' },
        ],
        false,
        false
      )
    );
    const last = chunks.at(-1) as { type: string; errorText: string };
    expect(last.type).toBe('error');
    expect(last.errorText).toContain('used its tools but never wrote an answer');
  });

  it('explains a reasoning-only turn, which the thread renders as nothing', async () => {
    const chunks = await readChunks(
      responder.respond(
        [
          { type: 'start' },
          { type: 'reasoning-start', id: 'r1' },
          { type: 'reasoning-delta', id: 'r1', delta: 'thinking…' },
          { type: 'reasoning-end', id: 'r1' },
          { type: 'finish' },
        ],
        false,
        false
      )
    );
    const last = chunks.at(-1) as { type: string; errorText: string };
    expect(last.type).toBe('error');
    expect(last.errorText).toContain('finished thinking but never wrote an answer');
  });

  it('explains a file-only turn, which the thread also renders as nothing', async () => {
    const chunks = await readChunks(
      responder.respond(
        [
          { type: 'start' },
          { type: 'file', url: 'https://example.test/a.png', mediaType: 'image/png' },
          { type: 'finish' },
        ],
        false,
        false
      )
    );
    const last = chunks.at(-1) as { type: string; errorText: string };
    expect(last.type).toBe('error');
    expect(last.errorText).toContain('produced a file but no written answer');
  });

  it('names the step budget when every step went on tool calls', async () => {
    // `resolveMaxSteps` gives an ordinary turn three steps, so this is reachable
    // from a single `web_fetch` chain — the #1899 case 2 repro.
    const chunks = await readChunks(
      responder.respond(
        [
          { type: 'start' },
          { type: 'tool-input-start', toolCallId: 'c1', toolName: 'web_fetch' },
          { type: 'finish-step' },
          { type: 'tool-input-start', toolCallId: 'c2', toolName: 'web_fetch' },
          { type: 'finish-step' },
          { type: 'tool-input-start', toolCallId: 'c3', toolName: 'web_fetch' },
          { type: 'finish-step' },
          { type: 'finish' },
        ],
        false,
        false,
        3
      )
    );
    const last = chunks.at(-1) as { type: string; errorText: string };
    expect(last.type).toBe('error');
    expect(last.errorText).toContain('used up all of its tool steps');
  });

  it('stays silent when a direct-render tool produced the deliverable (#1898)', async () => {
    // The download card IS the answer; a notice under it would contradict it.
    const chunks = await readChunks(
      responder.respond(
        [
          { type: 'start' },
          {
            type: 'tool-input-available',
            toolCallId: 'c1',
            toolName: 'generate_document',
            input: { kind: 'docx' },
          },
          { type: 'tool-output-available', toolCallId: 'c1', output: { ok: true } },
          { type: 'finish-step' },
          { type: 'finish' },
        ],
        false,
        false,
        1
      )
    );
    expect(chunks.some(c => c.type === 'error')).toBe(false);
  });

  it('leaves non-Nexus callers on the pre-#1899 rule', async () => {
    // Assistant Architect / decision-chat / the v1 assistants API share this
    // method; a run that ends on a structured tool call is a success there, and
    // an injected error chunk makes their AI SDK client throw.
    const toolOnly = [
      { type: 'start' },
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'commit_decision' },
      { type: 'finish-step' },
      { type: 'finish' },
    ];
    expect(
      (await readChunks(responder.respond(toolOnly, false, false, 1, false))).some(
        c => c.type === 'error'
      )
    ).toBe(false);
    // A wholly silent run is still called empty for them, as before.
    const silent = await readChunks(
      responder.respond([{ type: 'start' }, { type: 'finish' }], false, false, 1, false)
    );
    expect((silent.at(-1) as { errorText: string }).errorText).toContain('empty response');
  });

  it('stays silent for a turn that rendered only a source or a data part', async () => {
    // These two the thread DOES render by itself (sources via WebSearchSource).
    // Calling such a turn "empty" would tell someone their visible answer
    // wasn't there, so the check errs towards "visible". (PR #1686 review.)
    const rendered: Array<Record<string, unknown>> = [
      { type: 'source-url', sourceId: 's1', url: 'https://example.test' },
      { type: 'data-schedule', data: { rows: 1 } },
    ];

    for (const part of rendered) {
      const chunks = await readChunks(
        responder.respond([{ type: 'start' }, part, { type: 'finish' }], false, false)
      );
      expect(chunks.some(c => c.type === 'error')).toBe(false);
    }
  });

  it('hands toUIMessageStream an onError that replaces "An error occurred."', async () => {
    // #1899 case 3: without this the AI SDK default handler is what the browser
    // renders for every mid-stream failure.
    responder.respond(okChunks, false, false);
    const onError = responder.lastStreamOptions?.onError;
    expect(typeof onError).toBe('function');
    expect(onError?.(new Error('upstream connect error: 503 service unavailable'))).toContain(
      'could not be reached'
    );
    // The raw provider text is classified, never echoed.
    expect(onError?.(new Error('request id abc-123 leaked'))).not.toContain('abc-123');
  });

  it('leaves already-streamed content intact and only appends', async () => {
    const chunks = await readChunks(responder.respond(okChunks, true, true));
    // Everything the model produced still arrives, in order, ahead of the notice.
    expect(chunks.slice(0, 3).map(c => c.type)).toEqual(['start', 'text-delta', 'finish']);
    expect(chunks).toHaveLength(4);
  });
});

/**
 * #1899 regression — the empty-turn policy keys off `config.source`, and
 * `enhanceStreamConfig` opts every field in BY HAND. When `source` was left out
 * of that list, every Nexus run silently fell back to the non-Nexus rule and the
 * whole fix was inert — a failure that is invisible, because the only symptom is
 * a notice that never appears. (Codex review of PR #1945.)
 */
describe('enhanceStreamConfig preserves the calling surface', () => {
  const base = {
    model: 'test-model' as unknown as StreamConfig['model'],
    messages: [],
  };

  it('carries `source` through enhancement', () => {
    expect(adapter.enhance({ ...base, source: 'nexus' }).source).toBe('nexus');
    expect(adapter.enhance({ ...base, source: 'compare' }).source).toBe('compare');
  });

  it('leaves it undefined when the caller set none', () => {
    expect(adapter.enhance(base).source).toBeUndefined();
  });

  it('still carries the other run-shaping fields', () => {
    // Same class of bug: each of these was added to the opt-in list after a
    // silent loss (#926 for timeout and the cost cap).
    const enhanced = adapter.enhance({
      ...base,
      maxSteps: 7,
      timeout: 1234,
      costCapCents: 50,
    });
    expect(enhanced.maxSteps).toBe(7);
    expect(enhanced.timeout).toBe(1234);
    expect(enhanced.costCapCents).toBe(50);
  });
});
