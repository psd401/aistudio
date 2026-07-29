/**
 * Async job-runner entrypoint (issue #1138, "the 14-minute wall").
 *
 * Runs as an on-demand ECS Fargate task, launched by the router Lambda when
 * an interactive turn hits the 14-minute deadline (see promoteToJob in
 * index.ts). Reuses the router's own modules — invokeAgentCore, Chat
 * delivery, telemetry, session locks — outside Lambda, where nothing caps
 * execution at 15 minutes. The AgentCore invocation itself may run up to
 * the 2-hour job ceiling (harness clamps payload deadline_s to 7200); the
 * wrapper's ~30s SSE heartbeats keep the stream alive throughout.
 *
 * Contract:
 *   - JOB_PAYLOAD env var carries the job (see job-promotion.ts).
 *   - AGENTCORE_TIMEOUT_MS_OVERRIDE is set on the task definition so the
 *     undici dispatcher in index.ts outlives the 2h invocation.
 *   - The router pre-acquired the kind='job' session lock; this process
 *     renews it at startup and every 5 minutes, then releases it on exit.
 *   - ALWAYS posts something to the originating space: the final answer,
 *     the harness's failure frame, or a runner-error message. No silent
 *     deaths.
 */

import {
  formatJobChatResponse,
  jobAgentAudienceContext,
  jobChatDeliveryContext,
  JOB_DEADLINE_S,
  parseJobPayload,
  resolveJobInvocation,
} from './job-promotion';
import {
  createLogger,
  invokeAgentCore,
  logTelemetry,
  recordFailure,
  releaseSessionLock,
  renewSessionLock,
  sendGoogleChatResponse,
  writeScheduledRun,
} from './index';
import { recordScheduledJobTerminal } from './scheduled-run-telemetry';
import {
  sanitizeDiagnostic,
  sanitizeEmailForLog,
} from './log-sanitization';

// The renewed lease is 14 minutes. A five-minute cadence leaves enough margin
// for one complete transient renewal failure: the next attempt occurs around
// minute ten, before the existing lease can expire.
const RENEW_INTERVAL_MS = 5 * 60 * 1000;
type JobPayload = ReturnType<typeof parseJobPayload>;
type AgentResult = Awaited<ReturnType<typeof invokeAgentCore>>;
type JobLogger = ReturnType<typeof createLogger>;

/**
 * Best-effort lock release when JOB_PAYLOAD fails full validation (review,
 * #1147): the router pre-acquired the kind='job' lock BEFORE launching this
 * task, so bailing on a malformed payload without releasing would leave
 * users hearing "still working on your earlier task" until the 14-min TTL
 * expires. sessionId/lockToken are extracted loosely — independent of the
 * rest of the payload being valid.
 */
async function releaseLockFromRawPayload(
  raw: string | undefined,
  log: JobLogger
): Promise<void> {
  if (!raw) return;
  try {
    const loose = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof loose.sessionId === 'string' && loose.sessionId &&
      typeof loose.lockToken === 'string' && loose.lockToken
    ) {
      await releaseSessionLock(loose.sessionId, loose.lockToken, log);
      log.warn('Released job lock after payload validation failure');
    }
  } catch {
    // Not even loosely parseable — nothing recoverable; TTL self-heals.
  }
}

function scheduledFailureContext(job: JobPayload) {
  return {
    phase: 'job_runner',
    ...(job.scheduleId ? { scheduleId: job.scheduleId } : {}),
  };
}

async function recordCompletedJobResult(
  job: JobPayload,
  agentResult: AgentResult,
  latencyMs: number,
  deliveryOutcome: Awaited<ReturnType<typeof sendGoogleChatResponse>>,
  log: JobLogger
): Promise<void> {
  const deliveryFailed = deliveryOutcome === 'failed';
  await logTelemetry(
    {
      userId: job.userEmail,
      sessionId: job.sessionId,
      model: agentResult.model,
      inputTokens: agentResult.inputTokens,
      outputTokens: agentResult.outputTokens,
      cacheReadInputTokens: agentResult.cacheReadInputTokens,
      cacheWriteInputTokens: agentResult.cacheWriteInputTokens,
      latencyMs,
      modelCallCount: agentResult.modelCallCount,
      durationMs: agentResult.durationMs,
      nudged: agentResult.nudged,
      guardrailBlocked: false,
      spaceName: job.spaceName,
      messages: agentResult.messages,
      toolCalls: agentResult.toolCalls,
    },
    log
  );
  await recordScheduledJobTerminal(
    job,
    {
      status: agentResult.failed || deliveryFailed ? 'error' : 'success',
      inputTokens: agentResult.inputTokens,
      outputTokens: agentResult.outputTokens,
      latencyMs,
      ...(deliveryFailed
        ? {
            errorMessage:
              'Google Chat room post and private DM fallback both failed',
          }
        : agentResult.failed
          ? { errorMessage: agentResult.response }
        : {}),
    },
    writeScheduledRun,
    log
  );

  if (deliveryFailed) {
    log.warn('Background job completed but no Chat response was delivered', {
      marker: 'JOB_RUNNER_DELIVERY_FAILED',
      sessionId: job.sessionId,
      latencyMs,
    });
    return;
  }

  if (!agentResult.failed) {
    log.info('Background job completed', {
      sessionId: job.sessionId,
      latencyMs,
      outputTokens: agentResult.outputTokens,
    });
    return;
  }
  if (agentResult.errorSource === 'router') {
    await recordFailure(
      {
        source: 'router',
        severity: 'error',
        userId: job.userEmail,
        sessionId: job.sessionId,
        scheduleName: job.scheduleName,
        model: agentResult.model,
        errorClass: agentResult.errorClass ?? 'JobLegError',
        errorMessage: agentResult.response,
        context: scheduledFailureContext(job),
      },
      log
    );
  }
  log.warn('Background job finished with a failed turn', {
    marker: 'JOB_RUNNER_FAILED_TURN',
    errorClass: agentResult.errorClass ?? 'unknown',
    latencyMs,
  });
}

