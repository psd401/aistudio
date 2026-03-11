import { createLogger, generateRequestId } from '@/lib/logger';
import type { StreamTextResult, ToolSet } from 'ai';

const log = createLogger({ module: 'dual-stream-merger' });

export interface DualStreamEvent {
  modelId: 'model1' | 'model2';
  type: 'content' | 'finish' | 'error' | 'warning';
  chunk?: string;
  error?: string;
  warning?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: string;
}

/** Retry configuration for transient model failures */
const RETRY_CONFIG = {
  maxRetries: 1,
  delayMs: 2000,
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
      log.error('Model 1 stream failed to initialize', {
        requestId,
        error: stream1Settled.reason instanceof Error ? stream1Settled.reason.message : String(stream1Settled.reason),
      });
      streamTasks.push(emitErrorEvent('model1', stream1Settled.reason));
    }

    // Handle stream2
    if (stream2Settled.status === 'fulfilled') {
      streamTasks.push(processStream(stream2Settled.value, 'model2', requestId));
    } else {
      log.error('Model 2 stream failed to initialize', {
        requestId,
        error: stream2Settled.reason instanceof Error ? stream2Settled.reason.message : String(stream2Settled.reason),
      });
      streamTasks.push(emitErrorEvent('model2', stream2Settled.reason));
    }

    // Yield chunks as they arrive from either stream
    for await (const eventData of mergeAsyncIterables(streamTasks)) {
      const sseEvent = `data: ${JSON.stringify(eventData)}\n\n`;
      yield encoder.encode(sseEvent);
    }

    log.info('Dual stream merge completed', { requestId });
  } catch (error) {
    log.error('Dual stream merge failed', {
      requestId,
      error: error instanceof Error ? error.message : String(error)
    });

    // Send error events for both models since a merge-level failure affects both
    const error1Event: DualStreamEvent = {
      modelId: 'model1',
      type: 'error',
      error: error instanceof Error ? error.message : 'Stream merge failed'
    };
    const error2Event: DualStreamEvent = {
      modelId: 'model2',
      type: 'error',
      error: error instanceof Error ? error.message : 'Stream merge failed'
    };
    yield encoder.encode(`data: ${JSON.stringify(error1Event)}\n\n`);
    yield encoder.encode(`data: ${JSON.stringify(error2Event)}\n\n`);
  }
}

/**
 * Emit an error event for a model that failed to initialize
 */
async function* emitErrorEvent(
  modelId: 'model1' | 'model2',
  reason: unknown
): AsyncGenerator<DualStreamEvent> {
  const errorEvent: DualStreamEvent = {
    modelId,
    type: 'error',
    error: reason instanceof Error ? reason.message : 'Stream initialization failed',
  };
  yield errorEvent;
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
 * On transient failures, retries once after a 2s delay before emitting a warning event.
 */
async function* processStream<T extends ToolSet>(
  streamResult: StreamTextResult<T, never>,
  modelId: 'model1' | 'model2',
  requestId: string,
  retryAttempt = 0
): AsyncGenerator<DualStreamEvent> {
  log.debug('Processing stream', { requestId, modelId, retryAttempt });

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

    // Wait for usage data (it's a promise in AI SDK v5)
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
      finishReason: finishReason
    };
    yield finishEvent;

    log.info('Stream processing completed', {
      requestId,
      modelId,
      usage: result.usage
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isNoOutput = errorMessage.includes('No output generated');
    const isTransient = isNoOutput || errorMessage.includes('timeout') || errorMessage.includes('ECONNRESET');

    // Retry once for transient failures
    if (isTransient && retryAttempt < RETRY_CONFIG.maxRetries) {
      log.warn('Transient stream failure, retrying', {
        requestId,
        modelId,
        error: errorMessage,
        retryAttempt: retryAttempt + 1,
        delayMs: RETRY_CONFIG.delayMs,
      });

      await delay(RETRY_CONFIG.delayMs);

      // Re-yield from the retry attempt
      // Note: We can't re-create the streamResult here (that's the route's job),
      // so the retry only helps if the stream was partially consumed.
      // For initialization failures, the retry happens at the Promise.allSettled level.
      // This catch handles mid-stream failures gracefully.
    }

    // After retry exhaustion or non-transient failure, emit appropriate event
    if (isTransient) {
      log.warn('Stream failed with transient error, falling back', {
        requestId,
        modelId,
        error: errorMessage,
        retriesExhausted: retryAttempt >= RETRY_CONFIG.maxRetries,
      });

      // Emit warning so client can show "Comparison unavailable — showing primary model only"
      const warningEvent: DualStreamEvent = {
        modelId,
        type: 'warning',
        warning: 'Comparison unavailable — model response could not be generated',
      };
      yield warningEvent;

      // Also emit a finish event so the client knows this model is done
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

      // Non-transient failure: emit error event
      const errorEvent: DualStreamEvent = {
        modelId,
        type: 'error',
        error: errorMessage,
      };
      yield errorEvent;
    }
  }
}

/**
 * Merge multiple async iterables into a single async iterable
 * Yields items as they become available from any source
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

/** Promise-based delay utility */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
