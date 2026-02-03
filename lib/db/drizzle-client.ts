/**
 * Drizzle Database Client Wrapper
 *
 * Provides a Drizzle ORM instance configured for direct PostgreSQL connection
 * via postgres.js driver with integrated circuit breaker and retry logic.
 *
 * Issue #603 - Migrate from RDS Data API to Direct PostgreSQL via postgres.js
 *
 * Benefits of postgres.js over RDS Data API:
 * - Native JSONB handling (no stringify workarounds needed)
 * - Full transaction isolation level support
 * - Parallel queries work correctly in transactions
 * - ~10-50ms lower latency per query (TCP vs HTTP)
 * - Connection pooling for efficient resource usage
 *
 * @see https://orm.drizzle.team/docs/get-started-postgresql
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  executeWithRetry,
  getCircuitBreakerState,
  resetCircuitBreaker,
} from "./rds-error-handler";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import * as schema from "./schema";

// ============================================
// PostgreSQL Connection Configuration
// ============================================

/**
 * Build DATABASE_URL from environment variables
 *
 * Supports two configuration modes:
 * 1. DATABASE_URL: Full connection string (preferred for local dev)
 * 2. Individual vars: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
 *
 * For production on ECS, credentials are injected from Secrets Manager
 * at container startup via the getDatabaseUrl() function.
 */
