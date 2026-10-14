/**
 * Real-PostgreSQL behavioural smoke for the `failing` marker's streak count
 * (#1890) — the sibling of `agent-schedule-failure-streak.smoke.ts`.
 *
 * `consecutiveFailuresBySchedule` answers the same question as the cron's
 * statement but for every one of an owner's schedules at once, so it is a
 * second, independently-written query with the same semantics. It is what
 * decides `failing: true`, which is the only signal the agent sees. Asserting
 * it through the REAL reader rather than a mocked one is the point: the
 * service tests inject a fake, so a mistake in this SQL would be invisible to
 * every one of them.
 *
 * Unlike its sibling it cannot use a temp table — the reader goes through the
 * app's Drizzle client — so it writes rows under a synthetic owner address
 * that belongs to nothing else and removes them in `finally`.
 *
 * Run:
 *   DATABASE_URL='postgresql://postgres:postgres@localhost:5432/aistudio' \
 *     DB_SSL=false bun run test:smoke:schedule-failing-marker
 */

import assert from "node:assert/strict";
import postgres from "postgres";
import {
  DrizzleAgentScheduleRunReader,
  FAILING_SCHEDULE_THRESHOLD,
} from "../../lib/agent-schedules/run-reader";
import { scriptLogger as log } from "../../scripts/db/script-logger";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/aistudio";

/** Belongs to nothing else, so cleanup can key on it safely. */
const OWNER = "smoke-1890-failing-marker@invalid.test";
const OTHER_OWNER = "smoke-1890-other@invalid.test";
const MORNING = "smoke-1890-morning";
const EVENING = "smoke-1890-evening";

interface Run {
  scheduleId: string;
  status: string;
  /** Days before now, so cadence can be varied. */
  ageDays?: number;
  userId?: string;
}

const database = postgres(databaseUrl, {
  ssl: process.env.DB_SSL === "false" ? false : "require",
  max: 1,
});
const reader = new DrizzleAgentScheduleRunReader();

async function removeSmokeRows(): Promise<void> {
  await database`
    DELETE FROM agent_scheduled_runs
    WHERE user_id IN (${OWNER}, ${OTHER_OWNER})
  `;
}

/** Replace the history, inserting oldest-first as fires actually arrive. */
async function given(runs: Run[]): Promise<void> {
  await removeSmokeRows();
  let index = runs.length;
  for (const run of runs) {
    index -= 1;
    await database`
      INSERT INTO agent_scheduled_runs
        (user_id, schedule_id, session_id, status, created_at)
      VALUES (
        ${run.userId ?? OWNER},
        ${run.scheduleId},
        ${`smoke-session-${run.scheduleId}`},
        ${run.status},
        NOW() - make_interval(days => ${run.ageDays ?? 0}, mins => ${index})
      )
    `;
  }
}

async function streaks(): Promise<Map<string, number>> {
  return reader.consecutiveFailuresBySchedule(OWNER, [MORNING, EVENING]);
}

const fail = (scheduleId: string, ageDays?: number): Run => ({
  scheduleId,
  status: "error",
  ...(ageDays === undefined ? {} : { ageDays }),
});
const ok = (scheduleId: string): Run => ({ scheduleId, status: "success" });

let failed = false;

log.section("Agent schedule failing-marker PostgreSQL smoke");

