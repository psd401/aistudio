/**
 * Read-only audit of stored agent schedules (issue #1888).
 *
 * Numeric day-of-week was blocked on 2026-08-14, but schedules created before
 * that were never re-validated, and a misread 6-field cron could turn a daily
 * schedule into a monthly one with nothing to show for it. Those schedules are
 * still live: a director's "weekday brief" fires Sunday through Thursday, and
 * a principal's "evening heads-up" fires once a month on the 18th.
 *
 * This finds them and prints a suggested correction. It NEVER writes — not to
 * DynamoDB, not to EventBridge Scheduler. Fixing a schedule is the owner's
 * call (or an admin's), because the stored expression is only evidence of what
 * was typed, not of what was wanted.
 *
 * Run:
 *   AGENT_SCHEDULES_TABLE=<table> AWS_REGION=us-east-1 \
 *     bun run scripts/audit-agent-schedules.ts
 *   ... --json          machine-readable output
 *   ... --all           include disabled schedules
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  type ScanCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import {
  auditSchedule,
  type ScheduleFinding,
  type StoredSchedule,
} from "@/lib/agent-schedules/schedule-audit";
import { DEFAULT_SCHEDULE_TIMEZONE } from "@/lib/agent-schedules/validation";
import { scriptLogger as log } from "./db/script-logger";

function toStoredSchedule(item: Record<string, unknown>): StoredSchedule | null {
  if (
    typeof item.scheduleId !== "string" ||
    typeof item.schedulerExpression !== "string" ||
    typeof item.name !== "string"
  ) {
    // Name-uniqueness rows and owner-metadata rows share the table.
    return null;
  }
  return {
    scheduleId: item.scheduleId,
    ownerEmail:
      typeof item.ownerEmail === "string"
        ? item.ownerEmail
        : typeof item.userId === "string"
          ? item.userId
          : "unknown",
    name: item.name,
    timezone:
      typeof item.timezone === "string"
        ? item.timezone
        : DEFAULT_SCHEDULE_TIMEZONE,
    enabled: item.enabled === true,
    schedulerExpression: item.schedulerExpression,
    // Anchors a rate(...) interval, so the reported fire times match reality.
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : undefined,
  };
}

/**
 * Narrow view of the document client, as `AgentScheduleService` takes.
 *
 * The repo resolves two copies of `@smithy/types` (the bedrock-agent-runtime
 * client nests its own), so `DynamoDBDocumentClient.send` does not structurally
 * accept a `ScanCommand` built from the top-level copy. Depending on the one
 * method this script calls sidesteps the duplicate-types mismatch.
 */
interface ScheduleScanClient {
  send(command: ScanCommand): Promise<ScanCommandOutput>;
}

async function scanSchedules(
  client: ScheduleScanClient,
  tableName: string,
): Promise<StoredSchedule[]> {
  const schedules: StoredSchedule[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey: startKey }),
    );
    for (const item of page.Items ?? []) {
      const parsed = toStoredSchedule(item as Record<string, unknown>);
      if (parsed) schedules.push(parsed);
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return schedules;
}

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const includeDisabled = process.argv.includes("--all");
  const tableName = process.env.AGENT_SCHEDULES_TABLE;
  if (!tableName) {
    log.error("AGENT_SCHEDULES_TABLE is required");
    process.exitCode = 1;
    return;
  }

  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" }),
  ) as unknown as ScheduleScanClient;
  const schedules = (await scanSchedules(client, tableName)).filter(
    (schedule) => includeDisabled || schedule.enabled,
  );
  const findings = schedules
    .map(auditSchedule)
    .filter((finding): finding is ScheduleFinding => finding !== null);

  if (asJson) {
    // Straight to stdout, not through the logger: `log.info` prefixes an
    // ANSI-colored timestamp and level, which makes the documented
    // machine-readable mode unparseable by `jq`.
    process.stdout.write(
      `${JSON.stringify({ scanned: schedules.length, findings }, null, 2)}\n`,
    );
    return;
  }

  log.info(
    `Audited ${schedules.length} ${includeDisabled ? "" : "enabled "}` +
      `schedule(s); ${findings.length} need attention. Nothing was changed.`,
  );
  for (const finding of findings) {
    log.info(
      [
        "",
        `${finding.name}  (${finding.scheduleId})`,
        `  owner:     ${finding.ownerEmail}`,
        `  stored:    ${finding.schedulerExpression}  [${finding.timezone}]`,
        `  reads as:  ${finding.description}`,
        `  next runs: ${finding.nextRuns.join(", ") || "(none computed)"}`,
        ...finding.issues.map((issue) => `  issue:     ${issue}`),
        `  suggested: ${finding.suggestedExpression ?? "(review by hand)"}`,
      ].join("\n"),
    );
  }
}

// Guarded so the unit tests can import `auditSchedule` without the scan
// running (and failing on a missing table) as an import side effect.
if (process.argv[1]?.endsWith("audit-agent-schedules.ts")) {
  main().catch((error: unknown) => {
    log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