function getDatabaseUrl(): string {
  // Option 1: Direct DATABASE_URL (local dev or pre-constructed URL)
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  // Option 2: Construct from individual components
  const host = process.env.DB_HOST;
  const port = process.env.DB_PORT || "5432";
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const database = process.env.DB_NAME || process.env.RDS_DATABASE_NAME || "aistudio";

  if (host && user && password) {
    return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}?sslmode=require`;
  }

  // Fallback: Check for legacy RDS Data API config (error with migration guidance)
  if (process.env.RDS_SECRET_ARN && process.env.RDS_RESOURCE_ARN) {
    throw new Error(
      "RDS Data API configuration detected but no DATABASE_URL found. " +
      "Issue #603 migrated to postgres.js driver. " +
      "Set DATABASE_URL or DB_HOST/DB_USER/DB_PASSWORD environment variables."
    );
  }

  throw new Error(
    "Database configuration not found. " +
    "Set DATABASE_URL or DB_HOST/DB_USER/DB_PASSWORD environment variables."
  );
}

/**
 * Lazy-initialized postgres.js client instance with connection pooling
 *
 * Connection Pool Sizing Calculation:
 * - Aurora Serverless v2 max_connections: ~600 (for 2 ACU in dev), ~1200+ in prod
 * - Expected ECS tasks: 2-10 (dev) to 4-20 (prod) with auto-scaling
 * - Max connections per task: 20 (configurable via DB_MAX_CONNECTIONS)
 * - Total fleet connections: 40-400 (well within Aurora limits)
 *
 * Timeouts:
 * - idle_timeout: 20s (aggressive cleanup for cost optimization in serverless)
 * - max_lifetime: 3600s (1 hour, supports Aurora credential rotation)
 * - connect_timeout: 10s (fail fast on network issues)
 *
 * Lazy initialization is required because Next.js builds pages statically
 * and the database client should only be created at runtime.
 *
 * @see https://orm.drizzle.team/docs/connect-postgresql
 */
let pgClient: ReturnType<typeof postgres> | null = null;

function getPgClient(): ReturnType<typeof postgres> {
  if (!pgClient) {
    // SSL configuration: required for AWS Aurora, optional for local development
    // Set DB_SSL=false for local PostgreSQL without SSL certificates
    const sslEnabled = process.env.DB_SSL !== "false";

    // SQL_LOGGING enables verbose query logging (opt-in for security)
    // Set SQL_LOGGING=true to see all queries in console
    const sqlLoggingEnabled = process.env.SQL_LOGGING === "true";

    pgClient = postgres(getDatabaseUrl(), {
      max: parseInt(process.env.DB_MAX_CONNECTIONS || "20", 10),
      idle_timeout: parseInt(process.env.DB_IDLE_TIMEOUT || "20", 10),
      connect_timeout: parseInt(process.env.DB_CONNECT_TIMEOUT || "10", 10),
      max_lifetime: 60 * 60, // 1 hour - forces reconnection for credential rotation
      prepare: true, // Enable prepared statements for performance
      ssl: sslEnabled ? "require" : false, // SSL required for AWS, optional for local dev
      onnotice: () => {}, // Suppress PostgreSQL notices
      debug: sqlLoggingEnabled, // Opt-in via SQL_LOGGING=true (default: off)
    });
  }
  return pgClient;
}

// ============================================
// Drizzle Instance (lazy-loaded)
// ============================================

/**
 * Drizzle ORM instance configured for postgres.js driver
 *
 * Key improvements over RDS Data API:
 * - Native JSONB: Pass objects directly, no JSON.stringify needed
 * - Transactions: Full isolation level support (serializable, etc.)
 * - Parallel queries: Promise.all() works correctly in transactions
 *
 * Note: This is lazy-initialized to support Next.js static builds.
 */
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

/**
 * Get the Drizzle database instance (lazy-initialized)
 *
 * Use this function for explicit initialization control (e.g., in tests)
 * or when you need to ensure the database is initialized before accessing it.
 *
 * For most use cases, use the `db` export directly which is a lazy Proxy.
 *
 * @returns Drizzle database instance with schema
 * @throws Error if database URL is not configured
 */
export function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (!_db) {
    _db = drizzle(getPgClient(), { schema });
  }
  return _db;
}

/**
 * Drizzle database instance - lazily initialized on first property access
 *
 * This is a Proxy that initializes the postgres.js connection pool on first
 * property access. Use this for all normal database operations.
 *
 * IMPORTANT: Initialization errors will be thrown on first database operation.
 *
 * For testing or explicit initialization, use getDb() directly.
 *
 * @example
 * ```typescript
 * // Normal usage - db is initialized on first query
 * const users = await db.select().from(usersTable);
 *
 * // For explicit initialization control
 * const database = getDb();
 * ```
 */
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_, prop) {
    // Use unknown intermediate cast to avoid type inference issues
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

/**
 * Type alias for the Drizzle database instance
 * Useful for typing function parameters and return values
 */
export type DrizzleDB = typeof db;

// ============================================
// Result Type Helpers
// ============================================

/**
 * Type-safe helper for postgres.js raw query results
 *
 * postgres.js returns results directly as array-like objects (no .rows property)
 * unlike the RDS Data API which returned { rows: [...] }. This helper provides
 * a consistent, type-safe way to handle raw SQL results.
 *
 * Issue #603: Consolidates the repeated `as unknown as T[]` pattern across the codebase.
 *
 * @param result - Raw result from postgres.js query
 * @returns Typed array of rows
 * @throws Error if result is not a valid array-like object
 *
 * @example
 * ```typescript
 * const result = await executeQuery(
 *   (db) => db.execute(sql`SELECT id, name FROM users WHERE active = true`),
 *   "getActiveUsers"
 * );
 * const users = toPgRows<{ id: number; name: string }>(result);
 * ```
 */
export function toPgRows<T>(result: unknown): T[] {
  if (result === null || result === undefined) {
    return [];
  }

  // postgres.js results are array-like with numeric indices
  if (typeof result !== "object") {
    throw new TypeError(
      `Invalid postgres.js result format: expected array-like object, got ${typeof result}`
    );
  }

  // Handle both true arrays and array-like postgres.js results
  if (Array.isArray(result)) {
    return result as T[];
  }

  // postgres.js results have a length property and numeric indices
  if ("length" in result && typeof (result as { length: unknown }).length === "number") {
    return Array.from(result as ArrayLike<T>);
  }

  throw new TypeError(
    "Invalid postgres.js result format: expected array-like object with length property"
  );
}

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
// Transaction Execution with Circuit Breaker
// ============================================

/**
 * Transaction options for configuring isolation level and access mode
 *
 * ✅ FULLY SUPPORTED with postgres.js driver (Issue #603 migration)
 *
 * These options now work correctly, unlike the previous RDS Data API driver.
 */
export interface TransactionOptions {
  /**
   * Transaction isolation level
   * - "read uncommitted": Allows dirty reads (rarely used)
   * - "read committed": Default PostgreSQL level
   * - "repeatable read": Consistent reads within transaction
   * - "serializable": Full ACID isolation (strictest)
   */
  isolationLevel?:
    | "read uncommitted"
    | "read committed"
    | "repeatable read"
    | "serializable";
  /** Access mode for the transaction */
  accessMode?: "read only" | "read write";
  /** Whether to use deferrable mode (only for serializable read-only) */
  deferrable?: boolean;
}

/**
 * Execute a Drizzle transaction with circuit breaker and retry logic
 *
 * Wraps Drizzle transactions with the existing circuit breaker pattern from
 * rds-error-handler.ts, providing automatic retry for transient failures
 * and circuit breaker protection for sustained outages.
 *
 * Transactions are automatically rolled back on error. This is the recommended
 * way to perform multi-statement operations that must succeed or fail atomically.
 *
 * **TRANSACTION PATTERN (Still recommended):**
 * ALWAYS use executeTransaction() directly. NEVER nest db.transaction() inside executeQuery().
 *
 * ❌ WRONG: executeQuery((db) => db.transaction(async (tx) => { ... }))
 * ✅ CORRECT: executeTransaction(async (tx) => { ... })
 *
 * **✅ postgres.js IMPROVEMENTS (Issue #603):**
 * - Transaction options (isolationLevel, accessMode, deferrable) are NOW SUPPORTED
 * - Parallel queries work correctly inside transactions (Promise.all() is safe)
 * - No more parameter binding offset errors
 *
 * **IMPORTANT - Side Effect Warning:**
 * The retry mechanism will re-execute the ENTIRE transaction function on transient
 * failures. Transaction functions MUST be idempotent and should ONLY perform database
 * operations. Do NOT include side effects that could be duplicated on retry:
 * - ❌ Sending emails or notifications
 * - ❌ Calling external APIs
 * - ❌ Writing to S3 or other external storage
 * - ❌ Publishing messages to queues
 * - ✅ Only database operations via the transaction context (tx)
 *
 * If you need to perform side effects, do them AFTER the transaction completes
 * successfully, not inside the transaction function.
 *
 * @param transactionFn - Function that performs operations within the transaction
 * @param context - Descriptive name for the operation (used in logging)
 * @param options - Optional retry and transaction configuration
 * @returns Promise resolving to the transaction result
 * @throws Error if circuit breaker is open, all retries exhausted, or transaction fails
 *
 * @example
 * ```typescript
 * // Multi-table update with automatic rollback on failure
 * const result = await executeTransaction(
 *   async (tx) => {
 *     // Delete old roles
 *     await tx.delete(userRoles).where(eq(userRoles.userId, userId));
 *
 *     // Insert new roles
 *     await tx.insert(userRoles).values(
 *       roleIds.map(roleId => ({ userId, roleId }))
 *     );
 *
 *     // ✅ NEW: Parallel queries now work correctly!
 *     const [users, settings] = await Promise.all([
 *       tx.select().from(usersTable).where(eq(usersTable.id, userId)),
 *       tx.select().from(settingsTable).where(eq(settingsTable.userId, userId)),
 *     ]);
 *
 *     return true;
 *   },
 *   "updateUserRoles",
 *   { isolationLevel: "serializable" } // ✅ NOW SUPPORTED
 * );
 *
 * // Side effects AFTER transaction succeeds
 * await sendNotificationEmail(userId, "Roles updated");
 * ```
 */
export async function executeTransaction<T>(
  transactionFn: (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0]
  ) => Promise<T>,
  context: string,
  options?: QueryRetryOptions & TransactionOptions
): Promise<T> {
  const requestId = generateRequestId();
  const timer = startTimer(`drizzle_tx_${context}`);
  const log = createLogger({
    requestId,
    context: "drizzle-client",
    operation: `tx_${context}`,
  });

  const opts = { ...DEFAULT_QUERY_OPTIONS, ...options };

  log.debug("Starting Drizzle transaction", {
    context,
    maxRetries: opts.maxRetries,
    isolationLevel: opts.isolationLevel,
  });

  try {
    const result = await executeWithRetry(
      async () => {
        // postgres.js driver supports full PostgreSQL transaction options
        const txOptions: {
          isolationLevel?: typeof opts.isolationLevel;
          accessMode?: typeof opts.accessMode;
          deferrable?: boolean;
        } = {};

        if (opts.isolationLevel) {
          txOptions.isolationLevel = opts.isolationLevel;
        }
        if (opts.accessMode) {
          txOptions.accessMode = opts.accessMode;
        }
        if (opts.deferrable !== undefined) {
          txOptions.deferrable = opts.deferrable;
        }

        // Pass transaction options if any were specified
        if (Object.keys(txOptions).length > 0) {
          return await db.transaction(transactionFn, txOptions);
        }
        return await db.transaction(transactionFn);
      },
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
    log.debug("Transaction completed successfully", { context });

    return result;
  } catch (error) {
    timer({ status: "error" });
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorName = error instanceof Error ? error.name : "UnknownError";

    log.error("Transaction failed after retries", {
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
// Database Connection Validation
// ============================================

/**
 * Validate database connection by executing a simple query
 *
 * Used for health checks to verify:
 * - Database URL is configured
 * - Connection pool is healthy
 * - Database is accessible and responding
 *
 * @returns Object with success status and diagnostic information
 */
export async function validateDatabaseConnection(): Promise<{
  success: boolean;
  message: string;
  config: {
    hasDatabaseUrl: boolean;
    hasDbHost: boolean;
    maxConnections: string;
    database: string;
  };
  error?: string;
}> {
  const log = createLogger({ context: "validateDatabaseConnection" });

  const config = {
    hasDatabaseUrl: !!process.env.DATABASE_URL,
    hasDbHost: !!process.env.DB_HOST,
    maxConnections: process.env.DB_MAX_CONNECTIONS || "20",
    database: process.env.DB_NAME || process.env.RDS_DATABASE_NAME || "aistudio",
  };

  try {
    log.info("Validating database connection", { database: config.database });

    // Execute simple query to test connectivity
    // postgres.js returns the result array directly (no .rows property)
    const result = await executeQuery(
      (database) => database.execute(sql`SELECT 1 as test`),
      "validateConnection"
    );

    // postgres.js returns result as an array-like object
    if (result && Array.isArray(result) && result.length > 0) {
      log.info("Database connectivity test passed");
      return {
        success: true,
        message: "Database connection validated successfully (postgres.js)",
        config,
      };
    }

    throw new Error("Unexpected test query result");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    log.error("Database validation failed", { error: errorMessage });

    return {
      success: false,
      message: "Database connection validation failed",
      config,
      error: errorMessage,
    };
  }
}

// ============================================
// Graceful Shutdown
// ============================================

/**
 * Close database connection pool
 *
 * Call this during graceful shutdown (e.g., ECS SIGTERM) to ensure
 * all connections are properly closed before the process exits.
 *
 * @example
 * ```typescript
 * // In instrumentation.ts or custom server
 * process.on('SIGTERM', async () => {
 *   await closeDatabase();
 *   process.exit(0);
 * });
 * ```
 */
export async function closeDatabase(): Promise<void> {
  const log = createLogger({ context: "closeDatabase" });
  if (pgClient) {
    log.info("Closing database connection pool");
    await pgClient.end({ timeout: 5 }); // 5 second timeout
    pgClient = null;
    _db = null;
    log.info("Database connection pool closed");
  } else {
    log.info("Database connection pool was not initialized, skipping close");
  }
}

// ============================================
// Re-exports for Convenience
// ============================================

// Re-export schema for convenience when importing from drizzle-client
export * from "./schema";
