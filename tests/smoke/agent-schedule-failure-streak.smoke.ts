/**
 * Real-PostgreSQL behavioural smoke for the #1890 owner-notice streak query.
 *
 * The decision function that sends the message is trivial — it reads three
 * numbers. Whether a teacher gets one message or one an hour depends entirely
 * on the SQL that produces them, and the unit tests can only assert that
 * query's TEXT. A mistake in the `recent.id > bound.last_success_id` bound or
 * the `BOOL_OR` placement would reproduce the original repeat-message bug with
 * every unit test still green. So this runs the exact exported statement
 * against a real server.
 *
 * It owns only a temp table shadowing `agent_scheduled_runs` for this session
 * and leaves the target database unchanged.
 *
 * Run:
 *   DATABASE_URL='postgresql://postgres:postgres@localhost:5432/aistudio' \
 *     DB_SSL=false bun run test:smoke:schedule-failure-streak
 */

import assert from "node:assert/strict";
import postgres from "postgres";
import {
  FAILURE_STREAK_RUN_LIMIT,
  FAILURE_STREAK_SQL,
  ownerNotifiedSql,
} from "../../infra/lambdas/agent-cron/run-telemetry";
import { scriptLogger as log } from "../../scripts/db/script-logger";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/aistudio";

const OWNER = "owner@psd401.net";
const OTHER_OWNER = "someone-else@psd401.net";
const SCHEDULE = "sched-morning";
const OTHER_SCHEDULE = "sched-evening";

/**
 * The Lambda reaches PostgreSQL through the RDS Data API, which binds `:name`
 * parameters; postgres.js binds `$n`. Translating the two names here is the
 * only difference between what runs in production and what runs below.
 */
const streakQuery = FAILURE_STREAK_SQL.replaceAll(":user_id", "$1").replaceAll(
  ":schedule_id",
  "$2",
);

const stampByFireKey = ownerNotifiedSql({ fireKey: true })
  .replaceAll(":user_id", "$1")
  .replaceAll(":schedule_id", "$2")
  .replaceAll(":fire_key", "$3");
const stampNewestRun = ownerNotifiedSql({ fireKey: false })
  .replaceAll(":user_id", "$1")
  .replaceAll(":schedule_id", "$2");

/** The three columns the aggregate returns, as PostgreSQL names them. */
interface StreakRow {
  failures: number;
  already_notified: boolean;
  newest_error_message: string | null;
}

interface Run {
  status: string;
  /** Immutable occurrence identity, as a real fire carries. */
  fireKey?: string;
  errorMessage?: string | null;
  notified?: boolean;
  /** Days before now. Defaults to recent, inside the 90-day window. */
  ageDays?: number;
}

/** Replace the history, then read the streak the Lambda would read. */
interface Harness {
  given(
    runs: Run[],
    options?: { userId?: string; scheduleId?: string },
  ): Promise<void>;
  streak(): Promise<StreakRow>;
  /** Stamp as the Lambda does, and report how many rows it matched. */
  stamp(fireKey?: string): Promise<number>;
  stampedCount(): Promise<number>;
}

const FAIL: Run = { status: "error", errorMessage: "agent unavailable" };
const SUCCESS: Run = { status: "success" };
const failures = (count: number): Run[] =>
  Array.from({ length: count }, () => FAIL);

/**
 * THE regression. A stamp 27 failures back must still suppress: the original
 * bug read suppression from a fixed page of recent runs, so the stamped run
 * scrolled out of view and the owner was messaged again every page-worth of
 * failures — roughly hourly on a five-minute schedule.
 */
async function pageSizeCannotLoseTheStamp({ given, streak }: Harness) {
  await given([...failures(2), { ...FAIL, notified: true }, ...failures(27)]);
  let result = await streak();
  assert.equal(
    Number(result.failures),
    30,
    "the whole streak is counted, not a page of it",
  );
  assert.equal(
    result.already_notified,
    true,
    "a stamp 27 failures back still suppresses — this is the #1890 regression",
  );
  log.info("30-failure streak with an old stamp: counted 30, suppressed");

  // An unstamped streak of the same length must speak: this is the
  // already-failing-before-the-rule-existed case.
  await given(failures(30));
  result = await streak();
  assert.equal(Number(result.failures), 30);
  assert.equal(
    result.already_notified,
    false,
    "a month-long streak nobody was told about is not silently suppressed",
  );
  log.info("30-failure streak with no stamp: counted 30, speaks");
}

