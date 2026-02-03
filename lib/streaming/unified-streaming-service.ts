import { convertToModelMessages } from 'ai';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { getTelemetryConfig } from './telemetry-service';
import { getProviderAdapter, type ProviderCapabilities } from './provider-adapters';
import { CircuitBreaker, CircuitBreakerOpenError } from './circuit-breaker';
import { getContentSafetyService, type ContentSafetyResult } from '@/lib/safety';
import type { TokenMapping } from '@/lib/safety/types';
import type { StreamRequest, StreamResponse, StreamConfig, StreamingProgress, TelemetrySpan, TelemetryConfig } from './types';
import { ContentSafetyBlockedError } from './types';

// Logger for PII transform debugging
const piiTransformLog = createLogger({ module: 'pii-transform' });

// PII token format: [PII:uuid] where uuid is 36 chars = 42 total chars
const PII_TOKEN_REGEX = /\[PII:[\da-f-]{36}]/g;
// Simple check for potential partial token at end of string
// Looks for "[" followed by characters that could be part of "[PII:uuid]"
function hasPartialPIITokenAtEnd(text: string): { hasPartial: boolean; startIndex: number } {
  // Look for "[" in the last 42 characters (max PII token length)
  const searchStart = Math.max(0, text.length - 42);
  const lastBracket = text.lastIndexOf('[', text.length - 1);

  if (lastBracket < searchStart) {
    return { hasPartial: false, startIndex: -1 };
  }

  // Check if it looks like the start of a PII token using simple string checks
  const suffix = text.slice(lastBracket);

  // Valid partial patterns: "[", "[P", "[PI", "[PII", "[PII:", "[PII:xxx..."
  if (suffix === '[' ||
      suffix === '[P' ||
      suffix === '[PI' ||
      suffix === '[PII' ||
      suffix === '[PII:' ||
      (suffix.startsWith('[PII:') && suffix.length < 42 && !suffix.endsWith(']'))) {
    return { hasPartial: true, startIndex: lastBracket };
  }

  return { hasPartial: false, startIndex: -1 };
}

/**
 * Replace PII tokens in text with original values.
 * Returns { processed: string, remainder: string } where remainder
 * contains any partial token at the end that needs to be buffered.
 */
function replacePIITokensWithRemainder(
  text: string,
  tokenMap: Map<string, string>
): { processed: string; remainder: string } {
  // Replace all complete tokens
  const processed = text.replace(PII_TOKEN_REGEX, (match) => {
    const replacement = tokenMap.get(match);
    if (replacement) {
      return replacement;
    } else {
      // Log without exposing actual token patterns - just indicate a mismatch occurred
      piiTransformLog.warn('PII token mismatch during detokenization', { tokenCount: tokenMap.size });
      return match;
    }
  });

  // Check if there's a partial token at the end that needs buffering
  const { hasPartial, startIndex } = hasPartialPIITokenAtEnd(processed);
  if (hasPartial && startIndex >= 0) {
    return {
      processed: processed.slice(0, startIndex),
      remainder: processed.slice(startIndex)
    };
  }

  return { processed, remainder: '' };
}

/**
 * Process a single SSE event and replace PII tokens if present.
 * Uses textBuffer to handle tokens that span multiple events.
 * Returns { output: string, newBuffer: string }
 */
