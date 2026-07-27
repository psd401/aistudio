import { createLogger } from '@/lib/logger';
import type { StreamRequest, StreamResponse, StreamingCallbacks } from './types';
import { generateUUID } from '@/lib/utils/uuid';

const log = createLogger({ module: 'openai-responses-api' });

/**
 * OpenAI Responses API Implementation
 *
 * The Responses API is designed for reasoning models (o3, o4, GPT-5) and provides:
 * - Structured reasoning with step-by-step explanations
 * - Background processing for long-running reasoning tasks
 * - Reasoning effort control (minimal, low, medium, high)
 * - Reasoning token tracking and cost optimization
 * - Persistent reasoning context across conversations
 */

export interface ResponsesAPIConfig {
  apiKey: string;
  modelId: string;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  backgroundMode?: boolean;
  streamReasoningSummaries?: boolean;
  preserveReasoningItems?: boolean;
  maxReasoningTokens?: number;
}

export interface ResponsesAPIResult {
  jobId?: string;
  status: 'streaming' | 'background' | 'completed' | 'failed';
  reasoning?: string[];
  thinkingTime?: number;
  reasoningTokens?: number;
  response: string;
}

interface ResponsesAPIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface ResponsesAPIStreamEvent {
  type: 'reasoning_step' | 'response_delta' | 'tool_call' | 'finish';
  content?: string;
  tokens?: number;
  step_number?: number;
  tool_name?: string;
  tool_call_id?: string;
  arguments?: Record<string, unknown>;
  usage?: ResponsesAPIUsage;
  finish_reason?: string;
}

interface ResponsesAPIStreamState {
  reasoning: string[];
  responseText: string;
  reasoningTokens: number;
}

/**
 * Create a Responses API client for reasoning models
 */
export function createResponsesAPIClient(config: ResponsesAPIConfig) {
  return new ResponsesAPIClient(config);
}

export class ResponsesAPIClient {
  private apiKey: string;
  private baseURL = 'https://api.openai.com/v1/responses';

  constructor(private config: ResponsesAPIConfig) {
    this.apiKey = config.apiKey;
  }

  /**
   * Stream a response with reasoning
   */
  async stream(
    messages: Array<{ role: string; content: string }>,
    callbacks?: StreamingCallbacks
  ): Promise<ResponsesAPIResult> {
    const startTime = Date.now();

    log.info('Starting Responses API stream', {
      model: this.config.modelId,
      reasoningEffort: this.config.reasoningEffort,
      backgroundMode: this.config.backgroundMode,
      messageCount: messages.length
    });

    try {
      const response = await fetch(this.baseURL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'responses-api-v1'
        },
        body: JSON.stringify({
          model: this.config.modelId,
          messages,
          reasoning_effort: this.config.reasoningEffort || 'medium',
          background_mode: this.config.backgroundMode || false,
          stream: !this.config.backgroundMode,
          stream_reasoning_summaries: this.config.streamReasoningSummaries ?? true,
          preserve_reasoning_items: this.config.preserveReasoningItems ?? true,
          max_reasoning_tokens: this.config.maxReasoningTokens
        })
      });

      if (!response.ok) {
        throw new Error(`Responses API error: ${response.status} ${response.statusText}`);
      }