/**
 * The one deliberate exception, pinned: the streak is read over its newest
 * FAILURE_STREAK_RUN_LIMIT runs, so a stamp older than that is out of sight
 * and the owner is reminded once more. A stamp inside the window still
 * suppresses, and the count tops out at the limit rather than overstating.
 */
async function streakPastTheRunLimit({ given, streak }: Harness) {
  const limit = FAILURE_STREAK_RUN_LIMIT;
  await given([...failures(2), { ...FAIL, notified: true }, ...failures(limit)]);
  let result = await streak();
  assert.equal(
    Number(result.failures),
    limit,
    "the count is bounded by the run limit",
  );
  assert.equal(
    result.already_notified,
    false,
    "a stamp older than the run limit is out of sight — the documented reminder",
  );

  await given([
    ...failures(2),
    { ...FAIL, notified: true },
    ...failures(limit - 1),
  ]);
  result = await streak();
  assert.equal(Number(result.failures), limit);
  assert.equal(
    result.already_notified,
    true,
    "a stamp that is still the oldest run inside the limit still suppresses",
  );
  log.info(`past ${limit} runs: an older stamp re-notifies, one inside suppresses`);
}

/** A success bounds the streak, and takes its stamp out of scope with it. */
async function successBoundsTheStreak({ given, streak }: Harness) {
  await given([
    ...failures(5),
    { ...FAIL, notified: true },
    SUCCESS,
    FAIL,
    FAIL,
  ]);
  const result = await streak();
  assert.equal(
    Number(result.failures),
    2,
    "only failures after the newest success count",
  );
  assert.equal(
    result.already_notified,
    false,
    "a success resets the suppression, so the next streak can speak",
  );
  log.info("success between streaks: count reset to 2, suppression cleared");

  // Several successes: the NEWEST one bounds the streak.
  await given([FAIL, SUCCESS, FAIL, SUCCESS, ...failures(3)]);
  assert.equal(Number((await streak()).failures), 3);
  log.info("multiple successes: bounded by the newest");
}

/**
 * `skipped` (a coalesced fire that never ran) and `promoted` (handed to the
 * background job runner) decide nothing: they must not count as failures, and
 * must not end a streak by looking like a success.
 */
async function neutralRunsDecideNothing({ given, streak }: Harness) {
  await given([
    FAIL,
    { status: "skipped" },
    { status: "promoted" },
    FAIL,
    { status: "skipped" },
    FAIL,
  ]);
  let result = await streak();
  assert.equal(
    Number(result.failures),
    3,
    "skipped and promoted runs are not counted as failures",
  );
  log.info("interleaved skipped/promoted: counted 3 real failures");

  await given([
    { ...FAIL, notified: true },
    { status: "skipped" },
    { status: "promoted" },
    FAIL,
  ]);
  result = await streak();
  assert.equal(Number(result.failures), 2);
  assert.equal(
    result.already_notified,
    true,
    "a neutral run between failures does not break the streak or its stamp",
  );
  log.info("neutral runs do not break a streak");

  await given([{ status: "skipped" }, { status: "promoted" }]);
  result = await streak();
  assert.equal(Number(result.failures), 0);
  assert.equal(result.already_notified, false);
  assert.equal(result.newest_error_message, null);
  log.info("only neutral runs: no streak");

  // A deferred post counts: the owner has nothing in hand.
  await given([
    FAIL,
    { status: "deferred", errorMessage: "queued for retry" },
    FAIL,
  ]);
  assert.equal(Number((await streak()).failures), 3);
  log.info("deferred counts toward the streak");
}

/**
 * The newest failure's text is what gets classified, so an authorization
 * failure on the latest run is seen even behind older ordinary failures.
 */