function processSSEEventWithBuffer(
  event: string,
  tokenMap: Map<string, string>,
  textBuffer: string,
  SSE_DATA_PREFIX: string
): { output: string; newBuffer: string } {
  // Empty or non-data events pass through unchanged
  if (!event.trim() || !event.startsWith(SSE_DATA_PREFIX)) {
    return { output: event, newBuffer: textBuffer };
  }

  const jsonContent = event.slice(SSE_DATA_PREFIX.length);

  // Handle [DONE] marker - pass through unchanged
  if (jsonContent === '[DONE]') {
    return { output: event, newBuffer: textBuffer };
  }

  try {
    const parsed = JSON.parse(jsonContent);

    // Handle text-delta events (primary streaming text)
    if (parsed.type === 'text-delta' && parsed.delta && typeof parsed.delta === 'string') {
      // Prepend any buffered text from previous chunks
      const fullText = textBuffer + parsed.delta;
      const { processed, remainder } = replacePIITokensWithRemainder(fullText, tokenMap);

      // Update the delta with processed text (may be empty if all buffered)
      parsed.delta = processed;

      // If delta is empty after processing, we might want to skip this event
      // but that could mess up client state, so we send it anyway
      return {
        output: SSE_DATA_PREFIX + JSON.stringify(parsed),
        newBuffer: remainder
      };
    }

    // Handle reasoning-delta events similarly
    if (parsed.type === 'reasoning-delta' && parsed.delta && typeof parsed.delta === 'string') {
      const fullText = textBuffer + parsed.delta;
      const { processed, remainder } = replacePIITokensWithRemainder(fullText, tokenMap);
      parsed.delta = processed;
      return {
        output: SSE_DATA_PREFIX + JSON.stringify(parsed),
        newBuffer: remainder
      };
    }

    // Non-delta events pass through unchanged
    return { output: SSE_DATA_PREFIX + JSON.stringify(parsed), newBuffer: textBuffer };
  } catch {
    // Not valid JSON or parse error, pass through unchanged
    return { output: event, newBuffer: textBuffer };
  }
}

/**
 * Create a TransformStream that replaces PII tokens with original values in real-time.
 * Handles the AI SDK UI Message Stream Protocol format (SSE with data: prefix).
 *
 * AI SDK stream format:
 * - data: {"type":"text-delta","delta":"Hello [PII:uuid]"}\n\n
 * - data: [DONE]\n\n
 *
 * @see https://sdk.vercel.ai/docs/ai-sdk-ui/stream-protocol
 */
function createPIIDetokenizeTransform(tokenMappings: TokenMapping[]): TransformStream<Uint8Array, Uint8Array> {
  // Build lookup map from token placeholder to original value
  const tokenMap = new Map<string, string>();
  for (const mapping of tokenMappings) {
    tokenMap.set(mapping.placeholder, mapping.original);
  }

  // If no tokens to replace, return a pass-through transform
  if (tokenMap.size === 0) {
    return new TransformStream();
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let sseBuffer = '';      // Buffer for incomplete SSE events
  let textBuffer = '';     // Buffer for partial PII tokens across text-delta events

  // SSE format constants
  const SSE_EVENT_SEPARATOR = '\n\n';
  const SSE_DATA_PREFIX = 'data: ';

  return new TransformStream({
    transform(chunk, controller) {
      // Decode chunk and add to SSE buffer
      const decoded = decoder.decode(chunk, { stream: true });
      sseBuffer += decoded;

      // Process complete SSE events (terminated by \n\n)
      let separatorIndex: number;
      while ((separatorIndex = sseBuffer.indexOf(SSE_EVENT_SEPARATOR)) !== -1) {
        const event = sseBuffer.slice(0, separatorIndex);
        sseBuffer = sseBuffer.slice(separatorIndex + SSE_EVENT_SEPARATOR.length);

        // Process event with text buffering for cross-chunk PII tokens
        const { output, newBuffer } = processSSEEventWithBuffer(
          event,
          tokenMap,
          textBuffer,
          SSE_DATA_PREFIX
        );
        textBuffer = newBuffer;

        controller.enqueue(encoder.encode(output + SSE_EVENT_SEPARATOR));
      }
    },

    flush(controller) {
      // If there's remaining text buffer, output it as a final text-delta event
      // This handles any partial token that was buffered but never completed
      if (textBuffer.length > 0) {
        const finalEvent = { type: 'text-delta', delta: textBuffer, id: 'pii-flush' };
        controller.enqueue(encoder.encode(SSE_DATA_PREFIX + JSON.stringify(finalEvent) + SSE_EVENT_SEPARATOR));
      }

      // Output any remaining SSE buffer content (handles incomplete final event)
      if (sseBuffer.length > 0) {
        const { output } = processSSEEventWithBuffer(sseBuffer, tokenMap, '', SSE_DATA_PREFIX);
        controller.enqueue(encoder.encode(output));
      }
    }
  });
}
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
 * Result of content safety input check
 */
interface InputSafetyCheckResult {
  safetyResult?: ContentSafetyResult;
  updatedMessages: StreamRequest['messages'];
}

/**
 * Options for input content safety check
 */
interface InputSafetyCheckOptions {
  messages: StreamRequest['messages'];
  request: StreamRequest;
  contentSafetyService: ReturnType<typeof getContentSafetyService>;
  log: ReturnType<typeof createLogger>;
  requestId: string;
}

/**
 * Options for output content safety check
 */
interface OutputSafetyCheckOptions {
  data: { text: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number; reasoningTokens?: number; totalCost?: number }; finishReason: string };
  request: StreamRequest;
  contentSafetyService: ReturnType<typeof getContentSafetyService>;
  log: ReturnType<typeof createLogger>;
  requestId: string;
  span: TelemetrySpan | undefined;
}

