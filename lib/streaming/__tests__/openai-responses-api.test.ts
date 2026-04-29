import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { 
  createResponsesAPIClient, 
  ResponsesAPIClient,
  streamWithResponsesAPI 
} from '../openai-responses-api';
import type { StreamRequest, StreamingCallbacks } from '../types';

// Mock fetch globally
global.fetch = jest.fn() as unknown as typeof fetch;

// Polyfill ReadableStream for Node.js test environment
if (!global.ReadableStream) {
  global.ReadableStream = class ReadableStream {
    private controller: {
      enqueue: jest.MockedFunction<(chunk: unknown) => void>;
      close: jest.MockedFunction<() => void>;
    };
    
    constructor(source: { start?: (controller: unknown) => void }) {
      this.controller = {
        enqueue: jest.fn(),
        close: jest.fn()
      };
      if (source?.start) {
        source.start(this.controller);
      }
    }
    
    getReader() {
      const controller = this.controller;
      let chunks: unknown[] = [];
      let currentIndex = 0;
      
      // Extract chunks from controller.enqueue calls
      if (controller.enqueue.mock) {
        chunks = controller.enqueue.mock.calls.map((call: unknown[]) => call[0]);
      }
      
      return {
        read: async () => {
          if (currentIndex < chunks.length) {
            return { done: false, value: chunks[currentIndex++] };
          }
          return { done: true, value: undefined };
        },
        releaseLock: jest.fn()
      };
    }
  } as unknown as typeof ReadableStream;
  
  global.TextEncoder = class TextEncoder {
    encode(text: string): Uint8Array {
      return Buffer.from(text, 'utf-8');
    }
  } as unknown as typeof TextEncoder;
  
  global.TextDecoder = class TextDecoder {
    decode(buffer: BufferSource): string {
      return Buffer.from(buffer as ArrayBuffer).toString('utf-8');
    }
  } as unknown as typeof TextDecoder;
}

// Mock logger
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  })
}));

describe('OpenAI Responses API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.MockedFunction<typeof fetch>).mockClear();
  });
  
  describe('ResponsesAPIClient', () => {
    it('should create client with config', () => {
      const client = createResponsesAPIClient({
        apiKey: 'test-key',
        modelId: 'o3-mini',
        reasoningEffort: 'high',
        backgroundMode: false
      });
      
      expect(client).toBeInstanceOf(ResponsesAPIClient);
    });
    
    it('should handle streaming responses with reasoning', async () => {
      // Mock SSE stream response
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"reasoning_step","content":"Step 1: Analyzing","step_number":1,"tokens":5}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: {"type":"response_delta","content":"The answer is "}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: {"type":"response_delta","content":"42"}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: {"type":"finish","usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30},"finish_reason":"stop"}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        }
      });
      
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: mockStream
      } as Response);
      
      const client = createResponsesAPIClient({
        apiKey: 'test-key',
        modelId: 'o3-mini',
        reasoningEffort: 'medium'
      });
      
      const callbacks: StreamingCallbacks = {
        onReasoning: jest.fn(),
        onProgress: jest.fn(),
        onFinish: jest.fn()
      };
      
      const result = await client.stream([
        { role: 'user', content: 'What is the answer?' }
      ], callbacks);
      
      expect(result.status).toBe('completed');
      expect(result.reasoning).toEqual(['Step 1: Analyzing']);
      expect(result.response).toBe('The answer is 42');
      expect(result.reasoningTokens).toBe(5);
      
      expect(callbacks.onReasoning).toHaveBeenCalledWith('Step 1: Analyzing');
      expect(callbacks.onProgress).toHaveBeenCalled();
      expect(callbacks.onFinish).toHaveBeenCalledWith(expect.objectContaining({
        text: 'The answer is 42',
        usage: expect.objectContaining({
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          reasoningTokens: 5
        })
      }));
    });
    
    it('should handle background mode', async () => {
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          job_id: 'job-123',
          estimated_completion_time: 30000
        })
      } as Response);
      
      const client = createResponsesAPIClient({
        apiKey: 'test-key',
        modelId: 'o4',
        backgroundMode: true
      });
      
      const result = await client.stream([
        { role: 'user', content: 'Solve this complex problem' }
      ]);
      
      expect(result.status).toBe('background');
      expect(result.jobId).toBe('job-123');
      
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/responses',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-key',
            'OpenAI-Beta': 'responses-api-v1'
          }),
          body: expect.stringContaining('"background_mode":true')
        })
      );
    });
    
    it('should poll for job status', async () => {
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'completed',
          reasoning_steps: ['Step 1', 'Step 2'],
          thinking_time_ms: 5000,
          reasoning_tokens: 150,
          response: 'Complex solution'
        })
      } as Response);
      
      const client = createResponsesAPIClient({
        apiKey: 'test-key',
        modelId: 'o4'
      });
      
      const result = await client.getJobStatus('job-123');
      
      expect(result.status).toBe('completed');
      expect(result.reasoning).toEqual(['Step 1', 'Step 2']);
      expect(result.thinkingTime).toBe(5000);
      expect(result.reasoningTokens).toBe(150);
      expect(result.response).toBe('Complex solution');
    });
    
    it('should handle tool calls in reasoning', async () => {
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"tool_call","tool_name":"calculator","arguments":{"expression":"2+2"}}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: {"type":"response_delta","content":"Result: 4"}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        }
      });
      
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        body: mockStream
      } as Response);
      
      const client = createResponsesAPIClient({
        apiKey: 'test-key',
        modelId: 'gpt-5'
      });
      
      const callbacks: StreamingCallbacks = {
        onProgress: jest.fn()
      };
      
      await client.stream([
        { role: 'user', content: 'Calculate 2+2' }
      ], callbacks);
      
      expect(callbacks.onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'tool_call',
          metadata: expect.objectContaining({
            tool_name: 'calculator',
            arguments: { expression: '2+2' }
          })
        })
      );
    });
    
    it('should handle API errors', async () => {
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized'
      } as Response);
      
      const client = createResponsesAPIClient({
        apiKey: 'invalid-key',
        modelId: 'o3'
      });
      
      await expect(client.stream([
        { role: 'user', content: 'Test' }
      ])).rejects.toThrow('Responses API error: 401 Unauthorized');
    });
  });
  
  describe('streamWithResponsesAPI', () => {
    it('should integrate with unified streaming format', async () => {
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"response_delta","content":"Test response"}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        }
      });
      
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        body: mockStream
      } as Response);
      
      // Mock env variable
      process.env.OPENAI_API_KEY = 'test-key';
      
      const request: StreamRequest = {
        messages: [
          {
            id: '1',
            role: 'user',
            parts: [{ type: 'text', text: 'Test message' }]
          }
        ],
        modelId: 'o3-mini',
        provider: 'openai',
        source: 'chat',
        userId: 'test-user',
        options: {
          reasoningEffort: 'high',
          backgroundMode: false
        }
      };
      
      const result = await streamWithResponsesAPI(request);
      
      expect(result.capabilities.supportsReasoning).toBe(true);
      expect(result.capabilities.supportsBackgroundMode).toBe(true);
      expect(result.result).toBeDefined();
      
      const usage = await result.result.usage;
      expect(usage).toBeDefined();
    });
  });
});