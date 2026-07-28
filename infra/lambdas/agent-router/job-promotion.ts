/**
 * Async-job promotion — pure logic (issue #1138, "the 14-minute wall").
 *
 * A multi-step agent turn that cannot finish inside the router Lambda's
 * ~14-minute window is promoted EXACTLY ONCE into a long-lived ECS Fargate
 * job-runner task, which re-invokes the SAME AgentCore session with a
 * continuation prompt and a 2-hour deadline (AgentCore invocations may run
 * up to 8h; the Lambda caller was the only 15-minute wall).
 *
 * This module holds the dependency-free pieces (promotion predicate, job
 * payload build/parse, continuation prompt) so they can be unit tested
 * without the Lambda runtime — the ECS RunTask wiring stays in index.ts.
 */

/** Turn error classes that mean "ran out of clock", not "broke". */
const DEADLINE_ERROR_CLASSES = new Set([
  'ChatDeadlineExpired',
  'ChatDeadlineExpiredPartial',
]);

/**
 * Job leg ceiling: 2 hours (approved 2026-07-07). Mirrors the harness clamp
 * in agent-image/harness_adapter.py (_resolve_deadline_s, max 7200).
 */
export const JOB_DEADLINE_S = 7200;

/** True when a failed turn should be promoted to a background job. */
export function shouldPromoteToJob(errorClass: string | undefined): boolean {
  return !!errorClass && DEADLINE_ERROR_CLASSES.has(errorClass);
}

/**
 * Everything the job-runner needs to resume and deliver the turn. Carried
 * as a single JSON env var on the RunTask container override — AWS caps the
 * total override payload at 8 KiB, hence the prompt excerpt truncation in
 * buildJobPayload (the session already holds the full original prompt in
 * its OpenClaw history; the excerpt is context garnish for the continuation
 * message, not the source of truth).
 */
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

export interface JobPayload {
  /** AgentCore session to resume (sticky-routes to the same microVM). */
  sessionId: string;
  /** See PromotionReason. Defaults to 'deadline' when absent. */
  reason?: PromotionReason;
  /** Session-lock token the router pre-acquired with kind='job'. */
  lockToken: string;
  /** Resolved AgentCore runtime id/ARN (runner skips the SSM lookup). */
  runtimeId: string;
  userEmail: string;
  displayName: string;
  workspacePrefix: string;
  spaceName: string;
  /** Present only for cron-promoted turns; enables terminal run telemetry. */
  scheduleId?: string;
  scheduleName?: string;
  /** Per-fire agent_scheduled_runs primary key created before RunTask. */
  scheduledRunId?: string;
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
  prompt: string;
  restart: boolean;
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
 * Select the runner's session and prompt together. A deadline resumes the
 * existing session, while context overflow must discard that transcript and
 * restart from the original request.
 */
export function resolveJobInvocation(
  job: Pick<
    JobPayload,
    'sessionId' | 'lockToken' | 'reason' | 'promptExcerpt'
  >
): JobInvocation {
  const restart = job.reason === 'context-overflow';
  return {
    invokeSessionId: restart
      ? restartSessionId(job.sessionId, job.lockToken)
      : job.sessionId,
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

export function buildJobPayload(input: {
  sessionId: string;
  reason?: PromotionReason;
  lockToken: string;
  runtimeId: string;
  userEmail: string;
  displayName: string;
  workspacePrefix: string;
  spaceName: string;
  scheduleId?: string;
  scheduleName?: string;
  scheduledRunId?: string;
  threadName?: string;
  isDM: boolean;
  originalPrompt: string;
  responsePrefix?: string;
}): string {
  const payload: JobPayload = {
    sessionId: input.sessionId,
    ...(input.reason ? { reason: input.reason } : {}),
    lockToken: input.lockToken,
    runtimeId: input.runtimeId,
    userEmail: input.userEmail,
    displayName: input.displayName,
    workspacePrefix: input.workspacePrefix,
    spaceName: input.spaceName,
    ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
    ...(input.scheduleName ? { scheduleName: input.scheduleName } : {}),
    ...(input.scheduledRunId
      ? { scheduledRunId: input.scheduledRunId }
      : {}),
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
  return {
    sessionId: requireString('sessionId'),
    // Unknown/absent -> 'deadline'. A payload from an older cron build must
    // keep resuming the session, not silently switch to a fresh one.
    ...(obj.reason === 'context-overflow' || obj.reason === 'deadline'
      ? { reason: obj.reason }
      : {}),
    lockToken: requireString('lockToken'),
    runtimeId: requireString('runtimeId'),
    userEmail: requireString('userEmail'),
    displayName: typeof obj.displayName === 'string' ? obj.displayName : '',
    workspacePrefix: requireString('workspacePrefix'),
    spaceName: requireString('spaceName'),
    ...(scheduleId ? { scheduleId } : {}),
    ...(scheduleName ? { scheduleName } : {}),
    ...(scheduledRunId ? { scheduledRunId } : {}),
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
 * Session id for a restart leg — unique per PROMOTION, not per day.
 *
 * A fresh id is what actually discards the overflowing transcript: AgentCore
 * sticky-routes by session, so reusing the id hands the runner the very history
 * that blew the window.
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
 * Suffix replaced rather than appended, and bounded to 8 hex chars, because
 * AgentCore enforces a session-id length limit.
 */
export function restartSessionId(sessionId: string, lockToken: string): string {
  const base = sessionId.replace(/-r[0-9a-f]{1,12}$/i, '');
  const unique = (lockToken || '').replace(/[^0-9a-f]/gi, '').slice(0, 8).toLowerCase();
  return `${base}-r${unique || '0'}`;
}
