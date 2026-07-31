/**
 * Async-job promotion — pure logic (issue #1138, "the 14-minute wall").
 *
 * A multi-step agent turn that cannot finish inside the router Lambda's
 * ~14-minute window, or whose transcript overflows the model context, is
 * promoted EXACTLY ONCE into a long-lived ECS Fargate job-runner task.
 * Deadlines resume the same logical conversation; overflow recovery starts a
 * fresh logical conversation from the original request. New payloads retain
 * one owner-wide AgentCore runtime for workspace safety. Job invocations get a
 * 2-hour ceiling (AgentCore itself may run up to 8h).
 *
 * This module holds the dependency-free pieces (promotion predicate, job
 * payload build/parse, continuation prompt) so they can be unit tested
 * without the Lambda runtime — the ECS RunTask wiring stays in index.ts.
 */
import * as crypto from 'node:crypto';

/** Turn error classes that mean "ran out of clock", not "broke". */
const DEADLINE_ERROR_CLASSES = new Set([
  'ChatDeadlineExpired',
  'ChatDeadlineExpiredPartial',
]);

/**
 * Context overflow is also recoverable, but only in a fresh session. The
 * harness assigns this class from OpenClaw's lifecycle error; generic chat
 * failures remain intentionally unpromotable.
 */
const CONTEXT_OVERFLOW_ERROR_CLASS = 'ContextOverflow';

/**
 * Job leg ceiling: 2 hours (approved 2026-07-07). Mirrors the harness clamp
 * in agent-image/harness_adapter.py (_resolve_deadline_s, max 7200).
 */
export const JOB_DEADLINE_S = 7200;

/**
 * Broker authority must outlive the model-work deadline because the terminal
 * AgentCore result is withheld until the wrapper has drained privileged
 * traffic and durably checkpointed the workspace.
 *
 * Worst-case long-job finalization is bounded to 1,020 seconds:
 *   835s long proxy drain + 35s proxy replacement + 5s retry transition
 *   + 20s gateway shutdown + 125s workspace flush.
 *
 * A 2.5-hour token therefore leaves another 780 seconds for AgentCore cold
 * start, request transport, and clock skew without extending the approved
 * two-hour harness work ceiling.
 */
export const JOB_FINALIZATION_BOUNDED_MAX_S = 1_020;
export const JOB_AUTHORITY_STARTUP_MARGIN_S = 780;
export const JOB_INVOCATION_CONTEXT_TTL_S =
  JOB_DEADLINE_S
  + JOB_FINALIZATION_BOUNDED_MAX_S
  + JOB_AUTHORITY_STARTUP_MARGIN_S;

/**
 * Why a turn was promoted. Drives OPPOSITE handling in the runner:
 *
 *   deadline         — ran out of clock with a healthy transcript. RESUME the
 *                      same session; the work in progress is the whole point.
 *   context-overflow — the transcript itself outgrew the model window.
 *                      Resuming it re-overflows on the first model call, so the
 *                      runner starts a FRESH session from the original request.
 *
 * Absent on payloads written before this existed; treated as 'deadline', which
 * is exactly the behaviour that predated it.
 */
export type PromotionReason = 'deadline' | 'context-overflow';

/**
 * Why this failed turn should be promoted, or null for a genuine fault.
 *
 * The reason must be resolved before building the job payload because the
 * runner takes opposite recovery paths: deadlines resume; overflow restarts.
 */
export function promotionReason(
  errorClass: string | undefined
): PromotionReason | null {
  if (!errorClass) return null;
  if (DEADLINE_ERROR_CLASSES.has(errorClass)) return 'deadline';
  if (errorClass === CONTEXT_OVERFLOW_ERROR_CLASS) return 'context-overflow';
  return null;
}

/** True when a failed turn should be promoted to a background job. */
export function shouldPromoteToJob(errorClass: string | undefined): boolean {
  return promotionReason(errorClass) !== null;
}

/**
 * Everything the job-runner needs to resume and deliver the turn. Carried as
 * one JSON env var on the RunTask container override, which AWS caps at 8 KiB.
 * Deadline continuations can truncate the prompt excerpt because the original
 * request is already in session history. Overflow restarts must carry the
 * complete request or fail promotion rather than silently execute half of it.
 */
