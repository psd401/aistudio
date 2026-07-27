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

/**
 * Context overflow — the transcript outgrew the model's window.
 *
 * Classified in the container (harness_adapter._classify_chat_error) rather
 * than by matching text here, because the wording lives with the code that
 * produces it.
 */
const CONTEXT_OVERFLOW_ERROR_CLASS = 'ContextOverflow';

/**
 * Why a turn is being promoted. The two reasons need OPPOSITE handling in the
 * runner, which is why this is carried rather than re-derived:
 *
 *   deadline         — the turn ran out of clock with a healthy transcript.
 *                      RESUME the same session; the work in progress is the
 *                      whole point.
 *   context-overflow — the transcript itself is the problem. Resuming it is
 *                      guaranteed to overflow again, so the runner must start
 *                      a FRESH session from the original request.
 */
export type PromotionReason = 'deadline' | 'context-overflow';

/**
 * Why this failed turn should be promoted, or null to leave it alone.
 *
 * Deliberately NOT keyed on the generic OpenClawChatError: promoting that
 * would hand genuine crashes a two-hour retry budget.
 */
export function promotionReason(
  errorClass: string | undefined
): PromotionReason | null {
  if (!errorClass) return null;
  if (DEADLINE_ERROR_CLASSES.has(errorClass)) return 'deadline';
  if (errorClass === CONTEXT_OVERFLOW_ERROR_CLASS) return 'context-overflow';
  return null;
}

/** True when a failed scheduled turn should be promoted to a background job. */
export function shouldPromoteToJob(errorClass: string | undefined): boolean {
  return promotionReason(errorClass) !== null;
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
  /**
   * Why the turn was promoted. Optional so a payload written by an older cron
   * build still parses; the runner defaults it to 'deadline', which is the
   * behaviour that existed before this field.
   */
  reason?: PromotionReason;
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
  threadName?: string;
  isDM: boolean;
  originalPrompt: string;
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
    ...(input.threadName ? { threadName: input.threadName } : {}),
    isDM: input.isDM,
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
