import { createLogger } from '@/lib/logger';
import type { UIMessage } from 'ai';

const log = createLogger({ module: 'universal-polling-adapter' });

/**
 * Job status response from polling API
 */
export interface JobPollingResponse {
  jobId: string;
  conversationId: number;
  status: 'pending' | 'processing' | 'streaming' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  expiresAt: string;
  partialContent: string;
  progressInfo: {
    tokensStreamed?: number;
    completionPercentage?: number;
    currentPhase?: string;
    metadata?: Record<string, unknown>;
  };
  responseData?: {
    text: string;
    type?: 'text' | 'image';
    image?: string; // Base64 image data for image generation
    mediaType?: string; // MIME type for images
    prompt?: string; // Original prompt for image generation
    size?: string; // Image size
    style?: string; // Image style
    model?: string; // Model used for generation
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      reasoningTokens?: number;
      totalCost?: number;
    };
    finishReason: string;
    metadata?: Record<string, unknown>; // Additional metadata
  };
  errorMessage?: string;
  pollingInterval: number;
  shouldContinuePolling: boolean;
  requestId: string;
}

type PollingProgress = {
  content: string;
  metadata?: Record<string, unknown>;
};

function* completedJobUpdates(
  jobData: JobPollingResponse,
  lastContent: string,
  onProgress: ((progress: PollingProgress) => void) | undefined
): Generator<PollingProgress> {
  const finalContent = jobData.responseData?.text || jobData.partialContent || '';
  if (!finalContent || finalContent === lastContent) return;

  const finalData: PollingProgress = {
    content: finalContent,
    metadata: {
      status: 'completed',
      usage: jobData.responseData?.usage,
      finishReason: jobData.responseData?.finishReason,
      completed: true
    }
  };
  onProgress?.(finalData);
  yield finalData;
}

/**
 * Universal Polling Adapter
 *
 * Provides seamless polling integration for AI streaming requests,
 * overcoming AWS Amplify's 30-second timeout limitation.
 *
 * Features:
 * - Progressive content streaming via polling
 * - Intelligent polling intervals based on model characteristics
 * - Proper error handling and retry logic
 * - Connection recovery for page refreshes
 * - Resource cleanup on completion/cancellation
 */
export class UniversalPollingAdapter {
  private activePollers = new Map<string, AbortController>();

