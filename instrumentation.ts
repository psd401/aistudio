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
    // Flush live Atrium collab rooms BEFORE the DB pool closes. The collab server
    // (#1051) runs in this same process but from a separate esbuild bundle in prod
    // (voice-server.js), so it cannot be imported here directly — it registers a
    // process-global flush hook (collab-server.ts) that we await. Best-effort: a
    // flush failure is logged and must not block the DB-pool teardown / exit.
    const flushCollab = globalThis.__atriumCollabShutdown;
    if (typeof flushCollab === "function") {
      try {
        await flushCollab();
      } catch (collabError) {
        log.warn("Collab shutdown flush failed", {
          error: collabError instanceof Error ? collabError.message : String(collabError),
        });
      }
    }

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
 * Sync the capability manifest to the database on startup.
 *
 * Issue #923 - registers code-managed capabilities (lib/capabilities/manifest.ts)
 * so adding a capability requires only a manifest entry + restart, no SQL
 * migration. The sync is idempotent and holds a per-transaction advisory lock so
 * multiple replicas booting at once serialize safely. Non-blocking: failures are
 * logged and never prevent server startup (the previous boot's rows remain).
 */
async function syncCapabilities(): Promise<void> {
  const { createLogger } = await import("@/lib/logger");
  const log = createLogger({
    context: "instrumentation",
    operation: "capabilitySync",
  });

  try {
    const { syncCapabilityManifest } = await import("@/lib/capabilities/sync");
    const result = await syncCapabilityManifest();
    log.info("Capability manifest synced on startup", {
      inserted: result.inserted.length,
      updated: result.updated.length,
      deactivated: result.deactivated.length,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Don't fail startup on sync errors.
    log.warn("Capability manifest sync failed on startup", {
      error: errorMessage,
    });
  }
}

/**
 * Sync the tool catalog manifest to the database on startup.
 *
 * Issue #924 - registers code-defined tools (lib/tools/catalog/manifest.ts) into
 * the tool_catalog table so adding a tool requires only a manifest entry +
 * restart, no SQL migration. Idempotent, advisory-locked for safe concurrent
 * replica boots. Non-blocking: failures are logged and never prevent startup.
 */
async function syncToolCatalog(): Promise<void> {
  const { createLogger } = await import("@/lib/logger");
  const log = createLogger({
    context: "instrumentation",
    operation: "toolCatalogSync",
  });

  try {
    const { syncToolCatalogManifest } = await import(
      "@/lib/tools/catalog/sync"
    );
    const result = await syncToolCatalogManifest();
    log.info("Tool catalog manifest synced on startup", {
      inserted: result.inserted.length,
      updated: result.updated.length,
      deactivated: result.deactivated.length,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Don't fail startup on sync errors.
    log.warn("Tool catalog manifest sync failed on startup", {
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
 * 3. Sync the code capability manifest into the database (#923)
 * 4. Sync the code tool catalog manifest into the database (#924)
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
      // warmupConnectionPool already logs errors internally
      // Empty catch prevents unhandled rejection without redundant logging
      warmupConnectionPool().catch(() => {
        // Errors already logged in warmupConnectionPool
      });
    });

    // Sync capability manifest (async, non-blocking). Dispatched after the
    // warmup callback in registration order; the connection pool initializes
    // lazily on the sync's first query if warmup hasn't completed yet. Failures
    // are logged inside syncCapabilities and never block startup.
    setImmediate(() => {
      syncCapabilities().catch(() => {
        // Errors already logged in syncCapabilities
      });
    });

    // Sync tool catalog manifest (async, non-blocking). Same dispatch pattern as
    // the capability sync; uses a distinct advisory lock so the two boot syncs do
    // not serialize against each other. Failures are logged inside
    // syncToolCatalog and never block startup.
    setImmediate(() => {
      syncToolCatalog().catch(() => {
        // Errors already logged in syncToolCatalog
      });
    });
  }
}
