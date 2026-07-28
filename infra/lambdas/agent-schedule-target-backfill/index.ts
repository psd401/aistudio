import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  GetScheduleCommand,
  ListSchedulesCommand,
  SchedulerClient,
  UpdateScheduleCommand,
} from '@aws-sdk/client-scheduler';
import {
  InvokeCommand,
  LambdaClient,
} from '@aws-sdk/client-lambda';
import * as crypto from 'node:crypto';
import {
  backfillScheduleTargetPage,
  type ScheduleTargetBackfillDependencies,
  type ScheduleTargetBackfillResult,
} from './backfill';
import {
  SCHEDULE_MUTATION_LOCK_LEASE_SECONDS,
  scheduleMutationLockKey,
} from './mutation-lock';

const SCHEDULE_GROUP = process.env.SCHEDULE_GROUP ?? '';
const SCHEDULES_TABLE = process.env.SCHEDULES_TABLE ?? '';
const SCHEDULE_DLQ_ARN = process.env.SCHEDULE_DLQ_ARN ?? '';
const FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME ?? '';
const PAGE_SIZE = 100;

interface ScheduleTargetBackfillEvent {
  RequestType?: 'Create' | 'Update' | 'Delete';
  nextToken?: string;
}

const scheduler = new SchedulerClient({});
const lambda = new LambdaClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const runtimeDependencies: ScheduleTargetBackfillDependencies = {
  scheduleDlqArn: SCHEDULE_DLQ_ARN,
  recordInvalidTarget: (name, errorMessage) => {
    process.stderr.write(`${JSON.stringify({
      level: 'ERROR',
      marker: 'AGENT_FAILURE_RECORD',
      event: 'schedule_target_backfill_invalid_target',
      scheduleName: name,
      errorMessage,
    })}\n`);
  },
  list: async (nextToken) => {
    const page = await scheduler.send(
      new ListSchedulesCommand({
        GroupName: SCHEDULE_GROUP,
        MaxResults: PAGE_SIZE,
        ...(nextToken ? { NextToken: nextToken } : {}),
      }),
    );
    return {
      names: (page.Schedules ?? [])
        .map((schedule) => schedule.Name)
        .filter((name): name is string => Boolean(name)),
      ...(page.NextToken ? { nextToken: page.NextToken } : {}),
    };
  },
  get: (name) => scheduler.send(
    new GetScheduleCommand({ Name: name, GroupName: SCHEDULE_GROUP }),
  ),
  update: async (input) => {
    await scheduler.send(new UpdateScheduleCommand(input));
  },
  queueContinuation: async (nextToken) => {
    if (!FUNCTION_NAME) {
      throw new Error('AWS_LAMBDA_FUNCTION_NAME is not configured');
    }
    const response = await lambda.send(
      new InvokeCommand({
        FunctionName: FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({ nextToken })),
      }),
    );
    if (response.StatusCode !== 202) {
      throw new Error('Schedule target backfill continuation was not accepted');
    }
  },
  withMutationLock: async (identity, execute) => {
    const key = scheduleMutationLockKey(identity);
    const lockToken = crypto.randomUUID();
    const nowS = Math.floor(Date.now() / 1000);
    await dynamo.send(new PutCommand({
      TableName: SCHEDULES_TABLE,
      Item: {
        ...key,
        kind: 'schedule-mutation-lock',
        lockToken,
        expiresAt: nowS + SCHEDULE_MUTATION_LOCK_LEASE_SECONDS,
      },
      ConditionExpression:
        'attribute_not_exists(userId) OR expiresAt < :now',
      ExpressionAttributeValues: { ':now': nowS },
    }));
    try {
      return await execute();
    } finally {
      try {
        await dynamo.send(new DeleteCommand({
          TableName: SCHEDULES_TABLE,
          Key: key,
          ConditionExpression: 'lockToken = :lockToken',
          ExpressionAttributeValues: { ':lockToken': lockToken },
        }));
      } catch (error) {
        if (
          !(error instanceof Error)
          || error.name !== 'ConditionalCheckFailedException'
        ) {
          await dynamo.send(new UpdateCommand({
            TableName: SCHEDULES_TABLE,
            Key: key,
            UpdateExpression: 'SET expiresAt = :expiredAt',
            ConditionExpression: 'lockToken = :lockToken',
            ExpressionAttributeValues: {
              ':expiredAt': Math.floor(Date.now() / 1000) - 1,
              ':lockToken': lockToken,
            },
          }));
        }
      }
    }
  },
};

export async function handler(
  event: ScheduleTargetBackfillEvent,
): Promise<ScheduleTargetBackfillResult> {
  if (!SCHEDULE_GROUP) throw new Error('SCHEDULE_GROUP is not configured');
  if (!SCHEDULES_TABLE) throw new Error('SCHEDULES_TABLE is not configured');
  if (!SCHEDULE_DLQ_ARN) {
    throw new Error('SCHEDULE_DLQ_ARN is not configured');
  }
  if (event.RequestType === 'Delete') {
    return {
      scanned: 0,
      updated: 0,
      invalid: 0,
      continuationQueued: false,
    };
  }
  const result = await backfillScheduleTargetPage(
    event.nextToken,
    runtimeDependencies,
  );
  process.stdout.write(`${JSON.stringify({
    level: 'INFO',
    event: 'schedule_target_backfill_page_completed',
    ...result,
  })}\n`);
  return result;
}
