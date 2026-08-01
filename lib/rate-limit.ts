import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/auth/server-session';

interface RateLimitConfig {
  interval: number; // Time window in milliseconds
  uniqueTokenPerInterval: number; // Max requests per interval
  skipAuth?: boolean; // Skip rate limiting for authenticated users
  /** Internal per-handler namespace so unrelated routes do not share a budget. */
  namespace?: string;
}

export interface DirectRateLimitConfig {
  interval: number;
  uniqueTokenPerInterval: number;
  namespace: string;
  identifier: string;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
  resetTime: number;
}

// TODO: Move enforcement that must span multiple application tasks to a shared
// store. This in-memory map intentionally provides only a per-process guard.
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();
let rateLimiterInstance = 0;

function nextRateLimiterNamespace(prefix: string): string {
  rateLimiterInstance += 1;
  return `${prefix}-${rateLimiterInstance}`;
}

// Clean up expired entries periodically
const rateLimitCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rateLimitStore.entries()) {
    if (value.resetTime < now) {
      rateLimitStore.delete(key);
    }
  }
}, 60000); // Clean up every minute
rateLimitCleanupTimer.unref?.();

/**
 * Get identifier for rate limiting
 */
async function getIdentifier(request: NextRequest, skipAuth: boolean): Promise<string> {
  // Try to get authenticated user first
  if (!skipAuth) {
    try {
      const session = await getServerSession();
      if (session?.sub) {
        return `user:${session.sub}`;
      }
    } catch {
      // Fall through to IP-based limiting
    }
  }

  // Fall back to IP address
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded ? forwarded.split(',')[0] : 'unknown';
  return `ip:${ip}`;
}

/**
 * Consume one request from a named, in-memory rate-limit bucket.
 *
 * Server actions do not receive a `NextRequest`, so they cannot use the route
 * middleware wrapper below. This direct form lets an already-authenticated
 * caller supply its server-derived identifier while sharing the same store and
 * fixed-window behavior as API routes.
 */
export function consumeRateLimit(
  config: DirectRateLimitConfig
): RateLimitDecision {
  const storeKey = `${config.namespace}:${config.identifier}`;
  const now = Date.now();
  let entry = rateLimitStore.get(storeKey);

  if (!entry || entry.resetTime < now) {
    entry = {
      count: 1,
      resetTime: now + config.interval,
    };
    rateLimitStore.set(storeKey, entry);
    return {
      allowed: true,
      retryAfterSeconds: 0,
      remaining: Math.max(config.uniqueTokenPerInterval - 1, 0),
      resetTime: entry.resetTime,
    };
  }

  if (entry.count >= config.uniqueTokenPerInterval) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        Math.ceil((entry.resetTime - now) / 1000),
        1
      ),
      remaining: 0,
      resetTime: entry.resetTime,
    };
  }

  entry.count += 1;
  return {
    allowed: true,
    retryAfterSeconds: 0,
    remaining: Math.max(config.uniqueTokenPerInterval - entry.count, 0),
    resetTime: entry.resetTime,
  };
}

/**
 * Rate limiting middleware
 */
export function rateLimit(config: RateLimitConfig) {
  const namespace =
    config.namespace ?? nextRateLimiterNamespace("rate-limiter");
  return async function rateLimitMiddleware(
    request: NextRequest
  ): Promise<NextResponse | null> {
    const identifier = await getIdentifier(request, config.skipAuth || false);
    const decision = consumeRateLimit({
      interval: config.interval,
      uniqueTokenPerInterval: config.uniqueTokenPerInterval,
      namespace,
      identifier,
    });

    if (!decision.allowed) {
      return NextResponse.json(
        {
          isSuccess: false,
          message: 'Too many requests. Please try again later.',
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfter: decision.retryAfterSeconds
          }
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(decision.retryAfterSeconds),
            'X-RateLimit-Limit': String(config.uniqueTokenPerInterval),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(decision.resetTime)
          }
        }
      );
    }

    // Add rate limit headers to response
    return null; // Allow request, headers will be added by wrapper
  };
}

/**
 * Wrapper function for API routes with rate limiting
 */
export function withRateLimit<T extends unknown[], R>(
  handler: (...args: T) => Promise<R>,
  config: RateLimitConfig = {
    interval: 60 * 1000, // 1 minute
    uniqueTokenPerInterval: 100 // 100 requests per minute
  }
): (...args: T) => Promise<R | NextResponse> {
  const namespace =
    config.namespace ?? nextRateLimiterNamespace("rate-limit-handler");
  const limiter = rateLimit({ ...config, namespace });
  
  return async (...args: T) => {
    // Assume first argument is NextRequest
    const request = args[0] as unknown as NextRequest;
    
    // Check rate limit
    const rateLimitResponse = await limiter(request);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }
    
    // Call original handler
    const response = await handler(...args);
    
    // Add rate limit headers to successful responses.
    // Guard with typeof first: in test environments NextResponse may be mocked as a
    // plain object (not a constructor), which would cause `instanceof` to throw TypeError.
    if (typeof NextResponse === 'function' && response instanceof NextResponse) {
      const identifier = await getIdentifier(request, config.skipAuth || false);
      const entry = rateLimitStore.get(`${namespace}:${identifier}`);

      if (entry) {
        response.headers.set('X-RateLimit-Limit', String(config.uniqueTokenPerInterval));
        response.headers.set('X-RateLimit-Remaining', String(config.uniqueTokenPerInterval - entry.count));
        response.headers.set('X-RateLimit-Reset', String(entry.resetTime));
      }
    }
    
    return response;
  };
}

// Pre-configured rate limiters for common use cases
export const apiRateLimit = {
  // Standard API endpoints: 100 requests per minute
  standard: <T extends unknown[], R>(handler: (...args: T) => Promise<R>) => withRateLimit(handler, {
    interval: 60 * 1000,
    uniqueTokenPerInterval: 100
  }),
  
  // AI endpoints: 20 requests per minute (more expensive)
  ai: <T extends unknown[], R>(handler: (...args: T) => Promise<R>) => withRateLimit(handler, {
    interval: 60 * 1000,
    uniqueTokenPerInterval: 20
  }),
  
  // Auth endpoints: 10 requests per minute (prevent brute force)
  auth: <T extends unknown[], R>(handler: (...args: T) => Promise<R>) => withRateLimit(handler, {
    interval: 60 * 1000,
    uniqueTokenPerInterval: 10,
    skipAuth: true // Don't check auth for auth endpoints
  }),
  
  // Upload endpoints: 5 requests per minute
  upload: <T extends unknown[], R>(handler: (...args: T) => Promise<R>) => withRateLimit(handler, {
    interval: 60 * 1000,
    uniqueTokenPerInterval: 5
  })
};
