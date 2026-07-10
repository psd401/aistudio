/**
 * Authentication Performance Monitoring
 * Tracks and analyzes auth system performance metrics
 */

import { createLogger } from '@/lib/logger';
// Import the leaf cache directly (not getAuthCacheStats from optimized-polling-auth)
// to break the optimized-polling-auth ↔ auth-performance-monitor import cycle
// (REV-ARCH-004). polling-session-cache imports neither module, so the cycle is gone.
import { pollingSessionCache } from '@/lib/auth/polling-session-cache';

const log = createLogger({ module: 'auth-performance-monitor' });

interface AuthMetrics {
  totalRequests: number;
  cacheHits: number;
  cacheMisses: number;
  averageAuthTime: number;
  tokenRefreshCount: number;
  rateLimitHits: number;
  pollingRequests: number;
  errors: number;
  lastUpdated: number;
}

interface AuthPerformanceAlert {
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  metric: string;
  value: number;
  threshold: number;
  timestamp: number;
}

class AuthPerformanceMonitor {
  private metrics: AuthMetrics = {
    totalRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    averageAuthTime: 0,
    tokenRefreshCount: 0,
    rateLimitHits: 0,
    pollingRequests: 0,
    errors: 0,
    lastUpdated: Date.now()
  };

  private alerts: AuthPerformanceAlert[] = [];
  private authTimeSamples: number[] = [];
  private readonly maxSamples = 100;

  /**
   * Record authentication request metrics
   */
  recordAuthRequest(authTime: number, method: 'cache' | 'database' | 'failed', isPolling = false): void {
    this.metrics.totalRequests++;
    this.metrics.lastUpdated = Date.now();

    if (isPolling) {
      this.metrics.pollingRequests++;
    }

    switch (method) {
      case 'cache':
        this.metrics.cacheHits++;
        break;
      case 'database':
        this.metrics.cacheMisses++;
        break;
      case 'failed':
        this.metrics.errors++;
        return; // Don't include failed requests in timing
    }

    // Track authentication timing
    this.authTimeSamples.push(authTime);
    if (this.authTimeSamples.length > this.maxSamples) {
      this.authTimeSamples.shift();
    }

    // Calculate rolling average
    this.metrics.averageAuthTime =
      this.authTimeSamples.reduce((sum, time) => sum + time, 0) / this.authTimeSamples.length;

    // Check for performance alerts
    this.checkPerformanceAlerts(authTime);
  }

  /**
   * Record token refresh metrics
   */
  recordTokenRefresh(wasRateLimited = false): void {
    this.metrics.tokenRefreshCount++;
    if (wasRateLimited) {
      this.metrics.rateLimitHits++;
      this.createAlert('high', 'Token refresh rate limited', 'rate_limit', 1, 0);
    }
    this.metrics.lastUpdated = Date.now();
  }

  /**
   * Get current performance metrics
   */
  getMetrics(): AuthMetrics & {
    cacheHitRate: number;
    errorRate: number;
    pollingPercentage: number;
  } {
    const cacheHitRate = this.metrics.totalRequests > 0
      ? (this.metrics.cacheHits / (this.metrics.cacheHits + this.metrics.cacheMisses)) * 100
      : 0;

    const errorRate = this.metrics.totalRequests > 0
      ? (this.metrics.errors / this.metrics.totalRequests) * 100
      : 0;

    const pollingPercentage = this.metrics.totalRequests > 0
      ? (this.metrics.pollingRequests / this.metrics.totalRequests) * 100
      : 0;

    return {
      ...this.metrics,
      cacheHitRate,
      errorRate,
      pollingPercentage
    };
  }

  /**
   * Get performance summary with cache stats
   */
  getPerformanceSummary() {
    const metrics = this.getMetrics();
    const cacheStats = pollingSessionCache.getStats();

    return {
      authentication: {
        totalRequests: metrics.totalRequests,
        averageResponseTime: Math.round(metrics.averageAuthTime),
        cacheHitRate: Math.round(metrics.cacheHitRate * 10) / 10,
        errorRate: Math.round(metrics.errorRate * 10) / 10,
        pollingRequests: metrics.pollingRequests,
        pollingPercentage: Math.round(metrics.pollingPercentage * 10) / 10
      },
      tokenRefresh: {
        refreshCount: metrics.tokenRefreshCount,
        rateLimitHits: metrics.rateLimitHits,
        rateLimitRate: metrics.tokenRefreshCount > 0
          ? Math.round((metrics.rateLimitHits / metrics.tokenRefreshCount) * 100)
          : 0
      },
      caching: {
        ...cacheStats,
        effectivenessScore: this.calculateCacheEffectiveness()
      },
      alerts: this.alerts.slice(-5), // Last 5 alerts
      status: this.getOverallStatus()
    };
  }