try {
  // ---------------------------------------------------------------------
  // Each schedule is counted on its own, and a success bounds each.
  // ---------------------------------------------------------------------
  await given([
    fail(MORNING),
    fail(MORNING),
    fail(MORNING),
    fail(EVENING),
    ok(EVENING),
    fail(EVENING),
  ]);
  let result = await streaks();
  assert.equal(result.get(MORNING), 3, "the morning schedule's own streak");
  assert.equal(
    result.get(EVENING),
    1,
    "the evening schedule's streak is bounded by its own success, not the other's",
  );
  log.info("per-schedule streaks counted independently");

  // A schedule with no current streak is ABSENT, not present with 0, so a
  // caller cannot confuse "no failures" with "not asked about".
  await given([ok(MORNING), fail(EVENING), fail(EVENING)]);
  result = await streaks();
  assert.equal(result.has(MORNING), false, "a healthy schedule is absent");
  assert.equal(result.get(EVENING), 2);
  log.info("a healthy schedule is absent from the map");

  // ---------------------------------------------------------------------
  // The threshold the marker uses, against real rows.
  // ---------------------------------------------------------------------
  await given([fail(MORNING), fail(MORNING)]);
  assert.ok(
    (await streaks()).get(MORNING)! < FAILING_SCHEDULE_THRESHOLD,
    "two failures are below the marker threshold",
  );
  await given([fail(MORNING), fail(MORNING), fail(MORNING)]);
  assert.ok(
    (await streaks()).get(MORNING)! >= FAILING_SCHEDULE_THRESHOLD,
    "three failures reach it",
  );
  log.info(`threshold of ${FAILING_SCHEDULE_THRESHOLD} confirmed on real rows`);

  // ---------------------------------------------------------------------
  // Neutral statuses decide nothing here either.
  // ---------------------------------------------------------------------
  await given([
    fail(MORNING),
    { scheduleId: MORNING, status: "skipped" },
    { scheduleId: MORNING, status: "promoted" },
    fail(MORNING),
  ]);
  assert.equal(
    (await streaks()).get(MORNING),
    2,
    "skipped and promoted neither count nor break the streak",
  );
  log.info("neutral statuses decide nothing");

  // A deferred post counts: the owner has nothing in hand.
  await given([
    fail(MORNING),
    { scheduleId: MORNING, status: "deferred" },
    fail(MORNING),
  ]);
  assert.equal((await streaks()).get(MORNING), 3);
  log.info("deferred counts toward the marker");

  // ---------------------------------------------------------------------
  // Cadence does not decide the count. An elapsed-time bound let a
  // low-frequency schedule drop every earlier failure before its next run, so
  // its streak stayed 1 and it could never be marked failing.
  // ---------------------------------------------------------------------
  await given([fail(MORNING, 600), fail(MORNING, 400), fail(MORNING, 200)]);
  assert.equal(
    (await streaks()).get(MORNING),
    3,
    "failures 200 days apart still make a streak",
  );
  log.info("a low-frequency schedule still reaches the marker");

  // A success of any age still bounds it: the boundary is the last success,
  // not a date.
  await given([
    { scheduleId: MORNING, status: "success", ageDays: 500 },
    fail(MORNING, 300),
    fail(MORNING, 100),
  ]);
  assert.equal((await streaks()).get(MORNING), 2);
  log.info("an old success still bounds an old streak");

  // ---------------------------------------------------------------------
  // Another owner's identically-named schedule is invisible.
  // ---------------------------------------------------------------------
  await given([
    { ...fail(MORNING), userId: OTHER_OWNER },
    { ...fail(MORNING), userId: OTHER_OWNER },
    { ...fail(MORNING), userId: OTHER_OWNER },
    fail(EVENING),
  ]);
  result = await streaks();
  assert.equal(result.has(MORNING), false, "another owner's rows are not read");
  assert.equal(result.get(EVENING), 1);
  log.info("scoped to this owner");

  // An owner with no rows at all, and an empty request, are both fine.
  await removeSmokeRows();
  assert.equal((await streaks()).size, 0);
  assert.equal((await reader.consecutiveFailuresBySchedule(OWNER, [])).size, 0);
  log.info("no rows and no schedules both read as no streaks");

  log.success("Agent schedule failing-marker smoke passed");
} catch (error) {
  // Caught, not left to propagate, because the exit below is unconditional:
  // the app's Drizzle pool holds the event loop open, so this script has to
  // end itself. An earlier version exited 0 from `finally` and so reported
  // success on a failed assertion — a smoke test that cannot fail.
  log.error(
    `Agent schedule failing-marker smoke FAILED: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }`,
  );
  failed = true;
} finally {
  await removeSmokeRows();
  await database.end();
  // The app's Drizzle pool keeps the process alive otherwise.
  process.exit(failed ? 1 : 0);
}
