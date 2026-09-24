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

const KEEP_ALIVE_FRAME = new TextEncoder().encode(': keep-alive\n\n');

/**
 * Wrap an SSE byte stream so that a gap longer than `intervalMs` is filled with
 * comment frames.
 *
 * The timer is skipped whenever real bytes went out within the interval, so an
 * actively-streaming response is byte-identical to the unwrapped one. The timer
 * is always released — on end-of-stream, on error, and on consumer cancel — so
 * an abandoned turn cannot leak an interval.
 */
export function withSseKeepAlive(
  source: ReadableStream<Uint8Array>,
  intervalMs: number = SSE_KEEP_ALIVE_INTERVAL_MS
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastByteAt = Date.now();

  const stopTimer = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        if (Date.now() - lastByteAt < intervalMs) return;
        try {
          controller.enqueue(KEEP_ALIVE_FRAME);
          lastByteAt = Date.now();
        } catch {
          // The stream is already closed or errored — nothing left to keep alive.
          stopTimer();
        }
      }, intervalMs);

      // Pump eagerly rather than from `pull()`: the timer has to be able to
      // enqueue during a gap in which the consumer is not pulling, and the two
      // producers cannot share a pull-driven contract. SSE frames are small and
      // the consumer is a network socket, so the unbounded queue is bounded in
      // practice by the model's own output rate.
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            lastByteAt = Date.now();
            controller.enqueue(value);
          }
          stopTimer();
          controller.close();
        } catch (error) {
          stopTimer();
          controller.error(error);
        }
      })();
    },
    cancel(reason) {
      stopTimer();
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
  intervalMs: number = SSE_KEEP_ALIVE_INTERVAL_MS
): Response {
  if (!response.body) return response;
  return new Response(withSseKeepAlive(response.body, intervalMs), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