      if (this.config.backgroundMode) {
        // Background mode: return job ID for polling
        const data = await response.json();
        log.info('Background reasoning job created', {
          jobId: data.job_id,
          estimatedTime: data.estimated_completion_time
        });

        return {
          jobId: data.job_id,
          status: 'background',
          response: ''
        };
      } else {
        // Streaming mode: process SSE stream
        return await this.processStream(response, callbacks, startTime);
      }
    } catch (error) {
      log.error('Responses API request failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Process SSE stream from Responses API
   */
  private async processStream(
    response: Response,
    callbacks: StreamingCallbacks | undefined,
    startTime: number
  ): Promise<ResponsesAPIResult> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    const state: ResponsesAPIStreamState = {
      reasoning: [],
      responseText: '',
      reasoningTokens: 0
    };
    let isComplete = false;

    try {
      while (!isComplete) {
        const { done, value } = await reader.read();
        if (done) break;

        for (const line of decoder.decode(value).split('\n')) {
          isComplete = this.processSseLine(line, state, callbacks, startTime);
          if (isComplete) break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    const thinkingTime = Date.now() - startTime;

    log.info('Responses API stream completed', {
      model: this.config.modelId,
      reasoningSteps: state.reasoning.length,
      reasoningTokens: state.reasoningTokens,
      thinkingTimeMs: thinkingTime,
      responseLength: state.responseText.length
    });

    return {
      status: 'completed',
      reasoning: state.reasoning,
      thinkingTime,
      reasoningTokens: state.reasoningTokens,
      response: state.responseText
    };
  }

  private processSseLine(
    line: string,
    state: ResponsesAPIStreamState,
    callbacks: StreamingCallbacks | undefined,
    startTime: number
  ): boolean {
    if (!line.startsWith('data: ')) return false;

    const data = line.slice(6);
    if (data === '[DONE]') return true;

    try {
      this.processSseEvent(
        JSON.parse(data) as ResponsesAPIStreamEvent,
        state,
        callbacks,
        startTime
      );
    } catch (error) {
      log.warn('Failed to parse SSE event', {
        error: error instanceof Error ? error.message : String(error),
        data
      });
    }
    return false;
  }

  private processSseEvent(
    event: ResponsesAPIStreamEvent,
    state: ResponsesAPIStreamState,
    callbacks: StreamingCallbacks | undefined,
    startTime: number
  ): void {
    switch (event.type) {
      case 'reasoning_step':
        this.processReasoningStep(event, state, callbacks);
        break;
      case 'response_delta':
        this.processResponseDelta(event, state, callbacks);
        break;
      case 'tool_call':
        this.processToolCall(event, callbacks);
        break;
      case 'finish':
        this.processFinish(event, state, callbacks, startTime);
        break;
    }
  }

  private processReasoningStep(
    event: ResponsesAPIStreamEvent,
    state: ResponsesAPIStreamState,
    callbacks: StreamingCallbacks | undefined
  ): void {
    const content = event.content ?? '';
    state.reasoning.push(content);
    state.reasoningTokens += event.tokens ?? 0;
    callbacks?.onReasoning?.(content);
    callbacks?.onProgress?.({
      event: {
        type: 'reasoning-delta',
        delta: content,
        reasoning: content
      },
      timestamp: Date.now(),
      tokens: event.tokens,
      type: 'reasoning',
      content,
      metadata: {
        step: event.step_number,
        tokens: event.tokens
      }
    });
  }

  private processResponseDelta(
    event: ResponsesAPIStreamEvent,
    state: ResponsesAPIStreamState,
    callbacks: StreamingCallbacks | undefined
  ): void {
    const content = event.content ?? '';
    state.responseText += content;
    callbacks?.onProgress?.({
      event: {
        type: 'text-delta',
        delta: content
      },
      timestamp: Date.now(),
      type: 'token',
      content
    });
  }

  private processToolCall(
    event: ResponsesAPIStreamEvent,
    callbacks: StreamingCallbacks | undefined
  ): void {
    log.debug('Tool call in reasoning', {
      tool: event.tool_name,
      arguments: event.arguments
    });
    callbacks?.onProgress?.({
      event: {
        type: 'tool-call',
        toolCallId: event.tool_call_id || `tool-${Date.now()}`,
        toolName: event.tool_name || 'unknown',
        args: event.arguments
      },
      timestamp: Date.now(),
      type: 'tool_call',
      content: JSON.stringify(event),
      metadata: event as unknown as Record<string, unknown>
    });
  }

  private processFinish(
    event: ResponsesAPIStreamEvent,
    state: ResponsesAPIStreamState,
    callbacks: StreamingCallbacks | undefined,
    startTime: number
  ): void {
    callbacks?.onFinish?.({
      text: state.responseText,
      usage: {
        promptTokens: event.usage?.prompt_tokens || 0,
        completionTokens: event.usage?.completion_tokens || 0,
        totalTokens: event.usage?.total_tokens || 0,
        reasoningTokens: state.reasoningTokens,
        totalCost: this.calculateCost(
          event.usage,
          state.reasoningTokens,
          Date.now() - startTime
        )
      },
      finishReason: event.finish_reason || 'stop'
    });
  }

  /**
   * Poll for background job status
   */
  async getJobStatus(jobId: string): Promise<ResponsesAPIResult> {
    log.debug('Checking background job status', { jobId });

    const response = await fetch(`${this.baseURL}/jobs/${jobId}`, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'OpenAI-Beta': 'responses-api-v1'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to get job status: ${response.status}`);
    }

    const data = await response.json();

    return {
      jobId,
      status: data.status,
      reasoning: data.reasoning_steps,
      thinkingTime: data.thinking_time_ms,
      reasoningTokens: data.reasoning_tokens,
      response: data.response || ''
    };
  }

  /**
   * Calculate cost for reasoning models
   */
  private calculateCost(
    usage: ResponsesAPIUsage | undefined,
    reasoningTokens: number,
    thinkingTimeMs?: number
  ): number {
    if (!usage) return 0;

    // Pricing for reasoning models (estimated)
    const prices = {
      'o3': { input: 0.00015, output: 0.0006, reasoning: 0.0003 },
      'o4': { input: 0.0002, output: 0.0008, reasoning: 0.0004 },
      'gpt-5': { input: 0.00001, output: 0.00003, reasoning: 0.00002 }
    };

    const modelPrefix = this.config.modelId.split('-')[0];
    const pricing = prices[modelPrefix as keyof typeof prices] || prices['gpt-5'];

    const inputCost = (usage.prompt_tokens || 0) * pricing.input / 1000;
    const outputCost = (usage.completion_tokens || 0) * pricing.output / 1000;
    const reasoningCost = reasoningTokens * pricing.reasoning / 1000;

    // Add small cost for thinking time on reasoning models (optional)
    const thinkingCost = thinkingTimeMs ? (thinkingTimeMs / 1000) * 0.0001 : 0;

    return inputCost + outputCost + reasoningCost + thinkingCost;
  }
}

/**
 * Integration helper for the unified streaming service
 */
export async function streamWithResponsesAPI(
  request: StreamRequest,
  callbacks?: StreamingCallbacks
): Promise<StreamResponse> {
  const client = createResponsesAPIClient({
    apiKey: process.env.OPENAI_API_KEY || '',
    modelId: request.modelId,
    reasoningEffort: request.options?.reasoningEffort,
    backgroundMode: request.options?.backgroundMode,
    streamReasoningSummaries: true,
    preserveReasoningItems: true,
    maxReasoningTokens: 10000
  });

  const messages = request.messages.map(msg => {
    // Extract text content from parts if available
    let content = '';
    if ('parts' in msg && Array.isArray(msg.parts)) {
      const textParts = (msg.parts as Array<{ type?: string; text?: string }>)
        .filter(part => part.type === 'text')
        .map(part => part.text || '');
      content = textParts.join(' ');
    } else if ('content' in msg) {
      content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    }

    return {
      role: msg.role,
      content
    };
  });

  const result = await client.stream(messages, callbacks);

  // Convert to StreamResponse format
  return {
    result: {
      toDataStreamResponse: () => new Response(result.response),
      toUIMessageStreamResponse: () => new Response(result.response),
      usage: Promise.resolve({
        totalTokens: result.reasoningTokens || 0,
        reasoningTokens: result.reasoningTokens
      })
    },
    requestId: generateUUID(),
    capabilities: {
      supportsReasoning: true,
      supportsThinking: false,
      supportedResponseModes: ['standard', 'flex', 'priority'],
      supportsBackgroundMode: true,
      supportedTools: ['web_search', 'code_interpreter'],
      typicalLatencyMs: 10000,
      maxTimeoutMs: 600000
    },
    telemetryConfig: {
      isEnabled: false,
      functionId: 'responses-api',
      metadata: {},
      recordInputs: false,
      recordOutputs: false
    }
  };
}
