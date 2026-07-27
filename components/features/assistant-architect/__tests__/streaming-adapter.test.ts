/**
 * Assistant Architect Streaming Adapter Integration Tests
 *
 * Tests the streaming adapter's ability to process SSE events correctly,
 * handle errors, and maintain state throughout execution.
 *
 * @see ../assistant-architect-streaming.tsx
 * @see https://github.com/psd401/aistudio.psd401.ai/issues/364
 */

import { parseSSEEvent, isTextDeltaEvent, isTextStartEvent, isErrorEvent, isFinishEvent } from '@/lib/streaming/sse-event-types';
import { createMockSSEResponse, createFailingSSEStream, SSE_FIXTURES, accumulateText } from '@/lib/streaming/__tests__/mock-sse-factory';

describe('Assistant Architect Streaming Adapter', () => {

    it('should parse and handle text-delta events correctly', async () => {
      const mockResponse = createMockSSEResponse([...SSE_FIXTURES.simpleText]);

      // Simulate reading the stream
      const reader = mockResponse.body!.getReader();
      const decoder = new TextDecoder();
      const events = [];
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim() || !line.startsWith('data: ')) continue;

            const data = line.slice(6); // Remove 'data: ' prefix
            const event = parseSSEEvent(data);
            events.push(event);
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Verify we got the expected events
      expect(events.length).toBeGreaterThan(0);

      // Find text-delta events
      const textDeltaEvents = events.filter(isTextDeltaEvent);
      expect(textDeltaEvents.length).toBe(2);

      // Verify delta field exists (not textDelta)
      for (const event of textDeltaEvents) {
        expect(event.delta).toBeDefined();
        expect(typeof event.delta).toBe('string');

        // Ensure textDelta doesn't exist
        expect('textDelta' in event).toBe(false);
      };

      // Verify accumulated text
      const text = accumulateText(events);
      expect(text).toBe('Hello world');
    });

    it('should handle text-start and text-end events', async () => {
      const mockResponse = createMockSSEResponse([...SSE_FIXTURES.simpleText]);

      const reader = mockResponse.body!.getReader();
      const decoder = new TextDecoder();
      const events = [];
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim() || !line.startsWith('data: ')) continue;

            const data = line.slice(6);
            const event = parseSSEEvent(data);
            events.push(event);
          }
        }
      } finally {
        reader.releaseLock();
      }

      const textStartEvents = events.filter(isTextStartEvent);
      expect(textStartEvents.length).toBe(1);
      expect(textStartEvents[0].id).toBe('text-1');

      const finishEvents = events.filter(isFinishEvent);
      expect(finishEvents.length).toBe(1);
    });

    it('should process tool call events correctly', async () => {
      const mockResponse = createMockSSEResponse([...SSE_FIXTURES.withToolCall]);

      const reader = mockResponse.body!.getReader();
      const decoder = new TextDecoder();
      const events = [];
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim() || !line.startsWith('data: ')) continue;

            const data = line.slice(6);
            const event = parseSSEEvent(data);
            events.push(event);
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Check for tool-call event
      const toolCallEvent = events.find(e => e.type === 'tool-call');
      expect(toolCallEvent).toBeDefined();

      if (toolCallEvent && 'toolCallId' in toolCallEvent) {
        expect(toolCallEvent.toolCallId).toBe('call-123');
        expect(toolCallEvent.toolName).toBe('web_search');
      }

      // Check for tool-output-available event
      const toolOutputEvent = events.find(e => e.type === 'tool-output-available');
      expect(toolOutputEvent).toBeDefined();
    });

    it('should handle multi-step execution events', async () => {
      const mockResponse = createMockSSEResponse([...SSE_FIXTURES.multiStep]);

      const reader = mockResponse.body!.getReader();
      const decoder = new TextDecoder();
      const events = [];
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim() || !line.startsWith('data: ')) continue;

            const data = line.slice(6);
            const event = parseSSEEvent(data);
            events.push(event);
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Verify step events
      const startStepEvents = events.filter(e => e.type === 'start-step');
      expect(startStepEvents.length).toBe(2);

      const finishStepEvents = events.filter(e => e.type === 'finish-step');
      expect(finishStepEvents.length).toBe(2);

      // Verify text from both steps
      const text = accumulateText(events);
      expect(text).toContain('Analyzing input');
      expect(text).toContain('Here is the result');
    });
  ;


    it('should handle error events gracefully', async () => {
      const mockResponse = createMockSSEResponse([...SSE_FIXTURES.withError]);

      const reader = mockResponse.body!.getReader();
      const decoder = new TextDecoder();
      const events = [];
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim() || !line.startsWith('data: ')) continue;

            const data = line.slice(6);
            const event = parseSSEEvent(data);
            events.push(event);
          }
        }
      } finally {
        reader.releaseLock();
      }

      const errorEvents = events.filter(isErrorEvent);
      expect(errorEvents.length).toBe(1);

      expect(errorEvents[0].error).toBe('Connection lost');
      expect(errorEvents[0].code).toBe('ERR_STREAM');
    });

    it('should handle stream failures gracefully', async () => {
      const mockResponse = createFailingSSEStream(
        [...SSE_FIXTURES.simpleText],
        1 // Fail after first chunk
      );

      const reader = mockResponse.body!.getReader();
      const decoder = new TextDecoder();
      const events = [];
      let buffer = '';
      let streamError: Error | null = null;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim() || !line.startsWith('data: ')) continue;

            const data = line.slice(6);
            const event = parseSSEEvent(data);
            events.push(event);
          }
        }
      } catch (error) {
        streamError = error as Error;
      } finally {
        reader.releaseLock();
      }

      // Should have caught a stream error
      expect(streamError).toBeDefined();
      expect(streamError?.message).toContain('Simulated stream error');

      // May or may not have received events before failure depending on timing
      // The important thing is that the error was caught
    });

    it('should handle tool execution errors', async () => {
      const mockResponse = createMockSSEResponse([...SSE_FIXTURES.withToolError]);

      const reader = mockResponse.body!.getReader();
      const decoder = new TextDecoder();
      const events = [];
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim() || !line.startsWith('data: ')) continue;

            const data = line.slice(6);
            const event = parseSSEEvent(data);
            events.push(event);
          }
        }
      } finally {
        reader.releaseLock();
      }

      const toolErrorEvent = events.find(e => e.type === 'tool-output-error');
      expect(toolErrorEvent).toBeDefined();

      if (toolErrorEvent && 'errorText' in toolErrorEvent) {
        expect(toolErrorEvent.errorText).toBe('API rate limit exceeded');
      }
    });
  ;


    it('should handle large streaming responses efficiently', async () => {
      const mockResponse = createMockSSEResponse([...SSE_FIXTURES.large]);

      const startTime = Date.now();

      const reader = mockResponse.body!.getReader();
      const decoder = new TextDecoder();
      let eventCount = 0;
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim() || !line.startsWith('data: ')) continue;

            const data = line.slice(6);
            parseSSEEvent(data);
            eventCount++;
          }
        }
      } finally {
        reader.releaseLock();
      }

      const elapsedTime = Date.now() - startTime;

      // Should process all events
      expect(eventCount).toBeGreaterThan(90); // 100 text-delta + finish event

      // Should complete reasonably quickly (adjust threshold as needed)
      expect(elapsedTime).toBeLessThan(1000);
    });
  ;


    it('should handle empty responses', async () => {
      const mockResponse = createMockSSEResponse([...SSE_FIXTURES.empty]);

      const reader = mockResponse.body!.getReader();
      const decoder = new TextDecoder();
      const events = [];
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim() || !line.startsWith('data: ')) continue;

            const data = line.slice(6);
            const event = parseSSEEvent(data);
            events.push(event);
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Should have start and finish events
      expect(events.length).toBe(2);
      expect(events[0].type).toBe('start');
      expect(events[1].type).toBe('finish');
    });

    it('should handle responses with reasoning events', async () => {
      const mockResponse = createMockSSEResponse([...SSE_FIXTURES.withReasoning]);

      const reader = mockResponse.body!.getReader();
      const decoder = new TextDecoder();
      const events = [];
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim() || !line.startsWith('data: ')) continue;

            const data = line.slice(6);
            const event = parseSSEEvent(data);
            events.push(event);
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Verify reasoning events
      const reasoningStart = events.find(e => e.type === 'reasoning-start');
      expect(reasoningStart).toBeDefined();

      const reasoningDeltas = events.filter(e => e.type === 'reasoning-delta');
      expect(reasoningDeltas.length).toBe(2);

      const reasoningEnd = events.find(e => e.type === 'reasoning-end');
      expect(reasoningEnd).toBeDefined();
    });
  ;
});
