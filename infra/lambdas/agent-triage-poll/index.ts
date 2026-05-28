/**
 * Email Triage Classifier Lambda
 *
 * Triggered every 5 minutes by an EventBridge Rule. For each opted-in
 * user in the triage table:
 *   1. Mint a fresh Gmail access token (via lib/agent/workspace-token).
 *   2. Pull the user's Gmail history since their last cursor.
 *   3. For each new message: apply rules → maybe LLM → apply label →
 *      maybe escalate to Chat.
 *   4. For each user-driven label change: record as training signal.
 *   5. Advance cursor.
 *
 * The Lambda processes users in parallel batches of TRIAGE_USER_BATCH so
 * one slow user doesn't block the rest. Per-user errors are logged and
 * skipped — the next 5-minute tick picks up where it left off.
 */

import type { ScheduledHandler } from "aws-lambda";

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
  listHistory,
  modifyMessage,
  modifyThread,
  threadHasUserReply,
  type HistoryEvent,
} from "./gmail";
import { classifyWithLLM } from "./llm";
import {
  applyRules,
  shouldEscalate,
  type EmailFeatures,
  type Label,
} from "./rules";
import { postEscalation, postTaskOutcome, resolveDmSpace } from "./chat";
import {
  backfillDmSpaceName,
  claimTaskGesture,
  releaseTaskGestureClaim,
  getGoogleIdentityForEmail,
  getTriageRow,
  getUserProfile,
  listEnabledUsers,
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

const ENV = process.env.ENVIRONMENT ?? "dev";
const REGION = process.env.AWS_REGION ?? "us-east-1";
const USER_BATCH = parseInt(process.env.TRIAGE_USER_BATCH ?? "10", 10);
const RULES_CONFIDENCE_FLOOR = 0.6;

function log(level: "INFO" | "WARN" | "ERROR", evt: string, fields: Record<string, unknown>) {
  // eslint-disable-next-line no-console
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

export const handler: ScheduledHandler = async () => {
  const startedAt = Date.now();
  const users = await listEnabledUsers();
  log("INFO", "tick_start", { opted_in: users.length });

  for (let i = 0; i < users.length; i += USER_BATCH) {
    const batch = users.slice(i, i + USER_BATCH);
    await Promise.all(batch.map((row) => processUserSafe(row)));
  }

  log("INFO", "tick_complete", {
    opted_in: users.length,
    elapsed_ms: Date.now() - startedAt,
  });
};

async function processUserSafe(row: TriageRow): Promise<void> {
  try {
    await processUser(row);
  } catch (err) {
    log("ERROR", "user_processing_failed", {
      user: row.userEmail,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function processUser(row: TriageRow): Promise<void> {
  const t0 = Date.now();

  // Acquire access token.
  let accessToken: string;
  try {
    const token = await getFreshAccessTokenForUser(
      row.userEmail,
      ENV,
      "user_account",
      REGION,
    );
    if (!token) {
      log("WARN", "no_token", {
        user: row.userEmail,
        secretId: workspaceSecretId(row.userEmail, ENV, "user_account"),
      });
      return;
    }
    accessToken = token.access_token;
  } catch (err) {
    const errAny = err as Error & { code?: string };
    if (errAny.code === "invalid_grant") {
      // The user needs to re-consent. Phase 1 doesn't auto-disable —
      // we just log and skip; the next tick will skip again. The
      // agent will surface this when the user next interacts.
      log("WARN", "invalid_grant", { user: row.userEmail });
      return;
    }
    throw err;
  }

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
    // New messages → classify + label.
    for (const m of event.messagesAdded ?? []) {
      try {
        const decision = await classifyAndLabel(row, accessToken, m.message);
        if (decision) {
          newDecisions.push(decision.decision);
          if (decision.escalated) escalated++;
        }
      } catch (err) {
        log("ERROR", "classify_failed", {
          user: row.userEmail,
          messageId: m.message.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // User-driven label changes → training signal.
    for (const evt of [
      ...(event.labelsAdded ?? []),
      ...(event.labelsRemoved ?? []),
    ]) {
      const correction = detectCorrection(row, evt, event.labelsRemoved?.includes(evt) ? "removed" : "added");
      if (correction) newCorrections.push(correction);
    }

    // @psd/Task user gesture — collect into a dedup set so re-labeled
    // threads only fire once per tick. The classifier never assigns
    // @psd/Task itself, so any labelsAdded event for it is user-driven
    // (or programmatic from another tool — both count as "create a
    // task").
    const taskLabelId = row.labelIdsByKey?.task;
    if (taskLabelId) {
      for (const evt of event.labelsAdded ?? []) {
        if (evt.labelIds?.includes(taskLabelId)) {
          // Key by threadId — first message in this thread to fire
          // wins as the representative. Subsequent labelsAdded events
          // for the same thread (because Gmail fires one per message
          // when a thread is labeled) are no-ops.
          if (!taskGestures.has(evt.message.threadId)) {
            taskGestures.set(evt.message.threadId, evt.message.id);
          }
        }
      }
    }
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

  // Process task gestures sequentially with a per-tick wall-clock
  // budget. Each AgentCore call is hard-capped at ~90s; we cap the
  // total at TASK_GESTURE_BUDGET_MS so a backlog can't starve other
  // users (and so the Lambda timeout never bites). Any unprocessed
  // gestures are logged — they'll be picked up next time the user
  // re-applies the @psd/Task label (an intentional retry gesture).
  const TASK_GESTURE_BUDGET_MS = 180_000;
  if (taskGestures.size > 0 && row.tasksMode === "invoke-agent") {
    const gestureStart = Date.now();
    let processed = 0;
    let deferred = 0;
    for (const messageId of taskGestures.values()) {
      if (Date.now() - gestureStart > TASK_GESTURE_BUDGET_MS) {
        deferred++;
        continue;
      }
      try {
        await processTaskGesture(row, accessToken, messageId);
        processed++;
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
  } else if (taskGestures.size > 0) {
    log("INFO", "task_gesture_ignored_mode_none", {
      user: row.userEmail,
      count: taskGestures.size,
    });
  }

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

async function classifyAndLabel(
  row: TriageRow,
  accessToken: string,
  msgRef: { id: string; threadId: string; labelIds?: string[] },
): Promise<{ decision: DecisionRecord; escalated: boolean } | null> {
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

  // Step 1: deterministic rules.
  let result: ClassifierResult;
  const ruleDecision = applyRules(features, row.rules);
  if ("label" in ruleDecision) {
    result = {
      label: ruleDecision.label,
      confidence: 1, // rule matches are certain
      reason: ruleDecision.reason,
      source: "rule",
    };
  } else {
    // Step 2: LLM fallback.
    const internalDomain = row.internalDomain ?? row.userEmail.split("@")[1] ?? "";
    const llm = await classifyWithLLM(features, row.rules, internalDomain);
    // Safety net: anything below the confidence floor defaults to `later`
    // so we never blast something into `important` on a guess.
    const finalLabel: Label = llm.confidence >= RULES_CONFIDENCE_FLOOR ? llm.label : "later";
    result = {
      label: finalLabel,
      confidence: llm.confidence,
      reason: llm.confidence < RULES_CONFIDENCE_FLOOR
        ? `low-confidence (${llm.reason})`
        : llm.reason,
      source: "llm",
    };
  }

  // Apply the label via Gmail.
  const labelId = row.labelIdsByKey?.[result.label];
  if (!labelId) {
    log("WARN", "missing_label_id", { user: row.userEmail, key: result.label });
    return null;
  }
  // Always archive — INBOX comes off for every classification, not
  // just later/news. User treats labels as folders (each message lives
  // in exactly one place), so Important goes to @psd/Important AND is
  // removed from Inbox. Chat escalation is the "you need to look at
  // this NOW" signal; the @psd/Important label is the home folder.
  // Updated 2026-05-22 per user feedback — original design kept Important
  // dual-labelled in Inbox, which doubled the user's review surface.
  const removeLabelIds = ["INBOX"];
  await modifyMessage(accessToken, msgRef.id, [labelId], removeLabelIds);

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

  // Step 3: maybe escalate to Chat.
  let escalated = false;
  const esc = shouldEscalate(result.label, features, row.escalation);
  if (esc.escalate && row.dmSpaceName) {
    try {
      await postEscalation({
        dmSpaceName: row.dmSpaceName,
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
        reason: esc.reason,
      });
      escalated = true;
    } catch (err) {
      log("ERROR", "escalation_failed", {
        user: row.userEmail,
        messageId: msgRef.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

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
  _direction: "added" | "removed",
): CorrectionRecord | null {
  const prior = (row.recentDecisions ?? []).find((d) => d.messageId === evt.message.id);
  if (!prior) return null;

  const inboxAdded = evt.labelIds.includes("INBOX");
  const inboxRemoved = false; // labelsRemoved branch handles this, but we
                              // don't have a clean way to tell here — the
                              // shared handler treats both branches the
                              // same. Phase 2 splits them properly.

  if (prior.label !== "important" && inboxAdded) {
    return {
      messageId: evt.message.id,
      fromLabel: prior.label,
      toLabel: "inbox",
      ts: new Date().toISOString(),
    };
  }
  if (prior.label === "important" && inboxRemoved) {
    return {
      messageId: evt.message.id,
      fromLabel: prior.label,
      toLabel: "later",
      ts: new Date().toISOString(),
    };
  }
  return null;
}

// Re-exported for unit tests outside the handler.
export { detectCorrection };

/**
 * Handle a single @psd/Task user gesture.
 *
 *   1. Fetch the email metadata so the AgentCore prompt is well-formed.
 *   2. Invoke AgentCore — the user's MEMORY.md tells the agent how to
 *      create the task in their preferred system. We deliver metadata,
 *      the agent does the work.
 *   3. Parse the agent's terse reply for success/failure.
 *   4. On success: archive (remove INBOX + remove @psd/Task) so the
 *      message ends up in All Mail only — exactly one home.
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
  const meta = await getMessageMetadata(accessToken, messageId);
  if (!meta) {
    log("WARN", "task_gesture_meta_missing", {
      user: row.userEmail,
      messageId,
    });
    return;
  }
  // If the @psd/Task label is no longer on the message, the gesture has
  // either already been handled (label removed by a prior tick) or the
  // user un-labeled it. Either way, don't re-process the stale
  // labelsAdded event sitting in Gmail's 7-day history window.
  const taskLabelId = row.labelIdsByKey?.task;
  if (taskLabelId && !(meta.labelIds ?? []).includes(taskLabelId)) {
    log("INFO", "task_gesture_stale_label_removed", {
      user: row.userEmail,
      messageId,
    });
    return;
  }
  const fromEmail = extractFromEmail(meta);
  const subject = extractSubject(meta);
  // Fetch the full body so the agent can apply urgency-detection rules
  // (the 400-char snippet often cuts off "by Friday" or "EOD" markers).
  // Falls back to snippet if the body fetch fails.
  let bodyText = meta.snippet ?? "";
  try {
    const full = await getMessageFullBody(accessToken, messageId);
    if (full && full.trim()) bodyText = full;
  } catch (err) {
    log("WARN", "task_gesture_body_fetch_failed", {
      user: row.userEmail,
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // Resolve the user's actual S3 workspace prefix (e.g.
  // `hagelk-db0f32b5`) from the users table. Don't derive it from the
  // email's local-part — that loses the random suffix and the
  // resulting S3 path won't exist (bug observed 2026-05-22).
  const profile = await getUserProfile(row.userEmail);
  const workspacePrefix = profile?.workspacePrefix;
  if (!workspacePrefix) {
    log("ERROR", "task_gesture_no_workspace_prefix", {
      user: row.userEmail,
      messageId,
    });
    return;
  }

  const result = await requestTaskCreation({
    userEmail: row.userEmail,
    workspacePrefix,
    agentcoreRuntimeId: row.agentcoreRuntimeId,
    subject,
    fromEmail,
    snippet: bodyText,
    threadId: meta.threadId,
    messageId,
  });

  // Resolve DM space lazily for the Chat outcome posts. The triage row
  // doesn't always have it cached (users who haven't received a digest
  // or escalation yet) — look it up via the bot's Chat API and persist
  // back to the row for next time. Same pattern the cron Lambda uses.
  let dmSpaceName = row.dmSpaceName;
  if (!dmSpaceName) {
    const gid = await getGoogleIdentityForEmail(row.userEmail);
    if (gid) {
      dmSpaceName = await resolveDmSpace(gid) ?? undefined;
      if (dmSpaceName) {
        await backfillDmSpaceName(row.userEmail, dmSpaceName);
        log("INFO", "dm_space_backfilled", {
          user: row.userEmail,
          space: dmSpaceName,
        });
      }
    }
  }

  if (result.ok) {
    // Archive the WHOLE THREAD: drop INBOX + remove @psd/Task from
    // every message in the thread. Modifying just the one message
    // would leave other messages in the thread still tagged, which
    // (a) confuses the user and (b) lets the next tick re-fire on
    // those other messages' labelsAdded events.
    const taskLabelId = row.labelIdsByKey?.task;
    const removeLabelIds = ["INBOX"];
    if (taskLabelId) removeLabelIds.push(taskLabelId);
    try {
      await modifyThread(accessToken, meta.threadId, [], removeLabelIds);
    } catch (err) {
      // Modify failed — task exists upstream but email isn't archived.
      // Surface as a partial-success warning; user will see both the
      // task in their system AND the email still in their @psd/Task
      // label. Cleanup is manual but not catastrophic.
      log("WARN", "task_archive_failed", {
        user: row.userEmail,
        messageId,
        taskRef: result.taskRef,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    await recordTaskCreated(
      row.userEmail,
      messageId,
      result.taskRef,
      new Date().toISOString(),
    );
    log("INFO", "task_gesture_ok", {
      user: row.userEmail,
      messageId,
      taskRef: result.taskRef,
      elapsed_ms: Date.now() - t0,
    });
    if (row.tasksNotifySuccess && dmSpaceName) {
      try {
        await postTaskOutcome({
          dmSpaceName,
          subject,
          fromEmail,
          messageId,
          ok: true,
          taskRef: result.taskRef,
        });
      } catch (err) {
        log("WARN", "task_success_notify_failed", {
          user: row.userEmail,
          messageId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return;
  }

  // Failure path — log, release the claim so a retry (next tick or
  // user re-label) isn't blocked, surface to Chat, leave email state
  // untouched.
  await releaseTaskGestureClaim(row.userEmail, messageId);
  log("ERROR", "task_gesture_failed", {
    user: row.userEmail,
    messageId,
    reason: result.reason,
    elapsed_ms: Date.now() - t0,
  });
  if (dmSpaceName) {
    try {
      await postTaskOutcome({
        dmSpaceName,
        subject,
        fromEmail,
        messageId,
        ok: false,
        reason: result.reason,
      });
    } catch (err) {
      log("WARN", "task_failure_notify_failed", {
        user: row.userEmail,
        messageId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