export interface JobPayload {
  /** Build-rotated AgentCore runtime affinity identity. */
  sessionId: string;
  /** Deployment-stable owner workspace mutex; legacy jobs fall back to sessionId. */
  workspaceLockId?: string;
  /** OpenClaw transcript identity for the originating Chat space/thread. */
  conversationSessionId?: string;
  /** See PromotionReason. Defaults to 'deadline' when absent. */
  reason?: PromotionReason;
  /** Session-lock token the router pre-acquired with kind='job'. */
  lockToken: string;
  /** Resolved AgentCore runtime id/ARN (runner skips the SSM lookup). */
  runtimeId: string;
  userEmail: string;
  /** Originating Google Chat user identity retained for payload compatibility. */
  googleIdentity?: string;
  displayName: string;
  workspacePrefix: string;
  spaceName: string;
  /** Present only for cron-promoted turns; enables terminal run telemetry. */
  scheduleId?: string;
  scheduleName?: string;
  /** Per-fire agent_scheduled_runs primary key created before RunTask. */
  scheduledRunId?: string;
  /** Immutable Scheduler occurrence identity for retry-safe failure repair. */
  fireKey?: string;
  threadName?: string;
  /** In shared spaces the reply is prefixed [Name's Agent]; DMs are not. */
  isDM: boolean;
  /** Optional router-selected marker retained on acknowledgement/final replies. */
  responsePrefix?: string;
  /** Truncated excerpt of the original request (context only, see above). */
  promptExcerpt: string;
}

export interface JobInvocation {
  invokeSessionId: string;
  conversationSessionId?: string;
  prompt: string;
  restart: boolean;
}

export interface JobWorkspaceLockPlan {
  inheritedLockId: string;
  bridgeLockId?: string;
}

/** Deployment-stable owner mutex, byte-compatible with router + cron. */
export function workspaceLockIdFromPrefix(
  workspacePrefix: string
): string {
  const workspaceHash = crypto
    .createHash('sha256')
    .update(`owner-workspace-lock\0${workspacePrefix}`)
    .digest('hex');
  return `agent-workspace-${workspaceHash}`;
}

/**
 * New jobs inherit the stable lock directly. A payload queued by an older
 * deployment owns only its build-rotated session lock, so the runner must keep
 * that lease and additionally acquire the stable owner lock before touching
 * the workspace.
 */
export function resolveJobWorkspaceLockPlan(
  job: Pick<JobPayload, 'sessionId' | 'workspaceLockId' | 'workspacePrefix'>
): JobWorkspaceLockPlan {
  if (job.workspaceLockId) {
    return { inheritedLockId: job.workspaceLockId };
  }
  return {
    inheritedLockId: job.sessionId,
    bridgeLockId: workspaceLockIdFromPrefix(job.workspacePrefix),
  };
}

export function jobChatDeliveryContext(
  job: Pick<
    JobPayload,
    | 'isDM'
    | 'userEmail'
    | 'sessionId'
    | 'conversationSessionId'
  >,
  durableDelivery = false
) {
  const isSharedSpace = !job.isDM;
  return {
    isSharedSpace,
    durableDelivery,
    userId: job.userEmail,
    sessionId: job.conversationSessionId ?? job.sessionId,
  };
}

export function jobAgentAudienceContext(
  job: Pick<JobPayload, 'isDM'>
): { audience?: 'shared-space' } {
  return job.isDM ? {} : { audience: 'shared-space' };
}

const JOB_RESPONSE_MAX_LENGTH = 4096;
const JOB_TRUNCATION_SUFFIX =
  '\n\n_(Response truncated — ask me to continue)_';

/**
 * Format the final background-job reply exactly once, independently of the
 * runner's AWS/Chat side effects. A router-selected prefix (such as
 * "[aside]") takes precedence over the normal shared-space attribution.
 */
export function formatJobChatResponse(
  job: Pick<JobPayload, 'isDM' | 'displayName' | 'responsePrefix'>,
  response: string
): string {
  const prefix =
    job.responsePrefix ||
    (job.isDM ? '' : `[${job.displayName}'s Agent] `);
  const availableLength = JOB_RESPONSE_MAX_LENGTH - prefix.length;
  const truncatedResponse =
    response.length > availableLength
      ? response.substring(
          0,
          availableLength - JOB_TRUNCATION_SUFFIX.length
        ) + JOB_TRUNCATION_SUFFIX
      : response;
  return `${prefix}${truncatedResponse}`;
}

