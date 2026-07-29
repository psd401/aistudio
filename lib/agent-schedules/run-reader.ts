import { and, desc, eq, inArray } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { agentScheduledRuns } from "@/lib/db/schema";

export interface AgentScheduleLastRun {
  createdAt: Date;
  status: string;
  errorMessage: string | null;
}

export interface AgentScheduleRunReader {
  latestBySchedule(
    ownerEmail: string,
    scheduleIds: string[],
  ): Promise<Map<string, AgentScheduleLastRun>>;
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
}
