/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock all dependencies with proper typing
const mockGetTelemetryConfig = jest.fn() as jest.Mock<any>;
const mockGetProviderAdapter = jest.fn() as jest.Mock<any>;

jest.doMock('../telemetry-service', () => ({
  getTelemetryConfig: mockGetTelemetryConfig
}));

jest.doMock('../provider-adapters', () => ({
  getProviderAdapter: mockGetProviderAdapter,
  getModelCapabilities: jest.fn(),
  isModelSupported: jest.fn(),
  getSupportedProviders: jest.fn()
}));

jest.doMock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }),
  generateRequestId: () => 'test-request-id',
  startTimer: () => jest.fn()
}));

// Import after mocking - disable ESLint for this specific case
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { UnifiedStreamingService } = require('../unified-streaming-service');

describe('UnifiedStreamingService', () => {
  let streamingService: any;
  let mockAdapter: any;
  let mockTelemetryConfig: any;

  beforeEach(() => {
    jest.clearAllMocks();
    
    streamingService = new UnifiedStreamingService();
    
    mockAdapter = {
      createModel: jest.fn(),
      createTools: (jest.fn() as jest.Mock<any>).mockResolvedValue({}),
      getCapabilities: jest.fn(),
      getProviderOptions: jest.fn(),
      streamWithEnhancements: jest.fn()
    };
    
    mockTelemetryConfig = {
      isEnabled: true,
      functionId: 'test-function',
      metadata: {},
      recordInputs: true,
      recordOutputs: true,
      tracer: {
        startSpan: jest.fn(() => ({
          setAttributes: jest.fn(),
          addEvent: jest.fn(),
          recordException: jest.fn(),
          setStatus: jest.fn(),
          end: jest.fn()
        }))
      }
    };
    
    mockGetProviderAdapter.mockResolvedValue(mockAdapter);
    mockGetTelemetryConfig.mockResolvedValue(mockTelemetryConfig);
  });

  describe('stream', () => {
    it('should successfully stream with OpenAI provider', async () => {
      // Arrange
      const request = {
        provider: 'openai',
        modelId: 'gpt-4',
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'Hello' }] }
        ],
        temperature: 0.7,
        userId: 'test-user'
      };

      const mockCapabilities = {
        supportsReasoning: false,
        supportsThinking: false,
        supportsResponsesApi: true,
        streamingThreshold: 1000,
        maxTimeoutMs: 30000
      };

      const mockStreamResult = {
        result: {
          toUIMessageStreamResponse: jest.fn(() => new Response('stream')),
          onFinish: jest.fn()
        },
        telemetry: {
          totalDuration: 100,
          streamDuration: 80,
          firstTokenLatency: 20
        },
        reasoning: undefined
      };

      const mockModel = {
        id: 'gpt-4',
        provider: 'openai'
      };

      mockAdapter.getCapabilities.mockReturnValue(mockCapabilities);
      mockAdapter.createModel.mockResolvedValue(mockModel);
      mockAdapter.getProviderOptions.mockReturnValue({});
      mockAdapter.streamWithEnhancements.mockResolvedValue(mockStreamResult);

      // Act
      const result = await streamingService.stream(request);

      // Assert
      expect(result).toBeDefined();
      expect(result.result).toBeDefined();
      expect(mockAdapter.createModel).toHaveBeenCalled();
      expect(mockAdapter.createModel.mock.calls[0][0]).toBe('gpt-4');
      expect(mockAdapter.streamWithEnhancements).toHaveBeenCalled();
    });

    it('should handle reasoning models with extended timeout', async () => {
      // Arrange
      const request = {
        provider: 'openai',
        modelId: 'o3-mini',
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'Solve a complex problem' }] }
        ],
        temperature: 0.7,
        userId: 'test-user'
      };

      const mockCapabilities = {
        supportsReasoning: true,
        supportsThinking: false,
        supportsResponsesApi: true,
        streamingThreshold: 1000,
        maxTimeoutMs: 300000 // 5 minutes for reasoning
      };

      const mockStreamResult = {
        result: {
          toUIMessageStreamResponse: jest.fn(() => new Response('stream')),
          onFinish: jest.fn()
        },
        telemetry: {
          totalDuration: 45000,
          streamDuration: 44000,
          firstTokenLatency: 1000
        },
        reasoning: {
          content: 'Let me think step by step...',
          tokens: 500
        }
      };

      const mockModel = {
        id: 'o3-mini',
        provider: 'openai'
      };

      mockAdapter.getCapabilities.mockReturnValue(mockCapabilities);
      mockAdapter.createModel.mockResolvedValue(mockModel);
      mockAdapter.getProviderOptions.mockReturnValue({});
      mockAdapter.streamWithEnhancements.mockResolvedValue(mockStreamResult);

      // Act
      const result = await streamingService.stream(request);

      // Assert
      expect(result).toBeDefined();
      expect(result.result).toBeDefined();
      expect(mockAdapter.streamWithEnhancements).toHaveBeenCalledWith(
        expect.objectContaining({
          timeout: 300000 // Should use extended timeout for reasoning
        }),
        expect.any(Object) // The callbacks object
      );
    });

    it('should handle Claude thinking models', async () => {
      // Arrange
      const request = {
        provider: 'amazon-bedrock',
        modelId: 'claude-3-opus',
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'Complex analysis needed' }] }
        ],
        temperature: 0.5,
        userId: 'test-user'
      };

      const mockCapabilities = {
        supportsReasoning: false,
        supportsThinking: true,
        supportsResponsesApi: false,
        streamingThreshold: 2000,
        maxTimeoutMs: 120000
      };

      const mockStreamResult = {
        result: {
          toUIMessageStreamResponse: jest.fn(() => new Response('stream')),
          onFinish: jest.fn()
        },
        telemetry: {
          totalDuration: 25000,
          streamDuration: 24000,
          firstTokenLatency: 1000
        },
        reasoning: {
          content: '<thinking>Analyzing the problem...</thinking>',
          tokens: 200
        },
        thinking: {
          content: 'Analyzing the problem...',
          tokens: 200
        }
      };

      const mockModel = {
        id: 'claude-3-opus',
        provider: 'amazon-bedrock'
      };

      mockAdapter.getCapabilities.mockReturnValue(mockCapabilities);
      mockAdapter.createModel.mockResolvedValue(mockModel);
      mockAdapter.getProviderOptions.mockReturnValue({
        anthropic: {
          thinkingBudget: 4000,
          enableThinking: true,
          streamThinking: true
        }
      });
      mockAdapter.streamWithEnhancements.mockResolvedValue(mockStreamResult);

      // Act
      const result = await streamingService.stream(request);

      // Assert
      expect(result).toBeDefined();
      expect(result.result).toBeDefined();
      expect(mockAdapter.getProviderOptions).toHaveBeenCalledWith('claude-3-opus', undefined);
    });

    it('should handle circuit breaker open state', async () => {
      // Arrange
      const request = {
        provider: 'openai',
        modelId: 'gpt-4',
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'Hello' }] }
        ],
        temperature: 0.7,
        userId: 'test-user'
      };

      // Create a failing adapter
      const failingAdapter = {
        createModel: (jest.fn() as jest.Mock<any>).mockResolvedValue({ id: 'gpt-4', provider: 'openai' }),
        createTools: (jest.fn() as jest.Mock<any>).mockResolvedValue({}),
        getCapabilities: jest.fn().mockReturnValue({
          supportsReasoning: false,
          supportsThinking: false,
          supportsResponsesApi: true,
          streamingThreshold: 1000,
          maxTimeoutMs: 30000
        }),
        getProviderOptions: jest.fn().mockReturnValue({}),
        streamWithEnhancements: jest.fn(() => Promise.reject(new Error('Provider failure')))
      };

      mockGetProviderAdapter.mockResolvedValue(failingAdapter);

      // Trip the circuit breaker by failing multiple times
      const streamingServiceWithFailures = new UnifiedStreamingService();
      
      // Make 5 failed attempts to open the circuit (failureThreshold is 5)
      for (let i = 0; i < 5; i++) {
        try {
          await streamingServiceWithFailures.stream(request);
        } catch {
          // Expected to fail - error intentionally ignored
        }
      }

      // Act & Assert
      // Next attempt should fail immediately with circuit breaker open
      await expect(streamingServiceWithFailures.stream(request)).rejects.toThrow(
        'Circuit breaker is open for provider: openai'
      );
      
      // Verify the adapter wasn't called again after circuit opened
      expect(failingAdapter.streamWithEnhancements).toHaveBeenCalledTimes(5);
    });

    it('should record telemetry correctly', async () => {
      // Arrange
      const request = {
        provider: 'openai',
        modelId: 'gpt-4',
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'Hello' }] }
        ],
        temperature: 0.7,
        userId: 'test-user'
      };

      const mockCapabilities = {
        supportsReasoning: false,
        supportsThinking: false,
        supportsResponsesApi: true,
        streamingThreshold: 1000,
        maxTimeoutMs: 30000
      };

      const mockStreamResult = {
        result: {
          toUIMessageStreamResponse: jest.fn(() => new Response('stream')),
          onFinish: jest.fn()
        },
        telemetry: {
          totalDuration: 100,
          streamDuration: 80,
          firstTokenLatency: 20
        }
      };

      const mockModel = {
        id: 'gpt-4',
        provider: 'openai'
      };

      mockAdapter.getCapabilities.mockReturnValue(mockCapabilities);
      mockAdapter.createModel.mockResolvedValue(mockModel);
      mockAdapter.getProviderOptions.mockReturnValue({});
      mockAdapter.streamWithEnhancements.mockResolvedValue(mockStreamResult);

      // Act
      await streamingService.stream(request);

      // Assert
      expect(mockGetTelemetryConfig).toHaveBeenCalled();
      const callArgs = mockGetTelemetryConfig.mock.calls[0][0] as any;
      expect(callArgs.userId).toBe('test-user');
      expect(callArgs.modelId).toBe('gpt-4');
      expect(callArgs.provider).toBe('openai');
    });
  });
});