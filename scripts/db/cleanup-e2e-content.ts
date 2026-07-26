/**
 * Prune accumulated E2E-created content rows from the LOCAL dev database.
 *
 * The authenticated Playwright suite (scripts/test/e2e-local.sh) creates probe
 * documents/artifacts on every run ("e2e archived probe …", "Quarterly plan
 * <token>", …). Specs delete their own fixtures on the happy path, but failed
 * or interrupted runs leave rows behind, and the shared local database
 * accumulates hundreds of them over time — which slows list views and widens
 * timing races in the very specs the rows came from. CI is unaffected (it runs
 * against a fresh database); this is local-only hygiene.
 *
 * Usage:
 *   bun run db:cleanup:e2e                 # DRY RUN — lists what would be deleted
 *   bun run db:cleanup:e2e -- --yes        # actually delete
 *   bun run db:cleanup:e2e -- --yes --min-age-minutes 5
 *
 * Safety properties:
 *   - LOCAL ONLY: refuses any DATABASE_URL whose host is not
 *     localhost/127.0.0.1/::1 (Aurora and container-perspective URLs are
 *     rejected with a hint). Writing to shared/AWS databases from scripts is
 *     off-limits.
 *   - DRY RUN by default; deletion requires the explicit --yes flag.
 *   - AGE GUARD: only rows older than --min-age-minutes (default 60) are
 *     touched, so a cleanup can never race a currently-running suite's live
 *     probes.
 *   - PATTERN-SCOPED: matches only the title shapes the specs generate —
 *     "e2e …"/"E2E …" prefixes and the known "<Name> <run-token>" forms where
 *     the token is runToken()'s 13+ digit timestamp+random suffix. Anchored so
 *     a human's "Dashboard ideas" doc can never match.
 *   - SEED-SAFE: the reference fixtures (tests/e2e/fixtures/*.sql) use fixed
 *     UUIDs under the a7100000-… prefix and are excluded regardless of title
 *     (none currently collide with the patterns; the exclusion is insurance).
 *
 * Deleting content_objects rows cascades to versions, comments, publications,
 * visibility grants, assets, embed/index links, and doc state (all children
 * declare ON DELETE CASCADE), so no orphan rows are left behind.
 *
 * Exit codes: 0 — success (including "nothing to delete"); 2 — refused or failed.
 */

import postgres from "postgres";
import { scriptLogger as log } from "./script-logger";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/aistudio";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Title shapes the E2E specs generate. Keep in sync with tests/e2e/*.spec.ts. */
const TITLE_PREFIXES = ["e2e %", "E2E %"] as const;
const TOKENED_TITLE_REGEX =
  "^(Quarterly plan|Dashboard|Bulk probe [0-9]+|Comments probe|Cover probe|Sync probe|OAuth PKCE e2e) [0-9]{12,}$";

/** Seeded reference fixtures (tests/e2e/fixtures/*.sql) — never deleted. */
const FIXTURE_ID_PREFIX = "a7100000-%";

/**
 * Graph nodes created by the decision/graph E2E specs. Every node those specs
 * create carries an "E2E-<TAG>-<Date.now()>" token in its name (decision text
 * AND decidedBy actor names) — plus the graph-admin spec's hyphen-less
 * "E2EGRAPH<Date.now()>" form — so the anchored tag+timestamp shape is safe to
 * match on name alone across node types. Accumulation here breaks the semantic
 * search spec directly: each run adds a near-identical "zeppelin" decision, and
 * the fresh one must beat all its prior twins into the top-25 similarity
 * window — at ~100 twins it reliably loses (observed 2026-07-26).
 */
const GRAPH_E2E_NAME_REGEX = "(E2E-[A-Z]+-|E2EGRAPH)[0-9]{12,}";

interface CandidateRow {
  id: string;
  title: string;
  status: string;
  /**
   * Selected as ::text — `created_at` is `timestamp without time zone` (UTC
   * wall-clock), and letting the driver parse it into a JS Date re-interprets
   * it in the machine's local zone, shifting every printed time by the UTC
   * offset. The SQL age-guard comparison is unaffected (it never leaves the DB).
   */
  created_at: string;
}

function parseArgs(argv: string[]): { yes: boolean; minAgeMinutes: number } {
  let yes = false;
  let minAgeMinutes = 60;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes") yes = true;
    else if (a === "--min-age-minutes") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) {
        log.error(`--min-age-minutes requires a non-negative number, got: ${argv[i]}`);
        process.exit(2);
      }
      minAgeMinutes = v;
    } else if (a === "--help" || a === "-h") {
      log.info(
        "Usage: bun scripts/db/cleanup-e2e-content.ts [--yes] [--min-age-minutes N]"
      );
      process.exit(0);
    } else {
      log.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return { yes, minAgeMinutes };
}

