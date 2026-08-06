import { and, desc, eq, inArray } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { agentScheduledRuns } from "@/lib/db/schema";

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

  async recentForOwner(
    ownerEmail: string,
    options: { scheduleId?: string; limit?: number } = {},
  ): Promise<AgentScheduleRun[]> {
    // Bounded: this lands in an agent's context window, and an owner with a
    // five-minute schedule accumulates thousands of rows.
    const limit = Math.min(Math.max(1, options.limit ?? 20), 50);
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
