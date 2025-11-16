import { convertToModelMessages } from 'ai';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { getTelemetryConfig } from './telemetry-service';
import { getProviderAdapter, type ProviderCapabilities } from './provider-adapters';
import { CircuitBreaker, CircuitBreakerOpenError } from './circuit-breaker';
import type { StreamRequest, StreamResponse, StreamConfig, StreamingProgress, TelemetrySpan, TelemetryConfig } from './types';
import {
  isTextDeltaEvent,
  isTextStartEvent,
  isTextEndEvent,
  isToolCallEvent,
  isToolCallDeltaEvent,
  isReasoningDeltaEvent,
  isReasoningStartEvent,
  isReasoningEndEvent,
  isErrorEvent,
  isFinishEvent
} from './sse-event-types';

/**
 * Unified streaming service that handles all AI streaming operations
 * across chat, compare, and assistant execution tools.
 * 
 * Features:
 * - Provider-specific optimizations (OpenAI Responses API, Claude thinking, etc.)
 * - Comprehensive telemetry and observability
 * - Circuit breaker pattern for reliability
 * - Reasoning content extraction for advanced models
 * - Adaptive timeouts based on model capabilities
 */
export class UnifiedStreamingService {
  private circuitBreakers = new Map<string, CircuitBreaker>();
  
  /**
   * Main streaming method that handles all AI operations
   */
  async stream(request: StreamRequest): Promise<StreamResponse> {
    const requestId = generateRequestId();
    const timer = startTimer('unified-streaming-service.stream');
    const log = createLogger({ requestId, module: 'unified-streaming-service' });
    
    log.info('Starting unified stream', {
      provider: request.provider,
      modelId: request.modelId,
      source: request.source,
      userId: request.userId,
      messageCount: request.messages?.length || 0,
      hasMessages: !!request.messages,
      messagesType: typeof request.messages
    });
    
    try {
      // 1. Get provider adapter and capabilities
      const adapter = await getProviderAdapter(request.provider);
      const capabilities = adapter.getCapabilities(request.modelId);
      
      // 2. Configure telemetry
      const telemetryConfig = await getTelemetryConfig({
        functionId: `${request.source}.stream`,
        userId: request.userId,
        sessionId: request.sessionId,
        conversationId: request.conversationId,
        modelId: request.modelId,
        provider: request.provider,
        source: request.source,
        recordInputs: request.telemetry?.recordInputs,
        recordOutputs: request.telemetry?.recordOutputs
      });
      
      // 3. Check circuit breaker
      const circuitBreaker = this.getCircuitBreaker(request.provider);
      const circuitState = circuitBreaker.getState();
      log.info('Circuit breaker state', {
        provider: request.provider,
        state: circuitState,
        isOpen: circuitBreaker.isOpen(),
        metrics: circuitBreaker.getMetrics()
      });
      
      if (circuitBreaker.isOpen()) {
        log.error('Circuit breaker is open, blocking request', {
          provider: request.provider,
          state: circuitState
        });
        throw new CircuitBreakerOpenError(request.provider, circuitState);
      }
      
      // 4. Configure streaming with adaptive timeouts
      // Validate messages before conversion
      if (!request.messages || !Array.isArray(request.messages)) {
        log.error('Messages invalid in streaming service', {
          messages: request.messages,
          hasMessages: !!request.messages,
          isArray: Array.isArray(request.messages),
          requestKeys: Object.keys(request)
        });
        throw new Error('Messages array is required for streaming');
      }
      
      // Debug log the messages structure
      log.info('Messages structure before conversion', {
        messageCount: request.messages.length,
        firstMessage: JSON.stringify(request.messages[0]),
        allMessages: JSON.stringify(request.messages)
      });
      
      let convertedMessages;
      try {
        convertedMessages = convertToModelMessages(request.messages);
      } catch (conversionError) {
        const error = conversionError as Error;
        log.error('Failed to convert messages', {
          error: error.message,
          stack: error.stack,
          messages: JSON.stringify(request.messages)
        });
        throw new Error(`Message conversion failed: ${error.message}`);
      }
      
      // Create model (adapter stores client instance internally)
      const model = await adapter.createModel(request.modelId, request.options);

      // Create tools from adapter (uses same client instance as model)
      let tools = request.tools || {};
      if (!request.tools && request.enabledTools && request.enabledTools.length > 0) {
        tools = await adapter.createTools(request.enabledTools);
      }

      const config: StreamConfig = {
        model,
        messages: convertedMessages,
        system: request.systemPrompt,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        // Tools configuration
        tools,
        toolChoice: tools && Object.keys(tools).length > 0 ? 'auto' : undefined,
        // Adaptive timeout based on model capabilities
        timeout: this.getAdaptiveTimeout(capabilities, request),
        // Provider-specific options
        providerOptions: adapter.getProviderOptions(request.modelId, request.options),
        // Telemetry configuration
        experimental_telemetry: telemetryConfig.isEnabled ? {
          isEnabled: true,
          functionId: telemetryConfig.functionId,
          metadata: telemetryConfig.metadata,
          recordInputs: telemetryConfig.recordInputs,
          recordOutputs: telemetryConfig.recordOutputs,
          tracer: telemetryConfig.tracer
        } : undefined
      };
      
      // 5. Start telemetry span
      const span = telemetryConfig.tracer?.startSpan('ai.stream.unified', {
        attributes: {
          'ai.provider': request.provider,
          'ai.model.id': request.modelId,
          'ai.source': request.source,
          'ai.reasoning.capable': capabilities.supportsReasoning,
          'ai.thinking.capable': capabilities.supportsThinking,
          'ai.request.timeout': config.timeout
        }
      });
      
      try {
        // 6. Execute streaming with provider-specific handling
        const result = await adapter.streamWithEnhancements(config, {
          onProgress: (event) => {
            this.handleProgress(event, span, telemetryConfig);
            request.callbacks?.onProgress?.(event);
          },
          onReasoning: (reasoning) => {
            this.handleReasoning(reasoning, span);
            request.callbacks?.onReasoning?.(reasoning);
          },
          onThinking: (thinking) => {
            this.handleThinking(thinking, span);
            request.callbacks?.onThinking?.(thinking);
          },
          onFinish: async (data) => {
            this.handleFinish(data, span, telemetryConfig, timer);
            // Call user-provided onFinish callback
            if (request.callbacks?.onFinish) {
              try {
                await request.callbacks.onFinish(data);
              } catch (error) {
                // Safely extract error details to avoid circular reference issues
                const errorDetails = error instanceof Error ? {
                  name: error.name,
                  message: error.message,
                  stack: error.stack
                } : String(error);

                log.error('Critical: Failed to save assistant message', {
                  error: errorDetails,
                  conversationId: request.conversationId,
                  userId: request.userId
                });
                // Add telemetry for failed saves
                if (span) {
                  span.recordException(error as Error);
                  span.setAttributes({
                    'ai.message.save.failed': true,
                    'ai.message.save.error': (error as Error).message
                  });
                }
                // Don't rethrow to avoid breaking the stream, but mark as error
                // The message is already displayed to user, just not persisted
              }
            }
          },
          onError: (error) => {
            this.handleError(error, span, circuitBreaker);
            request.callbacks?.onError?.(error);
          }
        });
        
        // 7. Mark circuit breaker as successful
        circuitBreaker.recordSuccess();
        
        log.info('Stream completed successfully', {
          provider: request.provider,
          modelId: request.modelId,
          source: request.source
        });
        
        return {
          result,
          requestId,
          capabilities,
          telemetryConfig
        };
        
      } catch (error) {
        span?.recordException(error as Error);
        span?.setStatus({ code: 2 }); // ERROR
        circuitBreaker.recordFailure();
        throw error;
      } finally {
        span?.end();
      }
      
    } catch (error) {
      timer({ status: 'error' });
      log.error('Stream failed', {
        error: error instanceof Error ? error.message : String(error),
        provider: request.provider,
        modelId: request.modelId,
        source: request.source
      });
      throw error;
    }
  }
  
