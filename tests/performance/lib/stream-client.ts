/**
 * Stream Client for Performance Testing
 *
 * Provides utilities for connecting to SSE streams, measuring performance metrics,
 * and tracking streaming behavior.
 */

export interface StreamMetrics {
  /** Request ID for tracking */
  requestId: string;
  /** Time to first token in milliseconds */
  timeToFirstToken: number;
  /** Total response time in milliseconds */
  totalResponseTime: number;
  /** Number of tokens received */
  tokenCount: number;
  /** Tokens per second */
  tokensPerSecond: number;
  /** Whether the stream completed successfully */
  success: boolean;
  /** Error message if stream failed */
  error?: string;
  /** HTTP status code */
  statusCode?: number;
  /** Connection dropped during streaming */
  connectionDropped: boolean;
  /** Memory usage at start (bytes) */
  memoryStart?: number;
  /** Memory usage at end (bytes) */
  memoryEnd?: number;
  /** Usage data from response */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface StreamClientOptions {
  /** API endpoint URL */
  url: string;
  /** Request body */
  body: {
    messages: Array<{ role: string; content: string; id: string }>;
    modelId: string;
    provider?: string;
    conversationId?: string | null;
  };
  /** Authorization token */
  authToken?: string;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Enable verbose logging */
  verbose?: boolean;
}

interface StreamReadState {
  firstTokenTime: number | null;
  tokenCount: number;
  success: boolean;
  error?: string;
  connectionDropped: boolean;
  usage?: StreamMetrics['usage'];
}

interface StreamEvent {
  type?: string;
  content?: unknown;
  error?: string;
  message?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export class StreamClient {
  private options: StreamClientOptions;
  private abortController?: AbortController;

  constructor(options: StreamClientOptions) {
    this.options = {
      timeout: 300000, // 5 minutes default
      verbose: false,
      ...options,
    };
  }

  /**
   * Execute a streaming request and collect metrics
   */
  async execute(): Promise<StreamMetrics> {
    const requestId = this.generateRequestId();
    const startTime = Date.now();
    let firstTokenTime: number | null = null;
    let tokenCount = 0;
    let success = false;
    let error: string | undefined;
    let statusCode: number | undefined;
    let connectionDropped = false;
    let usage: StreamMetrics['usage'] | undefined;

    const memoryStart = process.memoryUsage().heapUsed;

    this.abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      this.abortController?.abort();
      error = 'Request timeout';
    }, this.options.timeout);

