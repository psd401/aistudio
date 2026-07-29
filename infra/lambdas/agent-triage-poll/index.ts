/**
 * Email Triage — per-user processing library.
 *
 * As of #1172 this file is a LIBRARY, not a Lambda entry point. The 5-minute
 * poll is fanned out (dispatcher.ts → SQS → worker.ts); the worker imports
 * `processUser` from here to do the actual per-user work:
 *   1. Mint a fresh Gmail access token (via lib/agent/workspace-token).
 *   2. Pull the user's Gmail history since their last cursor.
 *   3. For each new message: apply rules → maybe LLM → apply label →
 *      maybe escalate to Chat.
 *   4. For each user-driven label change: record as training signal.
 *   5. Advance cursor.
 *
 * The old in-Lambda serial `TRIAGE_USER_BATCH` loop is gone — one message
 * per user on a FIFO queue (group = userEmail) gives per-user single-flight
 * (the cursor-safety invariant the old reservedConcurrency=1 provided) while
 * running users in parallel.
 */

import {
  getFreshAccessTokenForUser,
  workspaceSecretId,
} from "./workspace-token";

import {
  extractFromEmail,
  extractSubject,
  getCurrentHistoryId,
  getMessageFullBody,
  getMessageMetadata,
  listLabels,
  listHistory,
  modifyMessage,
  modifyThread,
  threadHasUserReply,
} from "./gmail";
import {
  classifyWithLLM,
  finalizeLLMLabel,
  BODY_EXCERPT_MAX,
} from "./llm";
import {
  applyRules,
  shouldEscalate,
  type EmailFeatures,
} from "./rules";
import { postEscalation, postTaskOutcome, resolveDmSpace } from "./chat";
import {
  backfillDmSpaceName,
  claimTaskGesture,
  releaseTaskGestureClaim,
  getGoogleIdentityForEmail,
  getUserProfile,
  recordPollResult,
  recordTaskCreated,
  resetCursor,
} from "./storage";
import { requestTaskCreation } from "./agentcore";
import type {
  ClassifierResult,
  CorrectionRecord,
  DecisionRecord,
  TriageRow,
} from "./types";
import {
  resolveTrustedTriageLabelMapping,
  validateStoredTriageLabelMapping,
} from "./label-mapping";

const ENV = process.env.ENVIRONMENT ?? "dev";
const REGION = process.env.AWS_REGION ?? "us-east-1";
const validatedLabelMappings = new WeakMap<
  TriageRow,
  Promise<Record<"important" | "later" | "news" | "task", string> | null>
>();

export function log(
  level: "INFO" | "WARN" | "ERROR",
  evt: string,
  fields: Record<string, unknown>,
) {

  console.log(
    JSON.stringify({
      level,
      logger: "triage-poll",
      evt,
      timestamp: new Date().toISOString(),
      ...fields,
    }),
  );
}

/**
 * Mint a fresh Gmail access token for a user. Returns null and logs when
 * the token is missing or the grant was revoked (invalid_grant) — the
 * caller should skip that user, not crash the whole invocation. Exported
 * so the sweep path reuses the identical acquisition + skip semantics.
 */
export async function acquireUserAccessToken(
  userEmail: string,
): Promise<string | null> {
  try {
    const token = await getFreshAccessTokenForUser(
      userEmail,
      ENV,
      "user_account",
      REGION,
    );
    if (!token) {
      log("WARN", "no_token", {
        user: userEmail,
        secretId: workspaceSecretId(userEmail, ENV, "user_account"),
      });
      return null;
    }
    return token.access_token;
  } catch (err) {
    const errAny = err as Error & { code?: string };
    if (errAny.code === "invalid_grant") {
      // The user needs to re-consent. We just log and skip; the agent
      // will surface this when the user next interacts.
      log("WARN", "invalid_grant", { user: userEmail });
      return null;
    }
    throw err;
  }
}

