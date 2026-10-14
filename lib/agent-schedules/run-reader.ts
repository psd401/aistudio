import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { executeQuery, toPgRows } from "@/lib/db/drizzle-client";
import { agentScheduledRuns } from "@/lib/db/schema";

/**
 * Run statuses that count as a failed run, matching the cron's own notice rule
 * (`infra/lambdas/agent-cron/schedule-failure-notice.ts`). `skipped` (a
 * coalesced fire) and `promoted` (in flight at the job runner) are neither
 * failures nor successes.
 */
const FAILED_RUN_STATUSES = ["error", "deferred"] as const;

/**
 * Statuses that decide a streak at all: a success ends one, a failure extends
 * one. `skipped` (a coalesced fire that never ran) and `promoted` (handed to
 * the background job runner, whose own row carries the outcome) decide
 * neither. Mirrors `STREAK_DECIDING_STATUSES` in
 * `infra/lambdas/agent-cron/run-telemetry.ts`.
 */
const STREAK_DECIDING_STATUSES = ["success", ...FAILED_RUN_STATUSES] as const;

/**
 * How far back a consecutive-failure count looks, in RUNS per schedule —
 * deliberately not in elapsed time.
 *
 * An elapsed-time window makes the count depend on how often a schedule fires.
 * Validation sets no maximum interval, so `rate(100 days)` and an annual cron
 * are both legal; against a 90-day cutoff every earlier failure of such a
 * schedule is already outside the window by the next run, its streak is
 * permanently 1, and it can never be marked `failing`. Counting runs behaves
 * identically for a five-minute schedule and a yearly one, and — applied as a
 * per-schedule LATERAL `LIMIT` rather than a filter on `ROW_NUMBER()` —
 * genuinely stops the index scan rather than discarding rows after reading
 * them. Kept in step with `FAILURE_STREAK_RUN_LIMIT` in
 * `infra/lambdas/agent-cron/run-telemetry.ts`.
 */
export const FAILURE_STREAK_RUN_LIMIT = 500;

/** Consecutive failed runs at which `list` marks a schedule as failing. */
export const FAILING_SCHEDULE_THRESHOLD = 3;

export interface AgentScheduleLastRun {
  createdAt: Date;
  status: string;
  errorMessage: string | null;
}

/** One historical run, as the agent needs to see it to diagnose a failure. */
export interface AgentScheduleRun {
  scheduleId: string | null;
  scheduleName: string | null;
  createdAt: Date;
  status: string;
  errorMessage: string | null;
  latencyMs: number;
}

export interface AgentScheduleRunReader {
  latestBySchedule(
    ownerEmail: string,
    scheduleIds: string[],
  ): Promise<Map<string, AgentScheduleLastRun>>;
  /**
   * Recent runs for the owner, newest first, optionally narrowed to one
   * schedule. Carries `errorMessage` — the reason `list` alone was not enough:
   * it reports a status but not WHY, so an agent asked "why did my nightly job
   * fail" had nothing to answer with (prod 2026-08-06, agent_failures 2580).
   */
  recentForOwner(
    ownerEmail: string,
    options?: { scheduleId?: string; limit?: number },
  ): Promise<AgentScheduleRun[]>;
  /**
   * Consecutive failed runs since each schedule's last success. Schedules with
   * no current streak are absent from the map rather than present with 0, so a
   * caller cannot confuse "no failures" with "not asked about".
   */
  consecutiveFailuresBySchedule(
    ownerEmail: string,
    scheduleIds: string[],
  ): Promise<Map<string, number>>;
}

