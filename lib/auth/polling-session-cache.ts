/**
 * High-performance session cache for polling operations
 * Eliminates redundant auth checks during long-running operations
 */

import { createLogger } from '@/lib/logger';
import type { CognitoSession } from '@/lib/auth/server-session';

const log = createLogger({ module: 'polling-session-cache' });

interface CachedSession {
  session: CognitoSession;
  userId: number;
  userRoles: string[];
  cachedAt: number;
  expiresAt: number;
  requestCount: number;
}

interface SessionCacheOptions {
  maxAge?: number; // Cache duration in ms (default: 5 minutes)
  maxEntries?: number; // Max cached sessions (default: 1000)
  cleanupInterval?: number; // Cleanup frequency in ms (default: 2 minutes)
}

export class PollingSessionCache {
  private cache = new Map<string, CachedSession>();
  private cleanupTimer?: NodeJS.Timeout;
  private readonly options: Required<SessionCacheOptions>;

  constructor(options: SessionCacheOptions = {}) {
    this.options = {
      maxAge: options.maxAge || 5 * 60 * 1000, // 5 minutes
      maxEntries: options.maxEntries || 1000,
      cleanupInterval: options.cleanupInterval || 2 * 60 * 1000, // 2 minutes
    };

    // Start periodic cleanup
    this.startCleanup();
  }

  /**
   * Get cached session for a user, bypassing auth checks if valid
   */
  getCachedSession(sessionId: string): CachedSession | null {
    const cached = this.cache.get(sessionId);

    if (!cached) {
      return null;
    }

    const now = Date.now();

    // Check if cache entry is expired
    if (now > cached.expiresAt) {
      this.cache.delete(sessionId);
      log.debug('Cache entry expired', { sessionId, age: now - cached.cachedAt });
      return null;
    }

    // Update request count for metrics
    cached.requestCount++;

    log.debug('Cache hit', {
      sessionId,
      userId: cached.userId,
      requestCount: cached.requestCount,
      age: now - cached.cachedAt
    });

    return cached;
  }

  /**
   * Cache session data for future polling requests
   */
  setCachedSession(
    sessionId: string,
    session: CognitoSession,
    userId: number,
    userRoles: string[]
  ): void {
    const now = Date.now();

    // Implement LRU eviction if cache is full
    if (this.cache.size >= this.options.maxEntries) {
      this.evictOldest();
    }

    this.cache.set(sessionId, {
      session,
      userId,
      userRoles,
      cachedAt: now,
      expiresAt: now + this.options.maxAge,
      requestCount: 1
    });

    log.debug('Session cached', {
      sessionId,
      userId,
      roleCount: userRoles.length,
      cacheSize: this.cache.size
    });
  }

  /**
   * Invalidate cached session (on logout, role changes, etc.)
   */
  invalidateSession(sessionId: string): void {
    const deleted = this.cache.delete(sessionId);
    if (deleted) {
      log.info('Session cache invalidated', { sessionId });
    }
  }

  /**
   * Get cache statistics for monitoring
   */
  getStats() {
    const now = Date.now();
    let totalRequests = 0;
    let validEntries = 0;

    for (const entry of this.cache.values()) {
      if (now <= entry.expiresAt) {
        validEntries++;
        totalRequests += entry.requestCount;
      }
    }

    return {
      totalEntries: this.cache.size,
      validEntries,
      totalRequests,
      hitRate: validEntries > 0 ? (totalRequests / validEntries).toFixed(2) : '0.00',
      memoryUsage: this.estimateMemoryUsage()
    };
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.cachedAt < oldestTime) {
        oldestTime = entry.cachedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      log.debug('Evicted oldest cache entry', { sessionId: oldestKey });
    }
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      let cleaned = 0;

      for (const [key, entry] of this.cache.entries()) {
        if (now > entry.expiresAt) {
          this.cache.delete(key);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        log.debug('Cache cleanup completed', { cleaned, remaining: this.cache.size });
      }
    }, this.options.cleanupInterval);
  }

  private estimateMemoryUsage(): string {
    const avgEntrySize = 500; // Estimated bytes per cache entry
    const totalBytes = this.cache.size * avgEntrySize;

    if (totalBytes < 1024) return `${totalBytes}B`;
    if (totalBytes < 1024 * 1024) return `${(totalBytes / 1024).toFixed(1)}KB`;
    return `${(totalBytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.cache.clear();
    log.info('Session cache destroyed');
  }
}

// Singleton instance for application-wide use
export const pollingSessionCache = new PollingSessionCache({
  maxAge: 5 * 60 * 1000, // 5 minutes - longer than typical polling sessions
  maxEntries: 500, // Reasonable for concurrent users
  cleanupInterval: 2 * 60 * 1000, // 2 minutes
});

/**
 * Single source of truth for a user's polling-cache key. Keyed on `sub` alone (one
 * entry per user). The previous `:${iat}` suffix always fell back to `Date.now()`
 * because CognitoSession never carries `iat`, so every call produced a unique key —
 * a 0% cache hit rate AND an invalidation key that could never match the stored one
 * (REV-COR-512 / REV-SEC-165 / REV-SEC-181). Producer and invalidator both derive
 * keys through this function so the two formats cannot drift again. Safe because
 * `authenticatePollingRequest` re-validates the JWT via `getServerSession()` before
 * ever consulting the cache — an expired/rotated token can't produce a stale hit.
 */
export function sessionCacheKeyForSub(sub: string): string {
  return `session:${sub}`;
}

/**
 * Generate cache key from session data.
 */
export function generateSessionCacheKey(session: CognitoSession): string {
  return sessionCacheKeyForSub(session.sub);
}