async function handleJobRunnerError(
  job: JobPayload,
  error: unknown,
  startTime: number,
  log: JobLogger
): Promise<number> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await sendGoogleChatResponse(
      job.spaceName,
      job.threadName,
      '⚠️ The background job hit an internal error and could not finish. ' +
        'Some steps may have already completed — ask me to check before ' +
        'retrying.',
      log,
      jobChatDeliveryContext(job)
    );
  } catch (sendError) {
    log.error('Failed to post job-error message to Chat', {
      error: sanitizeDiagnostic(
        sendError instanceof Error
          ? sendError.message
          : String(sendError),
      ),
    });
  }
  await recordFailure(
    {
      source: 'router',
      severity: 'error',
      userId: job.userEmail,
      sessionId: job.sessionId,
      scheduleName: job.scheduleName,
      errorClass: 'JobRunnerError',
      errorMessage: message,
      context: scheduledFailureContext(job),
    },
    log
  );
  await recordScheduledJobTerminal(
    job,
    {
      status: 'error',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - startTime,
      errorMessage: message,
    },
    writeScheduledRun,
    log
  );
  return 1;
}

async function main(): Promise<number> {
  const log = createLogger({ service: 'agent-job-runner' });

  // A broken payload means there is no Chat destination to post to —
  // log loudly, release the pre-acquired lock if recoverable, and exit
  // nonzero (CloudWatch is the record).
  let job: JobPayload;
  try {
    job = parseJobPayload(process.env.JOB_PAYLOAD);
  } catch (error) {
    await releaseLockFromRawPayload(process.env.JOB_PAYLOAD, log);
    throw error;
  }

  // A context-overflow promotion must NOT resume the session it came from.
  // AgentCore sticky-routes by session id, so resuming would hand this leg the
  // exact transcript that outgrew the model window — it would re-overflow on
  // the first model call, having spent a Fargate cold start to get there.
  // Restart in a fresh session from the original request instead.
  //
  // The lock stays on the ORIGINAL session id: that is what the router checks
  // to answer "still working on your earlier task", and what cron acquired
  // before launching this task.
  const {
    invokeSessionId,
    prompt,
    restart: isRestart,
  } = resolveJobInvocation(job);

  log.info('Background job started', {
    sessionId: job.sessionId,
    invokeSessionId,
    reason: job.reason ?? 'deadline',
    restart: isRestart,
    userEmail: sanitizeEmailForLog(job.userEmail),
    space: job.spaceName,
    deadlineS: JOB_DEADLINE_S,
  });

  const startTime = Date.now();
  let renewTimer: ReturnType<typeof setInterval> | undefined;
  try {
    // The inherited lease started before RunTask, so Fargate startup already
    // consumed part of it. Renew once before any external work, then start the
    // cadence; otherwise a slow start plus one missed interval can expose the
    // session before the second attempt.
    const ownsLock = await renewSessionLock(
      job.sessionId,
      job.lockToken,
      log,
      true,
    );
    if (!ownsLock) {
      throw new Error(
        'Background job lost its session lock before execution',
      );
    }
    renewTimer = setInterval(() => {
      void renewSessionLock(job.sessionId, job.lockToken, log);
    }, RENEW_INTERVAL_MS);

    const agentResult = await invokeAgentCore(
      prompt,
      job.userEmail,
      invokeSessionId,
      log,
      {
        displayName: job.displayName,
        workspacePrefix: job.workspacePrefix,
        ...jobAgentAudienceContext(job),
        deadlineS: JOB_DEADLINE_S,
        runtimeIdOverride: job.runtimeId,
      }
    );

    // Deliver exactly like the router's Step 6: truncate the raw response,
    // then prefix in shared spaces. A failed turn's response is already the
    // harness's failure frame — posting it satisfies "always post something".
    const deliveryOutcome = await sendGoogleChatResponse(
      job.spaceName,
      job.threadName,
      formatJobChatResponse(job, agentResult.response),
      log,
      jobChatDeliveryContext(job)
    );

    const latencyMs =
      agentResult.latencyMs > 0 ? agentResult.latencyMs : Date.now() - startTime;
    await recordCompletedJobResult(
      job,
      agentResult,
      latencyMs,
      deliveryOutcome,
      log
    );
    // The ECS STOPPED-state supervisor uses the process exit code as its
    // authoritative terminal signal. A delivered agent failure is not a clean
    // job even though Chat delivery itself succeeded.
    return deliveryOutcome === 'failed' ? 3 : agentResult.failed ? 2 : 0;
  } catch (error) {
    const exitCode = await handleJobRunnerError(job, error, startTime, log);
    return exitCode;
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    await releaseSessionLock(job.sessionId, job.lockToken, log);
  }
}

// The postgres pool keeps the event loop alive — exit explicitly.
main()
  .then((code) => process.exit(code))
  .catch((error) => {
    const detail = sanitizeDiagnostic(
      error instanceof Error ? error.stack ?? error.message : String(error),
      4000,
    );
    process.stderr.write(
      `job-runner fatal: ${detail}\n`
    );
    process.exit(1);
  });