/**
 * Result of content safety output check
 */
interface OutputSafetyCheckResult {
  processedData: OutputSafetyCheckOptions['data'];
  wasBlocked: boolean;
}

/**
 * Extract text content from a UIMessage (AI SDK v5 format)
 */
function extractTextFromUIMessage(message: { parts?: Array<{ type: string; text?: string }> }): string {
  if (!message.parts || !Array.isArray(message.parts)) {
    return '';
  }
  return message.parts
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text)
    .join('\n');
}

/**
 * Update text content in a UIMessage (AI SDK v5 format)
 */
function updateUIMessageText<T extends { parts?: Array<{ type: string; text?: string }> }>(
  message: T,
  newText: string
): T {
  if (!message.parts || !Array.isArray(message.parts)) {
    return message;
  }
  let textPartFound = false;
  const updatedParts = message.parts.map((part) => {
    if (part.type === 'text' && !textPartFound) {
      textPartFound = true;
      return { ...part, text: newText };
    }
    return part;
  });
  return { ...message, parts: updatedParts };
}

/**
 * Check content safety for user input
 */
async function checkInputContentSafety(options: InputSafetyCheckOptions): Promise<InputSafetyCheckResult> {
  const { messages, request, contentSafetyService, log, requestId } = options;

  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMessage) {
    return { updatedMessages: messages };
  }

  const messageContent = extractTextFromUIMessage(lastUserMessage);
  if (!messageContent || !messageContent.trim()) {
    return { updatedMessages: messages };
  }

  const safetyResult = await contentSafetyService.processInput(
    messageContent,
    request.sessionId || request.userId
  );

  if (!safetyResult.allowed) {
    log.warn('Content blocked by safety guardrails (input)', {
      requestId,
      reason: safetyResult.blockedReason,
      categories: safetyResult.blockedCategories,
    });
    throw new ContentSafetyBlockedError(
      safetyResult.blockedMessage || 'Content blocked by safety guardrails',
      safetyResult.blockedCategories || [],
      'input',
      request.provider,
      request.modelId
    );
  }

  // If PII was tokenized, update the message content
  if (safetyResult.contentModified && safetyResult.processedContent !== messageContent) {
    log.info('PII tokenized in user message', {
      requestId,
      originalLength: messageContent.length,
      processedLength: safetyResult.processedContent.length,
      hasPII: safetyResult.hasPII,
    });

    const lastIndex = messages.length - 1 - messages.slice().reverse().findIndex(m => m.role === 'user');
    if (lastIndex >= 0 && lastIndex < messages.length) {
      const updatedMessages = [
        ...messages.slice(0, lastIndex),
        updateUIMessageText(messages[lastIndex], safetyResult.processedContent),
        ...messages.slice(lastIndex + 1)
      ];
      return { safetyResult, updatedMessages };
    }
  }

  return { safetyResult, updatedMessages: messages };
}

