import { createLogger, generateRequestId } from '@/lib/logger';
import type { StreamTextResult, ToolSet } from 'ai';
import { isTransientStreamError } from '@/lib/streaming/provider-adapters/base-adapter';

const log = createLogger({ module: 'dual-stream-merger' });

/** Usage data included in finish events */
interface StreamUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Discriminated union — TypeScript enforces that warning/error/chunk fields
 *  only appear on the correct event type. */
export type DualStreamEvent =
  | { modelId: 'model1' | 'model2'; type: 'content'; chunk: string }
  | { modelId: 'model1' | 'model2'; type: 'finish'; finishReason: string; usage?: StreamUsage }
  | { modelId: 'model1' | 'model2'; type: 'error'; error: string }
  | { modelId: 'model1' | 'model2'; type: 'warning'; warning: string };

/** Generic client-facing messages — raw provider errors are logged server-side only */
const CLIENT_MESSAGES = {
  initFailed: 'Stream initialization failed',
  mergeFailed: 'Stream merge failed',
  responseUnavailable: 'Comparison unavailable — model response could not be generated',
  streamFailed: 'Stream processing failed',
} as const;

/**
 * Merges two AI streaming responses into a single SSE stream with model identification.
 * Each chunk includes a modelId to distinguish between the two parallel streams.
 *
 * If one stream fails, the other continues streaming. Failed streams emit a warning
 * event so the client can notify the user ("Comparison unavailable — showing primary model only").
 *
 * Note: StreamTextResult is both a Promise AND has async iterable properties,
 * so we accept it directly and await it internally.
 */
export async function* mergeStreamsWithIdentifiers<T1 extends ToolSet, T2 extends ToolSet>(
  stream1Promise: StreamTextResult<T1, never>,
  stream2Promise: StreamTextResult<T2, never>
): AsyncGenerator<Uint8Array> {
  const requestId = generateRequestId();
  const encoder = new TextEncoder();

  log.info('Starting dual stream merge', { requestId });

  try {
    // Resolve each stream independently so one failure doesn't block the other.
    // Use allSettled to ensure both promises are handled regardless of success/failure.
    const [stream1Settled, stream2Settled] = await Promise.allSettled([
      stream1Promise,
      stream2Promise,
    ]);

    const streamTasks: AsyncGenerator<DualStreamEvent>[] = [];

    // Handle stream1
    if (stream1Settled.status === 'fulfilled') {
      streamTasks.push(processStream(stream1Settled.value, 'model1', requestId));
    } else {
      const reason = stream1Settled.reason;
      const errorMessage = reason instanceof Error ? reason.message : String(reason);
      const isTransient = reason instanceof Error && isTransientStreamError(reason);
      if (isTransient) {
        log.warn('Model 1 stream failed to initialize (transient)', { requestId, error: errorMessage });
      } else {
        log.error('Model 1 stream failed to initialize', { requestId, error: errorMessage });
      }
      streamTasks.push(emitInitFailureEvent('model1', isTransient));
    }

    // Handle stream2
    if (stream2Settled.status === 'fulfilled') {
      streamTasks.push(processStream(stream2Settled.value, 'model2', requestId));
    } else {
      const reason = stream2Settled.reason;
      const errorMessage = reason instanceof Error ? reason.message : String(reason);
      const isTransient = reason instanceof Error && isTransientStreamError(reason);
      if (isTransient) {
        log.warn('Model 2 stream failed to initialize (transient)', { requestId, error: errorMessage });
      } else {
        log.error('Model 2 stream failed to initialize', { requestId, error: errorMessage });
      }
      streamTasks.push(emitInitFailureEvent('model2', isTransient));
    }

    // Yield chunks as they arrive from either stream
    for await (const eventData of mergeAsyncIterables(streamTasks)) {
      const sseEvent = `data: ${JSON.stringify(eventData)}\n\n`;
      yield encoder.encode(sseEvent);
    }

    log.info('Dual stream merge completed', { requestId });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTransient = error instanceof Error && isTransientStreamError(error);

    if (isTransient) {
      log.warn('Dual stream merge failed (transient)', { requestId, error: errorMessage });
    } else {
      log.error('Dual stream merge failed', { requestId, error: errorMessage });
    }

    // Send terminal events for both models since a merge-level failure affects both.
    // Use warning for transient failures, error for persistent ones.
    // Always follow with finish so the client knows both models are done.
    for (const modelId of ['model1', 'model2'] as const) {
      const terminalEvent: DualStreamEvent = isTransient
        ? { modelId, type: 'warning', warning: CLIENT_MESSAGES.responseUnavailable }
        : { modelId, type: 'error', error: CLIENT_MESSAGES.mergeFailed };
      yield encoder.encode(`data: ${JSON.stringify(terminalEvent)}\n\n`);
      const finishEvent: DualStreamEvent = { modelId, type: 'finish', finishReason: 'error' };
      yield encoder.encode(`data: ${JSON.stringify(finishEvent)}\n\n`);
    }
  }
}

/**
 * Emit appropriate init failure event based on whether the error is transient.
 * Transient → warning (graceful fallback); persistent → error.
 *
 * Yields raw DualStreamEvent objects — SSE encoding happens in the caller's
 * for-await loop via encoder.encode().
 */
