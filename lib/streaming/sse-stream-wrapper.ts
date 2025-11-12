/**
 * SSE Stream Wrapper
 *
 * Wraps AI SDK streaming responses to inject custom SSE progress events
 * while preserving the original AI content stream.
 *
 * This allows us to emit custom events (prompt-start, progress, etc.)
 * alongside the AI response stream without breaking the AI SDK's streaming protocol.
 *
 * **IMPORTANT: Infrastructure Code - Not Currently Used**
 *
 * This module provides the foundation for future real-time SSE streaming but is
 * NOT imported or used in the current implementation (PR #336/Issue #360).
 *
 * Current Implementation:
 * - Events are stored in database via event-storage.ts
 * - No real-time streaming to clients
 *
 * Future Use Cases:
 * - Real-time progress streaming via /api/assistant-architect/events/[id]
 * - Client-side EventSource subscriptions
 * - Live execution monitoring
 *
 * @module lib/streaming/sse-stream-wrapper
 * @see /docs/features/assistant-architect-sse-events.md for implementation roadmap
 */

import type { SSEEventEmitter } from '@/types/sse-events';
import { createSSEEventEmitter } from './sse-event-emitter';
import { createLogger } from '@/lib/logger';

const log = createLogger({ module: 'sse-stream-wrapper' });

/**
 * Wrap an AI SDK streaming response to inject custom SSE events
 *
 * The wrapper:
 * 1. Creates a custom ReadableStream
 * 2. Forwards all AI content from the original stream
 * 3. Allows injecting custom SSE events via the returned emitter
 * 4. Returns both the wrapped response and the event emitter
 *
 * @param originalResponse - The original AI SDK streaming response
 * @param headers - Additional headers to include in the response
 * @returns Tuple of [wrapped Response, SSE event emitter, cleanup function]
 */
export function wrapStreamWithSSEEvents(
  originalResponse: Response,
  headers?: Record<string, string>
): {
  response: Response;
  emitEvent: SSEEventEmitter;
  cleanup: () => void;
} {
  const encoder = new TextEncoder();

  // Get the original stream
  const originalStream = originalResponse.body;
  if (!originalStream) {
    throw new Error('Original response has no body stream');
  }

  const originalReader = originalStream.getReader();

  // Create a new stream that merges custom events with AI content
  let eventEmitter: SSEEventEmitter;

  const customStream = new ReadableStream({
    async start(controller) {
      // Create the event emitter that writes to this controller
      eventEmitter = createSSEEventEmitter(controller, encoder);

      try {
        // Read from the original stream and forward all chunks
        while (true) {
          const { done, value } = await originalReader.read();

          if (done) {
            break;
          }

          // Forward the chunk from the AI stream
          controller.enqueue(value);
        }

        // Close the stream when original stream is done
        controller.close();
      } catch (error) {
        log.error('Error in SSE stream wrapper', { error });
        controller.error(error);
      }
    },

    cancel() {
      // Clean up the original reader
      originalReader.cancel().catch((err) => log.error('Failed to cancel reader', { error: err }));
    }
  });

  // Merge headers from original response with custom headers
  const responseHeaders = new Headers(originalResponse.headers);

  // Add custom headers
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      responseHeaders.set(key, value);
    }
  }

  // Ensure proper SSE headers
  responseHeaders.set('Content-Type', 'text/event-stream');
  responseHeaders.set('Cache-Control', 'no-cache, no-transform');
  responseHeaders.set('Connection', 'keep-alive');
  responseHeaders.set('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Create the wrapped response
  const wrappedResponse = new Response(customStream, {
    status: originalResponse.status,
    statusText: originalResponse.statusText,
    headers: responseHeaders
  });

  // Cleanup function to cancel streams
  const cleanup = (): void => {
    originalReader.cancel().catch((err) => log.error('Failed to cancel reader', { error: err }));
  };

  return {
    response: wrappedResponse,
    // Event emitter is assigned in the stream start callback
    emitEvent: eventEmitter!,
    cleanup
  };
}

/**
 * Check if a Response is an SSE stream
 *
 * @param response - The response to check
 * @returns True if the response is an SSE stream
 */
export function isSSEStream(response: Response): boolean {
  const contentType = response.headers.get('Content-Type');
  return contentType?.includes('text/event-stream') || false;
}

/**
 * Create a pure SSE stream (without AI content)
 *
 * Useful for endpoints that only emit custom events without AI streaming
 *
 * @param headers - Additional headers to include
 * @returns Tuple of [Response, SSE event emitter, cleanup function]
 */
export function createSSEStream(
  headers?: Record<string, string>
): {
  response: Response;
  emitEvent: SSEEventEmitter;
  cleanup: () => void;
} {
  const encoder = new TextEncoder();
  let eventEmitter: SSEEventEmitter;
  let streamController: ReadableStreamDefaultController;
  let isClosed = false;

  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
      eventEmitter = createSSEEventEmitter(controller, encoder);
    },

    cancel() {
      isClosed = true;
    }
  });

  const responseHeaders = new Headers();
  responseHeaders.set('Content-Type', 'text/event-stream');
  responseHeaders.set('Cache-Control', 'no-cache, no-transform');
  responseHeaders.set('Connection', 'keep-alive');
  responseHeaders.set('X-Accel-Buffering', 'no');

  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      responseHeaders.set(key, value);
    }
  }

  const response = new Response(stream, {
    status: 200,
    headers: responseHeaders
  });

  const cleanup = (): void => {
    if (!isClosed && streamController) {
      try {
        streamController.close();
        isClosed = true;
      } catch (error) {
        log.error('Error closing SSE stream', { error });
      }
    }
  };

  return {
    response,
    emitEvent: eventEmitter!,
    cleanup
  };
}
