/**
 * Next.js Instrumentation Hook
 *
 * Issue #603 - Implements graceful shutdown and connection pool warmup
 * for the postgres.js database driver migration.
 *
 * This file is automatically loaded by Next.js 15 during server startup.
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

/**
 * Graceful shutdown handler for SIGTERM/SIGINT signals
 *
 * ECS sends SIGTERM when stopping containers (with initProcessEnabled: true).
 * This ensures database connections are properly closed before exit.
 */
async function handleShutdown(signal: string): Promise<void> {
  // Dynamic import to avoid loading during build
  const { createLogger } = await import("@/lib/logger");
  const log = createLogger({ context: "instrumentation", operation: "shutdown" });

  log.info(`Received ${signal}, initiating graceful shutdown...`);

  try {
    const { closeDatabase } = await import("@/lib/db/drizzle-client");
    await closeDatabase();
    log.info("Graceful shutdown completed successfully");
    process.exit(0);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error("Error during graceful shutdown", { error: errorMessage });
    process.exit(1);
  }
}

/**
 * Warm up database connection pool on startup
 *
 * This avoids first-request latency spikes (100-500ms) by establishing
 * connections during server initialization instead of on first query.
 *
 * Note: Connection warmup is non-blocking and failures don't prevent startup.
 */
async function warmupConnectionPool(): Promise<void> {
  // Dynamic import to avoid loading during build
  const { createLogger } = await import("@/lib/logger");
  const log = createLogger({ context: "instrumentation", operation: "warmup" });

  try {
    const { validateDatabaseConnection } = await import("@/lib/db/drizzle-client");

    log.info("Warming up database connection pool...");
    const result = await validateDatabaseConnection();

    if (result.success) {
      log.info("Database connection pool warmed up successfully", {
        database: result.config.database,
        maxConnections: result.config.maxConnections,
      });
    } else {
      // Don't fail startup, but log warning for monitoring
      log.warn("Database connection warmup failed - connections will be established on first query", {
        error: result.error,
        database: result.config.database,
      });
    }
  } catch (error) {
    const { createLogger: createLoggerFallback } = await import("@/lib/logger");
    const fallbackLog = createLoggerFallback({ context: "instrumentation" });
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Don't fail startup on warmup errors
    fallbackLog.warn("Database connection warmup error - will retry on first query", {
      error: errorMessage,
    });
  }
}

/**
 * Next.js instrumentation register function
 *
 * Called once when the Next.js server starts. Used to:
 * 1. Register shutdown handlers for graceful connection cleanup
 * 2. Warm up the database connection pool to avoid cold start latency
 *
 * Only runs in Node.js runtime (not Edge runtime or during builds).
 */
export async function register(): Promise<void> {
  // Only run on server runtime, not during build
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Register shutdown handlers
    // Using once() to prevent multiple registrations in development
    process.once("SIGTERM", () => handleShutdown("SIGTERM"));
    process.once("SIGINT", () => handleShutdown("SIGINT"));

    // Warm up connection pool (async, non-blocking)
    // Use setImmediate to not block server startup
    setImmediate(() => {
      warmupConnectionPool().catch((error) => {
        // Silently catch - warmup failures are logged but shouldn't crash
        console.error("Connection pool warmup failed:", error);
      });
    });
  }
}
