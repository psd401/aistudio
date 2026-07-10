/**
 * DynamoDB helpers for the triage table — Document Client wrapper
 * around the table created in agent-platform-stack.ts.
 *
 * One row per user. Read-modify-write isn't atomic but it doesn't need
 * to be: the classifier Lambda is the only writer for the cursor/decision
 * fields (5-min schedule, single writer), and the agent skill is the
 * only writer for rules/escalation (per-user, low frequency).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import type {
  CorrectionRecord,
  DecisionRecord,
  LearnedPattern,
  Suggestion,
  SweepState,
  TriageRow,
} from "./types";

const TABLE = process.env.TRIAGE_TABLE ?? "";

let cached: DynamoDBDocumentClient | null = null;
function ddb(): DynamoDBDocumentClient {
  if (!cached) {
    cached = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: process.env.AWS_REGION ?? "us-east-1" }),
      { marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true } },
    );
  }
  return cached;
}

/**
 * Scan all rows with `enabled = true`. At 1000-user scale this is one
 * page of <100 KB — paginate just in case it grows past the 1 MB scan
 * page size.
 */
export async function listEnabledUsers(): Promise<TriageRow[]> {
  const rows: TriageRow[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const resp = await ddb().send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression: "enabled = :t",
        ExpressionAttributeValues: { ":t": true },
        ExclusiveStartKey: lastKey,
      }),
    );
    rows.push(...((resp.Items ?? []) as TriageRow[]));
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);
  return rows;
}

export async function getTriageRow(userEmail: string): Promise<TriageRow | null> {
  const resp = await ddb().send(
    new GetCommand({ TableName: TABLE, Key: { userEmail } }),
  );
  return (resp.Item as TriageRow) ?? null;
}

const USERS_TABLE = process.env.USERS_TABLE ?? "";

/**
 * Find a user's googleIdentity from the agent users table by email.
 * Used by the @psd/Task gesture path to resolve a DM space when one
 * isn't cached on the triage row yet. Returns null when the user has
 * never been registered (shouldn't happen for enabled triage users,
 * but be defensive).
 */
export async function getGoogleIdentityForEmail(
  email: string,
): Promise<string | null> {
  const profile = await getUserProfile(email);
  return profile?.googleIdentity ?? null;
}

/**
 * Look up a user's full profile from the agent users table by email.
 * Returns `workspacePrefix` (the S3 prefix the agent mounts) and
 * `googleIdentity` (the Chat user resource name). Result is cached
 * for 5 minutes per email to avoid hammering DDB on every gesture.
 *
 * `workspacePrefix` is the actual S3 prefix (e.g. `hagelk-db0f32b5`,
 * NOT just the local-part of the email). Deriving it from the email
 * loses the random suffix — bug observed 2026-05-22 when MEMORY.md
 * couldn't be fetched.
 */
const profileCache = new Map<string, { profile: UserProfile | null; t: number }>();
const PROFILE_TTL_MS = 5 * 60_000;

export interface UserProfile {
  googleIdentity?: string;
  workspacePrefix?: string;
}

