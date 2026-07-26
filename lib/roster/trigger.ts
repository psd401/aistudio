/**
 * Asynchronously invokes the same OneRoster Lambda used by the nightly rule.
 */

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { createLogger } from "@/lib/logger";

const log = createLogger({ service: "oneroster-sync-trigger" });
const REGION =
  process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const ENVIRONMENT = process.env.ENVIRONMENT || "dev";

let lambdaClient: LambdaClient | null = null;

function getLambdaClient(): LambdaClient {
  lambdaClient ??= new LambdaClient({ region: REGION });
  return lambdaClient;
}

export function getOneRosterSyncFunctionName(): string {
  return `psd-oneroster-sync-${ENVIRONMENT}`;
}

export async function triggerOneRosterSyncNow(
  requestedByUserId: number | null
): Promise<void> {
  const functionName = getOneRosterSyncFunctionName();
  await getLambdaClient().send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "Event",
      Payload: Buffer.from(
        JSON.stringify({ trigger: "manual", requestedByUserId })
      ),
    })
  );
  log.info("Dispatched manual OneRoster sync", {
    functionName,
    requestedByUserId,
  });
}
