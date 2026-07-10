/**
 * Optimized authentication service for polling operations
 * Reduces auth overhead from ~500ms to ~5ms per request
 */

import { getServerSession } from '@/lib/auth/server-session';
import { getCurrentUserAction } from '@/actions/db/get-current-user-action';
import { pollingSessionCache, generateSessionCacheKey, sessionCacheKeyForSub } from './polling-session-cache';
import { authPerformanceMonitor } from '@/lib/monitoring/auth-performance-monitor';
import { createLogger } from '@/lib/logger';

const log = createLogger({ module: 'optimized-polling-auth' });

export interface OptimizedAuthResult {
  isAuthorized: boolean;
  userId: number;
  session: {
    sub: string;
    email?: string;
    givenName?: string | null;
    familyName?: string | null;
  };
  userRoles: string[];
  authMethod: 'cache' | 'database' | 'failed';
  authTime: number;
}

/**
 * High-performance authentication for polling endpoints
 * Uses intelligent caching to minimize database hits
 */
export async function authenticatePollingRequest(): Promise<OptimizedAuthResult> {
  const startTime = Date.now();

  try {
    // Step 1: Get session (always required for JWT validation)
    const session = await getServerSession();
    if (!session) {
      const authTime = Date.now() - startTime;
      authPerformanceMonitor.recordAuthRequest(authTime, 'failed', true);

      return {
        isAuthorized: false,
        userId: 0,
        session: { sub: '' },
        userRoles: [],
        authMethod: 'failed',
        authTime
      };
    }

    const cacheKey = generateSessionCacheKey(session);

    // Step 2: Check cache first
    const cachedAuth = pollingSessionCache.getCachedSession(cacheKey);
    if (cachedAuth) {
      const authTime = Date.now() - startTime;
      authPerformanceMonitor.recordAuthRequest(authTime, 'cache', true);

      log.debug('Using cached authentication', {
        userId: cachedAuth.userId,
        cacheAge: Date.now() - cachedAuth.cachedAt,
        requestCount: cachedAuth.requestCount,
        authTime
      });

      return {
        isAuthorized: true,
        userId: cachedAuth.userId,
        session: cachedAuth.session,
        userRoles: cachedAuth.userRoles,
        authMethod: 'cache',
        authTime
      };
    }

    // Step 3: Full authentication (cache miss)
    log.debug('Cache miss - performing full authentication', { sub: session.sub });

    const userResult = await getCurrentUserAction();
    if (!userResult.isSuccess) {
      const authTime = Date.now() - startTime;
      authPerformanceMonitor.recordAuthRequest(authTime, 'failed', true);

      log.warn('Failed to authenticate user', { sub: session.sub, authTime });
      return {
        isAuthorized: false,
        userId: 0,
        session: { sub: session.sub },
        userRoles: [],
        authMethod: 'failed',
        authTime
      };
    }

    const { user, roles } = userResult.data;
    const userRoles = roles.map(role => role.name);

    // Step 4: Cache the result
    pollingSessionCache.setCachedSession(cacheKey, session, user.id, userRoles);

    const authTime = Date.now() - startTime;
    authPerformanceMonitor.recordAuthRequest(authTime, 'database', true);

    log.info('Full authentication completed and cached', {
      userId: user.id,
      roleCount: userRoles.length,
      authTime
    });

    return {
      isAuthorized: true,
      userId: user.id,
      session,
      userRoles,
      authMethod: 'database',
      authTime
    };

  } catch (error) {
    const authTime = Date.now() - startTime;
    authPerformanceMonitor.recordAuthRequest(authTime, 'failed', true);

    log.error('Authentication error in polling request', {
      error: error instanceof Error ? error.message : String(error),
      authTime
    });

    return {
      isAuthorized: false,
      userId: 0,
      session: { sub: '' },
      userRoles: [],
      authMethod: 'failed',
      authTime
    };
  }
}

/**
 * Validate job ownership without redundant auth checks
 */
export function validateJobOwnership(
  authResult: OptimizedAuthResult,
  jobUserId: number,
  jobId: string
): { authorized: boolean; reason?: string } {
  if (!authResult.isAuthorized) {
    return { authorized: false, reason: 'not_authenticated' };
  }

  if (authResult.userId !== jobUserId) {
    log.warn('Job access denied - user mismatch', {
      authenticatedUserId: authResult.userId,
      jobUserId,
      jobId
    });
    return { authorized: false, reason: 'wrong_user' };
  }

  return { authorized: true };
}

/**
 * Invalidate cached sessions (call on logout, role changes)
 */
export function invalidateUserSessions(userSub: string): void {
  // Derive the key the SAME way the producer does (sessionCacheKeyForSub) so the
  // delete actually matches the stored entry — previously it built `session:${sub}`
  // while entries were stored as `session:${sub}:${iat}`, making invalidation a
  // silent no-op (REV-SEC-165 / REV-SEC-181 / REV-COR-512).
  pollingSessionCache.invalidateSession(sessionCacheKeyForSub(userSub));
  log.info('User sessions invalidated', { userSub });
}

/**
 * Get authentication cache statistics
 */
export function getAuthCacheStats() {
  return pollingSessionCache.getStats();
}