import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { eq } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { repositoryProcessingJobs } from "@/lib/db/schema";

const sqs = new SQSClient({});

export interface ContentProcessingMessage {
  jobId: string;
  itemVersionId: string;
}

/**
 * Low-latency dispatch after the durable DB job commits. The scheduled worker
 * dispatcher is the recovery path if this send fails, so callers may safely
 * report an accepted upload while leaving the job pending.
 */
export async function dispatchContentProcessingJob(
  message: ContentProcessingMessage
): Promise<void> {
  const queueUrl = process.env.CONTENT_PROCESSING_QUEUE_URL;
  if (!queueUrl) throw new Error("CONTENT_PROCESSING_QUEUE_URL is not configured");

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
      MessageAttributes: {
        jobId: { DataType: "String", StringValue: message.jobId },
        itemVersionId: {
          DataType: "String",
          StringValue: message.itemVersionId,
        },
      },
    })
  );
  await executeQuery(
    (db) =>
      db
        .update(repositoryProcessingJobs)
        .set({ status: "queued", updatedAt: new Date() })
        .where(eq(repositoryProcessingJobs.id, message.jobId)),
    "contentPlatform.dispatchProcessingJob"
  );
}
