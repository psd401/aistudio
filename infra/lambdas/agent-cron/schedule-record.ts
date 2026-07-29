import type { GetCommandInput } from '@aws-sdk/lib-dynamodb';

const SAFE_EMAIL_RE = /^[\w%+.-]+@[\d.A-Za-z-]+\.[A-Za-z]{2,}$/;
const SCHEDULE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DM_SPACE_RE = /^spaces\/[\w-]{1,256}$/;

export interface ScheduleReferenceEvent {
  ownerEmail?: unknown;
  scheduleId?: unknown;
  version?: unknown;
  scheduledTime?: unknown;
}

export interface ScheduleRecordDynamoClient {
  get(input: GetCommandInput): Promise<{
    Item?: Record<string, unknown>;
  }>;
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

function isValidScheduleReference(
  event: ScheduleReferenceEvent,
  schedulesTable: string,
): event is {
  ownerEmail: string;
  scheduleId: string;
  version: number;
} {
  const ownerEmail = event.ownerEmail;
  const validOwner =
    typeof ownerEmail === 'string'
    && ownerEmail === ownerEmail.toLowerCase()
    && SAFE_EMAIL_RE.test(ownerEmail);
  const validScheduleId =
    typeof event.scheduleId === 'string'
    && SCHEDULE_ID_RE.test(event.scheduleId);
  const validVersion =
    Number.isInteger(event.version) && Number(event.version) >= 1;
  return validOwner && validScheduleId && validVersion && !!schedulesTable;
}

function hasMatchingScheduleOwner(
  item: Record<string, unknown>,
  event: { ownerEmail: string; scheduleId: string },
): boolean {
  return (
    item.userId === event.ownerEmail
    && item.ownerEmail === event.ownerEmail
    && item.scheduleId === event.scheduleId
  );
}

function hasValidOptionalIdentityFields(
  item: Record<string, unknown>,
): boolean {
  const validDisplayName =
    item.displayName === undefined
    || (
      typeof item.displayName === 'string'
      && item.displayName.length <= 200
    );
  const validGoogleIdentity =
    item.googleIdentity === undefined
    || (
      typeof item.googleIdentity === 'string'
      && /^users\/\d+$/.test(item.googleIdentity)
    );
  return validDisplayName && validGoogleIdentity;
}

function isBoundedString(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
  );
}

function hasValidScheduleContent(
  item: Record<string, unknown>,
): boolean {
  return (
    isBoundedString(item.name, 120)
    && isBoundedString(item.prompt, 20_000)
    && typeof item.dmSpaceName === 'string'
    && DM_SPACE_RE.test(item.dmSpaceName)
    && isBoundedString(item.workspacePrefix, 128)
    && hasValidOptionalIdentityFields(item)
  );
}

/**
 * Load and validate the one authoritative schedule record before any user
 * lookup, AgentCore invocation, or Chat delivery. EventBridge payload fields
 * beyond ownerEmail/scheduleId/version are intentionally ignored.
 */
export async function loadAuthorizedSchedule(
  event: ScheduleReferenceEvent,
  dynamo: ScheduleRecordDynamoClient,
  schedulesTable: string,
): Promise<ScheduleLoadResult> {
  if (!isValidScheduleReference(event, schedulesTable)) {
    return { authorized: false, reason: 'invalid-reference' };
  }

  const response = await dynamo.get({
    TableName: schedulesTable,
    Key: {
      userId: event.ownerEmail,
      scheduleId: event.scheduleId,
    },
    ConsistentRead: true,
  });
  if (!response.Item) {
    return { authorized: false, reason: 'not-found' };
  }
  const item: unknown = response.Item;
  if (!isObject(item)) {
    return { authorized: false, reason: 'invalid-record' };
  }
  if (!hasMatchingScheduleOwner(item, event)) {
    return { authorized: false, reason: 'owner-mismatch' };
  }
  if (item.version !== event.version) {
    return { authorized: false, reason: 'version-mismatch' };
  }
  if (item.enabled !== true) {
    return { authorized: false, reason: 'disabled' };
  }
  if (!hasValidScheduleContent(item)) {
    return { authorized: false, reason: 'invalid-record' };
  }
  return {
    authorized: true,
    schedule: item as unknown as AuthorizedSchedule,
  };
}
