/**
 * Drizzle Database Client Wrapper
 *
 * Provides a Drizzle ORM instance configured for AWS RDS Data API with
 * integrated circuit breaker and retry logic for resilience.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #529 - Create Drizzle database client wrapper with circuit breaker
 *
 * @see https://orm.drizzle.team/docs/connect-aws-data-api-pg
 */

import { drizzle } from "drizzle-orm/aws-data-api/pg";
import { RDSDataClient } from "@aws-sdk/client-rds-data";
import {
  executeWithRetry,
  getCircuitBreakerState,
  resetCircuitBreaker,
} from "./rds-error-handler";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import * as schema from "./schema";

// ============================================
// RDS Data API Client Configuration
// ============================================

/**
 * RDS Data API client instance
 * Uses server-side AWS_REGION (not NEXT_PUBLIC_AWS_REGION for security)
 */
const rdsClient = new RDSDataClient({
  region: process.env.AWS_REGION || "us-east-1",
});

// ============================================
// Drizzle Instance
// ============================================

/**
 * Drizzle ORM instance configured for AWS RDS Data API
 *
 * Uses environment variables:
 * - RDS_DATABASE_NAME: Database name (default: 'aistudio')
 * - RDS_SECRET_ARN: AWS Secrets Manager ARN for database credentials
 * - RDS_RESOURCE_ARN: Aurora cluster ARN
 *
 * Validates required environment variables at module load time to fail fast
 * with clear error messages rather than cryptic runtime failures.
 */
export const db = (() => {
  const secretArn = process.env.RDS_SECRET_ARN;
  const resourceArn = process.env.RDS_RESOURCE_ARN;

  if (!secretArn || !resourceArn) {
    throw new Error(
      "Required environment variables RDS_SECRET_ARN and RDS_RESOURCE_ARN are not set. " +
      "Database client cannot be initialized without these credentials."
    );
  }

  return drizzle(rdsClient, {
    database: process.env.RDS_DATABASE_NAME || "aistudio",
    secretArn,
    resourceArn,
    schema,
  });
})();

/**
 * Type alias for the Drizzle database instance
 * Useful for typing function parameters and return values
 */
export type DrizzleDB = typeof db;

// ============================================
// Retry Options Interface
// ============================================

export interface QueryRetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds before first retry (default: 100) */
  initialDelay?: number;
  /** Maximum delay in milliseconds between retries (default: 5000) */
  maxDelay?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** Maximum jitter in milliseconds to add to backoff delay (default: 100) */
  jitterMax?: number;
}

const DEFAULT_QUERY_OPTIONS: Required<QueryRetryOptions> = {
  maxRetries: 3,
  initialDelay: 100,
  maxDelay: 5000,
  backoffMultiplier: 2,
  jitterMax: 100,
};

// ============================================
// Query Execution with Circuit Breaker
// ============================================

/**
 * Execute a Drizzle query with circuit breaker and retry logic
 *
 * Wraps Drizzle operations with the existing circuit breaker pattern from
 * rds-error-handler.ts, providing automatic retry for transient failures
 * and circuit breaker protection for sustained outages.
 *
 * Circuit Breaker Configuration (from rds-error-handler.ts):
 * - Threshold: 5 consecutive failures before opening
 * - Timeout: 30 seconds before attempting to close
 * - Success Threshold: 2 successes needed to close circuit
 *
 * @param queryFn - Function that performs the Drizzle query
 * @param context - Descriptive name for the operation (used in logging)
 * @param options - Optional retry configuration
 * @returns Promise resolving to the query result
 * @throws Error if circuit breaker is open or all retries exhausted
 *
 * @example
 * ```typescript
 * // Simple select query
 * const users = await executeQuery(
 *   (db) => db.select().from(schema.users).where(eq(schema.users.id, userId)),
 *   "getUserById"
 * );
 *
 * // Insert with transaction
 * const result = await executeQuery(
 *   async (db) => {
 *     return db.insert(schema.users).values({ name: "John" }).returning();
 *   },
 *   "createUser"
 * );
 * ```
 */
export async function executeQuery<T>(
  queryFn: (database: DrizzleDB) => Promise<T>,
  context: string,
  options?: QueryRetryOptions
): Promise<T> {
  const requestId = generateRequestId();
  const timer = startTimer(`drizzle_${context}`);
  const log = createLogger({
    requestId,
    context: "drizzle-client",
    operation: context,
  });

  const opts = { ...DEFAULT_QUERY_OPTIONS, ...options };

  log.debug("Executing Drizzle query", {
    context,
    maxRetries: opts.maxRetries,
  });

  try {
    const result = await executeWithRetry(
      () => queryFn(db),
      context,
      {
        maxRetries: opts.maxRetries,
        initialDelay: opts.initialDelay,
        maxDelay: opts.maxDelay,
        backoffMultiplier: opts.backoffMultiplier,
        jitterMax: opts.jitterMax,
      },
      requestId
    );

    timer({ status: "success" });
    log.debug("Query completed successfully", { context });

    return result;
  } catch (error) {
    timer({ status: "error" });
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorName = error instanceof Error ? error.name : "UnknownError";

    log.error("Query failed after retries", {
      context,
      error: errorMessage,
      errorName,
      circuitState: getCircuitBreakerState().state,
      requestId,
    });
    throw error;
  }
}

// ============================================
// Circuit Breaker Status Utilities
// ============================================

/**
 * Get the current circuit breaker state
 *
 * Useful for monitoring and health checks to determine if the database
 * connection is healthy or in a degraded state.
 *
 * @returns Current circuit breaker state object
 *
 * @example
 * ```typescript
 * const state = getDatabaseCircuitState();
 * if (state.state === "open") {
 *   // Database is temporarily unavailable
 *   return { status: "degraded", message: "Database circuit breaker is open" };
 * }
 * ```
 */
export function getDatabaseCircuitState() {
  return getCircuitBreakerState();
}

/**
 * Reset the circuit breaker to closed state
 *
 * Use with caution - this should only be used for manual intervention
 * after confirming the database is healthy, or in testing scenarios.
 *
 * @example
 * ```typescript
 * // After confirming database recovery
 * resetDatabaseCircuit();
 * ```
 */
export function resetDatabaseCircuit() {
  const log = createLogger({
    context: "drizzle-client",
    operation: "resetCircuit",
  });
  log.info("Manually resetting database circuit breaker");
  resetCircuitBreaker();
}

// ============================================
// Re-exports for Convenience
// ============================================

// Re-export schema for convenience when importing from drizzle-client
export * from "./schema";
