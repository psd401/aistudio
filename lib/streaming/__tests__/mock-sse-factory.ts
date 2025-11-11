/**
 * Mock SSE (Server-Sent Events) Factory
 *
 * Provides utilities for creating realistic SSE response streams for testing.
 * Supports configurable delays, error injection, and connection simulation.
 *
 * @see ../sse-event-types.ts for event type definitions
 * @see https://github.com/psd401/aistudio/issues/364
 */

import { SSEEvent } from '../sse-event-types';

/**
 * Configuration options for SSE stream generation
 */
export interface SSEStreamConfig {
  /** Initial delay before first event (ms) */
  initialDelay?: number;
  /** Delay between chunks (ms) */
  chunkDelay?: number;
  /** Error after specific chunk index (0-based) */
  errorAfterChunk?: number;
  /** Simulate connection drop after specific chunk index */
  dropConnectionAfterChunk?: number;
  /** Include Content-Type header */
  includeHeaders?: boolean;
}

/**
 * Creates a ReadableStream that emits SSE events
 *
 * @example
 * ```typescript
 * const stream = createSSEStream([
 *   { type: 'text-delta', delta: 'Hello' },
 *   { type: 'text-delta', delta: ' world' },
 *   { type: 'finish' }
 * ], { chunkDelay: 10 });
 * ```
 */
export function createSSEStream(
  events: SSEEvent[],
  config: SSEStreamConfig = {}
): ReadableStream<Uint8Array> {
  const {
    initialDelay = 0,
    chunkDelay = 0,
    errorAfterChunk,
    dropConnectionAfterChunk,
  } = config;

  return new ReadableStream({
    async start(controller) {
      // Initial delay before first event
      if (initialDelay > 0) {
        await sleep(initialDelay);
      }

      for (let i = 0; i < events.length; i++) {
        // Simulate connection drop
        if (dropConnectionAfterChunk !== undefined && i === dropConnectionAfterChunk) {
          controller.close();
          return;
        }

        // Simulate error
        if (errorAfterChunk !== undefined && i === errorAfterChunk) {
          controller.error(new Error('Simulated stream error'));
          return;
        }

        // Encode and enqueue event
        const eventData = formatSSEEvent(events[i]);
        controller.enqueue(new TextEncoder().encode(eventData));

        // Delay between chunks (except after last chunk)
        if (chunkDelay > 0 && i < events.length - 1) {
          await sleep(chunkDelay);
        }
      }

      controller.close();
    },
  });
}

/**
 * Creates a mock Response object with SSE stream
 *
 * @example
 * ```typescript
 * const response = createMockSSEResponse([
 *   { type: 'text-delta', delta: 'Hello' }
 * ]);
 *
 * global.fetch = vi.fn().mockResolvedValue(response);
 * ```
 */
export function createMockSSEResponse(
  events: SSEEvent[],
  config: SSEStreamConfig = {}
): Response {
  const stream = createSSEStream(events, config);
  const headers = new Headers();

  if (config.includeHeaders !== false) {
    headers.set('Content-Type', 'text/event-stream');
    headers.set('Cache-Control', 'no-cache');
    headers.set('Connection', 'keep-alive');
  }

  return new Response(stream, {
    status: 200,
    headers,
  });
}

/**
 * Creates a failing SSE stream that errors after N chunks
 *
 * @example
 * ```typescript
 * const response = createFailingSSEStream(2); // Fails after 2nd chunk
 * ```
 */
export function createFailingSSEStream(
  events: SSEEvent[],
  failAfterChunk: number
): Response {
  return createMockSSEResponse(events, {
    errorAfterChunk: failAfterChunk,
  });
}

/**
 * Creates a stream that simulates connection drop
 *
 * @example
 * ```typescript
 * const response = createDroppedConnectionStream(events, 3);
 * ```
 */
export function createDroppedConnectionStream(
  events: SSEEvent[],
  dropAfterChunk: number
): Response {
  return createMockSSEResponse(events, {
    dropConnectionAfterChunk: dropAfterChunk,
  });
}

/**
 * Creates a Vercel AI SDK compatible stream
 * Uses the data stream format with proper encoding
 *
 * @example
 * ```typescript
 * const stream = createAISDKStream(['Hello ', 'world']);
 * ```
 */
export function createAISDKStream(
  messages: string[],
  config: SSEStreamConfig = {}
): ReadableStream<Uint8Array> {
  const { initialDelay = 0, chunkDelay = 10 } = config;

  return new ReadableStream({
    async start(controller) {
      if (initialDelay > 0) {
        await sleep(initialDelay);
      }

      // Vercel AI SDK data stream format
      for (let i = 0; i < messages.length; i++) {
        // Text content chunk format: '0:"message content"\n'
        const chunk = `0:${JSON.stringify(messages[i])}\n`;
        controller.enqueue(new TextEncoder().encode(chunk));

        if (chunkDelay > 0 && i < messages.length - 1) {
          await sleep(chunkDelay);
        }
      }

      // Finish event with metadata
      const finishEvent = 'd:{"finishReason":"stop","usage":{"promptTokens":10,"completionTokens":' + messages.length + '}}\n';
      controller.enqueue(new TextEncoder().encode(finishEvent));

      // Final event marker
      const endEvent = 'e:{"finishReason":"stop"}\n';
      controller.enqueue(new TextEncoder().encode(endEvent));

      controller.close();
    },
  });
}

/**
 * Creates a mock Vercel AI SDK Response
 *
 * @example
 * ```typescript
 * const response = createMockAISDKResponse(['Hello ', 'world']);
 * global.fetch = vi.fn().mockResolvedValue(response);
 * ```
 */
