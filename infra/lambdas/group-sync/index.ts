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
import { getSql, closeSql, listActiveRules, upsertGroup, replaceMembers, markSynced, markError, deactivateGroupsNotIn, reconcileManagedRoles, type RoleReconcileResult } from "./db";
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
  log.info("Group sync invoked", {
    trigger: isManual ? "manual" : "schedule",
    // Audit signal for manual runs — who pressed "Sync now".
    requestedByUserId: event.requestedByUserId ?? null,
  });

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

    // Drive managed roles from the freshly-synced memberships (Phase 1 / #1204).
    // Best-effort: membership is already committed and the login-time reconciler
    // is the backstop, so a role-reconcile failure must NOT fail the whole run
    // (which would also skip the success metrics for a good membership sync).
    let roleReconcile: RoleReconcileResult | null = null;
    try {
      roleReconcile = await reconcileManagedRoles(sql);
      log.info("Managed-role reconciliation completed", { ...roleReconcile });
      if (roleReconcile.adminRoleProtected) {
        log.error(
          "Last-administrator guard tripped: refused to auto-revoke the final administrator grant(s) — check the administrator group mapping/membership"
        );
      }
    } catch (error) {
      log.error("Managed-role reconciliation failed (membership sync still succeeded)", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await emitMetrics(result, roleReconcile);
    return { status: "ok", result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("Group sync failed", { error: message });
    await emitMetrics(null, null).catch(() => {});
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

/**
 * Publish per-run metrics. A null result records a run-level failure. Role
 * reconciliation metrics ride along when the reconcile pass ran (null when it
 * was skipped or threw — the membership sync can still have succeeded).
 */
async function emitMetrics(
  result: GroupSyncResult | null,
  roleReconcile: RoleReconcileResult | null
): Promise<void> {
  const dims = [{ Name: "Environment", Value: ENVIRONMENT }];
  const metrics: MetricDatum[] = result
    ? [
        { MetricName: "GroupsSelected", Value: result.selected, Unit: "Count", Dimensions: dims },
        { MetricName: "GroupsSynced", Value: result.synced, Unit: "Count", Dimensions: dims },
        { MetricName: "GroupsFailed", Value: result.failed, Unit: "Count", Dimensions: dims },
        { MetricName: "GroupsDeactivated", Value: result.deactivated, Unit: "Count", Dimensions: dims },
        { MetricName: "MembersTotal", Value: result.totalMembers, Unit: "Count", Dimensions: dims },
        { MetricName: "SyncRunFailed", Value: 0, Unit: "Count", Dimensions: dims },
        // Staleness signal (#1207): 1 on every successful run. The CDK
        // GroupSyncStalenessAlarm alarms when the SUM of this metric over the
        // staleness window is < 1 with treatMissingData=BREACHING, so it fires for
        // BOTH "ran but failed" (0 here) AND "did not run at all" (metric absent) —
        // a self-emitted "seconds since last sync" gauge could not detect the
        // latter because a dead Lambda emits nothing.
        { MetricName: "SyncRunSucceeded", Value: 1, Unit: "Count", Dimensions: dims },
      ]
    : [
        { MetricName: "SyncRunFailed", Value: 1, Unit: "Count", Dimensions: dims },
        { MetricName: "SyncRunSucceeded", Value: 0, Unit: "Count", Dimensions: dims },
      ];

  if (roleReconcile) {
    metrics.push(
      { MetricName: "RolesGranted", Value: roleReconcile.added, Unit: "Count", Dimensions: dims },
      { MetricName: "RolesRevoked", Value: roleReconcile.removed, Unit: "Count", Dimensions: dims },
      { MetricName: "RoleUsersChanged", Value: roleReconcile.usersChanged, Unit: "Count", Dimensions: dims }
    );
  }

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