async function* emitInitFailureEvent(
  modelId: 'model1' | 'model2',
  isTransient: boolean
): AsyncGenerator<DualStreamEvent> {
  if (isTransient) {
    const warningEvent: DualStreamEvent = {
      modelId,
      type: 'warning',
      warning: CLIENT_MESSAGES.responseUnavailable,
    };
    yield warningEvent;
    const finishEvent: DualStreamEvent = { modelId, type: 'finish', finishReason: 'error' };
    yield finishEvent;
  } else {
    const errorEvent: DualStreamEvent = {
      modelId,
      type: 'error',
      error: CLIENT_MESSAGES.initFailed,
    };
    yield errorEvent;
    // Emit finish so client knows this model is done, consistent with the transient path.
    const finishEvent: DualStreamEvent = { modelId, type: 'finish', finishReason: 'error' };
    yield finishEvent;
  }
}

/**
 * Convert AsyncGenerator to ReadableStream for Response
 */
export function asyncGeneratorToStream(generator: AsyncGenerator<Uint8Array>): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of generator) {
          controller.enqueue(chunk);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });
}

/**
 * Process a single stream and yield SSE events with model identification.
 * On transient failures (no output, timeout, connection reset, stale ID), emits a warning
 * event so the client can show "Comparison unavailable — showing primary model only".
 * Non-transient failures emit an error event.
 *
 * Uses the shared isTransientStreamError() classifier from base-adapter to ensure
 * consistent behavior with the provider adapters' handleError() path.
 *
 * Note: Retry at this level is not possible because the merger receives a pre-created
 * StreamTextResult — it cannot recreate the stream. Retries must happen at the
 * compare route level by re-calling streamText().
 */
async function* processStream<T extends ToolSet>(
  streamResult: StreamTextResult<T, never>,
  modelId: 'model1' | 'model2',
  requestId: string
): AsyncGenerator<DualStreamEvent> {
  log.debug('Processing stream', { requestId, modelId });

  try {
    // Stream the text chunks
    for await (const chunk of streamResult.textStream) {
      const event: DualStreamEvent = {
        modelId,
        type: 'content',
        chunk
      };
      yield event;
    }

    // Wait for final result
    const result = await streamResult;

    // Wait for usage data (it's a promise in AI SDK v6)
    const usage = await result.usage;
    const finishReason = await result.finishReason;

    // Send completion event with usage data
    const finishEvent: DualStreamEvent = {
      modelId,
      type: 'finish',
      usage: usage ? {
        promptTokens: usage.inputTokens || 0,
        completionTokens: usage.outputTokens || 0,
        totalTokens: (usage.inputTokens || 0) + (usage.outputTokens || 0)
      } : undefined,
      finishReason: finishReason ?? 'stop'
    };
    yield finishEvent;

    log.info('Stream processing completed', {
      requestId,
      modelId,
      usage: result.usage
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTransient = error instanceof Error && isTransientStreamError(error);

    if (isTransient) {
      log.warn('Stream failed with transient error, falling back', {
        requestId,
        modelId,
        error: errorMessage,
      });

      // Emit warning so client can show "Comparison unavailable — showing primary model only".
      // Raw error message is logged above — send only a generic string to the browser.
      const warningEvent: DualStreamEvent = {
        modelId,
        type: 'warning',
        warning: CLIENT_MESSAGES.responseUnavailable,
      };
      yield warningEvent;

      // Emit finish so the client knows this model is done
      const finishEvent: DualStreamEvent = {
        modelId,
        type: 'finish',
        finishReason: 'error',
      };
      yield finishEvent;
    } else {
      log.error('Stream processing failed', {
        requestId,
        modelId,
        error: errorMessage,
      });

      // Non-transient failure: emit error with generic client message.
      // Raw error is logged above.
      const errorEvent: DualStreamEvent = {
        modelId,
        type: 'error',
        error: CLIENT_MESSAGES.streamFailed,
      };
      yield errorEvent;
      // Emit finish so the client knows this model is done, consistent with all other error paths.
      const finishEvent: DualStreamEvent = { modelId, type: 'finish', finishReason: 'error' };
      yield finishEvent;
    }
  }
}

/**
 * Merge multiple async iterables into a single async iterable
 * Yields items as they become available from any source
 */
/**
 * Interleave events from N async generators, yielding each event as soon as
 * it resolves. Each iteration creates N wrapper promises via Promise.race —
 * acceptable for the current N=2 (dual-stream) use case but would need a
 * more efficient approach (e.g. a shared queue) if N grows significantly.
 */
async function* mergeAsyncIterables<T>(
  iterables: AsyncGenerator<T>[]
): AsyncGenerator<T> {
  const promises: Promise<IteratorResult<T>>[] = iterables.map(it => it.next());
  const generators = [...iterables];

  while (promises.length > 0) {
    // Wait for the first promise to resolve
    const { value, done, index } = await Promise.race(
      promises.map((p, i) => p.then(result => ({ ...result, index: i })))
    );

    if (!done) {
      yield value;
      // Replace the resolved promise with the next value from the same generator
      promises[index] = generators[index].next();
    } else {
      // Remove completed generator and its promise
      promises.splice(index, 1);
      generators.splice(index, 1);
    }
  }
}