export function createMockAISDKResponse(
  messages: string[],
  config: SSEStreamConfig = {}
): Response {
  const stream = createAISDKStream(messages, config);
  const headers = new Headers({
    'X-Vercel-AI-Data-Stream': 'v1',
    'Content-Type': 'text/plain; charset=utf-8',
  });

  return new Response(stream, {
    status: 200,
    headers,
  });
}

/**
 * Format an SSE event according to the SSE protocol
 * https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
 */
function formatSSEEvent(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Promise-based sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// TEST DATA FIXTURES
// ============================================================================

/**
 * Common SSE event sequences for testing
 */
export const SSE_FIXTURES = {
  /** Simple text streaming sequence */
  simpleText: [
    { type: 'start' as const },
    { type: 'text-start' as const, id: 'text-1' },
    { type: 'text-delta' as const, delta: 'Hello' },
    { type: 'text-delta' as const, delta: ' world' },
    { type: 'text-end' as const, id: 'text-1' },
    { type: 'finish' as const },
  ],

  /** Text streaming with tool call */
  withToolCall: [
    { type: 'start' as const },
    { type: 'text-start' as const, id: 'text-1' },
    { type: 'text-delta' as const, delta: 'Let me search for that.' },
    { type: 'text-end' as const, id: 'text-1' },
    {
      type: 'tool-call' as const,
      toolCallId: 'call-123',
      toolName: 'web_search',
      args: { query: 'weather' },
    },
    {
      type: 'tool-output-available' as const,
      toolCallId: 'call-123',
      output: { result: 'Sunny, 75°F' },
    },
    { type: 'text-start' as const, id: 'text-2' },
    { type: 'text-delta' as const, delta: "It's sunny and 75°F." },
    { type: 'text-end' as const, id: 'text-2' },
    { type: 'finish' as const },
  ],

  /** Stream that encounters an error */
  withError: [
    { type: 'start' as const },
    { type: 'text-start' as const, id: 'text-1' },
    { type: 'text-delta' as const, delta: 'Starting response...' },
    { type: 'error' as const, error: 'Connection lost', code: 'ERR_STREAM' },
  ],

  /** Multi-step execution (like Assistant Architect) */
  multiStep: [
    { type: 'start' as const },
    { type: 'start-step' as const, stepId: 'step-1', stepName: 'Analysis' },
    { type: 'text-start' as const, id: 'text-1' },
    { type: 'text-delta' as const, delta: 'Analyzing input...' },
    { type: 'text-end' as const, id: 'text-1' },
    { type: 'finish-step' as const, stepId: 'step-1' },
    { type: 'start-step' as const, stepId: 'step-2', stepName: 'Response' },
    { type: 'text-start' as const, id: 'text-2' },
    { type: 'text-delta' as const, delta: 'Here is the result.' },
    { type: 'text-end' as const, id: 'text-2' },
    { type: 'finish-step' as const, stepId: 'step-2' },
    { type: 'finish' as const },
  ],

  /** Reasoning events (O1/O3 models) */
  withReasoning: [
    { type: 'start' as const },
    { type: 'reasoning-start' as const, id: 'reasoning-1' },
    { type: 'reasoning-delta' as const, delta: 'Let me think about this...' },
    { type: 'reasoning-delta' as const, delta: ' I need to consider...' },
    { type: 'reasoning-end' as const, id: 'reasoning-1' },
    { type: 'text-start' as const, id: 'text-1' },
    { type: 'text-delta' as const, delta: 'Based on my analysis...' },
    { type: 'text-end' as const, id: 'text-1' },
    { type: 'finish' as const },
  ],

  /** Tool execution error */
  withToolError: [
    { type: 'start' as const },
    {
      type: 'tool-call' as const,
      toolCallId: 'call-456',
      toolName: 'web_search',
    },
    {
      type: 'tool-output-error' as const,
      toolCallId: 'call-456',
      errorText: 'API rate limit exceeded',
    },
    { type: 'text-start' as const, id: 'text-1' },
    { type: 'text-delta' as const, delta: 'Sorry, the search failed.' },
    { type: 'text-end' as const, id: 'text-1' },
    { type: 'finish' as const },
  ],

  /** Empty response */
  empty: [
    { type: 'start' as const },
    { type: 'finish' as const },
  ],

  /** Large response (for performance testing) */
  get large(): SSEEvent[] {
    const chunks: SSEEvent[] = Array.from({ length: 100 }, (_, i) => ({
      type: 'text-delta' as const,
      delta: `Chunk ${i + 1} `,
    }));
    chunks.push({ type: 'finish' as const });
    return chunks;
  },
} as const;

/**
 * Helper to create a custom text streaming sequence
 *
 * @example
 * ```typescript
 * const events = createTextStreamFixture([
 *   'Hello',
 *   ' world',
 *   '!'
 * ]);
 * ```
 */
export function createTextStreamFixture(deltas: string[]): SSEEvent[] {
  return [
    { type: 'start' },
    { type: 'text-start', id: 'text-1' },
    ...deltas.map((delta) => ({ type: 'text-delta' as const, delta })),
    { type: 'text-end', id: 'text-1' },
    { type: 'finish' },
  ];
}

/**
 * Helper to accumulate text from SSE events
 * Useful for testing that streaming produces expected output
 *
 * @example
 * ```typescript
 * const events = parseSSEStream(streamData);
 * const text = accumulateText(events);
 * expect(text).toBe('Hello world');
 * ```
 */
export function accumulateText(events: SSEEvent[]): string {
  return events
    .filter((event): event is { type: 'text-delta'; delta: string } =>
      event.type === 'text-delta' && 'delta' in event && typeof event.delta === 'string'
    )
    .map((event) => event.delta)
    .join('');
}