export async function getUserProfile(email: string): Promise<UserProfile | null> {
  if (!USERS_TABLE) return null;
  const cached = profileCache.get(email);
  if (cached && Date.now() - cached.t < PROFILE_TTL_MS) return cached.profile;
  // Use the email-index GSI (same as agent-router's resolveUserByEmailPrefix)
  // instead of a full-table Scan. O(1) vs O(N) and avoids the multi-page
  // pagination bug that hit Scan on 2026-05-22.
  const lowered = email.toLowerCase();
  let item: UserProfile | undefined;
  try {
    const resp = await ddb().send(
      new QueryCommand({
        TableName: USERS_TABLE,
        IndexName: "email-index",
        KeyConditionExpression: "email = :e",
        ExpressionAttributeValues: { ":e": lowered },
        Limit: 1,
      }),
    );
    if (resp.Items && resp.Items.length > 0) {
      item = resp.Items[0] as UserProfile;
    }
  } catch {
    // Fall back to Scan if GSI doesn't exist (e.g., local dev). This
    // preserves backward compatibility while preferring the fast path.
    let lastKey: Record<string, unknown> | undefined;
    do {
      const resp = await ddb().send(
        new ScanCommand({
          TableName: USERS_TABLE,
          FilterExpression: "email = :e",
          ExpressionAttributeValues: { ":e": lowered },
          ExclusiveStartKey: lastKey,
        }),
      );
      if (resp.Items && resp.Items.length > 0) {
        item = resp.Items[0] as UserProfile;
        break;
      }
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);
  }
  const profile = item
    ? {
        googleIdentity: item.googleIdentity,
        workspacePrefix: item.workspacePrefix,
      }
    : null;
  profileCache.set(email, { profile, t: Date.now() });
  return profile;
}

/**
 * Atomically claim a task gesture for processing. Writes
 * `taskGestureClaims.<messageId> = nowIso` only if the messageId isn't
 * already claimed (or its claim is older than `ttlMinutes`).
 *
 * Returns true if the claim was acquired (caller should proceed with
 * AgentCore invocation), false if someone else already holds it
 * (caller should skip).
 *
 * This is the durable defense against the 2026-05-22 duplicate-task
 * loop: AgentCore takes ~100s, Gmail's history.list returns the same
 * labelsAdded event in the next tick's window, and we have no other
 * way to know "we already started on this." With the claim, even if
 * concurrency=1 fails or the cursor doesn't advance fast enough, the
 * second attempt sees the existing claim and bails.
 */
export async function claimTaskGesture(
  userEmail: string,
  messageId: string,
  ttlMinutes = 30,
  _depth = 0,
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const ttlCutoffIso = new Date(Date.now() - ttlMinutes * 60_000).toISOString();
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { userEmail },
        UpdateExpression:
          "SET taskGestureClaims.#mid = :now",
        ConditionExpression:
          "attribute_not_exists(taskGestureClaims) OR " +
          "attribute_not_exists(taskGestureClaims.#mid) OR " +
          "taskGestureClaims.#mid < :ttl",
        ExpressionAttributeNames: { "#mid": messageId },
        ExpressionAttributeValues: { ":now": nowIso, ":ttl": ttlCutoffIso },
      }),
    );
    return true;
  } catch (err) {
    // ConditionalCheckFailed means someone else holds it.
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      return false;
    }
    // The claims map doesn't exist yet — initialize it then retry.
    // Depth guard prevents infinite recursion if the init + retry
    // both fail for an unexpected reason.
    if (
      _depth < 1 &&
      (err as { name?: string }).name === "ValidationException" &&
      String((err as Error).message).includes("document path")
    ) {
      await ddb().send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { userEmail },
          UpdateExpression:
            "SET taskGestureClaims = if_not_exists(taskGestureClaims, :empty)",
          ExpressionAttributeValues: { ":empty": {} },
        }),
      );
      return claimTaskGesture(userEmail, messageId, ttlMinutes, _depth + 1);
    }
    throw err;
  }
}

/**
 * Release a claim that didn't result in a successful task creation, so
 * the next tick (or a manual re-label by the user) can retry cleanly.
 * Only successes should keep the claim — failures aren't a real
 * downstream side-effect to dedupe.
 */
export async function releaseTaskGestureClaim(
  userEmail: string,
  messageId: string,
): Promise<void> {
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { userEmail },
        UpdateExpression: "REMOVE taskGestureClaims.#mid",
        ExpressionAttributeNames: { "#mid": messageId },
      }),
    );
  } catch {
    // Best-effort — if the path doesn't exist or the attribute is gone,
    // there's nothing to release. Don't throw.
  }
}

