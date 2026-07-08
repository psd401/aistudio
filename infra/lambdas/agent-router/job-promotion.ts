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
export interface JobPayload {
  /** AgentCore session to resume (sticky-routes to the same microVM). */
  sessionId: string;
  /** Session-lock token the router pre-acquired with kind='job'. */
  lockToken: string;
  /** Resolved AgentCore runtime id/ARN (runner skips the SSM lookup). */
  runtimeId: string;
  userEmail: string;
  displayName: string;
  workspacePrefix: string;
  spaceName: string;
  threadName?: string;
  /** In shared spaces the reply is prefixed [Name's Agent]; DMs are not. */
  isDM: boolean;
  /** Truncated excerpt of the original request (context only, see above). */
  promptExcerpt: string;
}

const PROMPT_EXCERPT_MAX = 2000;

export function buildJobPayload(input: {
  sessionId: string;
  lockToken: string;
  runtimeId: string;
  userEmail: string;
  displayName: string;
  workspacePrefix: string;
  spaceName: string;
  threadName?: string;
  isDM: boolean;
  originalPrompt: string;
}): string {
  const payload: JobPayload = {
    sessionId: input.sessionId,
    lockToken: input.lockToken,
    runtimeId: input.runtimeId,
    userEmail: input.userEmail,
    displayName: input.displayName,
    workspacePrefix: input.workspacePrefix,
    spaceName: input.spaceName,
    ...(input.threadName ? { threadName: input.threadName } : {}),
    isDM: input.isDM,
    promptExcerpt: (input.originalPrompt || '').slice(0, PROMPT_EXCERPT_MAX),
  };
  return JSON.stringify(payload);
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
  return {
    sessionId: requireString('sessionId'),
    lockToken: requireString('lockToken'),
    runtimeId: requireString('runtimeId'),
    userEmail: requireString('userEmail'),
    displayName: typeof obj.displayName === 'string' ? obj.displayName : '',
    workspacePrefix: requireString('workspacePrefix'),
    spaceName: requireString('spaceName'),
    ...(typeof obj.threadName === 'string' && obj.threadName
      ? { threadName: obj.threadName }
      : {}),
    isDM: obj.isDM === true,
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
