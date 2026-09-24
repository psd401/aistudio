/**
 * SSE keep-alive for long, silent model turns.
 *
 * ## Why this exists
 *
 * The ALB in front of the ECS service closes a connection after 300s with no
 * bytes in either direction (`infra/lib/constructs/ecs-service.ts`,
 * `idleTimeout: cdk.Duration.seconds(300)`). A reasoning-tier model emits a
 * `start` chunk immediately and can then go completely silent for the whole
 * think/tool phase — the per-step app budget for `gpt-5*` is itself 300s
 * (`openai-adapter.ts`, `maxTimeoutMs`), so the transport dies at or before the
 * app-level abort fires. The terminal `error` chunk that
 * `buildAbortAwareResponse` appends on abort is then enqueued into a socket
 * nobody is reading, and the user sees the turn simply stop: no answer, no
 * error, nothing persisted (FS#164150 / #1698).
 *
 * Raising the ALB timeout would not fix this — any intermediary proxy can cut a
 * silent stream too. Emitting a byte removes the idle constraint entirely.
 *
 * ## Why an SSE comment
 *
 * `: keep-alive\n\n` is the standard SSE no-op frame. Verified against the
 * installed `eventsource-parser` (used by `@ai-sdk/provider-utils`'s
 * `parseJsonEventStream` via `EventSourceParserStream`): a line whose first byte
 * is `:` is routed to the parser's `onComment` handler, which the SDK does not
 * supply, so the frame is discarded before it can reach
 * `processUIMessageStream`. The parsed chunk sequence is therefore unchanged.
 *
 * A `data-*` UIMessageChunk would NOT do: `BaseProviderAdapter.isVisibleChunkType`
 * counts `data-*` as visible output, so a keep-alive built that way would set
 * `producedVisibleOutput` and suppress the "model returned an empty response"
 * notice added in #1686.
 *
 * @see lib/streaming/provider-adapters/base-adapter.ts — the single call site
 * @see lib/voice/constants.ts — the same ALB constraint, on the WebSocket path
 */

/**
 * How long the stream may stay silent before a keep-alive frame is emitted.
 *
 * Well under the ALB's 300s idle timeout, and under the 60s that intermediary
 * proxies commonly use, so a single dropped or delayed frame still leaves
 * several more before anything times out. The cost is ~15 bytes/15s per
 * in-flight turn.
 */
export const SSE_KEEP_ALIVE_INTERVAL_MS = 15_000;

/**
 * Hard ceiling on how long a wrapped stream may stay open, whatever its source
 * is doing.
 *
 * Keep-alives defeat the ALB idle timeout on purpose, which also removes it as
 * an infrastructure backstop against a stream that never ends. Each turn is
 * already bounded by its own app deadline (`StreamDeadline`, the Assistant
 * Architect `executionDeadlineAt`); this cap is the backstop for a call site
 * whose deadline is missing or broken. It sits above the longest route budget
 * in the app (`app/api/nexus/chat/route.ts`, `maxDuration = 1800`), so it never
 * cuts a turn that its own deadline would have allowed.
 */
export const SSE_MAX_LIFETIME_MS = 40 * 60_000;

/**
 * The comment frame written during a silent stretch. Exported so tests that
 * splice frames into a mocked body stay in step with the real wire format.
 */
export const SSE_KEEP_ALIVE_FRAME = ': keep-alive\n\n';

const KEEP_ALIVE_BYTES = new TextEncoder().encode(SSE_KEEP_ALIVE_FRAME);

export interface SseKeepAliveOptions {
  /** Silence allowed before a keep-alive frame. Defaults to {@link SSE_KEEP_ALIVE_INTERVAL_MS}. */
  intervalMs?: number;
  /** Lifetime ceiling. Defaults to {@link SSE_MAX_LIFETIME_MS}. */
  maxLifetimeMs?: number;
}