async function main(): Promise<void> {
  const { yes, minAgeMinutes } = parseArgs(process.argv.slice(2));

  log.section("AI Studio — local E2E content cleanup");

  let host: string;
  try {
    host = new URL(DATABASE_URL).hostname;
  } catch {
    log.error("DATABASE_URL is not a parseable URL — refusing.");
    process.exit(2);
  }
  if (!LOCAL_HOSTS.has(host)) {
    log.error(
      `Refusing: DATABASE_URL host "${host}" is not local. This script only ` +
        "prunes the local Docker postgres. If you meant the local DB, run with:\n" +
        "  DATABASE_URL=postgresql://postgres:postgres@localhost:5432/aistudio bun run db:cleanup:e2e"
    );
    process.exit(2);
  }

  log.info("Database", { url: DATABASE_URL.replace(/:\/\/.*@/, "://*****@") });
  log.info(yes ? "Mode: DELETE" : "Mode: DRY RUN (pass --yes to delete)", {
    minAgeMinutes,
  });

  const sql = postgres(DATABASE_URL, {
    ssl: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  try {
    const candidates = await sql<CandidateRow[]>`
      SELECT id, title, status, created_at::text AS created_at
        FROM content_objects
       WHERE (
               title LIKE ${TITLE_PREFIXES[0]}
            OR title LIKE ${TITLE_PREFIXES[1]}
            OR title ~ ${TOKENED_TITLE_REGEX}
             )
         AND id::text NOT LIKE ${FIXTURE_ID_PREFIX}
         AND created_at < now() - make_interval(mins => ${minAgeMinutes})
       ORDER BY created_at
    `;

    const graphCandidates = await sql<{ id: string }[]>`
      SELECT id
        FROM graph_nodes
       WHERE name ~ ${GRAPH_E2E_NAME_REGEX}
         AND created_at < now() - make_interval(mins => ${minAgeMinutes})
    `;

    if (candidates.length === 0 && graphCandidates.length === 0) {
      log.success("Nothing to clean up — no E2E-pattern rows older than the age guard.");
      return;
    }

    const byStatus = new Map<string, number>();
    for (const c of candidates) {
      byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1);
    }
    log.info(`Matched ${candidates.length} content_objects rows`, {
      byStatus: Object.fromEntries(byStatus),
      oldestUtc: candidates[0]?.created_at,
      newestUtc: candidates.at(-1)?.created_at,
    });
    for (const c of candidates.slice(0, 15)) {
      log.info(`  ${c.created_at} UTC  [${c.status}]  ${c.title}`);
    }
    if (candidates.length > 15) {
      log.info(`  … and ${candidates.length - 15} more`);
    }

    log.info(
      `Matched ${graphCandidates.length} graph_nodes rows (E2E-tagged decision/graph fixtures)`
    );

    if (!yes) {
      log.info("Dry run — nothing deleted. Re-run with --yes to delete these rows.");
      return;
    }

    if (candidates.length > 0) {
      const ids = candidates.map((c) => c.id);

      // Repository items the candidates were indexed into: captured BEFORE the
      // content delete cascades away the content_index_links that reference
      // them (repository_items itself does NOT hang off content_objects, so
      // the cascade would orphan these rows and their chunks silently).
      const linkedRepoItems = await sql<{ repository_item_id: number }[]>`
        SELECT DISTINCT repository_item_id
          FROM content_index_links
         WHERE object_id IN ${sql(ids)}
      `;

      // Mirror contentService.delete: navigation_items.content_object_id is
      // ON DELETE NO ACTION and unpublish only soft-hides the row, so debris
      // from a published-then-abandoned probe would otherwise reject the whole
      // batch delete with an FK violation.
      await sql`
        DELETE FROM navigation_items
         WHERE content_object_id IN ${sql(ids)}
      `;

      const deleted = await sql<{ id: string }[]>`
        DELETE FROM content_objects
         WHERE id IN ${sql(ids)}
         RETURNING id
      `;
      log.success(
        `Deleted ${deleted.length} content_objects rows (children removed via ON DELETE CASCADE).`
      );

      // Now-unreferenced repository items from the captured set (an item still
      // linked by any SURVIVING content is kept); chunks/versions cascade.
      if (linkedRepoItems.length > 0) {
        const orphaned = await sql<{ id: number }[]>`
          DELETE FROM repository_items ri
           WHERE ri.id IN ${sql(linkedRepoItems.map((r) => r.repository_item_id))}
             AND NOT EXISTS (
                   SELECT 1 FROM content_index_links l
                    WHERE l.repository_item_id = ri.id
                 )
           RETURNING ri.id
        `;
        if (orphaned.length > 0) {
          log.success(
            `Deleted ${orphaned.length} orphaned repository_items rows (chunks/versions cascade).`
          );
        }
      }
    }

    if (graphCandidates.length > 0) {
      const deletedGraph = await sql<{ id: string }[]>`
        DELETE FROM graph_nodes
         WHERE id IN ${sql(graphCandidates.map((g) => g.id))}
         RETURNING id
      `;
      log.success(
        `Deleted ${deletedGraph.length} graph_nodes rows (edges removed via ON DELETE CASCADE).`
      );
    }
  } finally {
    await sql.end();
  }
}

main().catch((e: unknown) => {
  log.error("Cleanup failed", {
    error: e instanceof Error ? e.message : String(e),
  });
  process.exit(2);
});