/**
 * Check content safety for AI output
 */
async function checkOutputContentSafety(options: OutputSafetyCheckOptions): Promise<OutputSafetyCheckResult> {
  const { data, request, contentSafetyService, log, requestId, span } = options;

  const outputSafetyResult = await contentSafetyService.processOutput(
    data.text,
    request.modelId,
    request.provider,
    request.sessionId || request.userId
  );

  if (!outputSafetyResult.allowed) {
    log.warn('Content blocked by safety guardrails (output)', {
      requestId,
      reason: outputSafetyResult.blockedReason,
      categories: outputSafetyResult.blockedCategories,
      modelId: request.modelId,
      provider: request.provider,
    });

    if (span) {
      span.setAttributes({
        'ai.safety.output.blocked': true,
        'ai.safety.output.categories': outputSafetyResult.blockedCategories?.join(',') || '',
      });
    }

    return {
      processedData: {
        ...data,
        text: outputSafetyResult.blockedMessage || 'The AI response was blocked for safety reasons.',
      },
      wasBlocked: true
    };
  }

  if (outputSafetyResult.contentModified) {
    log.info('PII restored in AI output', {
      requestId,
      originalLength: data.text.length,
      processedLength: outputSafetyResult.processedContent.length,
    });
    return {
      processedData: { ...data, text: outputSafetyResult.processedContent },
      wasBlocked: false
    };
  }

  return { processedData: data, wasBlocked: false };
}

/**
 * Wrap stream result with PII detokenization transform
 */
function wrapStreamWithPIIDetokenization(
  result: StreamResponse['result'],
  tokenMappings: TokenMapping[]
): StreamResponse['result'] {
  return {
    ...result,
    toUIMessageStreamResponse: (options?: { headers?: Record<string, string> }) => {
      const originalResponse = result.toUIMessageStreamResponse(options);
      if (!originalResponse.body) {
        return originalResponse;
      }
      const transformedStream = originalResponse.body.pipeThrough(
        createPIIDetokenizeTransform(tokenMappings)
      );
      return new Response(transformedStream, {
        status: originalResponse.status,
        statusText: originalResponse.statusText,
        headers: originalResponse.headers
      });
    },
    toDataStreamResponse: (options?: { headers?: Record<string, string> }) => {
      const originalResponse = result.toDataStreamResponse(options);
      if (!originalResponse.body) {
        return originalResponse;
      }
      const transformedStream = originalResponse.body.pipeThrough(
        createPIIDetokenizeTransform(tokenMappings)
      );
      return new Response(transformedStream, {
        status: originalResponse.status,
        statusText: originalResponse.statusText,
        headers: originalResponse.headers
      });
    }
  };
}

/**
 * Create telemetry span for streaming
 */
function createStreamingTelemetrySpan(
  telemetryConfig: TelemetryConfig,
  request: StreamRequest,
  capabilities: ProviderCapabilities,
  timeout: number
): TelemetrySpan | undefined {
  return telemetryConfig.tracer?.startSpan('ai.stream.unified', {
    attributes: {
      'ai.provider': request.provider,
      'ai.model.id': request.modelId,
      'ai.source': request.source,
      'ai.reasoning.capable': capabilities.supportsReasoning,
      'ai.thinking.capable': capabilities.supportsThinking,
      'ai.request.timeout': timeout
    }
  });
}

/**
 * Validate and create deep copy of messages
 */
function validateAndCopyMessages(
  request: StreamRequest,
  log: ReturnType<typeof createLogger>
): StreamRequest['messages'] {
  if (!request.messages || !Array.isArray(request.messages)) {
    log.error('Messages invalid in streaming service', {
      messages: request.messages,
      hasMessages: !!request.messages,
      isArray: Array.isArray(request.messages),
      requestKeys: Object.keys(request)
    });
    throw new Error('Messages array is required for streaming');
  }

  // Create defensive deep copy to prevent race conditions
  return request.messages.map(m => ({
    ...m,
    parts: m.parts ? [...m.parts] : []
  }));
}