/**
 * Wrap an SSE byte stream so that a gap longer than `intervalMs` is filled with
 * comment frames.
 *
 * The timer is skipped whenever real bytes went out within the interval, so an
 * actively-streaming response is byte-identical to the unwrapped one. Timers
 * are always released — on end-of-stream, on error, and on consumer cancel — so
 * an abandoned turn cannot leak an interval.
 *
 * Backpressure is preserved: the source is only read while the consumer has
 * room (`desiredSize > 0`), so a slow client stalls the model stream exactly as
 * it would without the wrapper instead of buffering the rest of the turn in
 * memory.
 *
 * A stream still open after `maxLifetimeMs` is errored (so the client sees a
 * failed request, not a clean end) and its source is cancelled.
 */
export function withSseKeepAlive(
  source: ReadableStream<Uint8Array>,
  options: SseKeepAliveOptions = {}
): ReadableStream<Uint8Array> {
  const intervalMs = options.intervalMs ?? SSE_KEEP_ALIVE_INTERVAL_MS;
  const maxLifetimeMs = options.maxLifetimeMs ?? SSE_MAX_LIFETIME_MS;
  const reader = source.getReader();
  let timer: ReturnType<typeof setInterval> | undefined;
  let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  let lastByteAt = Date.now();
  // Set once the wrapper is closed, errored or cancelled; the pump must not
  // touch the controller after that.
  let finished = false;
  // Resolves the pump's wait for the consumer to drain the queue.
  let wake: (() => void) | undefined;

  const stopTimers = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    if (lifetimeTimer !== undefined) {
      clearTimeout(lifetimeTimer);
      lifetimeTimer = undefined;
    }
  };

  const resumePump = () => {
    const resume = wake;
    wake = undefined;
    resume?.();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const hasRoom = () => (controller.desiredSize ?? 0) > 0;

      timer = setInterval(() => {
        if (Date.now() - lastByteAt < intervalMs) return;
        // Bytes are already queued for a consumer that has not read them yet;
        // another frame behind them would not reach the socket any sooner.
        if (!hasRoom()) return;
        try {
          controller.enqueue(KEEP_ALIVE_BYTES);
          lastByteAt = Date.now();
        } catch {
          // The stream is already closed or errored — nothing left to keep alive.
          stopTimers();
        }
      }, intervalMs);

      lifetimeTimer = setTimeout(() => {
        if (finished) return;
        finished = true;
        stopTimers();
        resumePump();
        const error = new Error(
          `SSE stream exceeded its ${Math.round(maxLifetimeMs / 1000)}s lifetime ceiling`
        );
        controller.error(error);
        reader.cancel(error).catch(() => {
          // The source may already be errored; there is nothing left to release.
        });
      }, maxLifetimeMs);

      // Pump from `start()` rather than `pull()`: the timer has to be able to
      // enqueue during a gap in which the pump is parked on a pending source
      // read, and a pull-driven source cannot enqueue outside `pull()`. The
      // pump still waits for `pull()` (via `wake`) whenever the queue is full.
      void (async () => {
        try {
          for (;;) {
            while (!finished && !hasRoom()) {
              await new Promise<void>(resolve => {
                wake = resolve;
              });
            }
            if (finished) return;
            const { done, value } = await reader.read();
            if (finished) return;
            if (done) break;
            lastByteAt = Date.now();
            controller.enqueue(value);
          }
          finished = true;
          stopTimers();
          controller.close();
        } catch (error) {
          stopTimers();
          if (finished) return;
          finished = true;
          controller.error(error);
        }
      })();
    },
    pull() {
      resumePump();
    },
    cancel(reason) {
      finished = true;
      stopTimers();
      resumePump();
      return reader.cancel(reason);
    },
  });
}

/**
 * Apply {@link withSseKeepAlive} to a Response's body, preserving status and
 * headers. A body-less response is returned untouched.
 */
export function withSseKeepAliveResponse(
  response: Response,
  options: SseKeepAliveOptions = {}
): Response {
  if (!response.body) return response;
  return new Response(withSseKeepAlive(response.body, options), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