  /**
   * Start polling for a job and yield progressive updates
   */
  async *pollJob(
    jobId: string,
    options: {
      abortSignal?: AbortSignal;
      onProgress?: (progress: { content: string; metadata?: Record<string, unknown> }) => void;
      onStatusChange?: (status: string) => void;
    } = {}
  ): AsyncGenerator<{ content: string; metadata?: Record<string, unknown> }, void, unknown> {
    const { abortSignal, onProgress, onStatusChange } = options;

    log.info('Starting job polling', { jobId });

    // Set global context for JWT callback optimization
    // TODO: Replace with AsyncLocalStorage for better request isolation
    // This global approach works for current use case but could have race conditions in high-concurrency scenarios
    if (typeof global !== 'undefined') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global as any).__POLLING_CONTEXT__ = true;
    }

    // Create internal abort controller for cleanup
    const internalController = new AbortController();
    const combinedSignal = this.combineAbortSignals([abortSignal, internalController.signal]);

    // Track active poller for cleanup
    this.activePollers.set(jobId, internalController);

    let lastContent = '';
    let lastStatus = '';
    let pollingInterval = 1000; // Default 1 second

    try {
      while (!combinedSignal.aborted) {
        try {
          // Poll job status - determine correct endpoint based on context
          const pollingEndpoint = `/api/nexus/chat/jobs/${jobId}`;
          const response = await fetch(pollingEndpoint, {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
            },
            signal: combinedSignal,
          });

          if (!response.ok) {
            const handleNestedBranch1 = () => {
              if (response.status === 404) {
              throw new Error('Job not found');
            } else if (response.status === 403) {
              throw new Error('Access denied');
            } else {
              throw new Error(`Polling failed: ${response.status} ${response.statusText}`);
            }
            }
            handleNestedBranch1()
          }

          const jobData: JobPollingResponse = await response.json();

          log.debug('Job poll response', {
            jobId,
            status: jobData.status,
            hasPartialContent: !!jobData.partialContent,
            contentLength: jobData.partialContent?.length || 0,
            pollingInterval: jobData.pollingInterval
          });

          // Update polling interval from server recommendation
          pollingInterval = jobData.pollingInterval;

          // Check for status changes
          if (jobData.status !== lastStatus) {
            lastStatus = jobData.status;
            onStatusChange?.(jobData.status);
            log.info('Job status changed', { jobId, status: jobData.status });
          }

          // Yield new content if available
          if (jobData.partialContent && jobData.partialContent !== lastContent) {
            const newContent = jobData.partialContent;
            lastContent = newContent;

            const progressData = {
              content: newContent,
              metadata: {
                status: jobData.status,
                progressInfo: jobData.progressInfo,
                tokensStreamed: jobData.progressInfo.tokensStreamed,
                completionPercentage: jobData.progressInfo.completionPercentage,
                currentPhase: jobData.progressInfo.currentPhase
              }
            };

            onProgress?.(progressData);
            yield progressData;
          }

          // Handle completion states
          if (jobData.status === 'completed') {
            log.info('Job completed successfully', { jobId, finalContentLength: jobData.responseData?.text?.length });
            yield* completedJobUpdates(jobData, lastContent, onProgress);
            break;
          }

          if (jobData.status === 'failed') {
            log.error('Job failed', { jobId, errorMessage: jobData.errorMessage });
            throw new Error(jobData.errorMessage || 'AI request failed');
          }

          if (jobData.status === 'cancelled') {
            log.info('Job was cancelled', { jobId });
            throw new Error('Request was cancelled');
          }

          // Check if we should continue polling
          if (!jobData.shouldContinuePolling) {
            log.warn('Server indicated to stop polling', { jobId, status: jobData.status });
            break;
          }

          // Wait before next poll
          await this.sleep(pollingInterval, combinedSignal);

        } catch (error) {
          if (combinedSignal.aborted) {
            log.info('Polling cancelled by abort signal', { jobId });
            break;
          }

          // Handle network errors with retry logic
          if (error instanceof TypeError && error.message.includes('fetch')) {
            log.warn('Network error during polling, retrying...', { jobId, error: error.message });
            await this.sleep(Math.min(pollingInterval * 2, 5000), combinedSignal); // Exponential backoff, max 5s
            continue;
          }

          // Other errors are thrown
          throw error;
        }
      }

      // Handle cancellation
      if (combinedSignal.aborted) {
        log.info('Job polling cancelled', { jobId });

        // Try to cancel the job on the server
        try {
          await this.cancelJob(jobId);
        } catch (cancelError) {
          log.warn('Failed to cancel job on server', { jobId, error: cancelError });
        }

        throw new Error('Request cancelled by user');
      }

    } finally {
      // Cleanup
      this.activePollers.delete(jobId);

      // Clear global polling context
      // TODO: When migrating to AsyncLocalStorage, this cleanup will be automatic
      if (typeof global !== 'undefined') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (global as any).__POLLING_CONTEXT__;
      }

      log.debug('Job polling cleanup completed', { jobId });
    }
  }

  /**
   * Cancel a job and stop polling
   */
  async cancelJob(jobId: string): Promise<boolean> {
    log.info('Cancelling job', { jobId });

    try {
      // Stop local polling
      const poller = this.activePollers.get(jobId);
      if (poller) {
        poller.abort();
        this.activePollers.delete(jobId);
      }

      // Cancel on server - determine correct endpoint based on context
      const cancelEndpoint = `/api/nexus/chat/jobs/${jobId}`;
      const response = await fetch(cancelEndpoint, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          log.warn('Job not found for cancellation', { jobId });
          return false;
        } else if (response.status === 409) {
          log.info('Job not in cancellable state', { jobId });
          return false;
        } else {
          throw new Error(`Cancellation failed: ${response.status} ${response.statusText}`);
        }
      }

      const result = await response.json();
      log.info('Job cancelled successfully', { jobId, result });

      return result.success || false;

    } catch (error) {
      log.error('Failed to cancel job', { jobId, error });
      throw error;
    }
  }

  /**
   * Get current job status without polling
   */
  async getJobStatus(jobId: string): Promise<JobPollingResponse> {
    log.debug('Getting job status', { jobId });

    try {
      const statusEndpoint = `/api/nexus/chat/jobs/${jobId}`;
      const response = await fetch(statusEndpoint, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Status fetch failed: ${response.status} ${response.statusText}`);
      }

      const jobData: JobPollingResponse = await response.json();
      log.debug('Job status retrieved', { jobId, status: jobData.status });

      return jobData;

    } catch (error) {
      log.error('Failed to get job status', { jobId, error });
      throw error;
    }
  }

  /**
   * List active jobs for the current user
   */
  async getActiveJobs(): Promise<string[]> {
    return Array.from(this.activePollers.keys());
  }

  /**
   * Stop all active polling
   */
  async stopAllPolling(): Promise<void> {
    log.info('Stopping all active polling', { activeCount: this.activePollers.size });

    for (const [jobId, controller] of this.activePollers.entries()) {
      controller.abort();
      log.debug('Stopped polling for job', { jobId });
    }

    this.activePollers.clear();
  }

  /**
   * Combine multiple abort signals
   */
  private combineAbortSignals(signals: (AbortSignal | undefined)[]): AbortSignal {
    const validSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);

    if (validSignals.length === 0) {
      return new AbortController().signal;
    }

    if (validSignals.length === 1) {
      return validSignals[0];
    }

    // Create combined controller
    const combinedController = new AbortController();

    const abortHandler = () => {
      combinedController.abort();
    };

    // Listen to all signals
    for (const signal of validSignals) {
      if (signal.aborted) {
        combinedController.abort();
        return combinedController.signal;
      }
      signal.addEventListener('abort', abortHandler);
    }

    // Cleanup listeners when combined signal is aborted
    combinedController.signal.addEventListener('abort', () => {
      for (const signal of validSignals) {
        signal.removeEventListener('abort', abortHandler);
      }
    });

    return combinedController.signal;
  }

  /**
   * Sleep with abort signal support
   */
  private async sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (abortSignal?.aborted) {
        reject(new Error('Aborted'));
        return;
      }

      const timeout = setTimeout(resolve, ms);

      const abortHandler = () => {
        clearTimeout(timeout);
        reject(new Error('Aborted'));
      };

      abortSignal?.addEventListener('abort', abortHandler);

      // Cleanup
      setTimeout(() => {
        abortSignal?.removeEventListener('abort', abortHandler);
      }, ms);
    });
  }
}

// Singleton instance
export const universalPollingAdapter = new UniversalPollingAdapter();

/**
 * Assistant UI Chat Model Adapter
 *
 * Integrates with @ai-sdk/react's LocalRuntime to provide
 * universal polling for all AI requests.
 */
export const createUniversalPollingChatModelAdapter = () => {
  return {
    async *run({ messages, abortSignal, modelId, provider, conversationId }: {
      messages: UIMessage[];
      abortSignal?: AbortSignal;
      modelId?: string;
      provider?: string;
      conversationId?: number;
    }) {
      log.info('Starting universal polling chat request', {
        messageCount: messages.length,
        modelId,
        provider,
        conversationId
      });

      try {
        // 1. Create job via /api/nexus/chat
        const chatResponse = await fetch('/api/nexus/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messages,
            modelId,
            provider,
            conversationId
          }),
          signal: abortSignal,
        });

        if (!chatResponse.ok) {
          throw new Error(`Chat request failed: ${chatResponse.status} ${chatResponse.statusText}`);
        }

        const chatData = await chatResponse.json();
        const jobId = chatData.jobId;

        if (!jobId) {
          throw new Error('No job ID returned from chat API');
        }

        log.info('Job created, starting polling', {
          jobId,
          conversationId: chatData.conversationId
        });

        // 2. Poll for results with progressive streaming
        let lastContent = '';

        for await (const progress of universalPollingAdapter.pollJob(jobId, {
          abortSignal,
          onProgress: (data) => {
            log.debug('Polling progress', {
              jobId,
              contentLength: data.content?.length || 0,
              status: data.metadata?.status
            });
          },
          onStatusChange: (status) => {
            log.info('Job status changed', { jobId, status });
          }
        })) {
          // Yield progressive updates as Assistant UI messages
          if (progress.content !== lastContent) {
            lastContent = progress.content;

            yield {
              content: [{ type: 'text' as const, text: progress.content }],
              metadata: progress.metadata
            };
          }
        }

        log.info('Universal polling completed successfully', { jobId });

      } catch (error) {
        log.error('Universal polling adapter error', { error });
        throw error;
      }
    }
  };
};

/**
 * Hook for React components to use universal polling
 */
export const useUniversalPolling = () => {
  return {
    pollJob: universalPollingAdapter.pollJob.bind(universalPollingAdapter),
    cancelJob: universalPollingAdapter.cancelJob.bind(universalPollingAdapter),
    getJobStatus: universalPollingAdapter.getJobStatus.bind(universalPollingAdapter),
    getActiveJobs: universalPollingAdapter.getActiveJobs.bind(universalPollingAdapter),
    stopAllPolling: universalPollingAdapter.stopAllPolling.bind(universalPollingAdapter),
  };
};