  /**
   * Get recent alerts
   */
  getAlerts(limit = 10): AuthPerformanceAlert[] {
    return this.alerts.slice(-limit);
  }

  /**
   * Reset metrics (for testing or periodic resets)
   */
  reset(): void {
    this.metrics = {
      totalRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      averageAuthTime: 0,
      tokenRefreshCount: 0,
      rateLimitHits: 0,
      pollingRequests: 0,
      errors: 0,
      lastUpdated: Date.now()
    };
    this.alerts = [];
    this.authTimeSamples = [];

    log.info('Auth performance metrics reset');
  }

  private checkPerformanceAlerts(authTime: number): void {
    // Alert on slow authentication
    if (authTime > 1000) {
      this.createAlert('high', 'Slow authentication detected', 'auth_time', authTime, 1000);
    }

    // Alert on cache miss rate
    const metrics = this.getMetrics();
    if (metrics.totalRequests > 10 && metrics.cacheHitRate < 70) {
      this.createAlert('medium', 'Low cache hit rate', 'cache_hit_rate', metrics.cacheHitRate, 70);
    }

    // Alert on high error rate
    if (metrics.totalRequests > 5 && metrics.errorRate > 10) {
      this.createAlert('critical', 'High authentication error rate', 'error_rate', metrics.errorRate, 10);
    }
  }

  private createAlert(
    severity: AuthPerformanceAlert['severity'],
    message: string,
    metric: string,
    value: number,
    threshold: number
  ): void {
    // Avoid duplicate alerts (same metric within 5 minutes)
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    const recentSimilarAlert = this.alerts.find(alert =>
      alert.metric === metric && alert.timestamp > fiveMinutesAgo
    );

    if (recentSimilarAlert) {
      return;
    }

    const alert: AuthPerformanceAlert = {
      severity,
      message,
      metric,
      value,
      threshold,
      timestamp: Date.now()
    };

    this.alerts.push(alert);

    // Keep only last 50 alerts
    if (this.alerts.length > 50) {
      this.alerts.shift();
    }

    log.warn(`Auth performance alert: ${message}`, {
      severity,
      metric,
      value,
      threshold
    });
  }

  private calculateCacheEffectiveness(): number {
    const metrics = this.getMetrics();
    if (metrics.totalRequests === 0) return 0;

    // Effectiveness based on hit rate and performance improvement
    const hitRate = metrics.cacheHitRate / 100;
    const speedImprovement = 0.95; // Assume 95% speed improvement from cache
    const effectiveness = hitRate * speedImprovement * 100;

    return Math.round(effectiveness);
  }

  private getOverallStatus(): 'excellent' | 'good' | 'warning' | 'critical' {
    const metrics = this.getMetrics();

    if (metrics.errorRate > 20 || metrics.averageAuthTime > 2000) {
      return 'critical';
    }

    if (metrics.errorRate > 10 || metrics.averageAuthTime > 1000 || metrics.cacheHitRate < 50) {
      return 'warning';
    }

    if (metrics.cacheHitRate > 80 && metrics.averageAuthTime < 100) {
      return 'excellent';
    }

    return 'good';
  }
}

// Singleton instance
export const authPerformanceMonitor = new AuthPerformanceMonitor();

/**
 * Middleware to automatically track auth performance
 */
export function withAuthPerformanceTracking<T extends unknown[], R extends { authTime: number; authMethod: 'cache' | 'database' | 'failed'; isAuthorized: boolean }>(
  fn: (...args: T) => Promise<R>,
  isPollingRequest = false
) {
  return async (...args: T): Promise<R> => {
    const result = await fn(...args);

    authPerformanceMonitor.recordAuthRequest(
      result.authTime,
      result.authMethod,
      isPollingRequest
    );

    return result;
  };
}