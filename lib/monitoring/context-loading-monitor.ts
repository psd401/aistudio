/**
 * Context Loading Monitor
 * Monitors and alerts on context loading issues to prevent regression
 */

import logger from '@/lib/logger';

interface ContextLoadingMetrics {
  executionId: number | string | null;
  hasSystemContext: boolean;
  systemContextCount: number;
  chainPromptsCount: number;
  contextLength: number;
  loadTime: number;
  error?: string;
}

interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export class ContextLoadingMonitor {
  private static instance: ContextLoadingMonitor;
  private metrics: ContextLoadingMetrics[] = [];
  private readonly MAX_METRICS = 100;
  private readonly ALERT_THRESHOLD = {
    invalidExecutionId: 1, // Alert on first occurrence
    missingSystemContext: 3, // Alert after 3 occurrences
    contextLoadFailure: 1, // Alert on first occurrence
    slowLoadTime: 5000 // Alert if load time exceeds 5 seconds
  };

  private constructor() {}

  static getInstance(): ContextLoadingMonitor {
    if (!ContextLoadingMonitor.instance) {
      ContextLoadingMonitor.instance = new ContextLoadingMonitor();
    }
    return ContextLoadingMonitor.instance;
  }

  /**
   * Validate execution ID and alert on invalid values
   */
  validateExecutionId(executionId: unknown): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for known bad values
    if (executionId === 'streaming') {
      errors.push('ExecutionId is "streaming" - this is a known bug indicator');
      this.sendAlert('CRITICAL', 'Invalid executionId "streaming" detected', {
        executionId,
        timestamp: new Date().toISOString()
      });
    }

    if (executionId === 'undefined' || executionId === 'null') {
      errors.push(`ExecutionId is string "${executionId}" instead of actual null/undefined`);
    }

    if (typeof executionId === 'string' && executionId !== 'streaming') {
      const parsed = Number.parseInt(executionId, 10);
      if (isNaN(parsed)) {
        errors.push(`ExecutionId "${executionId}" cannot be parsed to number`);
      } else if (parsed <= 0) {
        errors.push(`ExecutionId ${parsed} is not positive`);
      } else {
        warnings.push(`ExecutionId is string "${executionId}" but can be parsed to ${parsed}`);
      }
    }

    if (typeof executionId === 'number' && executionId <= 0) {
      errors.push(`ExecutionId ${executionId} is not positive`);
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Track context loading metrics
   */
  trackContextLoad(startTime: number, result: {
    executionId: unknown;
    systemContexts?: string[];
    chainPrompts?: unknown[];
    contextLength?: number;
    error?: Error;
  }) {
    const loadTime = Date.now() - startTime;
    const metrics: ContextLoadingMetrics = {
      executionId: result.executionId as (number | string | null),
      hasSystemContext: (result.systemContexts?.length || 0) > 0,
      systemContextCount: result.systemContexts?.length || 0,
      chainPromptsCount: result.chainPrompts?.length || 0,
      contextLength: result.contextLength || 0,
      loadTime,
      error: result.error?.message
    };

    this.addMetric(metrics);
    this.checkForIssues(metrics);

    // Metrics tracked
  }

  /**
   * Check for issues and send alerts
   */
  private checkForIssues(metrics: ContextLoadingMetrics) {
    // Check for invalid execution ID
    const validation = this.validateExecutionId(metrics.executionId);
    if (!validation.isValid) {
      logger.error('[ContextMonitor] Invalid execution ID detected', {
        executionId: metrics.executionId,
        errors: validation.errors
      });
    }

    // Check for missing system context when chain prompts exist
    if (metrics.chainPromptsCount > 0 && metrics.systemContextCount === 0) {
      this.sendAlert('WARNING', 'System contexts missing despite having chain prompts', {
        chainPromptsCount: metrics.chainPromptsCount,
        systemContextCount: metrics.systemContextCount
      });
    }

    // Check for slow load times
    if (metrics.loadTime > this.ALERT_THRESHOLD.slowLoadTime) {
      this.sendAlert('WARNING', 'Slow context load detected', {
        loadTimeMs: metrics.loadTime,
        threshold: this.ALERT_THRESHOLD.slowLoadTime
      });
    }

    // Check for errors
    if (metrics.error) {
      this.sendAlert('ERROR', 'Context load failed', {
        error: metrics.error,
        executionId: metrics.executionId
      });
    }

    // Check for suspiciously small context
    if (metrics.contextLength > 0 && metrics.contextLength < 500) {
      logger.warn('[ContextMonitor] Suspiciously small context detected', {
        contextLength: metrics.contextLength,
        executionId: metrics.executionId
      });
    }
  }

  /**
   * Send alert to monitoring system
   */
  private sendAlert(level: 'CRITICAL' | 'ERROR' | 'WARNING', message: string, details: Record<string, unknown>) {
    // Log to application logger
    const logMessage = `[ContextMonitor Alert] ${level}: ${message}`;
    if (level === 'CRITICAL' || level === 'ERROR') {
      logger.error(logMessage, details);
    } else {
      logger.warn(logMessage, details);
    }

    // Here you would integrate with your monitoring service
    // For example: Sentry, Datadog, CloudWatch, etc.
    // Example:
    // if (typeof window !== 'undefined' && window.Sentry) {
    //   window.Sentry.captureMessage(message, {
    //     level: level.toLowerCase(),
    //     extra: details
    //   });
    // }
  }

  /**
   * Add metric and maintain size limit
   */
  private addMetric(metric: ContextLoadingMetrics) {
    this.metrics.push(metric);
    if (this.metrics.length > this.MAX_METRICS) {
      this.metrics.shift();
    }
  }

  /**
   * Get recent metrics for debugging
   */
  getRecentMetrics(count: number = 10): ContextLoadingMetrics[] {
    return this.metrics.slice(-count);
  }

  /**
   * Get metrics summary
   */
  getMetricsSummary() {
    if (this.metrics.length === 0) {
      return { totalLoads: 0 };
    }

    const validLoads = this.metrics.filter(m => !m.error);
    const avgLoadTime = validLoads.reduce((sum, m) => sum + m.loadTime, 0) / validLoads.length;
    const invalidExecutionIds = this.metrics.filter(m => {
      const validation = this.validateExecutionId(m.executionId);
      return !validation.isValid;
    });

    return {
      totalLoads: this.metrics.length,
      successfulLoads: validLoads.length,
      failedLoads: this.metrics.filter(m => m.error).length,
      avgLoadTimeMs: Math.round(avgLoadTime),
      invalidExecutionIds: invalidExecutionIds.length,
      missingSystemContexts: this.metrics.filter(m => !m.hasSystemContext && m.chainPromptsCount > 0).length
    };
  }

  /**
   * Clear metrics (useful for tests)
   */
  clearMetrics() {
    this.metrics = [];
  }
}

// Export singleton instance
export const contextMonitor = ContextLoadingMonitor.getInstance();