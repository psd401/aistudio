import { convertToModelMessages } from 'ai';
import { createProviderAdapter } from './provider-factory';
import { createLogger } from './utils/logger';
import type { SettingsManager } from './utils/settings-manager';
import type { 
  StreamRequest, 
  StreamResponse, 
  StreamConfig, 
  StreamingProgress
} from './types';

/**
 * Circuit breaker for provider reliability
 */
class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private isOpen = false;
  
  constructor(
    private readonly failureThreshold = 5,
    private readonly recoveryTimeoutMs = 60000
  ) {}
  
  execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOpen && Date.now() - this.lastFailureTime < this.recoveryTimeoutMs) {
      throw new Error('Circuit breaker is open');
    }
    
    return fn()
      .then(result => {
        this.onSuccess();
        return result;
      })
      .catch(error => {
        this.onFailure();
        throw error;
      });
  }
  
  private onSuccess() {
    this.failures = 0;
    this.isOpen = false;
  }
  
  private onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    
    if (this.failures >= this.failureThreshold) {
      this.isOpen = true;
    }
  }
  
  getState() {
    return {
      failures: this.failures,
      isOpen: this.isOpen,
      lastFailureTime: this.lastFailureTime
    };
  }
}

/**
 * Unified streaming service that handles all AI streaming operations
 * across chat, compare, and assistant execution tools.
 * 
 * Supports multiple providers (OpenAI, Claude via Bedrock, Google Gemini, Azure)
 * with circuit breaker pattern, telemetry, and settings management.
 */
export class UnifiedStreamingService {
  private circuitBreakers = new Map<string, CircuitBreaker>();
  private settingsManager?: SettingsManager;
  
  /**
   * Initialize the unified streaming service
   * @param settingsManager - Optional settings manager for database-backed configuration
   */
  constructor(settingsManager?: SettingsManager) {
    this.settingsManager = settingsManager;
  }
  
  /**
   * Main streaming method that handles all AI operations
   */
  async stream(request: StreamRequest): Promise<StreamResponse> {
    const requestId = this.generateRequestId();
    const startTime = Date.now();
    const log = createLogger({ module: 'UnifiedStreamingService', requestId });
    
    log.info('Starting unified stream', {
      provider: request.provider,
      modelId: request.modelId,
      source: request.source,
      userId: request.userId,
      messageCount: request.messages?.length || 0
    });
    
    try {
      // 1. Get provider adapter and capabilities  
      const adapter = createProviderAdapter(request.provider, this.settingsManager);
      const capabilities = adapter.getCapabilities(request.modelId);
      
      // 2. Check circuit breaker
      const circuitBreaker = this.getCircuitBreaker(request.provider);
      
      // 3. Validate and convert messages
      if (!request.messages || !Array.isArray(request.messages)) {
        throw new Error('Messages array is required for streaming');
      }
      
      // Pass messages directly to AI SDK without preprocessing
      // Let convertToModelMessages handle UIMessage → ModelMessage conversion
      const processedMessages = request.messages;
      
      let convertedMessages;
      try {
        convertedMessages = convertToModelMessages(processedMessages as Parameters<typeof convertToModelMessages>[0]);
      } catch (conversionError) {
        log.error('Message conversion failed', {
          error: (conversionError as Error).message
        });
        throw new Error(`Message conversion failed: ${(conversionError as Error).message}`);
      }
      
      // 4. Create model
      const model = await adapter.createModel(request.modelId, request.options);
      
      // 5. Configure streaming
      const tools = request.tools;
      
      // For gpt-image-1, we need to pass tools in the options to the Responses API
      // The tools array should be passed to the createModel call instead
      
      const config: StreamConfig = {
        model,
        messages: convertedMessages,
        system: request.systemPrompt,
        maxTokens: request.maxTokens || request.options?.maxTokens,
        temperature: request.temperature || request.options?.temperature,
        tools,
        timeout: this.getAdaptiveTimeout(capabilities, request),
        providerOptions: adapter.getProviderOptions(request.modelId, request.options)
      };
      
      // 6. Execute streaming with circuit breaker
      const result = await circuitBreaker.execute(async () => {
        return await adapter.streamWithEnhancements(config, {
          onProgress: (event) => {
            this.handleProgress(event, requestId);
            request.callbacks?.onProgress?.(event);
          },
          onReasoning: (reasoning) => {
            this.handleReasoning(reasoning, requestId);
            request.callbacks?.onReasoning?.(reasoning);
          },
          onThinking: (thinking) => {
            this.handleThinking(thinking, requestId);
            request.callbacks?.onThinking?.(thinking);
          },
          onFinish: async (data) => {
            const duration = Date.now() - startTime;
            this.handleFinish(data, requestId, duration);
            
            // Call user-provided onFinish callback
            if (request.callbacks?.onFinish) {
              try {
                await request.callbacks.onFinish(data);
              } catch (error) {
                log.error('Failed to execute onFinish callback:', {
                  error,
                  conversationId: request.conversationId
                });
                // Don't rethrow to avoid breaking the stream
              }
            }
          },
          onError: (error) => {
            this.handleError(error, requestId);
            request.callbacks?.onError?.(error);
          }
        });
      });
      
      log.info('Stream completed successfully', {
        provider: request.provider,
        modelId: request.modelId,
        duration: Date.now() - startTime
      });
      
      return {
        result,
        requestId,
        capabilities,
        telemetryConfig: { isEnabled: false } // Basic implementation
      };
      
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error('Stream failed', {
        error: error instanceof Error ? error.message : String(error),
        provider: request.provider,
        modelId: request.modelId,
        duration
      });
      throw error;
    }
  }
  
