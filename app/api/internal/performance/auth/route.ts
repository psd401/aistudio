/**
 * Authentication Performance Monitoring API
 * Internal endpoint for monitoring auth system performance
 */

import { NextRequest } from 'next/server';
import { authPerformanceMonitor } from '@/lib/monitoring/auth-performance-monitor';
import { getAuthCacheStats } from '@/lib/auth/optimized-polling-auth';
import { createLogger, generateRequestId } from '@/lib/logger';
import { getServerSession } from '@/lib/auth/server-session';
import { hasToolAccess } from '@/utils/roles';
import { rateLimit } from '@/lib/rate-limit';

const log = createLogger({ route: 'api.internal.performance.auth' });

// Rate limiting configuration for monitoring endpoints
const monitoringRateLimit = rateLimit({
  interval: 60 * 1000, // 1 minute window
  uniqueTokenPerInterval: 30, // Max 30 requests per minute per user
  skipAuth: false // Use authenticated user for rate limiting
});

// More restrictive rate limiting for admin operations (reset)
const adminActionRateLimit = rateLimit({
  interval: 60 * 1000, // 1 minute window
  uniqueTokenPerInterval: 5, // Max 5 admin actions per minute per user
  skipAuth: false
});

/**
 * GET /api/internal/performance/auth
 * Returns comprehensive authentication performance metrics
 */
export async function GET(request: NextRequest) {
  const requestId = generateRequestId();

  try {
    // Apply rate limiting first
    const rateLimitResponse = await monitoringRateLimit(request);
    if (rateLimitResponse) {
      log.warn('Rate limit exceeded for performance API', { requestId });
      return rateLimitResponse;
    }

    // Authenticate user
    const session = await getServerSession();
    if (!session) {
      log.warn('Unauthorized request to performance API', { requestId });
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check admin permissions for performance monitoring
    const canAccess = await hasToolAccess('internal-performance-monitoring');
    if (!canAccess) {
      log.warn('Forbidden request to performance API', {
        requestId,
        userId: session.sub
      });
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const searchParams = request.nextUrl.searchParams;
    const format = searchParams.get('format') || 'summary';

    log.debug('Auth performance metrics requested', {
      format,
      requestId,
      userId: session.sub
    });

    switch (format) {
      case 'detailed': {
        const detailedMetrics = {
          summary: authPerformanceMonitor.getPerformanceSummary(),
          metrics: authPerformanceMonitor.getMetrics(),
          cacheStats: getAuthCacheStats(),
          alerts: authPerformanceMonitor.getAlerts(20),
          timestamp: Date.now()
        };

        return Response.json(detailedMetrics, {
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Content-Type': 'application/json'
          }
        });
      }

      case 'alerts': {
        const alerts = authPerformanceMonitor.getAlerts(50);
        return Response.json({ alerts, count: alerts.length }, {
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Content-Type': 'application/json'
          }
        });
      }

      default: { // 'summary'
        const summary = authPerformanceMonitor.getPerformanceSummary();
        return Response.json(summary, {
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Content-Type': 'application/json'
          }
        });
      }
    }

  } catch (error) {
    log.error('Failed to retrieve auth performance metrics', {
      error: error instanceof Error ? error.message : String(error)
    });

    return Response.json(
      { error: 'Failed to retrieve performance metrics' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/internal/performance/auth
 * Reset performance metrics (for testing or maintenance)
 */
export async function POST(request: NextRequest) {
  const requestId = generateRequestId();

  try {
    // Apply more restrictive rate limiting for admin operations
    const rateLimitResponse = await adminActionRateLimit(request);
    if (rateLimitResponse) {
      log.warn('Rate limit exceeded for performance API admin action', { requestId });
      return rateLimitResponse;
    }

    // Authenticate user
    const session = await getServerSession();
    if (!session) {
      log.warn('Unauthorized request to performance API action', { requestId });
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check admin permissions for system administration (reset operations)
    const canAccess = await hasToolAccess('internal-system-administration');
    if (!canAccess) {
      log.warn('Forbidden request to performance API action', {
        requestId,
        userId: session.sub
      });
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const action = body.action;

    log.info('Auth performance action requested', {
      action,
      requestId,
      userId: session.sub
    });

    switch (action) {
      case 'reset':
        authPerformanceMonitor.reset();
        return Response.json({ message: 'Auth performance metrics reset successfully' });

      default:
        return Response.json(
          { error: 'Unknown action. Supported actions: reset' },
          { status: 400 }
        );
    }

  } catch (error) {
    log.error('Failed to perform auth performance action', {
      error: error instanceof Error ? error.message : String(error)
    });

    return Response.json(
      { error: 'Failed to perform action' },
      { status: 500 }
    );
  }
}