/** Persist a freshly-resolved DM space resource name onto the triage row. */
export async function backfillDmSpaceName(
  userEmail: string,
  dmSpaceName: string,
): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { userEmail },
      UpdateExpression: "SET dmSpaceName = :s",
      ExpressionAttributeValues: { ":s": dmSpaceName },
    }),
  );
}

/**
 * Update the cursor and append to the rolling decisions/corrections
 * arrays. We use DynamoDB list_append + a separate trimming step so the
 * arrays stay at most ~20 elements long.
 *
 * Calls UpdateItem twice when trimming is needed: once to append, once
 * to slice. The two-step is fine because the classifier Lambda is the
 * only writer for these fields — no one else races us.
 */
export async function recordPollResult(
  userEmail: string,
  cursorUpdate: {
    lastHistoryId: string;
    lastPollAt: string;
  },
  newDecisions: DecisionRecord[],
  newCorrections: CorrectionRecord[],
): Promise<void> {
  const RECENT_MAX = 20;

  // Append + cursor update in one call so the cursor moves only when
  // we successfully recorded what we did at this cursor.
  if (newDecisions.length > 0 || newCorrections.length > 0) {
    await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { userEmail },
        UpdateExpression: [
          "SET lastHistoryId = :h",
          "lastPollAt = :p",
          newDecisions.length > 0
            ? "recentDecisions = list_append(if_not_exists(recentDecisions, :empty), :d)"
            : null,
          newCorrections.length > 0
            ? "recentCorrections = list_append(if_not_exists(recentCorrections, :empty), :c)"
            : null,
        ]
          .filter(Boolean)
          .join(", "),
        ExpressionAttributeValues: {
          ":h": cursorUpdate.lastHistoryId,
          ":p": cursorUpdate.lastPollAt,
          ":empty": [],
          ...(newDecisions.length > 0 ? { ":d": newDecisions } : {}),
          ...(newCorrections.length > 0 ? { ":c": newCorrections } : {}),
        },
      }),
    );
    // Re-read and trim — separate call because DynamoDB doesn't have an
    // atomic "append then truncate to last N" primitive. Cost: one extra
    // RU per poll-with-new-decisions. Fine at our scale.
    const row = await getTriageRow(userEmail);
    if (row) {
      const trimmedDecisions = (row.recentDecisions ?? []).slice(-RECENT_MAX);
      const trimmedCorrections = (row.recentCorrections ?? []).slice(-RECENT_MAX);
      if (
        trimmedDecisions.length < (row.recentDecisions ?? []).length ||
        trimmedCorrections.length < (row.recentCorrections ?? []).length
      ) {
        await ddb().send(
          new UpdateCommand({
            TableName: TABLE,
            Key: { userEmail },
            UpdateExpression: "SET recentDecisions = :d, recentCorrections = :c",
            ExpressionAttributeValues: {
              ":d": trimmedDecisions,
              ":c": trimmedCorrections,
            },
          }),
        );
      }
    }
  } else {
    // Nothing happened — just advance the cursor so we don't re-scan
    // the same empty window next time.
    await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { userEmail },
        UpdateExpression: "SET lastHistoryId = :h, lastPollAt = :p",
        ExpressionAttributeValues: {
          ":h": cursorUpdate.lastHistoryId,
          ":p": cursorUpdate.lastPollAt,
        },
      }),
    );
  }
}

/**
 * Mark a single message as having had a task successfully created.
 * Stored on a separate attribute so the lookup by messageId is O(1).
 * Used by the @psd/Task gesture path (Phase 1.5) — when the user
 * re-labels a message, we DO want to re-create a task (matches the
 * "removing and re-adding is a deliberate fresh gesture" rule), so
 * this isn't a dedup key; it's just an audit trail.
 */