  /**
   * Generate image using unified provider system
   */
  async generateImage(request: {
    provider: string;
    modelId: string;
    prompt: string;
    size?: string;
    style?: string;
    options?: Record<string, unknown>;
    userId?: string;
    source?: string;
  }): Promise<{
    image: { base64: string; mediaType: string };
    metadata: {
      provider: string;
      model: string;
      prompt: string;
      size?: string;
      style?: string;
      generatedAt: string;
    };
  }> {
    const requestId = this.generateRequestId();
    const startTime = Date.now();
    const log = createLogger({ module: 'UnifiedStreamingService', requestId });
    
    log.info('Starting image generation', {
      provider: request.provider,
      modelId: request.modelId,
      source: request.source || 'unknown',
      userId: request.userId,
      prompt: request.prompt.substring(0, 100) + (request.prompt.length > 100 ? '...' : ''),
      size: request.size,
      style: request.style
    });
    
    try {
      // 1. Validate request
      if (!request.prompt || typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
        throw new Error('Image generation prompt is required');
      }
      
      // 2. Get circuit breaker
      const circuitBreaker = this.getCircuitBreaker(request.provider);
      
      // 3. Create provider adapter
      const adapter = createProviderAdapter(request.provider, this.settingsManager);
      
      // 4. Create image model
      const imageModel = await adapter.createImageModel(request.modelId, request.options);
      
      // 5. Configure generation options
      const generateConfig = {
        model: imageModel,
        prompt: request.prompt.trim(),
        ...((request.size?.length ?? 0) > 0 && { size: request.size }),
        ...(request.style && { style: request.style }),
        providerOptions: adapter.getProviderOptions(request.modelId, request.options)
      };
      
      // 6. Execute image generation with circuit breaker
      const result = await circuitBreaker.execute(async () => {
        return await adapter.generateImageWithEnhancements(generateConfig, {
          onError: (error) => {
            this.handleError(error, requestId);
          }
        });
      });
      
      const duration = Date.now() - startTime;
      
      log.info('Image generation completed', {
        provider: request.provider,
        modelId: request.modelId,
        duration,
        hasImage: !!result.image,
        imageType: result.image?.mediaType
      });
      
      return {
        image: result.image,
        metadata: {
          provider: request.provider,
          model: request.modelId,
          prompt: request.prompt,
          size: request.size,
          style: request.style,
          generatedAt: new Date().toISOString()
        }
      };
      
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error('Image generation failed', {
        provider: request.provider,
        modelId: request.modelId,
        error: (error as Error).message,
        duration
      });
      throw error;
    }
  }
  