async function newestErrorIsWhatClassifies({ given, streak }: Harness) {
  await given([
    { status: "error", errorMessage: "oldest" },
    { status: "error", errorMessage: "middle" },
    { status: "error", errorMessage: "invalid_grant" },
  ]);
  assert.equal(
    (await streak()).newest_error_message,
    "invalid_grant",
    "classification reads the newest failure, not an arbitrary one",
  );
  log.info("newest error text is returned");

  // A NULL error on the newest run must not surface an older run's text as if
  // it belonged to this failure.
  await given([
    { status: "error", errorMessage: "older text" },
    { status: "error", errorMessage: null },
  ]);
  assert.equal((await streak()).newest_error_message, null);
  log.info("a NULL newest error does not borrow an older one");
}

/**
 * The stamp write is as load-bearing as the read: an UPDATE that matches no
 * row leaves the suppression disengaged and the owner messaged on every later
 * failure — the same bug class from the other end.
 */
async function stampingEngagesSuppression({
  given,
  streak,
  stamp,
  stampedCount,
}: Harness) {
  // By fire key: the exact occurrence, and only it.
  await given([FAIL, FAIL, { ...FAIL, fireKey: "fire-3" }]);
  assert.equal(await stamp("fire-3"), 1, "the stamp matches its own fire");
  assert.equal(await stampedCount(), 1, "and no other run");
  assert.equal(
    (await streak()).already_notified,
    true,
    "stamping is what engages the suppression the read looks for",
  );

  // Idempotent: a repeat stamp matches nothing rather than moving the time.
  assert.equal(await stamp("fire-3"), 0, "a repeat stamp is a no-op");
  assert.equal(await stampedCount(), 1);
  log.info("stamp by fire key: one row, idempotent, suppression engaged");

  // Without a fire key it falls back to the schedule's newest run, which is
  // the row the caller just wrote.
  await given([FAIL, FAIL, FAIL]);
  assert.equal(await stamp(), 1);
  assert.equal(await stampedCount(), 1);
  assert.equal((await streak()).already_notified, true);
  log.info("stamp without a fire key: newest run, suppression engaged");

  // A fire key that is not this schedule's must match nothing.
  await given([FAIL]);
  assert.equal(
    await stamp("fire-belonging-to-another-schedule"),
    0,
    "an unknown fire key stamps nothing",
  );
  assert.equal((await streak()).already_notified, false);
  log.info("stamp with an unknown fire key: no row touched");
}

/**
 * The bound is a number of RUNS, not a stretch of time. Schedule validation
 * sets no maximum interval, so an elapsed-time cutoff let a `rate(100 days)`
 * or annual schedule drop every earlier failure before its next run — its
 * streak stayed 1 forever, and neither the `failing` marker nor the owner
 * notice could ever fire.
 */
async function cadenceDoesNotDecideTheStreak({ given, streak }: Harness) {
  // Three failures 200 days apart: a yearly-ish schedule, well past any
  // sensible time window, and still a streak of three.
  await given([
    { ...FAIL, ageDays: 600 },
    { ...FAIL, ageDays: 400 },
    { ...FAIL, ageDays: 200 },
  ]);
  assert.equal(
    Number((await streak()).failures),
    3,
    "a low-frequency schedule accumulates a streak like any other",
  );
  log.info("failures 200 days apart still streak");

  // And its stamp survives the same distance, so it is told once, not yearly.
  await given([
    { ...FAIL, ageDays: 600, notified: true },
    { ...FAIL, ageDays: 400 },
    { ...FAIL, ageDays: 200 },
  ]);
  assert.equal(
    (await streak()).already_notified,
    true,
    "an old stamp is not aged out of a low-frequency streak",
  );
  log.info("a years-old stamp still suppresses");

  // A success of any age still bounds the streak — the boundary is the last
  // success, not a date.
  await given([
    { ...SUCCESS, ageDays: 500 },
    { ...FAIL, ageDays: 300 },
    { ...FAIL, ageDays: 100 },
  ]);
  assert.equal(Number((await streak()).failures), 2);
  log.info("an old success still bounds an old streak");
}

