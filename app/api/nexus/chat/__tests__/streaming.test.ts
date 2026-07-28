/**
 * Nexus Chat Streaming Integration Tests
 *
 * Tests the Nexus Chat API's streaming functionality, including:
 * - Text streaming with AI SDK
 * - Error handling and recovery
 * - Tool execution during streaming
 * - Conversation continuity
 *
 * @see ../route.ts
 * @see https://github.com/psd401/aistudio.psd401.ai/issues/364
 */

import { parseSSEEvent, isTextDeltaEvent, isErrorEvent, isToolCallEvent } from '@/lib/streaming/sse-event-types';
import { createMockSSEResponse, createMockAISDKResponse, createFailingSSEStream, SSE_FIXTURES, accumulateText } from '@/lib/streaming/__tests__/mock-sse-factory';

function defineNexusChatStreamingSuite1Part1() {

    it('should stream text-delta events correctly', async () => {
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

      const textDeltaEvents = events.filter(isTextDeltaEvent);
      expect(textDeltaEvents.length).toBeGreaterThan(0);

      // Verify field name is 'delta', not 'textDelta'
      for (const event of textDeltaEvents) {
        expect(event.delta).toBeDefined();
        expect(typeof event.delta).toBe('string');

        // Critical: Ensure we're not using the wrong field name
        expect('textDelta' in event).toBe(false);
      };

      const text = accumulateText(events);
      expect(text).toBe('Hello world');
    });

    it('should handle Vercel AI SDK data stream format', async () => {
      const mockResponse = createMockAISDKResponse(['Hello', ' world', '!']);

      const reader = mockResponse.body!.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;

            // Vercel AI SDK format: '0:"text"\n'
            if (line.startsWith('0:')) {
              const textChunk = JSON.parse(line.slice(2));
              chunks.push(textChunk);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      expect(chunks.join('')).toBe('Hello world!');
    });

    }

function defineNexusChatStreamingSuite1Part2() {it('should process conversation with tools', async () => {
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

      // Verify tool execution flow
      const toolCalls = events.filter(isToolCallEvent);
      expect(toolCalls.length).toBeGreaterThan(0);

      const toolCall = toolCalls[0];
      expect(toolCall.toolName).toBe('web_search');
      expect(toolCall.toolCallId).toBeDefined();

      // Verify tool output is present
      const toolOutput = events.find(e => e.type === 'tool-output-available');
      expect(toolOutput).toBeDefined();

      // Verify final text includes tool result
      const text = accumulateText(events);
      expect(text).toContain('search');
    });
  ;


    it('should emit error events on stream failure', async () => {
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
      expect(errorEvents.length).toBeGreaterThan(0);

      const errorEvent = errorEvents[0];
      expect(errorEvent.error).toBe('Connection lost');
      expect(errorEvent.code).toBe('ERR_STREAM');
    });

    }

function defineNexusChatStreamingSuite1Part3() {it('should handle connection drops gracefully', async () => {
      const mockResponse = createFailingSSEStream([...SSE_FIXTURES.simpleText], 1);

      const reader = mockResponse.body!.getReader();
      const decoder = new TextDecoder();
      const events = [];
      let buffer = '';
      let error: Error | null = null;

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
      } catch (e) {
        error = e as Error;
      } finally {
        reader.releaseLock();
      }

      // Should have captured the error
      expect(error).toBeDefined();
      expect(error?.message).toContain('Simulated stream error');

      // May or may not have received events before failure depending on timing
      // The important thing is that the error was caught
    });

    it('should handle malformed SSE data', () => {
      const invalidData = 'not valid json';

      expect(() => parseSSEEvent(invalidData)).toThrow('Failed to parse SSE event JSON');
    });

    it('should handle missing type field', () => {
      const invalidData = '{"delta":"text but no type"}';

      expect(() => parseSSEEvent(invalidData)).toThrow('SSE event missing required "type" field');
    });
  ;


    it('should handle rapid event streams', async () => {
      const mockResponse = createMockSSEResponse(
        SSE_FIXTURES.large,
        { chunkDelay: 0 } // No delay for performance test
      );

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

      // Should process many events
      expect(eventCount).toBeGreaterThan(90);

      // Should be fast
      expect(elapsedTime).toBeLessThan(1000);
    });

    }

function defineNexusChatStreamingSuite1Part4() {it('should handle delayed event streams', async () => {
      const events = [
        { type: 'start' as const },
        { type: 'text-delta' as const, delta: 'Slow' },
        { type: 'text-delta' as const, delta: ' response' },
        { type: 'finish' as const },
      ];

      const mockResponse = createMockSSEResponse(events, {
        chunkDelay: 10, // 10ms between chunks
      });

      const startTime = Date.now();

      const reader = mockResponse.body!.getReader();
      const decoder = new TextDecoder();
      const receivedEvents = [];
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
            receivedEvents.push(event);
          }
        }
      } finally {
        reader.releaseLock();
      }

      const elapsedTime = Date.now() - startTime;

      // Should have received all events
      expect(receivedEvents.length).toBe(events.length);

      // Should have taken at least some time (delays between chunks)
      expect(elapsedTime).toBeGreaterThan(20);
    });
  ;


    it('should handle follow-up messages in same conversation', async () => {
      // First message
      const firstResponse = createMockSSEResponse([
        { type: 'start' as const },
        { type: 'text-delta' as const, delta: 'First message response' },
        { type: 'finish' as const },
      ]);

      const reader1 = firstResponse.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader1.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
        }
      } finally {
        reader1.releaseLock();
      }

      // Second message (follow-up)
      const secondResponse = createMockSSEResponse([
        { type: 'start' as const },
        { type: 'text-delta' as const, delta: 'Follow-up response' },
        { type: 'finish' as const },
      ]);

      const reader2 = secondResponse.body!.getReader();
      buffer = '';
      const events = [];

      try {
        while (true) {
          const { done, value } = await reader2.read();
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
        reader2.releaseLock();
      }

      const text = accumulateText(events);
      expect(text).toBe('Follow-up response');
    });
  ;


    }

function defineNexusChatStreamingSuite1Part5() {it('should handle empty messages', async () => {
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

      expect(events.length).toBe(2);
      expect(events[0].type).toBe('start');
      expect(events[1].type).toBe('finish');
    });

    it('should accumulate text correctly across multiple deltas', async () => {
      const deltas = ['The ', 'quick ', 'brown ', 'fox ', 'jumps'];
      const events = [
        { type: 'start' as const },
        ...deltas.map(delta => ({ type: 'text-delta' as const, delta })),
        { type: 'finish' as const },
      ];

      const mockResponse = createMockSSEResponse(events);

      const reader = mockResponse.body!.getReader();
      const decoder = new TextDecoder();
      const receivedEvents = [];
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
            receivedEvents.push(event);
          }
        }
      } finally {
        reader.releaseLock();
      }

      const text = accumulateText(receivedEvents);
      expect(text).toBe('The quick brown fox jumps');
    });
  ;
}

const defineNexusChatStreamingSuite1 = () => {
  defineNexusChatStreamingSuite1Part1()
  defineNexusChatStreamingSuite1Part2()
  defineNexusChatStreamingSuite1Part3()
  defineNexusChatStreamingSuite1Part4()
  defineNexusChatStreamingSuite1Part5()
};

describe('Nexus Chat Streaming', defineNexusChatStreamingSuite1);