  /**
   * Preprocess messages to ensure correct format for AI SDK
   */
  private preprocessMessages(messages: Record<string, unknown>[]): Record<string, unknown>[] {
    return messages.map((msg) => {
      // If message already has parts array, use it as-is
      if (msg.parts && Array.isArray(msg.parts)) {
        return msg;
      }
      
      // If message has content property with string, convert to parts
      if ('content' in msg && typeof msg.content === 'string') {
        return {
          ...msg,
          parts: [{ type: 'text', text: msg.content }]
        };
      }
      
      // If message has content property with array, keep as ModelMessage format
      // Don't convert back to parts - let convertToModelMessages handle proper conversion
      if ('content' in msg && Array.isArray(msg.content)) {
        return msg;
      }
      
      // Otherwise, return as-is and let convertToModelMessages handle it
      return msg;
    });
  }
  
  /**
   * Get or create circuit breaker for provider
   */
  private getCircuitBreaker(provider: string): CircuitBreaker {
    if (!this.circuitBreakers.has(provider)) {
      this.circuitBreakers.set(provider, new CircuitBreaker());
    }
    return this.circuitBreakers.get(provider)!;
  }
  
  /**
   * Calculate adaptive timeout based on model capabilities
   */
  private getAdaptiveTimeout(capabilities: { supportsReasoning?: boolean; supportsThinking?: boolean; maxTimeoutMs?: number }, request: StreamRequest): number {
    const baseTimeout = 30000; // 30 seconds
    
    // Extend timeout for reasoning models
    if (capabilities.supportsReasoning) {
      // Complex reasoning models may need up to 5 minutes
      if (request.modelId.includes('o3') || request.modelId.includes('o4') || request.modelId.includes('gpt-5')) {
        return 300000; // 5 minutes
      }
      // Claude thinking models may need up to 2 minutes
      if (capabilities.supportsThinking) {
        return 120000; // 2 minutes
      }
      // Other reasoning models get 1 minute
      return 60000;
    }
    
    return request.timeout || baseTimeout;
  }
  
  /**
   * Handle streaming progress events
   */
  private handleProgress(event: StreamingProgress, requestId: string) {
    const log = createLogger({ module: 'UnifiedStreamingService', requestId });
    log.debug('Stream progress', {
      tokens: event.metadata?.tokens
    });
  }
  
  /**
   * Handle reasoning content
   */
  private handleReasoning(reasoning: string, requestId: string) {
    const log = createLogger({ module: 'UnifiedStreamingService', requestId });
    log.debug('Reasoning chunk received', {
      length: reasoning.length
    });
  }
  
  /**
   * Handle thinking content
   */
  private handleThinking(thinking: string, requestId: string) {
    const log = createLogger({ module: 'UnifiedStreamingService', requestId });
    log.debug('Thinking chunk received', {
      length: thinking.length
    });
  }
  
  /**
   * Handle stream completion
   */
  private handleFinish(
    data: {
      text: string;
      usage?: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        reasoningTokens?: number;
        totalCost?: number;
      };
      finishReason: string;
    },
    requestId: string,
    duration: number
  ) {
    const log = createLogger({ module: 'UnifiedStreamingService', requestId });
    log.info('Stream finished', {
      textLength: data.text?.length || 0,
      tokensUsed: data.usage?.totalTokens || 0,
      finishReason: data.finishReason,
      duration
    });
  }
  
  /**
   * Handle stream errors
   */
  private handleError(error: Error, requestId: string) {
    const log = createLogger({ module: 'UnifiedStreamingService', requestId });
    log.error('Stream error', {
      error: error.message,
      stack: error.stack
    });
  }
  
  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}