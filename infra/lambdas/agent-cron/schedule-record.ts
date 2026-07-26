import {
  DynamoDBDocumentClient,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';

const SAFE_EMAIL_RE = /^[\w%+.-]+@[\d.A-Za-z-]+\.[A-Za-z]{2,}$/;
const SCHEDULE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DM_SPACE_RE = /^spaces\/[\w-]{1,256}$/;

export interface ScheduleReferenceEvent {
  ownerEmail?: unknown;
  scheduleId?: unknown;
  version?: unknown;
}

export interface AuthorizedSchedule {
  userId: string;
  ownerEmail: string;
  scheduleId: string;
  version: number;
  name: string;
  prompt: string;
  enabled: true;
  dmSpaceName: string;
  googleIdentity?: string;
  displayName?: string;
  workspacePrefix: string;
}

export type ScheduleLoadResult =
  | { authorized: true; schedule: AuthorizedSchedule }
  | {
      authorized: false;
      reason:
        | 'invalid-reference'
        | 'not-found'
        | 'owner-mismatch'
        | 'version-mismatch'
        | 'disabled'
        | 'invalid-record';
    };

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Load and validate the one authoritative schedule record before any user
 * lookup, AgentCore invocation, or Chat delivery. EventBridge payload fields
 * beyond ownerEmail/scheduleId/version are intentionally ignored.
 */
export async function loadAuthorizedSchedule(
  event: ScheduleReferenceEvent,
  dynamo: DynamoDBDocumentClient,
  schedulesTable: string,
): Promise<ScheduleLoadResult> {
  if (
    typeof event?.ownerEmail !== 'string' ||
    event.ownerEmail !== event.ownerEmail.toLowerCase() ||
    !SAFE_EMAIL_RE.test(event.ownerEmail) ||
    typeof event.scheduleId !== 'string' ||
    !SCHEDULE_ID_RE.test(event.scheduleId) ||
    !Number.isInteger(event.version) ||
    (event.version as number) < 1 ||
    !schedulesTable
  ) {
    return { authorized: false, reason: 'invalid-reference' };
  }

  const response = await dynamo.send(
    new GetCommand({
      TableName: schedulesTable,
      Key: {
        userId: event.ownerEmail,
        scheduleId: event.scheduleId,
      },
      ConsistentRead: true,
    }),
  );
  if (!response.Item) {
    return { authorized: false, reason: 'not-found' };
  }
  const item: unknown = response.Item;
  if (!isObject(item)) {
    return { authorized: false, reason: 'invalid-record' };
  }
  if (
    item.userId !== event.ownerEmail ||
    item.ownerEmail !== event.ownerEmail ||
    item.scheduleId !== event.scheduleId
  ) {
    return { authorized: false, reason: 'owner-mismatch' };
  }
  if (item.version !== event.version) {
    return { authorized: false, reason: 'version-mismatch' };
  }
  if (item.enabled !== true) {
    return { authorized: false, reason: 'disabled' };
  }
  if (
    typeof item.name !== 'string' ||
    item.name.length < 1 ||
    item.name.length > 120 ||
    typeof item.prompt !== 'string' ||
    item.prompt.length < 1 ||
    item.prompt.length > 20_000 ||
    typeof item.dmSpaceName !== 'string' ||
    !DM_SPACE_RE.test(item.dmSpaceName) ||
    typeof item.workspacePrefix !== 'string' ||
    item.workspacePrefix.length < 1 ||
    item.workspacePrefix.length > 128 ||
    (item.displayName !== undefined &&
      (typeof item.displayName !== 'string' ||
        item.displayName.length > 200)) ||
    (item.googleIdentity !== undefined &&
      (typeof item.googleIdentity !== 'string' ||
        !/^users\/\d+$/.test(item.googleIdentity)))
  ) {
    return { authorized: false, reason: 'invalid-record' };
  }
  return {
    authorized: true,
    schedule: item as unknown as AuthorizedSchedule,
  };
}
