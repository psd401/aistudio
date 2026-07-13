/**
 * Group-sync Lambda handler (Epic #1202, Phase 0 / #1203).
 *
 * Entry point for the hourly EventBridge schedule AND the admin "Sync now"
 * async invoke (payload `{ trigger: 'manual' }`). Resolves config from the
 * settings table, loads the Google service-account key from Secrets Manager,
 * builds the directory client (Cloud Identity or Admin SDK), and drives the
 * reconciler (runGroupSync). Emits per-run CloudWatch metrics.
 *
 * Gating:
 *   - Scheduled runs execute only when GROUP_SYNC_ENABLED = 'true' AND an SA
 *     secret ARN is configured.
 *   - Manual runs execute whenever an SA secret ARN is configured (so an admin
 *     can sync even while the hourly schedule is paused).
 *
 * This bundle is isolated from the Next.js app (it cannot import @/lib/*), so it
 * uses console logging (allowed for standalone Lambda code — see root CLAUDE.md).
 */

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import {
  CloudWatchClient,
  PutMetricDataCommand,
  type MetricDatum,
} from "@aws-sdk/client-cloudwatch";
import { getSql, closeSql, listActiveRules, upsertGroup, replaceMembers, markSynced, markError, deactivateGroupsNotIn } from "./db";
import { resolveConfig, parseServiceAccountKey } from "./config";
import { createDirectoryClient } from "./directory-client";
import { runGroupSync, type GroupSyncPorts, type GroupSyncResult } from "./sync";

const METRIC_NAMESPACE = "AIStudio/GroupSync";
const ENVIRONMENT = process.env.ENVIRONMENT ?? "dev";

const secretsClient = new SecretsManagerClient({});
const cloudwatch = new CloudWatchClient({});

/* eslint-disable no-console */
const log = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: "info", msg, ...meta })),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    console.warn(JSON.stringify({ level: "warn", msg, ...meta })),
  error: (msg: string, meta?: Record<string, unknown>) =>
    console.error(JSON.stringify({ level: "error", msg, ...meta })),
};
/* eslint-enable no-console */

interface GroupSyncEvent {
  trigger?: string;
  requestedByUserId?: number | null;
}

interface HandlerResult {
  status: "ok" | "skipped" | "error";
  reason?: string;
  result?: GroupSyncResult;
}

export async function handler(event: GroupSyncEvent = {}): Promise<HandlerResult> {
  const isManual = event.trigger === "manual";
  log.info("Group sync invoked", { trigger: isManual ? "manual" : "schedule" });

  const sql = await getSql();
  try {
    const config = await resolveConfig(sql);

    if (!config.saSecretArn) {
      log.warn("Group sync not configured (no SA secret ARN) — skipping");
      return { status: "skipped", reason: "not-configured" };
    }
    if (!isManual && !config.enabled) {
      log.info("Hourly group sync disabled — skipping (manual runs still allowed)");
      return { status: "skipped", reason: "disabled" };
    }

    const key = parseServiceAccountKey(await loadSecret(config.saSecretArn));
    const directory = createDirectoryClient(key, config);

    const ports: GroupSyncPorts = {
      listActiveRules: () => listActiveRules(sql),
      listDirectoryGroups: () => directory.listGroups(),
      fetchTransitiveMembers: (email) => directory.fetchTransitiveMembers(email),
      upsertGroup: (input) => upsertGroup(sql, input),
      replaceMembers: (groupId, emails) => replaceMembers(sql, groupId, emails),
      markSynced: (groupId) => markSynced(sql, groupId),
      markError: (groupId, message) => markError(sql, groupId, message),
      deactivateGroupsNotIn: (emails) => deactivateGroupsNotIn(sql, emails),
      log,
    };

    const result = await runGroupSync(ports);
    log.info("Group sync completed", { ...result });
    await emitMetrics(result);
    return { status: "ok", result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("Group sync failed", { error: message });
    await emitMetrics(null).catch(() => {});
    throw error;
  } finally {
    await closeSql().catch(() => {});
  }
}

async function loadSecret(secretArn: string): Promise<string> {
  const res = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!res.SecretString) {
    throw new Error(`Service-account secret has no SecretString: ${secretArn}`);
  }
  return res.SecretString;
}

/** Publish per-run metrics. A null result records a run-level failure. */
async function emitMetrics(result: GroupSyncResult | null): Promise<void> {
  const dims = [{ Name: "Environment", Value: ENVIRONMENT }];
  const metrics: MetricDatum[] = result
    ? [
        { MetricName: "GroupsSelected", Value: result.selected, Unit: "Count", Dimensions: dims },
        { MetricName: "GroupsSynced", Value: result.synced, Unit: "Count", Dimensions: dims },
        { MetricName: "GroupsFailed", Value: result.failed, Unit: "Count", Dimensions: dims },
        { MetricName: "GroupsDeactivated", Value: result.deactivated, Unit: "Count", Dimensions: dims },
        { MetricName: "MembersTotal", Value: result.totalMembers, Unit: "Count", Dimensions: dims },
        { MetricName: "SyncRunFailed", Value: 0, Unit: "Count", Dimensions: dims },
      ]
    : [{ MetricName: "SyncRunFailed", Value: 1, Unit: "Count", Dimensions: dims }];

  try {
    await cloudwatch.send(
      new PutMetricDataCommand({ Namespace: METRIC_NAMESPACE, MetricData: metrics })
    );
  } catch (error) {
    log.warn("Failed to publish group-sync metrics", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