async function windowAndScoping({ given, streak }: Harness) {

  await given(failures(3), { userId: OTHER_OWNER });
  assert.equal(Number((await streak()).failures), 0);
  await given(failures(3), { scheduleId: OTHER_SCHEDULE });
  assert.equal(Number((await streak()).failures), 0);
  log.info("scoped to one owner and one schedule");

  // An empty history is an empty streak, not an error.
  await given([]);
  const result = await streak();
  assert.equal(Number(result.failures), 0);
  assert.equal(result.already_notified, false);
  assert.equal(result.newest_error_message, null);
  log.info("no history: zero, unnotified, no text");
}

const database = postgres(databaseUrl, {
  ssl: process.env.DB_SSL === "false" ? false : "require",
  max: 1,
});

log.section("Agent schedule failure-streak PostgreSQL smoke");

try {
  await database.begin(async (transaction) => {
    // postgres.js transaction objects keep the Sql tagged-template API at
    // runtime, although TransactionSql omits that call signature in its types.
    const sql = transaction as unknown as postgres.Sql;

    // Mirrors the real table's shape for every column this query reads
    // (migrations 066, 067, 165, 188). A temp table of this name shadows the
    // real one for this session, so the statement under test is unmodified.
    await sql`
      CREATE TEMP TABLE agent_scheduled_runs (
        id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id           VARCHAR(255) NOT NULL,
        schedule_id       VARCHAR(64),
        fire_key          VARCHAR(192),
        status            VARCHAR(32) NOT NULL DEFAULT 'success',
        error_message     TEXT,
        owner_notified_at TIMESTAMPTZ,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    // The production index from migration 188, so the statement runs against
    // the access path it was written for.
    await sql`
      CREATE INDEX ON agent_scheduled_runs
        (user_id, schedule_id, created_at DESC, id DESC)
        WHERE status IN ('success', 'error', 'deferred')
    `;

    const harness: Harness = {
      /** Insert runs oldest-first, as they would actually have arrived. */
      async given(runs, options = {}) {
        await sql`DELETE FROM agent_scheduled_runs`;
        let index = runs.length;
        for (const run of runs) {
          index -= 1;
          // Distinct, strictly increasing timestamps so `id` and `created_at`
          // agree on order, as they do for real fires.
          await sql`
            INSERT INTO agent_scheduled_runs
              (user_id, schedule_id, fire_key, status, error_message,
               owner_notified_at, created_at)
            VALUES (
              ${options.userId ?? OWNER},
              ${options.scheduleId ?? SCHEDULE},
              ${run.fireKey ?? null},
              ${run.status},
              ${run.errorMessage ?? null},
              ${run.notified ? new Date() : null},
              NOW() - make_interval(
                days => ${run.ageDays ?? 0}, mins => ${index}
              )
            )
          `;
        }
      },
      async streak() {
        const [row] = await sql.unsafe(streakQuery, [OWNER, SCHEDULE]);
        return row as unknown as StreakRow;
      },
      async stamp(fireKey) {
        const result = fireKey
          ? await sql.unsafe(stampByFireKey, [OWNER, SCHEDULE, fireKey])
          : await sql.unsafe(stampNewestRun, [OWNER, SCHEDULE]);
        return result.count;
      },
      async stampedCount() {
        const [row] = await sql`
          SELECT COUNT(*)::int AS stamped
          FROM agent_scheduled_runs
          WHERE owner_notified_at IS NOT NULL
        `;
        return Number((row as { stamped: number }).stamped);
      },
    };

    await pageSizeCannotLoseTheStamp(harness);
    await streakPastTheRunLimit(harness);
    await successBoundsTheStreak(harness);
    await neutralRunsDecideNothing(harness);
    await newestErrorIsWhatClassifies(harness);
    await stampingEngagesSuppression(harness);
    await cadenceDoesNotDecideTheStreak(harness);
    await windowAndScoping(harness);

    // Leave nothing behind beyond the temp table, which dies with the session.
    await sql`DELETE FROM agent_scheduled_runs`;
  });

  log.success("Agent schedule failure-streak smoke passed");
} finally {
  await database.end();
}
