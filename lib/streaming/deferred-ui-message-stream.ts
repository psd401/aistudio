/**
 * Keep a UI-message-stream request alive while the Response itself is still
 * being built.
 *
 * `withSseKeepAlive` can only fill a gap in a body that already exists. A
 * prompt-chain assistant runs every prompt except the last to completion
 * before it builds the streaming Response for the final one
 * (`executePromptChain` in `app/api/assistant-architect/execute/route.ts` and
 * `lib/api/assistant-execution-service.ts`), so a slow earlier prompt leaves
 * the socket with no bytes at all — not even headers — and the ALB drops it
 * after 300s of idle (#1698).
 *
 * {@link deferUIMessageStreamResponse} waits a short grace period for the real
 * Response. If it arrives in time (or fails in time) the caller gets exactly
 * what it would have got without this helper, including error statuses. If
 * not, it commits to a 200 SSE response straight away, fills the wait with
 * keep-alive comments, then streams the real body once it exists — or, if the
 * work fails after the commit, a UI-message `error` chunk carrying the same
 * user-facing message the caller's error Response would have carried.
 */

import { UI_MESSAGE_STREAM_HEADERS } from 'ai';
import {
  SSE_KEEP_ALIVE_INTERVAL_MS,
  withSseKeepAlive,
  type SseKeepAliveOptions,
} from './sse-keep-alive';

/** Message used when a late failure's error Response carries none. */
export const DEFERRED_STREAM_FALLBACK_ERROR = 'The request failed. Please try again.';

export interface DeferUIMessageStreamOptions extends SseKeepAliveOptions {
  /** Headers for the committed response (merged over the SDK's SSE headers). */
  headers: Record<string, string>;
  /**
   * Map a failure that arrives after the response was committed to the error
   * Response the route would otherwise have returned. It is used for its side
   * effects (logging, compensation) and for its user-facing message; its
   * status can no longer be sent.
   */
  onLateError: (error: unknown) => Response | Promise<Response>;
  /** How long to wait for the real Response before committing. */
  graceMs?: number;
}

const encoder = new TextEncoder();

/** One UI-message-stream `error` chunk as an SSE frame. */
export function uiMessageErrorFrame(errorText: string): string {
  return `data: ${JSON.stringify({ type: 'error', errorText })}\n\n`;
}

/**
 * Pull the user-facing message out of an error Response. Understands both
 * shapes the app returns: `{ error: string }` (internal routes) and
 * `{ error: { message } }` (`createErrorResponse`, the v1 API).
 */
async function errorMessageFrom(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
    if (body.error !== null && typeof body.error === 'object') {
      const message = (body.error as { message?: unknown }).message;
      if (typeof message === 'string' && message) return message;
    }
  } catch {
    // Not JSON — fall through to the generic message.
  }
  return DEFERRED_STREAM_FALLBACK_ERROR;
}

/**
 * The body of a committed response: silent until `pending` settles, then the
 * real body, or a single error frame.
 */
function deferredBody(
  pending: Promise<Response>,
  onLateError: DeferUIMessageStreamOptions['onLateError']
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;

  const failWith = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
    errorResponse: Response
  ) => {
    const message = await errorMessageFrom(errorResponse);
    if (cancelled) return;
    controller.enqueue(encoder.encode(uiMessageErrorFrame(message)));
    controller.close();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!reader) {
        let response: Response;
        try {
          response = await pending;
        } catch (error) {
          const errorResponse = await onLateError(error);
          await failWith(controller, errorResponse);
          return;
        }
        if (cancelled) {
          await response.body?.cancel('client disconnected');
          return;
        }
        if (!response.ok || !response.body) {
          await failWith(controller, response);
          return;
        }
        reader = response.body.getReader();
      }
      const { done, value } = await reader.read();
      if (cancelled) return;
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      cancelled = true;
      if (reader) return reader.cancel(reason);
      // The work is still running; release its body once it exists so the
      // model stream is not left generating for nobody.
      pending.then(
        response => response.body?.cancel(reason),
        () => undefined
      );
      return undefined;
    },
  });
}

/**
 * Resolve to `pending`'s Response if it settles within `graceMs`; otherwise to
 * a committed SSE Response kept alive until it does. A rejection within the
 * grace period propagates unchanged, so the caller's existing error mapping
 * still applies to every fast failure.
 */
export async function deferUIMessageStreamResponse(
  pending: Promise<Response>,
  options: DeferUIMessageStreamOptions
): Promise<Response> {
  const graceMs = options.graceMs ?? SSE_KEEP_ALIVE_INTERVAL_MS;
  const graceElapsed = Symbol('graceElapsed');
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const first = await Promise.race([
    pending,
    new Promise<typeof graceElapsed>(resolve => {
      graceTimer = setTimeout(() => resolve(graceElapsed), graceMs);
    }),
  ]).finally(() => clearTimeout(graceTimer));

  if (first !== graceElapsed) return first;

  return new Response(
    withSseKeepAlive(deferredBody(pending, options.onLateError), options),
    {
      status: 200,
      headers: { ...UI_MESSAGE_STREAM_HEADERS, ...options.headers },
    }
  );
}
