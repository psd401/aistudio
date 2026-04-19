/**
 * Agent Chat Bridge — receives GCP Pub/Sub push deliveries via API Gateway
 * (HTTP API JWT-authorized for Google's OIDC issuer) and forwards them to the
 * agent-router SQS queue.
 *
 * The Router Lambda already understands the Pub/Sub envelope shape, so we
 * forward the raw request body unchanged. This keeps the bridge stateless and
 * means schema changes only need to land in one place (the Router).
 *
 * Pub/Sub treats any 2xx response as success and any other status as failure,
 * applying its own retry/backoff. We return 204 on successful enqueue.
 */

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

const QUEUE_URL = process.env.ROUTER_QUEUE_URL;
if (!QUEUE_URL) {
  throw new Error('ROUTER_QUEUE_URL env var is required');
}

const sqs = new SQSClient({});

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const requestId = event.requestContext.requestId;

  if (!event.body) {
    console.warn(JSON.stringify({ requestId, msg: 'empty body' }));
    return { statusCode: 400, body: 'empty body' };
  }

  const body = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;

  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: body,
      }),
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        requestId,
        msg: 'sqs send failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    // 5xx → Pub/Sub retries with backoff. Better than dropping the message.
    return { statusCode: 502, body: 'sqs send failed' };
  }

  console.info(
    JSON.stringify({ requestId, msg: 'forwarded', bytes: body.length }),
  );
  return { statusCode: 204, body: '' };
}
