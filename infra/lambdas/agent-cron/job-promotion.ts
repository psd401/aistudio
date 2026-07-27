/**
 * Async-job promotion for SCHEDULED tasks — pure logic.
 *
 * A scheduled turn that cannot finish inside the cron Lambda's window is
 * promoted into the same long-lived ECS Fargate job-runner the router uses for
 * interactive turns (infra/lambdas/agent-router/job-main.ts). The runner
 * re-invokes the SAME AgentCore session with a continuation prompt and a 2-hour
 * deadline, then posts the finished answer to Chat.
 *
 * WHY THIS EXISTS. Lambda's 15-minute ceiling is an AWS hard limit, so a
 * scheduled task that legitimately needs longer had no way to finish — it was
 * killed and the owner was told the agent was unavailable. The router already
 * solved this for interactive turns; scheduled tasks were simply never wired
 * up. This is that wiring, not a new mechanism.
 *
 * WHY THE PAYLOAD BUILDER IS DUPLICATED HERE. The runner parses JOB_PAYLOAD
 * with agent-router's parseJobPayload, but agent-router and agent-cron are
 * separate deployment bundles with separate node_modules — neither can import
 * the other at runtime. Rather than trust two copies to stay in sync by
 * inspection, tests/unit/agent-cron-job-promotion.test.ts builds a payload with
 * THIS module and parses it with the ROUTER'S parser, so the real contract is
 * asserted against the real consumer. A field added on one side and not the
 * other fails that test.
 *
 * Kept dependency-free so it is testable without the Lambda runtime — jest runs
 * no tests under infra/lambdas, so the suite lives in tests/unit.
 */

/**
 * Turn error classes that mean "ran out of clock", not "broke".
 *
 * Must match agent-router/job-promotion.ts. These are emitted by the harness
 * when it hits the deadline the caller supplied, which for scheduled tasks only
 * became reachable once the cron Lambda started sending an explicit deadline_s
 * (see turn-deadline.ts): previously the Lambda's own abort always fired first,
 * so the harness never got to report a deadline at all and promotion could
 * never have triggered.
 */
const DEADLINE_ERROR_CLASSES = new Set([
  'ChatDeadlineExpired',
  'ChatDeadlineExpiredPartial',
]);

/** True when a failed scheduled turn should be promoted to a background job. */
export function shouldPromoteToJob(errorClass: string | undefined): boolean {
  return !!errorClass && DEADLINE_ERROR_CLASSES.has(errorClass);
}

/**
 * Everything the job-runner needs to resume and deliver the turn. Shape is
 * dictated by agent-router/job-promotion.ts `parseJobPayload`.
 *
 * Carried as a single JSON env var on the RunTask container override, and AWS
 * caps the total override payload at 8 KiB — hence the excerpt truncation. The
 * session already holds the full original prompt in its OpenClaw history.
 */
export interface JobPayload {
  sessionId: string;
  lockToken: string;
  runtimeId: string;
  userEmail: string;
  displayName: string;
  workspacePrefix: string;
  spaceName: string;
  threadName?: string;
  isDM: boolean;
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
