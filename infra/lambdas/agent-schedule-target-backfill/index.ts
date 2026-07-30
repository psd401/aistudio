import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
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
  backfillScheduleRecordPage,
  backfillScheduleTargetPage,
  type LegacyScheduleRecordUpgrade,
  type ScheduleBackfillContinuation,
  type ScheduleBackfillPhase,
  type ScheduleTargetBackfillDependencies,
  type ScheduleTargetBackfillResult,
  type TrustedOwnerProfile,
  withIamPropagationRetry,
} from './backfill';
import {
  SCHEDULE_MUTATION_LOCK_LEASE_SECONDS,
  type ScheduleMutationIdentity,
  scheduleMutationLockKey,
} from './mutation-lock';

const SCHEDULE_GROUP = process.env.SCHEDULE_GROUP ?? '';
const SCHEDULES_TABLE = process.env.SCHEDULES_TABLE ?? '';
const USERS_TABLE = process.env.USERS_TABLE ?? '';
const SCHEDULE_DLQ_ARN = process.env.SCHEDULE_DLQ_ARN ?? '';
const FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME ?? '';
const PAGE_SIZE = 100;

interface ScheduleTargetBackfillEvent {
  RequestType?: 'Create' | 'Update' | 'Delete';
  phase?: ScheduleBackfillPhase;
  nextToken?: string;
}

const scheduler = new SchedulerClient({});
const lambda = new LambdaClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function objectValue(value: unknown): Record<string, unknown> | null {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
  )
    ? value as Record<string, unknown>
    : null;
}

function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

function decodeCursor(token?: string): Record<string, unknown> | undefined {
  if (!token) return undefined;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(token, 'base64url').toString('utf8'),
    );
    const key = objectValue(decoded);
    if (!key) throw new Error('Cursor is not an object');
    return key;
  } catch {
    throw new Error('Schedule record backfill cursor is invalid');
  }
}

function normalizedEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function ownerProfile(
  ownerEmail: string,
  values: Record<string, unknown>[],
): TrustedOwnerProfile | null {
  const candidates = values.filter(
    (value) => normalizedEmail(value.email) === ownerEmail,
  );
  const selected = candidates.find(
    (value) =>
      typeof value.googleIdentity === 'string'
      && /^users\/\d+$/.test(value.googleIdentity),
  ) ?? candidates[0];
  if (!selected) return null;
  const workspacePrefix =
    typeof selected.workspacePrefix === 'string'
    && selected.workspacePrefix.length > 0
    && selected.workspacePrefix.length <= 128
      ? selected.workspacePrefix
      : ownerEmail.split('@')[0];
  return {
    workspacePrefix,
    ...(typeof selected.dmSpaceName === 'string'
      && /^spaces\/[\w-]{1,256}$/.test(selected.dmSpaceName)
      ? { dmSpaceName: selected.dmSpaceName }
      : {}),
  };
}

