/**
 * Manual group-sync trigger (Epic #1202, Phase 0).
 *
 * The hourly sync runs via EventBridge → the group-sync Lambda. A "Sync now"
 * admin action invokes the SAME Lambda asynchronously (InvocationType 'Event'),
 * so manual and scheduled runs share one code path. Mirrors
 * lib/skills/skill-publish-pipeline.ts#invokeSkillScan.
 */

import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { createLogger } from "@/lib/logger";
import { getSetting } from "@/lib/settings-manager";

const log = createLogger({ service: "group-sync-trigger" });

const REGION =
  process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const ENVIRONMENT = process.env.ENVIRONMENT || "dev";

let lambdaClientSingleton: LambdaClient | null = null;
function getLambda(): LambdaClient {
  if (!lambdaClientSingleton) {
    lambdaClientSingleton = new LambdaClient({ region: REGION });
  }
  return lambdaClientSingleton;
}

/**
 * Resolve the group-sync Lambda function name. Settings table first (admin-
 * configurable, no redeploy), then the CDK-injected env var, then the
 * deterministic default `psd-group-sync-{env}`.
 */
export async function getGroupSyncFunctionName(): Promise<string> {
  return (
    (await getSetting("GROUP_SYNC_LAMBDA_NAME")) ||
    process.env.GROUP_SYNC_LAMBDA_NAME ||
    `psd-group-sync-${ENVIRONMENT}`
  );
}

export interface TriggerResult {
  dispatched: boolean;
  /** Present when not dispatched — a human-readable reason. */
  reason?: string;
}

/**
 * Dispatch a manual sync. Async invoke — returns as soon as the Lambda accepts
 * the event (the sync itself runs in the Lambda with a 10-minute budget). Throws
 * on an actual invoke failure so the caller can surface it; returns a
 * non-dispatched result only when no function name resolves (never in a normal
 * deployment).
 */
export async function triggerGroupSyncNow(
  requestedByUserId: number | null
): Promise<TriggerResult> {
  const functionName = await getGroupSyncFunctionName();
  if (!functionName) {
    return { dispatched: false, reason: "Group-sync Lambda is not configured" };
  }

  const client = getLambda();
  await client.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "Event", // async — do not block the admin request
      Payload: Buffer.from(
        JSON.stringify({ trigger: "manual", requestedByUserId })
      ),
    })
  );
  log.info("Dispatched manual group sync", { functionName, requestedByUserId });
  return { dispatched: true };
}
