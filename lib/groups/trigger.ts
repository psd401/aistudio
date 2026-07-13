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
 * Deterministic group-sync Lambda name — must match processing-stack.ts's
 * `functionName` and the ECS task role's invoke grant (ecs-service.ts), both of
 * which hard-code this same `psd-group-sync-{env}` shape. IAM scopes the invoke
 * to exactly this ARN, so a configurable name could never widen anyway.
 */
export function getGroupSyncFunctionName(): string {
  return `psd-group-sync-${ENVIRONMENT}`;
}

/**
 * Dispatch a manual sync. Async invoke — returns as soon as the Lambda accepts
 * the event (the sync itself runs in the Lambda with a 10-minute budget).
 * Throws on an invoke failure so the caller can surface it.
 */
export async function triggerGroupSyncNow(
  requestedByUserId: number | null
): Promise<void> {
  const functionName = getGroupSyncFunctionName();
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
}
