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
import {
  backfillScheduleTargetPage,
  type ScheduleTargetBackfillDependencies,
  type ScheduleTargetBackfillResult,
} from './backfill';

const SCHEDULE_GROUP = process.env.SCHEDULE_GROUP ?? '';
const FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME ?? '';
const PAGE_SIZE = 100;

interface ScheduleTargetBackfillEvent {
  RequestType?: 'Create' | 'Update' | 'Delete';
  nextToken?: string;
}

const scheduler = new SchedulerClient({});
const lambda = new LambdaClient({});

const runtimeDependencies: ScheduleTargetBackfillDependencies = {
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
};

export async function handler(
  event: ScheduleTargetBackfillEvent,
): Promise<ScheduleTargetBackfillResult> {
  if (!SCHEDULE_GROUP) throw new Error('SCHEDULE_GROUP is not configured');
  if (event.RequestType === 'Delete') {
    return { scanned: 0, updated: 0, continuationQueued: false };
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