export class DrizzleAgentScheduleRunReader
  implements AgentScheduleRunReader
{
  async latestBySchedule(
    ownerEmail: string,
    scheduleIds: string[],
  ): Promise<Map<string, AgentScheduleLastRun>> {
    if (scheduleIds.length === 0) return new Map();

    const rows = await executeQuery(
      (db) =>
        db
          .selectDistinctOn([agentScheduledRuns.scheduleId], {
            scheduleId: agentScheduledRuns.scheduleId,
            createdAt: agentScheduledRuns.createdAt,
            status: agentScheduledRuns.status,
            errorMessage: agentScheduledRuns.errorMessage,
          })
          .from(agentScheduledRuns)
          .where(
            and(
              eq(agentScheduledRuns.userId, ownerEmail),
              inArray(agentScheduledRuns.scheduleId, scheduleIds),
            ),
          )
          .orderBy(
            agentScheduledRuns.scheduleId,
            desc(agentScheduledRuns.createdAt),
            desc(agentScheduledRuns.id),
          ),
      "getLatestAgentScheduleRuns",
    );

    const latest = new Map<string, AgentScheduleLastRun>();
    for (const row of rows) {
      if (row.scheduleId === null) continue;
      latest.set(row.scheduleId, {
        createdAt: row.createdAt,
        status: row.status,
        errorMessage: row.errorMessage,
      });
    }
    return latest;
  }

  async consecutiveFailuresBySchedule(
    ownerEmail: string,
    scheduleIds: string[],
  ): Promise<Map<string, number>> {
    if (scheduleIds.length === 0) return new Map();

    // A VALUES list, not an IN list: each id drives its own LATERAL lookup
    // below, which is what makes the per-schedule bound a real one.
    const scheduleRows = sql.join(
      scheduleIds.map((scheduleId) => sql`(${scheduleId})`),
      sql`, `,
    );
    const failedStatuses = sql.join(
      FAILED_RUN_STATUSES.map((status) => sql`${status}`),
      sql`, `,
    );
    // Narrowed inside the LATERAL, not only in the outer filter: `skipped` and
    // `promoted` rows decide nothing, and an owner with contended five-minute
    // schedules accumulates far more of those than real runs — leaving them in
    // would spend the per-schedule run budget on rows that cannot affect the
    // answer.
    const streakDecidingStatuses = sql.join(
      STREAK_DECIDING_STATUSES.map((status) => sql`${status}`),
      sql`, `,
    );
    // The last successful run's id per schedule is the streak boundary, and
    // every failed run after it is in the current streak. `id` is the
    // tiebreaker the rest of this reader already orders by, so two runs
    // recorded in the same second cannot invert the boundary.
    //
    // The bound is applied by a LATERAL `ORDER BY ... LIMIT` per schedule
    // rather than by filtering a `ROW_NUMBER()`. That distinction is the whole
    // point: a window function must process every row of its partition before
    // an outer predicate on its result can apply, so `WHERE recency <= N`
    // reads the owner's entire history and only then discards most of it. The
    // LIMIT inside the LATERAL stops the index scan itself, which is what
    // keeps an owner whose five-minute schedule has been failing for a year
    // from being read whole on every `list` call.
    const result = await executeQuery(
      (db) =>
        db.execute(sql`
          SELECT bounded.schedule_id AS schedule_id,
                 COUNT(*)::int AS failures
          FROM (
            SELECT requested.schedule_id AS schedule_id,
                   recent.id AS id,
                   recent.status AS status,
                   MAX(
                     CASE WHEN recent.status = 'success' THEN recent.id END
                   ) OVER (PARTITION BY requested.schedule_id)
                     AS last_success_id
            FROM (VALUES ${scheduleRows})
                   AS requested(schedule_id)
            CROSS JOIN LATERAL (
              SELECT id, status
              FROM agent_scheduled_runs
              WHERE user_id = ${ownerEmail}
                AND schedule_id = requested.schedule_id
                AND status IN (${streakDecidingStatuses})
              ORDER BY created_at DESC, id DESC
              LIMIT ${FAILURE_STREAK_RUN_LIMIT}
            ) AS recent
          ) AS bounded
          WHERE bounded.status IN (${failedStatuses})
            AND (
              bounded.last_success_id IS NULL
              OR bounded.id > bounded.last_success_id
            )
          GROUP BY bounded.schedule_id
        `),
      "getConsecutiveAgentScheduleFailures",
    );

    const streaks = new Map<string, number>();
    for (const row of toPgRows<{
      schedule_id: string | null;
      failures: number;
    }>(result)) {
      if (typeof row.schedule_id !== "string") continue;
      if (!Number.isFinite(row.failures) || row.failures <= 0) continue;
      streaks.set(row.schedule_id, row.failures);
    }
    return streaks;
  }

  async recentForOwner(
    ownerEmail: string,
    options: { scheduleId?: string; limit?: number } = {},
  ): Promise<AgentScheduleRun[]> {
    // Bounded: this lands in an agent's context window, and an owner with a
    // five-minute schedule accumulates thousands of rows.
    // Floored as well as clamped: this is the last hop before Drizzle's
    // `.limit()`, and a fraction reaching Postgres is a runtime error rather
    // than a smaller page.
    const limit = Math.floor(Math.min(Math.max(1, options.limit ?? 20), 50));
    const conditions = [eq(agentScheduledRuns.userId, ownerEmail)];
    if (options.scheduleId) {
      conditions.push(eq(agentScheduledRuns.scheduleId, options.scheduleId));
    }
    const rows = await executeQuery(
      (db) =>
        db
          .select({
            scheduleId: agentScheduledRuns.scheduleId,
            scheduleName: agentScheduledRuns.scheduleName,
            createdAt: agentScheduledRuns.createdAt,
            status: agentScheduledRuns.status,
            errorMessage: agentScheduledRuns.errorMessage,
            latencyMs: agentScheduledRuns.latencyMs,
          })
          .from(agentScheduledRuns)
          .where(and(...conditions))
          .orderBy(desc(agentScheduledRuns.createdAt), desc(agentScheduledRuns.id))
          .limit(limit),
      "getRecentAgentScheduleRuns",
    );
    return rows.map((row) => ({
      scheduleId: row.scheduleId,
      scheduleName: row.scheduleName,
      createdAt: row.createdAt,
      status: row.status,
      errorMessage: row.errorMessage,
      latencyMs: row.latencyMs,
    }));
  }
}