  /**
   * Get or create circuit breaker for provider
   */
  private getCircuitBreaker(provider: string): CircuitBreaker {
    if (!this.circuitBreakers.has(provider)) {
      this.circuitBreakers.set(provider, new CircuitBreaker({
        failureThreshold: 5,
        recoveryTimeoutMs: 60000, // 1 minute
        monitoringPeriodMs: 60000  // 1 minute
      }));
    }
    return this.circuitBreakers.get(provider)!;
  }
  
  /**
   * Calculate adaptive timeout based on model capabilities and request
   */
  private getAdaptiveTimeout(capabilities: ProviderCapabilities, request: StreamRequest): number {
    const baseTimeout = 30000; // 30 seconds
    
    // Extend timeout for reasoning models
    if (capabilities.supportsReasoning) {
      // o3/o4 models may need up to 5 minutes for complex reasoning
      if (request.modelId.includes('o3') || request.modelId.includes('o4')) {
        return 300000; // 5 minutes
      }
      // Claude thinking models may need up to 2 minutes
      if (capabilities.supportsThinking) {
        return 120000; // 2 minutes
      }
      // Other reasoning models get 1 minute
      return 60000;
    }
    
    // Standard models use base timeout
    return request.timeout || baseTimeout;
  }
  
  /**
   * Handle streaming progress events using typed SSE events and type guards
   */
  private handleProgress(progress: StreamingProgress, span: TelemetrySpan | undefined, telemetryConfig: TelemetryConfig) {
    if (!telemetryConfig.isEnabled || !span) {
      return;
    }

    const event = progress.event;

    // Use type guards for safe property access and specific event handling
    if (isTextDeltaEvent(event)) {
      span.addEvent('ai.stream.text.delta', {
        timestamp: Date.now(),
        'ai.text.delta.length': event.delta.length,
        'ai.tokens.estimated': progress.tokens || Math.ceil(event.delta.length / 4)
      });
    } else if (isTextStartEvent(event)) {
      span.addEvent('ai.stream.text.start', {
        timestamp: Date.now(),
        'ai.text.id': event.id
      });
    } else if (isTextEndEvent(event)) {
      span.addEvent('ai.stream.text.end', {
        timestamp: Date.now(),
        'ai.text.id': event.id
      });
    } else if (isToolCallEvent(event)) {
      span.addEvent('ai.stream.tool.call', {
        timestamp: Date.now(),
        'ai.tool.name': event.toolName,
        'ai.tool.call.id': event.toolCallId
      });
    } else if (isToolCallDeltaEvent(event)) {
      span.addEvent('ai.stream.tool.delta', {
        timestamp: Date.now(),
        'ai.tool.name': event.toolName,
        'ai.tool.call.id': event.toolCallId,
        'ai.tool.delta.length': event.delta?.length || 0
      });
    } else if (isReasoningDeltaEvent(event)) {
      span.addEvent('ai.stream.reasoning.delta', {
        timestamp: Date.now(),
        'ai.reasoning.delta.length': event.delta.length
      });
    } else if (isReasoningStartEvent(event)) {
      span.addEvent('ai.stream.reasoning.start', {
        timestamp: Date.now(),
        'ai.reasoning.id': event.id
      });
    } else if (isReasoningEndEvent(event)) {
      span.addEvent('ai.stream.reasoning.end', {
        timestamp: Date.now(),
        'ai.reasoning.id': event.id
      });
    } else if (isErrorEvent(event)) {
      span.addEvent('ai.stream.error', {
        timestamp: Date.now(),
        'ai.error.message': event.error,
        'ai.error.code': event.code || 'unknown'
      });
    } else if (isFinishEvent(event)) {
      span.addEvent('ai.stream.finish', {
        timestamp: Date.now(),
        'ai.usage.prompt_tokens': event.usage?.promptTokens || 0,
        'ai.usage.completion_tokens': event.usage?.completionTokens || 0,
        'ai.usage.total_tokens': event.usage?.totalTokens || 0
      });
    } else {
      // Fallback for unrecognized event types
      span.addEvent('ai.stream.progress', {
        timestamp: Date.now(),
        'ai.event.type': event.type,
        'ai.tokens.streamed': progress.tokens || 0
      });
    }
  }
  