function updateRecordRequest(
  identity: ScheduleMutationIdentity,
  upgrade: LegacyScheduleRecordUpgrade,
) {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {
    ':owner': identity.ownerEmail,
    ':scheduleId': identity.scheduleId,
  };
  const setters: string[] = [];
  const append = (
    field: keyof LegacyScheduleRecordUpgrade,
    value: string | number | undefined,
  ) => {
    if (value === undefined) return;
    const name = `#${field}`;
    const parameter = `:${field}`;
    names[name] = field;
    values[parameter] = value;
    setters.push(`${name} = ${parameter}`);
  };
  append('version', upgrade.version);
  append('ownerEmail', upgrade.ownerEmail);
  append('schedulerExpression', upgrade.schedulerExpression);
  append('workspacePrefix', upgrade.workspacePrefix);
  append('dmSpaceName', upgrade.dmSpaceName);
  if (setters.length === 0) {
    throw new Error('Schedule record backfill has no fields to update');
  }
  return {
    TableName: SCHEDULES_TABLE,
    Key: {
      userId: identity.ownerEmail,
      scheduleId: identity.scheduleId,
    },
    UpdateExpression: `SET ${setters.join(', ')}`,
    ConditionExpression:
      'userId = :owner AND scheduleId = :scheduleId',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

const runtimeDependencies: ScheduleTargetBackfillDependencies = {
  scheduleDlqArn: SCHEDULE_DLQ_ARN,
  recordInvalidRecord: (identity, errorMessage) => {
    process.stderr.write(`${JSON.stringify({
      level: 'ERROR',
      marker: 'AGENT_FAILURE_RECORD',
      event: 'schedule_record_backfill_invalid_record',
      ownerBound: Boolean(identity?.ownerEmail),
      scheduleId: identity?.scheduleId ?? 'unknown',
      errorMessage,
    })}\n`);
  },
  recordInvalidTarget: (name, errorMessage) => {
    process.stderr.write(`${JSON.stringify({
      level: 'ERROR',
      marker: 'AGENT_FAILURE_RECORD',
      event: 'schedule_target_backfill_invalid_target',
      scheduleName: name,
      errorMessage,
    })}\n`);
  },
  listRecords: async (nextToken) => {
    const page = await dynamo.send(new ScanCommand({
      TableName: SCHEDULES_TABLE,
      Limit: PAGE_SIZE,
      ConsistentRead: true,
      ...(nextToken
        ? { ExclusiveStartKey: decodeCursor(nextToken) }
        : {}),
    }));
    return {
      records: (page.Items ?? []).filter(
        (item): item is Record<string, unknown> => Boolean(objectValue(item)),
      ),
      ...(page.LastEvaluatedKey
        ? { nextToken: encodeCursor(page.LastEvaluatedKey) }
        : {}),
    };
  },
  getRecord: async (identity) => {
    const response = await dynamo.send(new GetCommand({
      TableName: SCHEDULES_TABLE,
      Key: {
        userId: identity.ownerEmail,
        scheduleId: identity.scheduleId,
      },
      ConsistentRead: true,
    }));
    return objectValue(response.Item) ?? undefined;
  },
  loadOwnerProfile: async (ownerEmail) => {
    const response = await dynamo.send(new QueryCommand({
      TableName: USERS_TABLE,
      IndexName: 'email-index',
      KeyConditionExpression: 'email = :email',
      ExpressionAttributeValues: { ':email': ownerEmail },
    }));
    return ownerProfile(
      ownerEmail,
      (response.Items ?? []).filter(
        (item): item is Record<string, unknown> => Boolean(objectValue(item)),
      ),
    );
  },
  updateRecord: async (identity, upgrade) => {
    await dynamo.send(new UpdateCommand(
      updateRecordRequest(identity, upgrade),
    ));
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
  queueContinuation: async (continuation: ScheduleBackfillContinuation) => {
    if (!FUNCTION_NAME) {
      throw new Error('AWS_LAMBDA_FUNCTION_NAME is not configured');
    }
    const response = await lambda.send(
      new InvokeCommand({
        FunctionName: FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(continuation)),
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
  if (!USERS_TABLE) throw new Error('USERS_TABLE is not configured');
  if (!SCHEDULE_DLQ_ARN) {
    throw new Error('SCHEDULE_DLQ_ARN is not configured');
  }
  if (event.RequestType === 'Delete') {
    return {
      phase: event.phase ?? 'records',
      scanned: 0,
      updated: 0,
      invalid: 0,
      continuationQueued: false,
    };
  }
  const phase = event.phase ?? 'records';
  const result = await withIamPropagationRetry(
    () =>
      phase === 'records'
        ? backfillScheduleRecordPage(event.nextToken, runtimeDependencies)
        : backfillScheduleTargetPage(event.nextToken, runtimeDependencies),
  );
  process.stdout.write(`${JSON.stringify({
    level: 'INFO',
    event: 'schedule_target_backfill_page_completed',
    ...result,
  })}\n`);
  return result;
}
