/**
 * Agent Chat Bridge — receives GCP Pub/Sub push deliveries via API Gateway
 * (HTTP API JWT-authorized for Google's OIDC issuer) and forwards them to the
 * agent-router SQS queue.
 *
 * The API Gateway authorizer validates signature, issuer, and audience. This
 * function additionally pins the JWT subject/email to the one Pub/Sub push
 * service account and pins the envelope to the configured subscription before
 * forwarding it.
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
const EXPECTED_OIDC_SUBJECT = process.env.EXPECTED_OIDC_SUBJECT;
const EXPECTED_OIDC_EMAIL = process.env.EXPECTED_OIDC_EMAIL;
const EXPECTED_PUBSUB_SUBSCRIPTION =
  process.env.EXPECTED_PUBSUB_SUBSCRIPTION;
if (
  !QUEUE_URL ||
  !EXPECTED_OIDC_SUBJECT ||
  !EXPECTED_OIDC_EMAIL ||
  !EXPECTED_PUBSUB_SUBSCRIPTION
) {
  throw new Error(
    'ROUTER_QUEUE_URL, EXPECTED_OIDC_SUBJECT, EXPECTED_OIDC_EMAIL, and ' +
      'EXPECTED_PUBSUB_SUBSCRIPTION are required',
  );
}

const sqs = new SQSClient({});

type JwtClaims = Record<string, string | number | boolean | string[]>;

export function hasExpectedPushIdentity(
  claims: JwtClaims | undefined,
): boolean {
  if (!claims) return false;
  const emailVerified =
    claims.email_verified === true || claims.email_verified === 'true';
  return (
    claims.sub === EXPECTED_OIDC_SUBJECT &&
    claims.email === EXPECTED_OIDC_EMAIL &&
    emailVerified
  );
}

export function hasExpectedSubscription(body: string): boolean {
  try {
    const envelope = JSON.parse(body) as { subscription?: unknown };
    return envelope.subscription === EXPECTED_PUBSUB_SUBSCRIPTION;
  } catch {
    return false;
  }
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const requestId = event.requestContext.requestId;
  const authorizedContext = event.requestContext as typeof event.requestContext & {
    authorizer?: { jwt?: { claims?: JwtClaims } };
  };
  const claims = authorizedContext.authorizer?.jwt?.claims as
    | JwtClaims
    | undefined;
  if (!hasExpectedPushIdentity(claims)) {
    console.warn(
      JSON.stringify({ requestId, msg: 'unexpected push identity' }),
    );
    return { statusCode: 403, body: 'forbidden' };
  }

  if (!event.body) {
    console.warn(JSON.stringify({ requestId, msg: 'empty body' }));
    return { statusCode: 400, body: 'empty body' };
  }

  const body = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;
  if (!hasExpectedSubscription(body)) {
    console.warn(
      JSON.stringify({ requestId, msg: 'unexpected Pub/Sub subscription' }),
    );
    return { statusCode: 403, body: 'forbidden' };
  }

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