async function trustedLabelIdsForRow(
  row: TriageRow,
  accessToken: string,
): Promise<Record<"important" | "later" | "news" | "task", string> | null> {
  let pending = validatedLabelMappings.get(row);
  if (!pending) {
    const stored = validateStoredTriageLabelMapping(row);
    if (!stored.valid) {
      log("ERROR", "untrusted_label_mapping", {
        user: row.userEmail,
        reason: stored.reason,
      });
      return null;
    }
    pending = resolveTrustedTriageLabelMapping(
      row,
      () => listLabels(accessToken)
    );
    validatedLabelMappings.set(row, pending);
  }
  return pending;
}

type HistoryEvent = Awaited<
  ReturnType<typeof listHistory>
>["events"][number];

async function collectMessageDecisions(
  row: TriageRow,
  accessToken: string,
  event: HistoryEvent,
  decisions: DecisionRecord[],
): Promise<number> {
  let escalated = 0;
  for (const item of event.messagesAdded ?? []) {
    try {
      const result = await classifyAndLabel(
        row,
        accessToken,
        item.message,
      );
      if (result) {
        decisions.push(result.decision);
        if (result.escalated) escalated += 1;
      }
    } catch (err) {
      log("ERROR", "classify_failed", {
        user: row.userEmail,
        messageId: item.message.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return escalated;
}

function collectCorrections(
  row: TriageRow,
  event: HistoryEvent,
  corrections: CorrectionRecord[],
): void {
  for (const item of event.labelsAdded ?? []) {
    const correction = detectCorrection(row, item, "added");
    if (correction) corrections.push(correction);
  }
  for (const item of event.labelsRemoved ?? []) {
    const correction = detectCorrection(row, item, "removed");
    if (correction) corrections.push(correction);
  }
}

function collectTaskGestures(
  row: TriageRow,
  event: HistoryEvent,
  taskGestures: Map<string, string>,
): void {
  const taskLabelId = row.labelIdsByKey?.task;
  if (!taskLabelId) return;
  for (const item of event.labelsAdded ?? []) {
    if (
      item.labelIds?.includes(taskLabelId) &&
      !taskGestures.has(item.message.threadId)
    ) {
      taskGestures.set(item.message.threadId, item.message.id);
    }
  }
}

async function processTaskGesturesForTick(
  row: TriageRow,
  accessToken: string,
  taskGestures: Map<string, string>,
): Promise<void> {
  if (taskGestures.size === 0) return;
  if (row.tasksMode !== "invoke-agent") {
    log("INFO", "task_gesture_ignored_mode_none", {
      user: row.userEmail,
      count: taskGestures.size,
    });
    return;
  }

  const gestureStart = Date.now();
  const budgetMs = 180_000;
  let processed = 0;
  let deferred = 0;
  for (const messageId of taskGestures.values()) {
    if (Date.now() - gestureStart > budgetMs) {
      deferred += 1;
      continue;
    }
    try {
      await processTaskGesture(row, accessToken, messageId);
      processed += 1;
    } catch (err) {
      log("ERROR", "task_gesture_failed", {
        user: row.userEmail,
        messageId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (deferred > 0) {
    log("WARN", "task_gestures_deferred", {
      user: row.userEmail,
      processed,
      deferred,
      elapsed_ms: Date.now() - gestureStart,
    });
  }
}

/**
 * Process one enabled user's live-triage tick. Exported for the SQS worker
 * (worker.ts) which invokes it once per `poll` message.
 */
export async function processUser(row: TriageRow): Promise<void> {
  const t0 = Date.now();

  // Acquire access token.
  const accessToken = await acquireUserAccessToken(row.userEmail);
  if (!accessToken) return;
  const trustedLabelIds = await trustedLabelIdsForRow(row, accessToken);
  if (!trustedLabelIds) return;
  row = { ...row, labelIdsByKey: trustedLabelIds };

  // Anchor cursor — when missing or on first run we capture "now" so we
  // only classify forward.
  let startHistoryId = row.lastHistoryId ?? row.classifierStartHistoryId;
  if (!startHistoryId) {
    startHistoryId = await getCurrentHistoryId(accessToken);
    await resetCursor(row.userEmail, startHistoryId);
    log("INFO", "cursor_anchored", { user: row.userEmail, historyId: startHistoryId });
    return; // nothing to do this tick — wait for next mail
  }

  // Pull diff.
  const { events, latestHistoryId, tooOld } = await listHistory(
    accessToken,
    startHistoryId,
  );
  if (tooOld) {
    const fresh = await getCurrentHistoryId(accessToken);
    await resetCursor(row.userEmail, fresh);
    log("WARN", "cursor_too_old_reset", {
      user: row.userEmail,
      stale: startHistoryId,
      fresh,
    });
    return;
  }

  const newDecisions: DecisionRecord[] = [];
  const newCorrections: CorrectionRecord[] = [];
  // Map of threadId → one representative messageId. When the user
  // labels a thread, Gmail fires a labelsAdded event for EACH message
  // in the thread — keying by thread (not message) collapses those
  // into a single gesture per thread. Bug 2026-05-22: keying by
  // messageId created N issues for an N-message thread.
  const taskGestures = new Map<string, string>();
  let escalated = 0;

  for (const event of events) {
    escalated += await collectMessageDecisions(
      row,
      accessToken,
      event,
      newDecisions,
    );
    collectCorrections(row, event, newCorrections);
    collectTaskGestures(row, event, taskGestures);
  }

  // Advance cursor FIRST, before any expensive gesture processing.
  // Reason: AgentCore calls can take ~100s each. If we processed
  // gestures first and the Lambda timed out, the cursor would stay
  // put and the next tick would replay the same labelsAdded events,
  // creating duplicates forever (observed 2026-05-22).
  //
  // The claim mechanism (claimTaskGesture) is the durable defense
  // against duplicates within a 30-min window; cursor advancement
  // ensures we don't reprocess the same Gmail history events at all.
  const cursor = latestHistoryId ?? startHistoryId;
  await recordPollResult(
    row.userEmail,
    { lastHistoryId: cursor, lastPollAt: new Date().toISOString() },
    newDecisions,
    newCorrections,
  );

  await processTaskGesturesForTick(row, accessToken, taskGestures);

  log("INFO", "user_processed", {
    user: row.userEmail,
    new_msgs: newDecisions.length,
    corrections: newCorrections.length,
    escalations: escalated,
    task_gestures: taskGestures.size,
    elapsed_ms: Date.now() - t0,
  });
}

// Gmail's built-in system labels. Anything else on a message means a
// human or a Gmail filter has already classified it — we shouldn't
// overwrite their decision with our own label. The classifier respects
// existing organisation.
//
// CATEGORY_* covers Gmail's Promotions/Social/Updates/Forums/etc.
// auto-categorisation — those keep INBOX so they're still "fresh" mail
// the user hasn't classified yet, so we DO want to classify them. We
// only skip CATEGORY_* when paired with another non-system label that
// indicates explicit filter action.
const GMAIL_SYSTEM_LABELS = new Set([
  "INBOX",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "SENT",
  "DRAFT",
  "TRASH",
  "SPAM",
  "CHAT",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
  "CATEGORY_RESERVATIONS",
  "CATEGORY_PURCHASES",
]);

/**
 * Decide whether a message has already been triaged by something other
 * than us — a Gmail filter, a user action, or anything that already
 * organised the message.
 *
 * Skip rules:
 *   1. Any user-defined label that isn't one of ours → filter/user
 *      already classified it.
 *   2. INBOX is absent → either a "Skip Inbox" filter archived it, the
 *      user manually archived before we got there, or it's a draft/sent
 *      we shouldn't touch.
 *
 * On 2026-05-22 hagelk reported messages with existing filter labels
 * were being double-labelled with @psd/Later. This guard prevents that
 * from recurring.
 */
function shouldSkipMessage(
  row: TriageRow,
  labelIds: string[] | undefined,
): { skip: true; reason: string } | { skip: false } {
  const labels = labelIds ?? [];
  if (!labels.includes("INBOX")) {
    return { skip: true, reason: "no-inbox" };
  }
  const ourLabelIds = new Set(Object.values(row.labelIdsByKey ?? {}));
  const nonSystemNonOurs = labels.filter(
    (id) => !GMAIL_SYSTEM_LABELS.has(id) && !ourLabelIds.has(id),
  );
  if (nonSystemNonOurs.length > 0) {
    return { skip: true, reason: `existing-labels:${nonSystemNonOurs.join(",")}` };
  }
  return { skip: false };
}

async function classifyMessage(
  row: TriageRow,
  accessToken: string,
  messageId: string,
  features: EmailFeatures,
): Promise<ClassifierResult> {
  const ruleDecision = applyRules(features, row.rules);
  if ("label" in ruleDecision) {
    return {
      label: ruleDecision.label,
      confidence: 1,
      reason: ruleDecision.reason,
      source: "rule",
    };
  }

  const internalDomain =
    row.internalDomain ?? row.userEmail.split("@")[1] ?? "";
  let bodyExcerpt: string | undefined;
  try {
    const full = await getMessageFullBody(
      accessToken,
      messageId,
      BODY_EXCERPT_MAX,
    );
    if (full?.trim()) bodyExcerpt = full;
  } catch (err) {
    log("WARN", "body_fetch_failed", {
      user: row.userEmail,
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  const llm = await classifyWithLLM(features, row.rules, internalDomain, {
    bodyExcerpt,
    learnedPatterns: row.learnedPatterns ?? [],
    recentCorrections: row.recentCorrections ?? [],
  });
  const finalized = finalizeLLMLabel(llm);
  return {
    label: finalized.label,
    confidence: finalized.confidence,
    reason: finalized.reason,
    source: "llm",
  };
}

async function resolveDmSpaceForRow(
  row: TriageRow,
  logEvent: string,
): Promise<string | undefined> {
  if (row.dmSpaceName) return row.dmSpaceName;
  const googleIdentity = await getGoogleIdentityForEmail(row.userEmail);
  if (!googleIdentity) return undefined;
  const dmSpaceName = (await resolveDmSpace(googleIdentity)) ?? undefined;
  if (dmSpaceName) {
    await backfillDmSpaceName(row.userEmail, dmSpaceName);
    log("INFO", logEvent, {
      user: row.userEmail,
      space: dmSpaceName,
    });
  }
  return dmSpaceName;
}

interface EscalationContext {
  features: EmailFeatures;
  meta: NonNullable<Awaited<ReturnType<typeof getMessageMetadata>>>;
  msgRef: { id: string; threadId: string };
  result: ClassifierResult;
  row: TriageRow;
  suppressEscalation: boolean;
}

async function maybeEscalateMessage({
  features,
  meta,
  msgRef,
  result,
  row,
  suppressEscalation,
}: EscalationContext): Promise<boolean> {
  if (suppressEscalation) return false;
  const escalation = shouldEscalate({
    label: result.label,
    source: result.source,
    confidence: result.confidence,
    features,
    escalation: row.escalation,
    mode: row.escalationMode,
    confidenceThreshold: row.escalationConfidenceThreshold,
  });
  if (!escalation.escalate) return false;
  const dmSpaceName = await resolveDmSpaceForRow(
    row,
    "dm_space_backfilled_escalation",
  );
  if (!dmSpaceName) return false;

  try {
    await postEscalation({
      dmSpaceName,
      userEmail: row.userEmail,
      label: result.label,
      message: {
        id: msgRef.id,
        threadId: msgRef.threadId,
        fromEmail: features.fromEmail,
        subject: features.subject,
        snippet: meta.snippet ?? "",
        internalDate: meta.internalDate ?? "",
        labelIds: meta.labelIds ?? [],
      },
      reason: escalation.reason,
    });
    return true;
  } catch (err) {
    log("ERROR", "escalation_failed", {
      user: row.userEmail,
      messageId: msgRef.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function classifyAndLabel(
  row: TriageRow,
  accessToken: string,
  msgRef: { id: string; threadId: string; labelIds?: string[] },
  opts: { suppressEscalation?: boolean } = {},
): Promise<{ decision: DecisionRecord; escalated: boolean } | null> {
  const trustedLabelIds = await trustedLabelIdsForRow(row, accessToken);
  if (!trustedLabelIds) return null;
  row = { ...row, labelIdsByKey: trustedLabelIds };

  // Fetch metadata — needed for sender + subject + snippet.
  const meta = await getMessageMetadata(accessToken, msgRef.id);
  if (!meta) return null;

  // Respect anything that already triaged this message (Gmail filters,
  // the user's own labelling, Skip-Inbox filters, etc.). meta.labelIds
  // is the current authoritative state from Gmail; msgRef.labelIds from
  // the history event can be stale by ~seconds. We trust meta.
  const skip = shouldSkipMessage(row, meta.labelIds);
  if (skip.skip) {
    log("INFO", "skip_already_triaged", {
      user: row.userEmail,
      messageId: msgRef.id,
      reason: skip.reason,
    });
    return null;
  }

  const features = await buildFeatures(row, accessToken, meta);
  const result = await classifyMessage(
    row,
    accessToken,
    msgRef.id,
    features,
  );

  // Apply the label via Gmail.
  const labelId = row.labelIdsByKey?.[result.label];
  if (!labelId) {
    log("WARN", "missing_label_id", { user: row.userEmail, key: result.label });
    return null;
  }
  // The mapping has been provenance-checked and confirmed against live Gmail
  // above, so preserving the product's folder semantics is safe here.
  await modifyMessage(accessToken, msgRef.id, [labelId], ["INBOX"]);

  const record: DecisionRecord = {
    messageId: msgRef.id,
    threadId: msgRef.threadId,
    label: result.label,
    source: result.source,
    reason: result.reason,
    confidence: result.confidence,
    ts: new Date().toISOString(),
    fromEmail: features.fromEmail,
    subject: features.subject,
  };

  const escalated = await maybeEscalateMessage({
    features,
    meta,
    msgRef,
    result,
    row,
    suppressEscalation: opts.suppressEscalation ?? false,
  });

  return { decision: record, escalated };
}

async function buildFeatures(
  row: TriageRow,
  accessToken: string,
  meta: NonNullable<Awaited<ReturnType<typeof getMessageMetadata>>>,
): Promise<EmailFeatures> {
  const fromEmail = extractFromEmail(meta);
  const subject = extractSubject(meta);
  const snippet = meta.snippet ?? "";
  const fromDomain = fromEmail.split("@")[1] ?? "";
  const internalDomain = row.internalDomain ?? row.userEmail.split("@")[1] ?? "";
  const isInternal = fromDomain.toLowerCase() === internalDomain.toLowerCase();
  let hasUserReply = false;
  if (meta.threadId) {
    try {
      hasUserReply = await threadHasUserReply(accessToken, meta.threadId);
    } catch {
      // Treat as no-reply; rules engine falls back to other signals.
    }
  }
  return {
    fromEmail,
    fromDomain,
    isInternal,
    subject,
    subjectLower: subject.toLowerCase(),
    snippetLower: snippet.toLowerCase(),
    hasUserReply,
  };
}

/**
 * Detect when the user moved a recently-classified message between
 * labels in a way that contradicts our prior decision. We only record
 * INBOX-direction movement: removing INBOX (= archiving) by the user
 * after we labeled `important` means we got it wrong (they didn't want
 * to see it); adding INBOX after we labeled `later` means we got it
 * wrong (they DID want to see it).
 *
 * Phase 1 records corrections only. Phase 2 will act on them to update
 * `learnedPatterns`.
 */
function detectCorrection(
  row: TriageRow,
  evt: {
    message: { id: string; labelIds?: string[] };
    labelIds: string[];
  },
  direction: "added" | "removed",
): CorrectionRecord | null {
  const prior = (row.recentDecisions ?? []).find((d) => d.messageId === evt.message.id);
  if (!prior) return null;

  const inboxInEvent = evt.labelIds.includes("INBOX");
  // Snapshot the sender from the prior decision so the nightly learning
  // job (#1172) can attribute the correction to a sender/domain.
  const fromEmail = prior.fromEmail;
  const fromDomain = fromEmail ? fromEmail.split("@")[1] : undefined;

  // Direction "added" + INBOX in labelIds = user moved message back to
  // inbox (un-archived) after we classified it as later/news → we got
  // it wrong, they DID want to see it.
  if (direction === "added" && inboxInEvent && prior.label !== "important") {
    return {
      messageId: evt.message.id,
      fromLabel: prior.label,
      toLabel: "inbox",
      ts: new Date().toISOString(),
      fromEmail,
      fromDomain,
    };
  }

  // Direction "removed" + INBOX in labelIds = user archived a message
  // we classified as "important" → we got it wrong, they didn't want
  // to see it. Previously this branch was dead (hardcoded false).
  if (direction === "removed" && inboxInEvent && prior.label === "important") {
    return {
      messageId: evt.message.id,
      fromLabel: prior.label,
      toLabel: "archived",
      ts: new Date().toISOString(),
      fromEmail,
      fromDomain,
    };
  }

  return null;
}

// Re-exported for unit tests outside the handler.
export { detectCorrection };

interface TaskGestureContext {
  fromEmail: string;
  meta: NonNullable<Awaited<ReturnType<typeof getMessageMetadata>>>;
  result: Awaited<ReturnType<typeof requestTaskCreation>>;
  subject: string;
}

async function loadTaskGestureContext(
  row: TriageRow,
  accessToken: string,
  messageId: string,
): Promise<TaskGestureContext | null> {
  const meta = await getMessageMetadata(accessToken, messageId);
  if (!meta) {
    log("WARN", "task_gesture_meta_missing", {
      user: row.userEmail,
      messageId,
    });
    return null;
  }
  const taskLabelId = row.labelIdsByKey?.task;
  if (taskLabelId && !(meta.labelIds ?? []).includes(taskLabelId)) {
    log("INFO", "task_gesture_stale_label_removed", {
      user: row.userEmail,
      messageId,
    });
    return null;
  }

  const fromEmail = extractFromEmail(meta);
  const subject = extractSubject(meta);
  let bodyText = meta.snippet ?? "";
  try {
    const full = await getMessageFullBody(accessToken, messageId);
    if (full?.trim()) bodyText = full;
  } catch (err) {
    log("WARN", "task_gesture_body_fetch_failed", {
      user: row.userEmail,
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const profile = await getUserProfile(row.userEmail);
  if (!profile?.workspacePrefix) {
    log("ERROR", "task_gesture_no_workspace_prefix", {
      user: row.userEmail,
      messageId,
    });
    return null;
  }
  const result = await requestTaskCreation({
    userEmail: row.userEmail,
    workspacePrefix: profile.workspacePrefix,
    agentcoreRuntimeId: row.agentcoreRuntimeId,
    subject,
    fromEmail,
    snippet: bodyText,
    threadId: meta.threadId,
    messageId,
  });
  return { fromEmail, meta, result, subject };
}

interface TaskOutcomeContext {
  accessToken: string;
  context: TaskGestureContext;
  dmSpaceName: string | undefined;
  messageId: string;
  row: TriageRow;
  startedAt: number;
}

async function completeTaskGesture({
  accessToken,
  context,
  dmSpaceName,
  messageId,
  row,
  startedAt,
}: TaskOutcomeContext): Promise<void> {
  if (!context.result.ok) return;
  const taskLabelId = row.labelIdsByKey?.task;
  const removeLabelIds = taskLabelId
    ? ["INBOX", taskLabelId]
    : ["INBOX"];
  try {
    await modifyThread(
      accessToken,
      context.meta.threadId,
      [],
      removeLabelIds,
    );
  } catch (err) {
    log("WARN", "task_archive_failed", {
      user: row.userEmail,
      messageId,
      taskRef: context.result.taskRef,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  await recordTaskCreated(
    row.userEmail,
    messageId,
    context.result.taskRef,
    new Date().toISOString(),
  );
  log("INFO", "task_gesture_ok", {
    user: row.userEmail,
    messageId,
    taskRef: context.result.taskRef,
    elapsed_ms: Date.now() - startedAt,
  });
  if (!row.tasksNotifySuccess || !dmSpaceName) return;
  try {
    await postTaskOutcome({
      dmSpaceName,
      subject: context.subject,
      fromEmail: context.fromEmail,
      messageId,
      ok: true,
      taskRef: context.result.taskRef,
    });
  } catch (err) {
    log("WARN", "task_success_notify_failed", {
      user: row.userEmail,
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function failTaskGesture({
  context,
  dmSpaceName,
  messageId,
  row,
  startedAt,
}: TaskOutcomeContext): Promise<void> {
  if (context.result.ok) return;
  await releaseTaskGestureClaim(row.userEmail, messageId);
  log("ERROR", "task_gesture_failed", {
    user: row.userEmail,
    messageId,
    reason: context.result.reason,
    elapsed_ms: Date.now() - startedAt,
  });
  if (!dmSpaceName) return;
  try {
    await postTaskOutcome({
      dmSpaceName,
      subject: context.subject,
      fromEmail: context.fromEmail,
      messageId,
      ok: false,
      reason: context.result.reason,
    });
  } catch (err) {
    log("WARN", "task_failure_notify_failed", {
      user: row.userEmail,
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Handle a single @psd/Task user gesture.
 *
 *   1. Fetch the email metadata so the AgentCore prompt is well-formed.
 *   2. Invoke AgentCore — the user's MEMORY.md tells the agent how to
 *      create the task in their preferred system. We deliver metadata,
 *      the agent does the work.
 *   3. Parse the agent's terse reply for success/failure.
 *   4. On success: archive and remove @psd/Task.
 *   5. On success: record an audit trail entry (recentTaskCreations).
 *   6. On success: optional confirmation card if tasksNotifySuccess=true.
 *   7. On failure: leave the email as-is (still in Inbox + @psd/Task)
 *      and post a Chat card explaining the failure + the retry path.
 *
 * Failures intentionally don't roll back any state — the email keeps
 * its label so a remove + re-add gesture from the user re-triggers
 * cleanly on the next tick.
 */
async function processTaskGesture(
  row: TriageRow,
  accessToken: string,
  messageId: string,
): Promise<void> {
  const t0 = Date.now();
  // Atomic claim — if another tick already started this gesture, bail.
  // Defends against AgentCore-slow + cursor-not-advanced + concurrent-tick
  // duplication. The claim lives for 30 minutes; expired claims are
  // treated as available again so a stuck invocation can be re-tried.
  const claimed = await claimTaskGesture(row.userEmail, messageId);
  if (!claimed) {
    log("INFO", "task_gesture_already_claimed", {
      user: row.userEmail,
      messageId,
    });
    return;
  }
  const context = await loadTaskGestureContext(
    row,
    accessToken,
    messageId,
  );
  if (!context) return;
  const dmSpaceName = await resolveDmSpaceForRow(
    row,
    "dm_space_backfilled",
  );
  const outcomeContext = {
    accessToken,
    context,
    dmSpaceName,
    messageId,
    row,
    startedAt: t0,
  };
  if (context.result.ok) {
    await completeTaskGesture(outcomeContext);
  } else {
    await failTaskGesture(outcomeContext);
  }
}
