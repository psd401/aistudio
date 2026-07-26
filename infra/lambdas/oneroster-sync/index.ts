/**
 * Nightly and manually-invoked ClassLink OneRoster sync Lambda.
 *
 * This is an isolated bundle and cannot import the Next.js logger. Structured
 * console output is therefore permitted by the repository's standalone-script
 * exception. Credentials are read from Secrets Manager and never logged.
 */

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
  writeLastPermRev,
} from "./db";
import { OneRosterClient } from "./oneroster-client";
import { runOneRosterSync, type OneRosterSyncResult } from "./sync";

const METRIC_NAMESPACE = "AIStudio/RosterSync";
const ENVIRONMENT = process.env.ENVIRONMENT ?? "dev";
const secrets = new SecretsManagerClient({});
const cloudwatch = new CloudWatchClient({});

/* eslint-disable no-console */
const log = {
  info: (message: string, metadata?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: "info", message, ...metadata })),
  warn: (message: string, metadata?: Record<string, unknown>) =>
    console.warn(JSON.stringify({ level: "warn", message, ...metadata })),
  error: (message: string, metadata?: Record<string, unknown>) =>
    console.error(JSON.stringify({ level: "error", message, ...metadata })),
};
/* eslint-enable no-console */

interface OneRosterSyncEvent {
  trigger?: string;
  requestedByUserId?: number | null;
}

interface HandlerResult {
  status: "ok" | "skipped";
  reason?: string;
  result?: OneRosterSyncResult;
}

export async function handler(
  event: OneRosterSyncEvent = {}
): Promise<HandlerResult> {
  const manual = event.trigger === "manual";
  let metricsEmitted = false;
  log.info("OneRoster sync invoked", {
    trigger: manual ? "manual" : "schedule",
    requestedByUserId: event.requestedByUserId ?? null,
  });

  const sql = await getSql();
  try {
    const config = await resolveConfig(sql);
    if (!config.baseUrl || !config.authMode || !config.credentialsSecretArn) {
      log.warn("OneRoster sync is not fully configured; skipping");
      return { status: "skipped", reason: "not-configured" };
    }
    if (!manual && !config.enabled) {
      log.info("Nightly OneRoster sync is disabled; skipping");
      return { status: "skipped", reason: "disabled" };
    }

    const credentials = parseCredentials(
      await loadSecret(config.credentialsSecretArn),
      config.authMode
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
      reconcileCollection: (collection) =>
        reconcileCollection(sql, collection),
      writeLastPermRev: (permRev) => writeLastPermRev(sql, permRev),
      log,
    });

    await emitMetrics(result);
    metricsEmitted = true;
    if (!result.fullySuccessful) {
      throw new Error(
        "OneRoster sync was incomplete; failed collections retain last-known-good rows"
      );
    }
    log.info("OneRoster sync completed", {
      unchanged: result.unchanged,
      restartCount: result.restartCount,
      recordsSynced: result.collections.reduce(
        (total, collection) => total + collection.synced,
        0
      ),
    });
    return { status: "ok", result };
  } catch (error) {
    log.error("OneRoster sync failed", { error: safeErrorMessage(error) });
    if (!metricsEmitted) {
      await emitMetrics(null).catch(() => {});
    }
    throw error;
  } finally {
    await closeSql().catch(() => {});
  }
}

async function loadSecret(secretArn: string): Promise<string> {
  const response = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );
  if (!response.SecretString) {
    throw new Error("OneRoster credentials secret has no SecretString");
  }
  return response.SecretString;
}

async function emitMetrics(result: OneRosterSyncResult | null): Promise<void> {
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
        }
      );
    }
  }

  try {
    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: METRIC_NAMESPACE,
        MetricData: metrics,
      })
    );
  } catch (error) {
    log.warn("Failed to publish OneRoster metrics", {
      error: safeErrorMessage(error),
    });
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}
