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

      // Read the stream
      const reader = response.body?.getReader();
      if (!reader) {
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

      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            success = true;
            break;
          }

          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE messages
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim() || !line.startsWith('data: ')) {
              continue;
            }

            const data = line.replace('data: ', '').trim();

            // Skip non-JSON data
            if (!data.startsWith('{')) {
              continue;
            }

            try {
              const parsed = JSON.parse(data);

              // AI SDK v5 format - look for text deltas or content
              if (parsed.type === '0' || parsed.type === 'text-delta' || parsed.content) {
                if (firstTokenTime === null) {
                  firstTokenTime = Date.now();
                  if (this.options.verbose) {
                    console.log(`First token received at ${firstTokenTime - startTime}ms`);
                  }
                }
                tokenCount++;
              }

              // Check for usage data
              if (parsed.usage || (parsed.type === 'finish' && parsed.usage)) {
                const usageData = parsed.usage;
                if (usageData) {
                  usage = {
                    promptTokens: usageData.promptTokens || 0,
                    completionTokens: usageData.completionTokens || 0,
                    totalTokens: usageData.totalTokens || 0,
                  };
                }
              }

              // Check for errors
              if (parsed.type === 'error' || parsed.error) {
                error = parsed.error || parsed.message || 'Unknown stream error';
                connectionDropped = true;
                break;
              }
            } catch {
              // Skip unparseable chunks
              if (this.options.verbose) {
                console.warn('Failed to parse SSE data:', data.substring(0, 100));
              }
            }
          }
        }
      } catch (streamError) {
        connectionDropped = true;
        error = streamError instanceof Error ? streamError.message : 'Stream read error';
        if (this.options.verbose) {
          console.error('Stream reading error:', streamError);
        }
      } finally {
        reader.releaseLock();
      }

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