/**
 * Select the runner's runtime, transcript, and prompt together. A deadline
 * resumes the existing transcript, while context overflow must discard that
 * transcript and restart from the original request.
 */
export function resolveJobInvocation(
  job: Pick<
    JobPayload,
    | 'sessionId'
    | 'conversationSessionId'
    | 'lockToken'
    | 'reason'
    | 'promptExcerpt'
  >
): JobInvocation {
  const restart = job.reason === 'context-overflow';
  const conversationSessionId = job.conversationSessionId
    ? restart
      ? restartSessionId(job.conversationSessionId, job.lockToken)
      : job.conversationSessionId
    : undefined;
  return {
    // New payloads keep one owner-wide runtime even when an overflowing
    // OpenClaw transcript must restart. Legacy payloads lacked a separate
    // conversation id, so retain their original fresh-runtime behavior.
    invokeSessionId:
      restart && !conversationSessionId
        ? restartSessionId(job.sessionId, job.lockToken)
        : job.sessionId,
    ...(conversationSessionId ? { conversationSessionId } : {}),
    prompt: restart
      ? buildOverflowRestartPrompt(job.promptExcerpt)
      : buildContinuationPrompt(job.promptExcerpt),
    restart,
  };
}

const PROMPT_EXCERPT_MAX = 2000;
// Mirrors lib/agent-schedules/validation.ts; the router bundle cannot import
// application code at runtime.
const SCHEDULE_NAME_MAX_LENGTH = 120;

/**
 * RunTask caps the ENTIRE container-override payload at 8 KiB. Enforced here so
 * an oversized job fails at build time, where the caller can fall back, rather
 * than at launch with an opaque RunTask rejection.
 */
const MAX_PAYLOAD_BYTES = 8 * 1024;
const AGENTCORE_SESSION_ID_MAX_LENGTH = 100;
const AGENTCORE_SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function assertAgentCoreSessionId(sessionId: string): void {
  if (
    sessionId.length === 0 ||
    sessionId.length > AGENTCORE_SESSION_ID_MAX_LENGTH ||
    !AGENTCORE_SESSION_ID_PATTERN.test(sessionId)
  ) {
    throw new Error(
      `JOB_PAYLOAD invalid field: sessionId (must match AgentCore's ${AGENTCORE_SESSION_ID_MAX_LENGTH}-character contract)`
    );
  }
}

export function buildJobPayload(input: {
  sessionId: string;
  workspaceLockId?: string;
  conversationSessionId?: string;
  reason?: PromotionReason;
  lockToken: string;
  runtimeId: string;
  userEmail: string;
  googleIdentity?: string;
  displayName: string;
  workspacePrefix: string;
  spaceName: string;
  scheduleId?: string;
  scheduleName?: string;
  scheduledRunId?: string;
  fireKey?: string;
  threadName?: string;
  isDM: boolean;
  originalPrompt: string;
  responsePrefix?: string;
}): string {
  assertAgentCoreSessionId(input.sessionId);
  const payload: JobPayload = {
    sessionId: input.sessionId,
    ...(input.workspaceLockId
      ? { workspaceLockId: input.workspaceLockId }
      : {}),
    ...(input.conversationSessionId
      ? { conversationSessionId: input.conversationSessionId }
      : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    lockToken: input.lockToken,
    runtimeId: input.runtimeId,
    userEmail: input.userEmail,
    ...(input.googleIdentity
      ? { googleIdentity: input.googleIdentity }
      : {}),
    displayName: input.displayName,
    workspacePrefix: input.workspacePrefix,
    spaceName: input.spaceName,
    ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
    ...(input.scheduleName ? { scheduleName: input.scheduleName } : {}),
    ...(input.scheduledRunId
      ? { scheduledRunId: input.scheduledRunId }
      : {}),
    ...(input.fireKey ? { fireKey: input.fireKey } : {}),
    ...(input.threadName ? { threadName: input.threadName } : {}),
    isDM: input.isDM,
    ...(input.responsePrefix
      ? { responsePrefix: input.responsePrefix }
      : {}),
    // A CONTINUATION resumes a session whose transcript already holds the full
    // request, so an excerpt is context garnish. A RESTART has no transcript —
    // a truncated prompt there means the agent silently executes an incomplete
    // request, which is worse than not restarting at all. Schedule validation
    // accepts prompts up to 20,000 chars, well past the old 2,000 cap.
    promptExcerpt:
      input.reason === 'context-overflow'
        ? input.originalPrompt || ''
        : (input.originalPrompt || '').slice(0, PROMPT_EXCERPT_MAX),
  };
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
    // Deliberately fatal rather than truncating back down: the caller catches
    // this and posts the partial instead. Restarting with half the
    // instructions would look like success and produce the wrong work.
    throw new Error(
      `JOB_PAYLOAD exceeds the ${MAX_PAYLOAD_BYTES}-byte RunTask override cap`
    );
  }
  return serialized;
}

