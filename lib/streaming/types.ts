import type { UIMessage, LanguageModel, ModelMessage, ToolSet } from 'ai';
import type { SSEEventEmitter } from '@/types/sse-events';
import type { SSEEvent } from './sse-event-types';

/**
 * Core streaming types for the unified streaming architecture
 */

export interface StreamRequest {
  // Core request data
  messages: UIMessage[];
  modelId: string;
  provider: string;
  
  // User context
  userId: string;
  sessionId?: string;
  conversationId?: string | number;
  
  // Request source and metadata
  source: 'chat' | 'compare' | 'assistant_execution' | 'ai-helpers' | 'nexus';
  executionId?: number;
  documentId?: string;
  
  // Model configuration
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
  
  // Tools configuration
  tools?: ToolSet;
  enabledTools?: string[]; // Tool names to enable (tools will be created by adapter)

  // Advanced model options
  options?: {
    // Reasoning configuration
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
    responseMode?: 'standard' | 'flex' | 'priority';

    // Background processing for long-running models
    backgroundMode?: boolean;

    // Thinking configuration for Claude models
    thinkingBudget?: number; // 1024-6553 tokens

    // Tool configuration
    enableWebSearch?: boolean;
    enableCodeInterpreter?: boolean;
    enableImageGeneration?: boolean;
    enabledTools?: string[];
  };

  // K-12 Content Safety Options
  contentSafety?: {
    /** Enable content safety filtering (default: true when guardrails configured) */
    enabled?: boolean;
    /** Enable PII tokenization (default: true when configured) */
    enablePiiTokenization?: boolean;
    /** Skip input safety check (not recommended) */
    skipInputCheck?: boolean;
    /** Skip output safety check (not recommended) */
    skipOutputCheck?: boolean;
  };
  
  // Telemetry configuration
  telemetry?: {
    recordInputs?: boolean;
    recordOutputs?: boolean;
    customAttributes?: Record<string, string | number | boolean>;
  };
  
  // Callbacks for streaming events
  callbacks?: StreamingCallbacks;
}

export interface StreamResponse {
  result: {
    toDataStreamResponse: (options?: { headers?: Record<string, string> }) => Response;
    toUIMessageStreamResponse: (options?: { headers?: Record<string, string> }) => Response;
    usage: Promise<{
      totalTokens?: number;
      promptTokens?: number;
      completionTokens?: number;
      reasoningTokens?: number;
      totalCost?: number;
    }>;
  };
  requestId: string;
  capabilities: ProviderCapabilities;
  telemetryConfig: TelemetryConfig;
}

export interface StreamConfig {
  model: LanguageModel;
  messages: ModelMessage[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
  tools?: ToolSet;
  toolChoice?: 'auto' | 'required' | { type: 'tool'; toolName: string };
  providerOptions?: Record<string, unknown>;
  experimental_telemetry?: {
    isEnabled: boolean;
    functionId: string;
    metadata: Record<string, string | number | boolean>;
    recordInputs: boolean;
    recordOutputs: boolean;
    tracer?: {
      startSpan: (name: string, options?: Record<string, unknown>) => TelemetrySpan;
    };
  };
}

export interface ProviderCapabilities {
  // Reasoning capabilities
  supportsReasoning: boolean;
  supportsThinking: boolean;
  maxThinkingTokens?: number;
  supportedResponseModes: ('standard' | 'flex' | 'priority')[];
  
  // Background processing
  supportsBackgroundMode: boolean;
  
  // Built-in tools
  supportedTools: string[];
  
  // Performance characteristics
  typicalLatencyMs: number;
  maxTimeoutMs: number;
  
  // Cost information
  costPerInputToken?: number;
  costPerOutputToken?: number;
  costPerReasoningToken?: number;
}

export interface TelemetrySpan {
  setAttributes: (attributes: Record<string, string | number | boolean>) => void;
  addEvent: (name: string, attributes?: Record<string, unknown>) => void;
  recordException: (error: Error) => void;
  setStatus: (status: { code: number; message?: string }) => void;
  end: () => void;
}

export interface TelemetryConfig {
  isEnabled: boolean;
  functionId: string;
  metadata: Record<string, string | number | boolean>;
  recordInputs: boolean;
  recordOutputs: boolean;
  tracer?: {
    startSpan: (name: string, options?: Record<string, unknown>) => TelemetrySpan;
  };
}

/**
 * Streaming progress event with typed SSE event
 * This replaces the generic metadata-based approach with typed SSE events
 */
export interface StreamingProgress {
  /** Typed SSE event - provides compile-time safety for all event types */
  event: SSEEvent;
  /** Optional token count for progress tracking */
  tokens?: number;
  /** Timestamp for debugging and monitoring */
  timestamp: number;