export async function recordTaskCreated(
  userEmail: string,
  messageId: string,
  taskRef: string,
  ts: string,
): Promise<void> {
  const RECENT_MAX = 20;
  // Append the new entry.
  await ddb().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { userEmail },
      UpdateExpression:
        "SET recentTaskCreations = list_append(if_not_exists(recentTaskCreations, :empty), :entry)",
      ExpressionAttributeValues: {
        ":empty": [],
        ":entry": [{ messageId, taskRef, ts }],
      },
    }),
  );
  // Trim to keep at most RECENT_MAX entries (same rolling-window pattern
  // as recentDecisions/recentCorrections in recordPollResult).
  const row = await getTriageRow(userEmail);
  if (row) {
    const current = (row as unknown as { recentTaskCreations?: unknown[] }).recentTaskCreations ?? [];
    if (current.length > RECENT_MAX) {
      const trimmed = current.slice(-RECENT_MAX);
      await ddb().send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { userEmail },
          UpdateExpression: "SET recentTaskCreations = :t",
          ExpressionAttributeValues: { ":t": trimmed },
        }),
      );
    }
  }
}

/**
 * Persist one initial-inbox-sweep slice (#1172): append the decisions
 * recorded during this slice (trimmed to the rolling window) and update
 * the `sweep` state map (status, pageToken, counts). Kept separate from
 * recordPollResult so a sweep never touches the live Gmail-history cursor
 * (`lastHistoryId`) — the two run independently.
 */
export async function recordSweepSlice(
  userEmail: string,
  newDecisions: DecisionRecord[],
  sweep: SweepState,
): Promise<void> {
  const RECENT_MAX = 20;
  if (newDecisions.length > 0) {
    await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { userEmail },
        UpdateExpression:
          "SET recentDecisions = list_append(if_not_exists(recentDecisions, :empty), :d), sweep = :s",
        ExpressionAttributeValues: {
          ":empty": [],
          ":d": newDecisions,
          ":s": sweep,
        },
      }),
    );
    // Trim the rolling decisions window — same two-step pattern as
    // recordPollResult (DynamoDB has no atomic append-then-truncate).
    const row = await getTriageRow(userEmail);
    if (row) {
      const trimmed = (row.recentDecisions ?? []).slice(-RECENT_MAX);
      if (trimmed.length < (row.recentDecisions ?? []).length) {
        await ddb().send(
          new UpdateCommand({
            TableName: TABLE,
            Key: { userEmail },
            UpdateExpression: "SET recentDecisions = :d",
            ExpressionAttributeValues: { ":d": trimmed },
          }),
        );
      }
    }
  } else {
    await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { userEmail },
        UpdateExpression: "SET sweep = :s",
        ExpressionAttributeValues: { ":s": sweep },
      }),
    );
  }
}

/**
 * Persist the output of the nightly learning job (#1172): the soft
 * `learnedPatterns` (LLM hints) and the merged `pendingSuggestions`
 * (user-approvable rule changes). `learnedAt` timestamps the run so the
 * admin page + skill can show freshness.
 */
export async function saveLearning(
  userEmail: string,
  learnedPatterns: LearnedPattern[],
  pendingSuggestions: Suggestion[],
  learnedAt: string,
): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { userEmail },
      UpdateExpression:
        "SET learnedPatterns = :lp, pendingSuggestions = :ps, learnedAt = :at",
      ExpressionAttributeValues: {
        ":lp": learnedPatterns,
        ":ps": pendingSuggestions,
        ":at": learnedAt,
      },
    }),
  );
}

/**
 * Hard-reset the cursor — used when Gmail rejects our startHistoryId
 * as too old (>7 days retention) and we have to re-anchor to "now."
 * We log a warning so the operator dashboard can show "this user
 * stopped getting classified for N days, just recovered."
 */
export async function resetCursor(
  userEmail: string,
  freshHistoryId: string,
): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { userEmail },
      UpdateExpression: "SET lastHistoryId = :h, lastPollAt = :p, cursorResetAt = :p",
      ExpressionAttributeValues: {
        ":h": freshHistoryId,
        ":p": new Date().toISOString(),
      },
    }),
  );
}