function boundedOptionalString(
  obj: Record<string, unknown>,
  field: string,
  maxLength: number
): string | undefined {
  const value = obj[field];
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength
    ? value
    : undefined;
}

function readScheduledRunId(
  obj: Record<string, unknown>,
): string | undefined {
  const value = boundedOptionalString(obj, 'scheduledRunId', 20);
  return value && /^\d{1,20}$/.test(value) ? value : undefined;
}

function readConversationSessionFields(
  obj: Record<string, unknown>
): Pick<JobPayload, 'conversationSessionId'> {
  const value = boundedOptionalString(
    obj,
    'conversationSessionId',
    256
  );
  if (value && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
    throw new Error('JOB_PAYLOAD invalid field: conversationSessionId');
  }
  return value ? { conversationSessionId: value } : {};
}

function readWorkspaceLockFields(
  obj: Record<string, unknown>
): Pick<JobPayload, 'workspaceLockId'> {
  const value = boundedOptionalString(obj, 'workspaceLockId', 256);
  if (value && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
    throw new Error('JOB_PAYLOAD invalid field: workspaceLockId');
  }
  return value ? { workspaceLockId: value } : {};
}

/**
 * Parse + validate a JOB_PAYLOAD env value in the runner. Throws with a
 * field-specific message on anything missing — the runner catches, logs,
 * and exits nonzero (there is no Chat destination to post to if the payload
 * itself is broken).
 */
export function parseJobPayload(raw: string | undefined): JobPayload {
  if (!raw) throw new Error('JOB_PAYLOAD env var is empty');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('JOB_PAYLOAD is not valid JSON');
  }
  const obj = parsed as Record<string, unknown>;
  const requireString = (field: string): string => {
    const v = obj[field];
    if (typeof v !== 'string' || !v) {
      throw new Error(`JOB_PAYLOAD missing required field: ${field}`);
    }
    return v;
  };
  const scheduleId = boundedOptionalString(obj, 'scheduleId', 64);
  const scheduleName = boundedOptionalString(
    obj,
    'scheduleName',
    SCHEDULE_NAME_MAX_LENGTH
  );
  const scheduledRunId = readScheduledRunId(obj);
  const fireKey = boundedOptionalString(obj, 'fireKey', 192);
  const googleIdentity = boundedOptionalString(obj, 'googleIdentity', 256);
  const conversationSessionFields = readConversationSessionFields(obj);
  const workspaceLockFields = readWorkspaceLockFields(obj);
  const sessionId = requireString('sessionId');
  assertAgentCoreSessionId(sessionId);
  return {
    sessionId,
    ...workspaceLockFields,
    ...conversationSessionFields,
    // Unknown/absent -> 'deadline'. A payload from an older cron build must
    // keep resuming the session, not silently switch to a fresh one.
    ...(obj.reason === 'context-overflow' || obj.reason === 'deadline'
      ? { reason: obj.reason }
      : {}),
    lockToken: requireString('lockToken'),
    runtimeId: requireString('runtimeId'),
    userEmail: requireString('userEmail'),
    googleIdentity,
    displayName: typeof obj.displayName === 'string' ? obj.displayName : '',
    workspacePrefix: requireString('workspacePrefix'),
    spaceName: requireString('spaceName'),
    ...(scheduleId ? { scheduleId } : {}),
    ...(scheduleName ? { scheduleName } : {}),
    ...(scheduledRunId ? { scheduledRunId } : {}),
    ...(fireKey ? { fireKey } : {}),
    ...(typeof obj.threadName === 'string' && obj.threadName
      ? { threadName: obj.threadName }
      : {}),
    isDM: obj.isDM === true,
    ...(typeof obj.responsePrefix === 'string' && obj.responsePrefix
      ? { responsePrefix: obj.responsePrefix }
      : {}),
    promptExcerpt:
      typeof obj.promptExcerpt === 'string' ? obj.promptExcerpt : '',
  };
}