  // Legacy fields for backward compatibility
  /** @deprecated Use event.type instead */
  type?: 'token' | 'reasoning' | 'thinking' | 'tool_call' | 'tool_result';
  /** @deprecated Use event-specific fields (e.g., event.delta) instead */
  content?: string;
  /** @deprecated Use event.delta for text-delta events instead */
  text?: string;
  /** @deprecated Use typed event fields instead */
  metadata?: Record<string, unknown>;
}

/**
 * Tool call data structure for persistence
 */
export interface ToolCallData {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;  // Tool execution result for persistence
}

export interface StreamingCallbacks {
  onProgress?: (event: StreamingProgress) => void;
  onReasoning?: (reasoning: string) => void;
  onThinking?: (thinking: string) => void;
  onFinish?: (data: {
    text: string;
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      reasoningTokens?: number;
      totalCost?: number;
    };
    finishReason: string;
    /** Tool calls made during this response (from all steps) */
    toolCalls?: ToolCallData[];
  }) => void;
  onError?: (error: Error) => void;

  /**
   * SSE event emitter for custom progress events
   * Only used for assistant architect execution
   */
  sseEventEmitter?: SSEEventEmitter;
}

export interface ProviderAdapter {
  /**
   * Create a model instance for this provider
   */
  createModel(modelId: string, options?: StreamRequest['options']): Promise<LanguageModel>;
  
  /**
   * Get capabilities for a specific model
   */
  getCapabilities(modelId: string): ProviderCapabilities;
  
  /**
   * Get provider-specific options for streaming
   */
  getProviderOptions(modelId: string, options?: StreamRequest['options']): Record<string, unknown>;

  /**
   * Create provider-native tools from stored client instance
   */
  createTools(enabledTools: string[]): Promise<ToolSet>;

  /**
   * Get list of tools supported by a specific model
   */
  getSupportedTools(modelId: string): string[];

  /**
   * Stream with provider-specific enhancements
   */
  streamWithEnhancements(
    config: StreamConfig,
    callbacks: StreamingCallbacks
  ): Promise<{
    toDataStreamResponse: (options?: { headers?: Record<string, string> }) => Response;
    toUIMessageStreamResponse: (options?: { headers?: Record<string, string> }) => Response;
    usage: Promise<{
      totalTokens?: number;
      promptTokens?: number;
      completionTokens?: number;
      reasoningTokens?: number;
      totalCost?: number;
    }>;
  }>;
  
  /**
   * Validate if this adapter supports the given model
   */
  supportsModel(modelId: string): boolean;
}

// Export unified streaming service interface
export interface IUnifiedStreamingService {
  stream(request: StreamRequest): Promise<StreamResponse>;
}

// Error types specific to streaming
export class StreamingError extends Error {
  constructor(
    message: string,
    public code: string,
    public provider?: string,
    public modelId?: string,
    public cause?: Error
  ) {
    super(message);
    this.name = 'StreamingError';
  }
}

export class ProviderUnavailableError extends StreamingError {
  constructor(provider: string, cause?: Error) {
    super(
      `Provider ${provider} is currently unavailable`,
      'PROVIDER_UNAVAILABLE',
      provider,
      undefined,
      cause
    );
  }
}

export class ModelNotSupportedError extends StreamingError {
  constructor(provider: string, modelId: string) {
    super(
      `Model ${modelId} is not supported by provider ${provider}`,
      'MODEL_NOT_SUPPORTED',
      provider,
      modelId
    );
  }
}

export class StreamTimeoutError extends StreamingError {
  constructor(timeoutMs: number, provider: string, modelId: string) {
    super(
      `Stream timed out after ${timeoutMs}ms`,
      'STREAM_TIMEOUT',
      provider,
      modelId
    );
  }
}

/**
 * Error thrown when content is blocked by safety guardrails
 */
export class ContentSafetyBlockedError extends StreamingError {
  constructor(
    public blockedMessage: string,
    public blockedCategories: string[],
    public source: 'input' | 'output',
    provider?: string,
    modelId?: string
  ) {
    super(
      blockedMessage,
      source === 'input' ? 'CONTENT_BLOCKED_INPUT' : 'CONTENT_BLOCKED_OUTPUT',
      provider,
      modelId
    );
    this.name = 'ContentSafetyBlockedError';
  }
}

// Utility types for frontend hooks
export interface UseUnifiedStreamConfig {
  source: StreamRequest['source'];
  modelId?: string;
  provider?: string;
  systemPrompt?: string;
  options?: StreamRequest['options'];
  telemetry?: StreamRequest['telemetry'];
}

export interface UseUnifiedStreamReturn {
  messages: UIMessage[];
  status: 'idle' | 'loading' | 'streaming' | 'success' | 'error';
  error: Error | null;
  reasoning: string | null;
  thinking: string | null;
  sendMessage: (message: UIMessage, config?: Partial<StreamRequest>) => Promise<void>;
  stop: () => void;
  clear: () => void;
  capabilities: ProviderCapabilities | null;
}