/**
 * Convert messages to model format with error handling
 */
async function convertMessages(
  messages: StreamRequest['messages'],
  log: ReturnType<typeof createLogger>
) {
  log.info('Messages structure before conversion', {
    messageCount: messages.length,
    firstMessage: JSON.stringify(messages[0]),
    allMessages: JSON.stringify(messages)
  });

  try {
    return await convertToModelMessages(messages);
  } catch (conversionError) {
    const error = conversionError as Error;
    log.error('Failed to convert messages', {
      error: error.message,
      stack: error.stack,
      messages: JSON.stringify(messages)
    });
    throw new Error(`Message conversion failed: ${error.message}`);
  }
}

/**
 * Build stream config
 */
interface BuildConfigOptions {
  model: StreamConfig['model'];
  convertedMessages: Awaited<ReturnType<typeof convertToModelMessages>>;
  request: StreamRequest;
  tools: StreamConfig['tools'];
  timeout: number;
  providerOptions: Record<string, unknown>;
  telemetryConfig: TelemetryConfig;
}

function buildStreamConfig(options: BuildConfigOptions): StreamConfig {
  const { model, convertedMessages, request, tools, timeout, providerOptions, telemetryConfig } = options;

  return {
    model,
    messages: convertedMessages,
    system: request.systemPrompt,
    maxTokens: request.maxTokens,
    maxSteps: request.maxSteps,
    temperature: request.temperature,
    tools,
    toolChoice: tools && Object.keys(tools).length > 0 ? 'auto' : undefined,
    timeout,
    providerOptions,
    experimental_telemetry: telemetryConfig.isEnabled ? {
      isEnabled: true,
      functionId: telemetryConfig.functionId,
      metadata: telemetryConfig.metadata,
      recordInputs: telemetryConfig.recordInputs,
      recordOutputs: telemetryConfig.recordOutputs,
      tracer: telemetryConfig.tracer
    } : undefined
  };
}

/**
 * Check circuit breaker and throw if open
 */
function checkCircuitBreaker(
  circuitBreaker: CircuitBreaker,
  provider: string,
  log: ReturnType<typeof createLogger>
): void {
  const circuitState = circuitBreaker.getState();
  log.info('Circuit breaker state', {
    provider,
    state: circuitState,
    isOpen: circuitBreaker.isOpen(),
    metrics: circuitBreaker.getMetrics()
  });

  if (circuitBreaker.isOpen()) {
    log.error('Circuit breaker is open, blocking request', { provider, state: circuitState });
    throw new CircuitBreakerOpenError(provider, circuitState);
  }
}

/**
 * Check if content safety should be applied for input
 */
function shouldCheckInputSafety(
  request: StreamRequest,
  contentSafetyService: ReturnType<typeof getContentSafetyService>
): boolean {
  const safetyEnabled = request.contentSafety?.enabled !== false;
  return safetyEnabled && !request.contentSafety?.skipInputCheck && contentSafetyService.isEnabled();
}

/**
 * Check if content safety should be applied for output
 */
function shouldCheckOutputSafety(
  request: StreamRequest,
  contentSafetyService: ReturnType<typeof getContentSafetyService>,
  hasText: boolean
): boolean {
  const safetyEnabled = request.contentSafety?.enabled !== false;
  return safetyEnabled && !request.contentSafety?.skipOutputCheck && contentSafetyService.isEnabled() && hasText;
}

/**
 * Get or create tools for streaming
 */
async function getOrCreateTools(
  request: StreamRequest,
  adapter: Awaited<ReturnType<typeof getProviderAdapter>>
): Promise<StreamConfig['tools']> {
  if (request.tools) {
    return request.tools;
  }
  return adapter.createTools(request.enabledTools || []);
}