  /**
   * Handle reasoning content for advanced models
   */
  private handleReasoning(reasoning: string, span: TelemetrySpan | undefined) {
    if (span) {
      span.addEvent('ai.reasoning.chunk', {
        timestamp: Date.now(),
        'ai.reasoning.length': reasoning.length
      });
    }
  }
  
  /**
   * Handle thinking content for Claude models
   */
  private handleThinking(thinking: string, span: TelemetrySpan | undefined) {
    if (span) {
      span.addEvent('ai.thinking.chunk', {
        timestamp: Date.now(),
        'ai.thinking.length': thinking.length
      });
    }
  }
  
  /**
   * Handle stream completion
   */
  private handleFinish(
    data: {
      text: string;
      usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        reasoningTokens?: number;
        totalCost?: number;
      };
      finishReason: string;
    },
    span: TelemetrySpan | undefined,
    telemetryConfig: TelemetryConfig,
    timer: (metadata?: Record<string, unknown>) => void
  ) {
    if (span) {
      span.setAttributes({
        'ai.tokens.input': data.usage?.promptTokens || 0,
        'ai.tokens.output': data.usage?.completionTokens || 0,
        'ai.tokens.total': data.usage?.totalTokens || 0,
        'ai.tokens.reasoning': data.usage?.reasoningTokens || 0,
        'ai.finish_reason': data.finishReason || 'unknown',
        'ai.cost.total': data.usage?.totalCost || 0
      });
      span.setStatus({ code: 1 }); // OK
    }
    
    timer({ 
      status: 'success',
      tokensUsed: data.usage?.totalTokens || 0,
      finishReason: data.finishReason
    });
  }
  
  /**
   * Handle stream errors
   */
  private handleError(error: Error, span: TelemetrySpan | undefined, circuitBreaker: CircuitBreaker) {
    if (span) {
      span.recordException(error);
      span.setStatus({ code: 2 }); // ERROR
    }
    circuitBreaker.recordFailure();
  }
}

// Singleton instance
export const unifiedStreamingService = new UnifiedStreamingService();