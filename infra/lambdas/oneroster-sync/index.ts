/**
 * Nightly and manually-invoked ClassLink OneRoster sync Lambda.
 *
 * This is an isolated bundle and cannot import the Next.js logger. Structured
 * console output is therefore permitted by the repository's standalone-script
 * exception. Credentials are read from Secrets Manager and never logged.
 */

import { randomUUID } from "node:crypto";
import {
  CloudWatchClient,
  PutMetricDataCommand,
  type MetricDatum,
} from "@aws-sdk/client-cloudwatch";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { parseCredentials, resolveConfig } from "./config";
import {
  closeSql,
  getSql,
  readLastPermRev,
  reconcileCollection,
  reconcileOneRosterRoles,
  writeLastPermRev,
  writeSyncStatus,
  type RoleReconcileResult,
} from "./db";
import { OneRosterClient } from "./oneroster-client";
import {
  roleReconcileMetrics,
  runPostSyncRoleReconciliation,
} from "./role-reconciliation";
import { runOneRosterSync, type OneRosterSyncResult } from "./sync";

const METRIC_NAMESPACE = "AIStudio/RosterSync";
const ENVIRONMENT = process.env.ENVIRONMENT ?? "dev";
const secrets = new SecretsManagerClient({});
const cloudwatch = new CloudWatchClient({});

const log = {
  info: (message: string, metadata?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: "info", message, ...metadata })),
  warn: (message: string, metadata?: Record<string, unknown>) =>
    console.warn(JSON.stringify({ level: "warn", message, ...metadata })),
  error: (message: string, metadata?: Record<string, unknown>) =>
    console.error(JSON.stringify({ level: "error", message, ...metadata })),
};

interface OneRosterSyncEvent {
  trigger?: string;
  requestedByUserId?: number | null;
  runId?: string;
}

interface HandlerResult {
  status: "ok" | "skipped";
  reason?: string;
  result?: OneRosterSyncResult;
}

type SyncState = "running" | "succeeded" | "failed" | "skipped";

interface PersistedSyncStatus {
  runId: string;
  trigger: "manual" | "schedule";
  state: SyncState;
  startedAt: string;
  completedAt: string | null;
  unchanged: boolean;
  collections: Array<{
    name: string;
    recordsTotal: number;
    synced: number;
    deactivated: number;
    failed: number;
  }>;
  error: string | null;
}

const INCOMPLETE_SYNC_ERROR =
  "OneRoster sync was incomplete; failed collections retain last-known-good rows";

type OneRosterConfig = Awaited<ReturnType<typeof resolveConfig>>;

function syncSkip(
  config: OneRosterConfig,
  manual: boolean,
): { reason: "not-configured" | "disabled"; error: string } | null {
  if (!config.baseUrl || !config.authMode || !config.credentialsSecretArn) {
    return {
      reason: "not-configured",
      error: "OneRoster settings are incomplete.",
    };
  }
  if (!manual && !config.enabled) {
    return {
      reason: "disabled",
      error: "Scheduled OneRoster synchronization is disabled.",
    };
  }
  return null;
}

function syncFailureMessage(
  error: unknown,
  result: OneRosterSyncResult | null,
): string {
  const thrown = safeErrorMessage(error);
  const collectionError = result?.collections.find(
    (collection) => collection.failed > 0,
  )?.error;
  return thrown === INCOMPLETE_SYNC_ERROR && collectionError
    ? collectionError
    : thrown;
}

export async function handler(
  event: OneRosterSyncEvent = {},
): Promise<HandlerResult> {
  const manual = event.trigger === "manual";
  const trigger = manual ? "manual" : "schedule";
  const runId = resolveRunId(event.runId);
  const startedAt = new Date().toISOString();
  let metricsEmitted = false;
  let syncResult: OneRosterSyncResult | null = null;
  log.info("OneRoster sync invoked", {
    trigger,
    requestedByUserId: event.requestedByUserId ?? null,
    runId,
  });

  const sql = await getSql();
  try {
    await writeStatusSafely(sql, {
      runId,
      trigger,
      state: "running",
      startedAt,
      completedAt: null,
      unchanged: false,
      collections: [],
      error: null,
    });
    const config = await resolveConfig(sql);
    const skip = syncSkip(config, manual);
    if (skip) {
      log.info("OneRoster sync skipped", { reason: skip.reason });
      await writeStatusSafely(sql, {
        runId,
        trigger,
        state: "skipped",
        startedAt,
        completedAt: new Date().toISOString(),
        unchanged: false,
        collections: [],
        error: skip.error,
      });
      return { status: "skipped", reason: skip.reason };
    }
    if (!config.credentialsSecretArn || !config.authMode || !config.baseUrl) {
      throw new Error("OneRoster settings became incomplete during sync");
    }

    const credentials = parseCredentials(
      await loadSecret(config.credentialsSecretArn),
      config.authMode,
    );
    const client = new OneRosterClient({
      baseUrl: config.baseUrl,
      apiVersion: config.apiVersion,
      pageSize: config.pageSize,
      credentials,
    });
    const result = await runOneRosterSync({
      readLastPermRev: () => readLastPermRev(sql),
      pullRoster: (previousPermRev) => client.pullAll(previousPermRev),
      reconcileCollection: (collection) => reconcileCollection(sql, collection),
      writeLastPermRev: (permRev) => writeLastPermRev(sql, permRev),
      log,
    });
    syncResult = result;

    if (!result.fullySuccessful) {
      await emitMetrics(result, null);
      metricsEmitted = true;
      throw new Error(INCOMPLETE_SYNC_ERROR);
    }

    const roleReconcile = await runPostSyncRoleReconciliation(
      {
        trigger,
        enabled: config.roleSyncEnabled,
        fullySuccessful: result.fullySuccessful,
      },
      {
        reconcile: () => reconcileOneRosterRoles(sql),
        log,
      }
    );
    await emitMetrics(result, roleReconcile);
    metricsEmitted = true;

    log.info("OneRoster sync completed", {
      unchanged: result.unchanged,
      restartCount: result.restartCount,
      recordsSynced: result.collections.reduce(
        (total, collection) => total + collection.synced,
        0,
      ),
    });
    await writeStatusSafely(
      sql,
      statusFromResult({
        runId,
        trigger,
        startedAt,
        state: "succeeded",
        result,
        error: null,
      }),
    );
    return { status: "ok", result };
  } catch (error) {
    const errorMessage = syncFailureMessage(error, syncResult);
    log.error("OneRoster sync failed", { error: errorMessage, runId });
    if (!metricsEmitted) {
      await emitMetrics(null, null).catch(() => {});
    }
    await writeStatusSafely(
      sql,
      statusFromResult({
        runId,
        trigger,
        startedAt,
        state: "failed",
        result: syncResult,
        error: errorMessage,
      }),
    );
    throw error;
  } finally {
    await closeSql().catch(() => {});
  }
}