/**
 * The continuation message sent to the resumed session. The session's
 * OpenClaw history already contains the original request and every tool
 * call the first leg ran — this message only needs to say "keep going,
 * carefully".
 */
export function buildContinuationPrompt(promptExcerpt: string): string {
  const excerpt = promptExcerpt
    ? `\n\n[original request excerpt: ${promptExcerpt}]`
    : '';
  return (
    '[job-continuation] Your previous turn hit the platform time limit ' +
    'mid-task and has been moved to a background job with a much longer ' +
    'budget. Continue the task from where you stopped. Before re-running ' +
    'ANY side effect (document creation, sharing, posting, sending), check ' +
    'whether it already completed in your earlier work and skip it if so. ' +
    'When everything is done, reply with the complete final answer for the ' +
    `user.${excerpt}`
  );
}

/**
 * The message sent when restarting after a CONTEXT OVERFLOW.
 *
 * Deliberately NOT the continuation prompt. Continuation says "carry on from
 * where you stopped", which is meaningless in a fresh session that has no
 * history to carry on from — and worse, it invites the model to hunt for
 * earlier work it cannot see.
 *
 * The tradeoff this makes explicit: the previous leg's tool calls are NOT in
 * this session, so the model cannot verify what already ran. Side effects are
 * therefore the real hazard on a restart, and the instruction leads with
 * checking current state before re-doing anything that writes.
 */
export function buildOverflowRestartPrompt(promptExcerpt: string): string {
  const request = promptExcerpt
    ? `\n\nThe original request was:\n${promptExcerpt}`
    : '';
  return (
    '[job-restart] Your previous attempt at this task grew too large for the ' +
    'model context window and could not continue, so you are starting over ' +
    'in a fresh session with a much longer time budget. You do NOT have the ' +
    'earlier transcript.\n\n' +
    'Two things matter:\n' +
    '1. SIDE EFFECTS MAY ALREADY HAVE RUN. Before creating, sending, ' +
    'sharing, or posting anything, check whether it already exists and skip ' +
    'it if so.\n' +
    '2. STAY SMALLER THIS TIME. Prefer fewer, more targeted tool calls, and ' +
    'avoid re-reading large outputs you have already summarized — running ' +
    'out of context is what ended the last attempt.\n\n' +
    `When everything is done, reply with the complete final answer.${request}`
  );
}

/**
 * Session key for a restart leg — unique per PROMOTION, not per day.
 *
 * A fresh OpenClaw conversation id is what actually discards the overflowing
 * transcript. Legacy payloads also use this helper to rotate AgentCore
 * affinity because they predate the separate conversation key.
 *
 * The uniqueness has to come from the lock token, not a counter. A scheduled
 * session id is date-based and STABLE for the whole UTC day
 * (`…-sched-<id>-2026-07-27`), and cron always passes that original id — never
 * a previously derived one. So an incrementing suffix returns the same value on
 * every promotion that day: a task overflowing twice would sticky-route the
 * second restart straight into the first restart's transcript, re-overflowing
 * or blending two separate runs. The lock token is a fresh UUID per promotion,
 * which makes each restart distinct while staying deterministic for tests.
 *
 * Suffix replaced rather than appended, and bounded to 8 hex chars, so both
 * OpenClaw and legacy AgentCore keys remain within the platform length limit.
 */
export function restartSessionId(sessionId: string, lockToken: string): string {
  const base = sessionId.replace(/-r[0-9a-f]{1,12}$/i, '');
  const unique = (lockToken || '').replace(/[^0-9a-f]/gi, '').slice(0, 8).toLowerCase();
  return `${base}-r${unique || '0'}`;
}