    try {
      const response = await fetch(this.options.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.options.authToken && {
            'Authorization': `Bearer ${this.options.authToken}`,
          }),
        },
        body: JSON.stringify(this.options.body),
        signal: this.abortController.signal,
      });

      statusCode = response.status;

      if (!response.ok) {
        error = `HTTP ${response.status}: ${response.statusText}`;
        const body = await response.text();
        if (this.options.verbose) {
          console.error(`Stream request failed: ${error}`, body);
        }
        return this.buildMetrics({
          requestId,
          startTime,
          firstTokenTime,
          tokenCount,
          success: false,
          error,
          statusCode,
          connectionDropped,
          memoryStart,
          usage,
        });
      }

      if (!response.body) {
        error = 'No response body reader available';
        return this.buildMetrics({
          requestId,
          startTime,
          firstTokenTime,
          tokenCount,
          success: false,
          error,
          statusCode,
          connectionDropped,
          memoryStart,
          usage,
        });
      }

      const streamState = await this.readStream(response.body, startTime);
      firstTokenTime = streamState.firstTokenTime;
      tokenCount = streamState.tokenCount;
      success = streamState.success;
      error = streamState.error;
      connectionDropped = streamState.connectionDropped;
      usage = streamState.usage;

    } catch (fetchError) {
      error = fetchError instanceof Error ? fetchError.message : 'Fetch error';
      if (this.options.verbose) {
        console.error('Fetch error:', fetchError);
      }
    } finally {
      clearTimeout(timeoutId);
      // Clear abort controller reference to allow garbage collection
      this.abortController = undefined;
    }

    return this.buildMetrics({
      requestId,
      startTime,
      firstTokenTime,
      tokenCount,
      success,
      error,
      statusCode,
      connectionDropped,
      memoryStart,
      usage,
    });
  }

  private async readStream(
    body: ReadableStream<Uint8Array>,
    startTime: number
  ): Promise<StreamReadState> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const state: StreamReadState = {
      firstTokenTime: null,
      tokenCount: 0,
      success: false,
      connectionDropped: false,
    };
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          state.success = true;
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const messages = buffer.split('\n\n');
        buffer = messages.pop() || '';

        for (const message of messages) {
          if (this.processStreamMessage(message, state, startTime)) break;
        }
      }
    } catch (streamError) {
      state.connectionDropped = true;
      state.error = streamError instanceof Error ? streamError.message : 'Stream read error';
      if (this.options.verbose) {
        console.error('Stream reading error:', streamError);
      }
    } finally {
      reader.releaseLock();
    }

    return state;
  }

  private processStreamMessage(
    message: string,
    state: StreamReadState,
    startTime: number
  ): boolean {
    if (!message.trim() || !message.startsWith('data: ')) return false;

    const data = message.replace('data: ', '').trim();
    if (!data.startsWith('{')) return false;

    try {
      const event = JSON.parse(data) as StreamEvent;
      this.recordTextEvent(event, state, startTime);
      this.recordUsage(event, state);
      return this.recordError(event, state);
    } catch {
      if (this.options.verbose) {
        console.warn('Failed to parse SSE data:', data.substring(0, 100));
      }
      return false;
    }
  }

  private recordTextEvent(
    event: StreamEvent,
    state: StreamReadState,
    startTime: number
  ): void {
    if (event.type !== '0' && event.type !== 'text-delta' && !event.content) return;

    if (state.firstTokenTime === null) {
      state.firstTokenTime = Date.now();
      if (this.options.verbose) {
        console.log(`First token received at ${state.firstTokenTime - startTime}ms`);
      }
    }
    state.tokenCount++;
  }

  private recordUsage(event: StreamEvent, state: StreamReadState): void {
    if (!event.usage) return;

    state.usage = {
      promptTokens: event.usage.promptTokens || 0,
      completionTokens: event.usage.completionTokens || 0,
      totalTokens: event.usage.totalTokens || 0,
    };
  }

  private recordError(event: StreamEvent, state: StreamReadState): boolean {
    if (event.type !== 'error' && !event.error) return false;

    state.error = event.error || event.message || 'Unknown stream error';
    state.connectionDropped = true;
    return true;
  }

  /**
   * Build metrics object from collected data
   */
  private buildMetrics(data: {
    requestId: string;
    startTime: number;
    firstTokenTime: number | null;
    tokenCount: number;
    success: boolean;
    error?: string;
    statusCode?: number;
    connectionDropped: boolean;
    memoryStart: number;
    usage?: StreamMetrics['usage'];
  }): StreamMetrics {
    const endTime = Date.now();
    const totalResponseTime = endTime - data.startTime;
    const timeToFirstToken = data.firstTokenTime ? data.firstTokenTime - data.startTime : -1;
    const tokensPerSecond = data.tokenCount > 0 && totalResponseTime > 0
      ? (data.tokenCount / totalResponseTime) * 1000
      : 0;

    return {
      requestId: data.requestId,
      timeToFirstToken,
      totalResponseTime,
      tokenCount: data.tokenCount,
      tokensPerSecond,
      success: data.success,
      error: data.error,
      statusCode: data.statusCode,
      connectionDropped: data.connectionDropped,
      memoryStart: data.memoryStart,
      memoryEnd: process.memoryUsage().heapUsed,
      usage: data.usage,
    };
  }

  /**
   * Generate a unique request ID
   */
  private generateRequestId(): string {
    return `perf_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }

  /**
   * Cancel the ongoing request
   */
  cancel(): void {
    this.abortController?.abort();
  }
}

/**
 * Helper function to create and execute a stream request
 */
export async function measureStream(options: StreamClientOptions): Promise<StreamMetrics> {
  const client = new StreamClient(options);
  return client.execute();
}
