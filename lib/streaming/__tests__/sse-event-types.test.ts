/**
 * Unit tests for SSE event type definitions, type guards, and parsing functions
 *
 * @see ../sse-event-types.ts
 */

import {
  parseSSEEvent,
  tryParseSSEEvent,
  isSSEEvent,
  isTextDeltaEvent,
  isTextStartEvent,
  isTextEndEvent,
  isReasoningDeltaEvent,
  isReasoningStartEvent,
  isReasoningEndEvent,
  isToolCallEvent,
  isToolCallDeltaEvent,
  isToolInputStartEvent,
  isToolInputErrorEvent,
  isToolOutputErrorEvent,
  isToolOutputAvailableEvent,
  isStartEvent,
  isStartStepEvent,
  isFinishStepEvent,
  isFinishEvent,
  isMessageEvent,
  isAssistantMessageEvent,
  isErrorEvent,
  isSourceUrlEvent,
  type SSEEvent
} from '../sse-event-types';

describe('SSE Event Parsing', () => {
  describe('parseSSEEvent', () => {
    it('should parse valid text-delta event', () => {
      const data = '{"type":"text-delta","delta":"Hello"}';
      const event = parseSSEEvent(data);

      expect(event.type).toBe('text-delta');
      expect(isTextDeltaEvent(event)).toBe(true);
      if (isTextDeltaEvent(event)) {
        expect(event.delta).toBe('Hello');
      }
    });

    it('should parse valid text-start event', () => {
      const data = '{"type":"text-start","id":"text-123"}';
      const event = parseSSEEvent(data);

      expect(event.type).toBe('text-start');
      expect(isTextStartEvent(event)).toBe(true);
    });

    it('should parse valid error event', () => {
      const data = '{"type":"error","error":"Something went wrong"}';
      const event = parseSSEEvent(data);

      expect(event.type).toBe('error');
      expect(isErrorEvent(event)).toBe(true);
    });

    it('should throw error for invalid JSON', () => {
      const data = '{invalid json}';

      expect(() => parseSSEEvent(data)).toThrow('Failed to parse SSE event JSON');
    });

    it('should throw error for missing type field', () => {
      const data = '{"delta":"Hello"}';

      expect(() => parseSSEEvent(data)).toThrow('SSE event missing required "type" field');
    });

    it('should throw error for non-string type field', () => {
      const data = '{"type":123,"delta":"Hello"}';

      expect(() => parseSSEEvent(data)).toThrow('SSE event missing required "type" field');
    });

    it('should warn for unrecognized event type', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const data = '{"type":"unknown-type","data":"test"}';

      parseSSEEvent(data);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unrecognized event type: "unknown-type"')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('tryParseSSEEvent', () => {
    it('should return parsed event for valid input', () => {
      const data = '{"type":"text-delta","delta":"Hello"}';
      const event = tryParseSSEEvent(data);

      expect(event).not.toBeNull();
      expect(event?.type).toBe('text-delta');
    });

    it('should return null for invalid JSON', () => {
      const data = '{invalid json}';
      const event = tryParseSSEEvent(data);

      expect(event).toBeNull();
    });

    it('should return null for missing type field', () => {
      const data = '{"delta":"Hello"}';
      const event = tryParseSSEEvent(data);

      expect(event).toBeNull();
    });
  });

  describe('isSSEEvent', () => {
    it('should return true for valid SSE event object', () => {
      const event = { type: 'text-delta', delta: 'Hello' };

      expect(isSSEEvent(event)).toBe(true);
    });

    it('should return false for object without type', () => {
      const event = { delta: 'Hello' };

      expect(isSSEEvent(event)).toBe(false);
    });

    it('should return false for null', () => {
      expect(isSSEEvent(null)).toBe(false);
    });

    it('should return false for primitive values', () => {
      expect(isSSEEvent('string')).toBe(false);
      expect(isSSEEvent(123)).toBe(false);
      expect(isSSEEvent(true)).toBe(false);
    });
  });
});

describe('Text Event Type Guards', () => {
  describe('isTextDeltaEvent', () => {
    it('should return true for valid text-delta event', () => {
      const event: SSEEvent = { type: 'text-delta', delta: 'Hello' };

      expect(isTextDeltaEvent(event)).toBe(true);
    });

    it('should return false for text-delta with missing delta field', () => {
      const event = { type: 'text-delta' } as unknown as SSEEvent;

      expect(isTextDeltaEvent(event)).toBe(false);
    });

    it('should return false for text-delta with null delta', () => {
      const event = { type: 'text-delta', delta: null } as unknown as SSEEvent;

      expect(isTextDeltaEvent(event)).toBe(false);
    });

    it('should return false for text-delta with non-string delta', () => {
      const event = { type: 'text-delta', delta: 123 } as unknown as SSEEvent;

      expect(isTextDeltaEvent(event)).toBe(false);
    });

    it('should return false for different event type', () => {
      const event: SSEEvent = { type: 'text-start', id: 'test' };

      expect(isTextDeltaEvent(event)).toBe(false);
    });
  });

  describe('isTextStartEvent', () => {
    it('should return true for valid text-start event', () => {
      const event: SSEEvent = { type: 'text-start', id: 'text-123' };

      expect(isTextStartEvent(event)).toBe(true);
    });

    it('should return false for text-start with missing id', () => {
      const event = { type: 'text-start' } as unknown as SSEEvent;

      expect(isTextStartEvent(event)).toBe(false);
    });

    it('should return false for text-start with non-string id', () => {
      const event = { type: 'text-start', id: 123 } as unknown as SSEEvent;

      expect(isTextStartEvent(event)).toBe(false);
    });
  });

  describe('isTextEndEvent', () => {
    it('should return true for valid text-end event', () => {
      const event: SSEEvent = { type: 'text-end', id: 'text-123' };

      expect(isTextEndEvent(event)).toBe(true);
    });

    it('should return false for text-end with missing id', () => {
      const event = { type: 'text-end' } as unknown as SSEEvent;

      expect(isTextEndEvent(event)).toBe(false);
    });
  });
});

describe('Reasoning Event Type Guards', () => {
  describe('isReasoningDeltaEvent', () => {
    it('should return true for valid reasoning-delta event', () => {
      const event: SSEEvent = { type: 'reasoning-delta', delta: 'thinking...' };

      expect(isReasoningDeltaEvent(event)).toBe(true);
    });

    it('should return true for reasoning-delta with optional reasoning field', () => {
      const event: SSEEvent = {
        type: 'reasoning-delta',
        delta: 'thinking...',
        reasoning: 'detailed reasoning'
      };

      expect(isReasoningDeltaEvent(event)).toBe(true);
    });

    it('should return false for reasoning-delta with missing delta', () => {
      const event = { type: 'reasoning-delta' } as unknown as SSEEvent;

      expect(isReasoningDeltaEvent(event)).toBe(false);
    });
  });

  describe('isReasoningStartEvent', () => {
    it('should return true for valid reasoning-start event', () => {
      const event: SSEEvent = { type: 'reasoning-start', id: 'reasoning-123' };

      expect(isReasoningStartEvent(event)).toBe(true);
    });
  });

  describe('isReasoningEndEvent', () => {
    it('should return true for valid reasoning-end event', () => {
      const event: SSEEvent = { type: 'reasoning-end', id: 'reasoning-123' };

      expect(isReasoningEndEvent(event)).toBe(true);
    });
  });
});

describe('Tool Event Type Guards', () => {
  describe('isToolCallEvent', () => {
    it('should return true for valid tool-call event', () => {
      const event: SSEEvent = {
        type: 'tool-call',
        toolCallId: 'call-123',
        toolName: 'web_search'
      };

      expect(isToolCallEvent(event)).toBe(true);
    });

    it('should return false for tool-call with missing toolCallId', () => {
      const event = { type: 'tool-call', toolName: 'web_search' } as unknown as SSEEvent;

      expect(isToolCallEvent(event)).toBe(false);
    });

    it('should return false for tool-call with missing toolName', () => {
      const event = { type: 'tool-call', toolCallId: 'call-123' } as unknown as SSEEvent;

      expect(isToolCallEvent(event)).toBe(false);
    });

    it('should return false for tool-call with non-string fields', () => {
      const event = {
        type: 'tool-call',
        toolCallId: 123,
        toolName: 456
      } as unknown as SSEEvent;

      expect(isToolCallEvent(event)).toBe(false);
    });
  });

  describe('isToolCallDeltaEvent', () => {
    it('should return true for valid tool-call-delta event', () => {
      const event: SSEEvent = {
        type: 'tool-call-delta',
        toolCallId: 'call-123',
        toolName: 'web_search'
      };

      expect(isToolCallDeltaEvent(event)).toBe(true);
    });
  });

  describe('isToolInputStartEvent', () => {
    it('should return true for valid tool-input-start event', () => {
      const event: SSEEvent = {
        type: 'tool-input-start',
        toolCallId: 'call-123',
        toolName: 'web_search'
      };

      expect(isToolInputStartEvent(event)).toBe(true);
    });
  });

  describe('isToolInputErrorEvent', () => {
    it('should return true for valid tool-input-error event', () => {
      const event: SSEEvent = {
        type: 'tool-input-error',
        toolCallId: 'call-123',
        toolName: 'web_search',
        error: 'Invalid input'
      };

      expect(isToolInputErrorEvent(event)).toBe(true);
    });
  });

  describe('isToolOutputErrorEvent', () => {
    it('should return true for valid tool-output-error event', () => {
      const event: SSEEvent = {
        type: 'tool-output-error',
        toolCallId: 'call-123',
        errorText: 'Tool execution failed'
      };

      expect(isToolOutputErrorEvent(event)).toBe(true);
    });

    it('should return false for tool-output-error with missing toolCallId', () => {
      const event = {
        type: 'tool-output-error',
        errorText: 'Tool execution failed'
      } as unknown as SSEEvent;

      expect(isToolOutputErrorEvent(event)).toBe(false);
    });
  });

  describe('isToolOutputAvailableEvent', () => {
    it('should return true for valid tool-output-available event', () => {
      const event: SSEEvent = {
        type: 'tool-output-available',
        toolCallId: 'call-123'
      };

      expect(isToolOutputAvailableEvent(event)).toBe(true);
    });
  });
});

describe('Lifecycle Event Type Guards', () => {
  describe('isStartEvent', () => {
    it('should return true for valid start event', () => {
      const event: SSEEvent = { type: 'start' };

      expect(isStartEvent(event)).toBe(true);
    });

    it('should return false for different event type', () => {
      const event: SSEEvent = { type: 'finish' };

      expect(isStartEvent(event)).toBe(false);
    });
  });

  describe('isStartStepEvent', () => {
    it('should return true for valid start-step event', () => {
      const event: SSEEvent = { type: 'start-step' };

      expect(isStartStepEvent(event)).toBe(true);
    });

    it('should return true for start-step with optional fields', () => {
      const event: SSEEvent = {
        type: 'start-step',
        stepId: 'step-1',
        stepName: 'Initialize'
      };

      expect(isStartStepEvent(event)).toBe(true);
    });
  });

  describe('isFinishStepEvent', () => {
    it('should return true for valid finish-step event', () => {
      const event: SSEEvent = { type: 'finish-step' };

      expect(isFinishStepEvent(event)).toBe(true);
    });
  });

  describe('isFinishEvent', () => {
    it('should return true for valid finish event', () => {
      const event: SSEEvent = { type: 'finish' };

      expect(isFinishEvent(event)).toBe(true);
    });

    it('should return true for finish event with message', () => {
      const event: SSEEvent = {
        type: 'finish',
        message: {
          role: 'assistant',
          parts: [{ type: 'text', text: 'Response' }]
        }
      };

      expect(isFinishEvent(event)).toBe(true);
    });
  });
});

describe('Message Event Type Guards', () => {
  describe('isMessageEvent', () => {
    it('should return true for valid message event', () => {
      const event: SSEEvent = {
        type: 'message',
        parts: [{ type: 'text', text: 'Hello' }]
      };

      expect(isMessageEvent(event)).toBe(true);
    });
  });

  describe('isAssistantMessageEvent', () => {
    it('should return true for valid assistant-message event', () => {
      const event: SSEEvent = {
        type: 'assistant-message',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hello' }]
      };

      expect(isAssistantMessageEvent(event)).toBe(true);
    });
  });
});

describe('Error Event Type Guards', () => {
  describe('isErrorEvent', () => {
    it('should return true for valid error event', () => {
      const event: SSEEvent = {
        type: 'error',
        error: 'Something went wrong'
      };

      expect(isErrorEvent(event)).toBe(true);
    });

    it('should return true for error event with code and stack', () => {
      const event: SSEEvent = {
        type: 'error',
        error: 'Something went wrong',
        code: 'ERR_STREAM',
        stack: 'Error: ...'
      };

      expect(isErrorEvent(event)).toBe(true);
    });

    it('should return false for error event with missing error field', () => {
      const event = { type: 'error' } as unknown as SSEEvent;

      expect(isErrorEvent(event)).toBe(false);
    });

    it('should return false for error event with non-string error', () => {
      const event = { type: 'error', error: 123 } as unknown as SSEEvent;

      expect(isErrorEvent(event)).toBe(false);
    });
  });
});

describe('Source Event Type Guards', () => {
  describe('isSourceUrlEvent', () => {
    it('should return true for valid source-url event with https URL', () => {
      const event: SSEEvent = {
        type: 'source-url',
        sourceId: 'ws_123',
        url: 'https://example.com/article'
      };

      expect(isSourceUrlEvent(event)).toBe(true);
    });

    it('should return true for source-url event with optional title', () => {
      const event: SSEEvent = {
        type: 'source-url',
        sourceId: 'ws_456',
        url: 'https://example.com',
        title: 'Example Article Title'
      };

      expect(isSourceUrlEvent(event)).toBe(true);
    });

    it('should return true for source-url event with http URL', () => {
      const event: SSEEvent = {
        type: 'source-url',
        sourceId: 'ws_789',
        url: 'http://example.com/page'
      };

      expect(isSourceUrlEvent(event)).toBe(true);
    });

    it('should return false for source-url with missing sourceId', () => {
      const event = {
        type: 'source-url',
        url: 'https://example.com'
      } as unknown as SSEEvent;

      expect(isSourceUrlEvent(event)).toBe(false);
    });

    it('should return false for source-url with missing url', () => {
      const event = {
        type: 'source-url',
        sourceId: 'ws_123'
      } as unknown as SSEEvent;

      expect(isSourceUrlEvent(event)).toBe(false);
    });

    it('should return false for source-url with non-string sourceId', () => {
      const event = {
        type: 'source-url',
        sourceId: 123,
        url: 'https://example.com'
      } as unknown as SSEEvent;

      expect(isSourceUrlEvent(event)).toBe(false);
    });

    it('should return false for source-url with non-string url', () => {
      const event = {
        type: 'source-url',
        sourceId: 'ws_123',
        url: 123
      } as unknown as SSEEvent;

      expect(isSourceUrlEvent(event)).toBe(false);
    });

    it('should return false for different event type', () => {
      const event: SSEEvent = { type: 'text-delta', delta: 'Hello' };

      expect(isSourceUrlEvent(event)).toBe(false);
    });

    // Security: URL protocol validation (defense-in-depth)
    it('should return false for javascript: protocol URL', () => {
      const event = {
        type: 'source-url',
        sourceId: 'ws_evil',
        url: 'javascript:alert(document.cookie)'
      } as unknown as SSEEvent;

      expect(isSourceUrlEvent(event)).toBe(false);
    });

    it('should return false for data: protocol URL', () => {
      const event = {
        type: 'source-url',
        sourceId: 'ws_evil',
        url: 'data:text/html,<script>alert(1)</script>'
      } as unknown as SSEEvent;

      expect(isSourceUrlEvent(event)).toBe(false);
    });

    it('should return false for file: protocol URL', () => {
      const event = {
        type: 'source-url',
        sourceId: 'ws_evil',
        url: 'file:///etc/passwd'
      } as unknown as SSEEvent;

      expect(isSourceUrlEvent(event)).toBe(false);
    });

    it('should return false for malformed URL', () => {
      const event = {
        type: 'source-url',
        sourceId: 'ws_bad',
        url: 'not-a-valid-url'
      } as unknown as SSEEvent;

      expect(isSourceUrlEvent(event)).toBe(false);
    });
  });
});

describe('Integration Tests', () => {
  it('should correctly identify event type through parsing and type guards', () => {
    const events = [
      '{"type":"text-delta","delta":"Hello"}',
      '{"type":"text-start","id":"text-123"}',
      '{"type":"error","error":"Failed"}',
      '{"type":"start"}',
      '{"type":"tool-call","toolCallId":"call-1","toolName":"search"}',
      '{"type":"source-url","sourceId":"ws_1","url":"https://example.com","title":"Example"}'
    ];

    const parsed = events.map(data => parseSSEEvent(data));

    expect(isTextDeltaEvent(parsed[0])).toBe(true);
    expect(isTextStartEvent(parsed[1])).toBe(true);
    expect(isErrorEvent(parsed[2])).toBe(true);
    expect(isStartEvent(parsed[3])).toBe(true);
    expect(isToolCallEvent(parsed[4])).toBe(true);
    expect(isSourceUrlEvent(parsed[5])).toBe(true);
  });

  it('should handle real-world SSE stream sequence', () => {
    const streamData = [
      '{"type":"start"}',
      '{"type":"text-start","id":"text-1"}',
      '{"type":"text-delta","delta":"The"}',
      '{"type":"text-delta","delta":" answer"}',
      '{"type":"text-delta","delta":" is"}',
      '{"type":"text-end","id":"text-1"}',
      '{"type":"finish","message":{"role":"assistant","parts":[{"type":"text","text":"The answer is"}]}}'
    ];

    const events = streamData.map(data => parseSSEEvent(data));
    let accumulatedText = '';

    events.forEach(event => {
      if (isTextDeltaEvent(event)) {
        accumulatedText += event.delta;
      }
    });

    expect(accumulatedText).toBe('The answer is');
    expect(isFinishEvent(events[events.length - 1])).toBe(true);
  });

  it('should handle stream with mixed text and source-url events', () => {
    const streamData = [
      '{"type":"start"}',
      '{"type":"text-start","id":"text-1"}',
      '{"type":"text-delta","delta":"According to "}',
      '{"type":"source-url","sourceId":"ws_1","url":"https://example.com","title":"Example"}',
      '{"type":"text-delta","delta":"the source"}',
      '{"type":"source-url","sourceId":"ws_2","url":"https://google.com","title":"Google"}',
      '{"type":"text-end","id":"text-1"}',
      '{"type":"finish"}'
    ];

    const events = streamData.map(data => parseSSEEvent(data));
    let text = '';
    const sources: Array<{ id: string; url: string; title?: string }> = [];

    events.forEach(event => {
      if (isTextDeltaEvent(event)) {
        text += event.delta;
      } else if (isSourceUrlEvent(event)) {
        sources.push({ id: event.sourceId, url: event.url, title: event.title });
      }
    });

    expect(text).toBe('According to the source');
    expect(sources).toHaveLength(2);
    expect(sources[0]).toEqual({ id: 'ws_1', url: 'https://example.com', title: 'Example' });
    expect(sources[1]).toEqual({ id: 'ws_2', url: 'https://google.com', title: 'Google' });
  });
});
