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
 *     renews it every 10 minutes and releases it on exit.
 *   - ALWAYS posts something to the originating space: the final answer,
 *     the harness's failure frame, or a runner-error message. No silent
 *     deaths.
 */

import {
  formatJobChatResponse,
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
} from './index';

const RENEW_INTERVAL_MS = 10 * 60 * 1000;

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
  log: ReturnType<typeof createLogger>
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

async function main(): Promise<number> {
  const log = createLogger({ service: 'agent-job-runner' });

  // A broken payload means there is no Chat destination to post to —
  // log loudly, release the pre-acquired lock if recoverable, and exit
  // nonzero (CloudWatch is the record).
  let job: ReturnType<typeof parseJobPayload>;
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
    userEmail: job.userEmail,
    space: job.spaceName,
    deadlineS: JOB_DEADLINE_S,
  });

  // Keep the kind='job' lock alive for the duration — the router uses it to
  // answer mid-job user messages instantly with "still working".
  const renewTimer = setInterval(() => {
    void renewSessionLock(job.sessionId, job.lockToken, log);
  }, RENEW_INTERVAL_MS);

  const startTime = Date.now();
  try {
    const agentResult = await invokeAgentCore(
      prompt,
      job.userEmail,
      invokeSessionId,
      log,
      {
        displayName: job.displayName,
        workspacePrefix: job.workspacePrefix,
        deadlineS: JOB_DEADLINE_S,
        runtimeIdOverride: job.runtimeId,
      }
    );

    // Deliver exactly like the router's Step 6: truncate the raw response,
    // then prefix in shared spaces. A failed turn's response is already the
    // harness's failure frame — posting it satisfies "always post something".
    await sendGoogleChatResponse(
      job.spaceName,
      job.threadName,
      formatJobChatResponse(job, agentResult.response),
      log
    );

    const latencyMs =
      agentResult.latencyMs > 0 ? agentResult.latencyMs : Date.now() - startTime;
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
        // Guardrails ran on the original message in the first leg.
        guardrailBlocked: false,
        spaceName: job.spaceName,
        messages: agentResult.messages,
        toolCalls: agentResult.toolCalls,
      },
      log
    );

    if (agentResult.failed) {
      // Harness-side failures were already recorded by the container; a
      // router-source failure (e.g. HTTP error) gets recorded here so the
      // job leg is visible in agent_failures.
      if (agentResult.errorSource === 'router') {
        await recordFailure(
          {
            source: 'router',
            severity: 'error',
            userId: job.userEmail,
            sessionId: job.sessionId,
            model: agentResult.model,
            errorClass: agentResult.errorClass ?? 'JobLegError',
            errorMessage: agentResult.response,
            context: { phase: 'job_runner' },
          },
          log
        );
      }
      log.warn('Background job finished with a failed turn', {
        // Stable marker for the JobRunnerFailure metric filter (#1161).
        marker: 'JOB_RUNNER_FAILED_TURN',
        errorClass: agentResult.errorClass ?? 'unknown',
        latencyMs,
      });
    } else {
      log.info('Background job completed', {
        sessionId: job.sessionId,
        latencyMs,
        outputTokens: agentResult.outputTokens,
      });
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Best-effort user notification — the job must never die silently.
    try {
      await sendGoogleChatResponse(
        job.spaceName,
        job.threadName,
        '⚠️ The background job hit an internal error and could not finish. ' +
          'Some steps may have already completed — ask me to check before ' +
          'retrying.',
        log
      );
    } catch (sendError) {
      log.error('Failed to post job-error message to Chat', {
        error:
          sendError instanceof Error ? sendError.message : String(sendError),
      });
    }
    await recordFailure(
      {
        source: 'router',
        severity: 'error',
        userId: job.userEmail,
        sessionId: job.sessionId,
        errorClass: 'JobRunnerError',
        errorMessage: message,
        context: { phase: 'job_runner' },
      },
      log
    );
    return 1;
  } finally {
    clearInterval(renewTimer);
    await releaseSessionLock(job.sessionId, job.lockToken, log);
  }
}

// The postgres pool keeps the event loop alive — exit explicitly.
main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(
      `job-runner fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
    );
    process.exit(1);
  });