/**
 * Options for building stream response
 */
interface BuildStreamResponseOptions {
  result: StreamResponse['result'];
  requestId: string;
  capabilities: ProviderCapabilities;
  telemetryConfig: TelemetryConfig;
  tokenMappings: TokenMapping[];
  log: ReturnType<typeof createLogger>;
}

/**
 * Build stream response with optional PII wrapping
 */
function buildStreamResponse(options: BuildStreamResponseOptions): StreamResponse {
  const { result, requestId, capabilities, telemetryConfig, tokenMappings, log } = options;

  if (tokenMappings.length > 0) {
    log.info('Wrapping stream with PII detokenization transform', { tokenCount: tokenMappings.length });
    const wrappedResult = wrapStreamWithPIIDetokenization(result, tokenMappings);
    return { result: wrappedResult, requestId, capabilities, telemetryConfig };
  }
  return { result, requestId, capabilities, telemetryConfig };
}

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
      checkCircuitBreaker(circuitBreaker, request.provider, log);

      // 4. Validate and copy messages
      let messages = validateAndCopyMessages(request, log);

      // 5. K-12 Content Safety: Check user input before sending to AI
      const contentSafetyService = getContentSafetyService();
      let inputSafetyResult: ContentSafetyResult | undefined;

      if (shouldCheckInputSafety(request, contentSafetyService)) {
        const safetyCheck = await checkInputContentSafety({
          messages, request, contentSafetyService, log, requestId
        });
        inputSafetyResult = safetyCheck.safetyResult;
        messages = safetyCheck.updatedMessages;
      }

      // 6. Convert messages and build config
      const convertedMessages = await convertMessages(messages, log);
      const model = await adapter.createModel(request.modelId, request.options);
      const tools = await getOrCreateTools(request, adapter);
      const timeout = this.getAdaptiveTimeout(capabilities, request);

      const config = buildStreamConfig({
        model,
        convertedMessages,
        request,
        tools,
        timeout,
        providerOptions: adapter.getProviderOptions(request.modelId, request.options),
        telemetryConfig
      });
      
      // 5. Start telemetry span
      const span = createStreamingTelemetrySpan(telemetryConfig, request, capabilities, config.timeout || timeout);
      
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

            // K-12 Content Safety: Check AI output before saving/displaying
            let processedData = data;
            if (shouldCheckOutputSafety(request, contentSafetyService, !!data.text)) {
              const safetyCheck = await checkOutputContentSafety({
                data, request, contentSafetyService, log, requestId, span
              });
              processedData = safetyCheck.processedData;
            }

            await this.invokeOnFinishCallback(request, processedData, span, log);
          },
          onError: (error) => {
            this.handleError(error, span, circuitBreaker);
            request.callbacks?.onError?.(error);
          }
        });
        
        // 7. Mark circuit breaker as successful and build response
        circuitBreaker.recordSuccess();
        log.info('Stream completed successfully', {
          provider: request.provider,
          modelId: request.modelId,
          source: request.source
        });

        return buildStreamResponse({
          result, requestId, capabilities, telemetryConfig,
          tokenMappings: inputSafetyResult?.tokens || [],
          log
        });
        
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
    const timestamp = Date.now();

    // Try each event handler in order
    if (this.handleTextEvents(event, span, progress, timestamp)) return;
    if (this.handleToolEvents(event, span, timestamp)) return;
    if (this.handleReasoningEvents(event, span, timestamp)) return;
    if (this.handleStreamControlEvents(event, span, timestamp)) return;

    // Fallback for unrecognized event types
    span.addEvent('ai.stream.progress', {
      timestamp,
      'ai.event.type': event.type,
      'ai.tokens.streamed': progress.tokens || 0
    });
  }

  /**
   * Handle text-related stream events
   */
  private handleTextEvents(
    event: StreamingProgress['event'],
    span: TelemetrySpan,
    progress: StreamingProgress,
    timestamp: number
  ): boolean {
    if (isTextDeltaEvent(event)) {
      span.addEvent('ai.stream.text.delta', {
        timestamp,
        'ai.text.delta.length': event.delta.length,
        'ai.tokens.estimated': progress.tokens || Math.ceil(event.delta.length / 4)
      });
      return true;
    }
    if (isTextStartEvent(event)) {
      span.addEvent('ai.stream.text.start', { timestamp, 'ai.text.id': event.id });
      return true;
    }
    if (isTextEndEvent(event)) {
      span.addEvent('ai.stream.text.end', { timestamp, 'ai.text.id': event.id });
      return true;
    }
    return false;
  }

  /**
   * Handle tool-related stream events
   */
  private handleToolEvents(
    event: StreamingProgress['event'],
    span: TelemetrySpan,
    timestamp: number
  ): boolean {
    if (isToolCallEvent(event)) {
      span.addEvent('ai.stream.tool.call', {
        timestamp,
        'ai.tool.name': event.toolName,
        'ai.tool.call.id': event.toolCallId
      });
      return true;
    }
    if (isToolCallDeltaEvent(event)) {
      span.addEvent('ai.stream.tool.delta', {
        timestamp,
        'ai.tool.name': event.toolName,
        'ai.tool.call.id': event.toolCallId,
        'ai.tool.delta.length': event.delta?.length || 0
      });
      return true;
    }
    return false;
  }

  /**
   * Handle reasoning-related stream events
   */
  private handleReasoningEvents(
    event: StreamingProgress['event'],
    span: TelemetrySpan,
    timestamp: number
  ): boolean {
    if (isReasoningDeltaEvent(event)) {
      span.addEvent('ai.stream.reasoning.delta', { timestamp, 'ai.reasoning.delta.length': event.delta.length });
      return true;
    }
    if (isReasoningStartEvent(event)) {
      span.addEvent('ai.stream.reasoning.start', { timestamp, 'ai.reasoning.id': event.id });
      return true;
    }
    if (isReasoningEndEvent(event)) {
      span.addEvent('ai.stream.reasoning.end', { timestamp, 'ai.reasoning.id': event.id });
      return true;
    }
    return false;
  }

  /**
   * Handle stream control events (error, finish)
   */
  private handleStreamControlEvents(
    event: StreamingProgress['event'],
    span: TelemetrySpan,
    timestamp: number
  ): boolean {
    if (isErrorEvent(event)) {
      span.addEvent('ai.stream.error', {
        timestamp,
        'ai.error.message': event.error,
        'ai.error.code': event.code || 'unknown'
      });
      return true;
    }
    if (isFinishEvent(event)) {
      span.addEvent('ai.stream.finish', {
        timestamp,
        'ai.usage.prompt_tokens': event.usage?.promptTokens || 0,
        'ai.usage.completion_tokens': event.usage?.completionTokens || 0,
        'ai.usage.total_tokens': event.usage?.totalTokens || 0
      });
      return true;
    }
    return false;
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

  /**
   * Invoke onFinish callback with error handling
   */
  private async invokeOnFinishCallback(
    request: StreamRequest,
    processedData: OutputSafetyCheckOptions['data'],
    span: TelemetrySpan | undefined,
    log: ReturnType<typeof createLogger>
  ): Promise<void> {
    if (!request.callbacks?.onFinish) {
      return;
    }

    try {
      await request.callbacks.onFinish(processedData);
    } catch (error) {
      const errorDetails = error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : String(error);

      log.error('Critical: Failed to save assistant message', {
        error: errorDetails,
        conversationId: request.conversationId,
        userId: request.userId
      });

      if (span) {
        span.recordException(error as Error);
        span.setAttributes({
          'ai.message.save.failed': true,
          'ai.message.save.error': (error as Error).message
        });
      }
      // Don't rethrow to avoid breaking the stream
    }
  }
}

// Singleton instance
export const unifiedStreamingService = new UnifiedStreamingService();