function statusFromResult(options: {
  runId: string;
  trigger: "manual" | "schedule";
  startedAt: string;
  state: "succeeded" | "failed";
  result: OneRosterSyncResult | null;
  error: string | null;
}): PersistedSyncStatus {
  const { runId, trigger, startedAt, state, result, error } = options;
  return {
    runId,
    trigger,
    state,
    startedAt,
    completedAt: new Date().toISOString(),
    unchanged: result?.unchanged ?? false,
    collections:
      result?.collections.map((collection) => ({
        name: collection.name,
        recordsTotal: collection.recordsTotal,
        synced: collection.synced,
        deactivated: collection.deactivated,
        failed: collection.failed,
      })) ?? [],
    error: error ? safeErrorMessage(error) : null,
  };
}

async function writeStatusSafely(
  sql: Awaited<ReturnType<typeof getSql>>,
  status: PersistedSyncStatus,
): Promise<void> {
  try {
    await writeSyncStatus(sql, status);
  } catch (error) {
    // Dashboard observability must never turn a safe roster reconciliation into
    // a failed run. The Lambda error/staleness alarms remain the fallback.
    log.warn("Failed to persist OneRoster sync status", {
      runId: status.runId,
      state: status.state,
      error: safeErrorMessage(error),
    });
  }
}

async function loadSecret(secretArn: string): Promise<string> {
  const response = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  if (!response.SecretString) {
    throw new Error("OneRoster credentials secret has no SecretString");
  }
  return response.SecretString;
}

async function emitMetrics(
  result: OneRosterSyncResult | null,
  roleReconcile: RoleReconcileResult | null
): Promise<void> {
  const environmentDimension = [{ Name: "Environment", Value: ENVIRONMENT }];
  const metrics: MetricDatum[] = result
    ? [
        {
          MetricName: "SyncRunFailed",
          Value: result.fullySuccessful ? 0 : 1,
          Unit: "Count",
          Dimensions: environmentDimension,
        },
        {
          MetricName: "SyncRunSucceeded",
          Value: result.fullySuccessful ? 1 : 0,
          Unit: "Count",
          Dimensions: environmentDimension,
        },
        {
          MetricName: "RevisionRestarts",
          Value: result.restartCount,
          Unit: "Count",
          Dimensions: environmentDimension,
        },
      ]
    : [
        {
          MetricName: "SyncRunFailed",
          Value: 1,
          Unit: "Count",
          Dimensions: environmentDimension,
        },
        {
          MetricName: "SyncRunSucceeded",
          Value: 0,
          Unit: "Count",
          Dimensions: environmentDimension,
        },
      ];

  if (result) {
    for (const collection of result.collections) {
      const dimensions = [
        ...environmentDimension,
        { Name: "Collection", Value: collection.name },
      ];
      metrics.push(
        {
          MetricName: "RecordsSynced",
          Value: collection.synced,
          Unit: "Count",
          Dimensions: dimensions,
        },
        {
          MetricName: "CollectionsFailed",
          Value: collection.failed,
          Unit: "Count",
          Dimensions: dimensions,
        },
        {
          MetricName: "RecordsDeactivated",
          Value: collection.deactivated,
          Unit: "Count",
          Dimensions: dimensions,
        },
        {
          MetricName: "RecordsTotal",
          Value: collection.recordsTotal,
          Unit: "Count",
          Dimensions: dimensions,
        },
      );
    }
  }

  if (roleReconcile) {
    for (const metric of roleReconcileMetrics(roleReconcile)) {
      metrics.push({
        MetricName: metric.name,
        Value: metric.value,
        Unit: "Count",
        Dimensions: environmentDimension,
      });
    }
  }

  try {
    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: METRIC_NAMESPACE,
        MetricData: metrics,
      }),
    );
  } catch (error) {
    log.warn("Failed to publish OneRoster metrics", {
      error: safeErrorMessage(error),
    });
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 499)}…` : message;
}

function resolveRunId(value: unknown): string {
  if (typeof value !== "string") return randomUUID();
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 100
    ? normalized
    : randomUUID();
}
