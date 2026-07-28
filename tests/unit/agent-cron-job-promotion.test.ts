/**
 * Scheduled-task promotion to the background job-runner.
 *
 * The cron Lambda builds a JOB_PAYLOAD; the ECS runner
 * (agent-router/job-main.ts) parses it with agent-router's parseJobPayload.
 * Those live in SEPARATE deployment bundles with separate node_modules, so
 * neither can import the other at runtime and the payload builder is
 * necessarily duplicated.
 *
 * That duplication is only safe if something asserts the two halves agree. So
 * these tests build with CRON'S builder and parse with the ROUTER'S parser —
 * the real producer against the real consumer. A field added on one side and
 * not the other fails here rather than at 6am in a Fargate task with no human
 * watching.
 *
 * In tests/unit because jest runs NO tests under infra/lambdas.
 */

import fs from "node:fs"
import path from "node:path"
import {
  buildJobPayload as buildFromCron,
  promotionReason,
  shouldPromoteToJob as shouldPromoteFromCron,
} from "../../infra/lambdas/agent-cron/job-promotion"
import {
  buildJobPayload as buildFromRouter,
  buildOverflowRestartPrompt,
  parseJobPayload,
  resolveJobInvocation,
  restartSessionId,
  shouldPromoteToJob as shouldPromoteFromRouter,
} from "../../infra/lambdas/agent-router/job-promotion"
import { stripComments } from "../helpers/strip-ts-comments"

const stackSource = stripComments(
  fs.readFileSync(
    path.join(process.cwd(), "infra/lib/agent-platform-stack.ts"),
    "utf8",
  ),
)
const cronSource = stripComments(
  fs.readFileSync(
    path.join(process.cwd(), "infra/lambdas/agent-cron/index.ts"),
    "utf8",
  ),
)

const baseInput = {
  sessionId: "hagelk-db0f32b5-sched-5123b45b-2026-07-27",
  lockToken: "lock-token-abc",
  runtimeId: "arn:aws:bedrock-agentcore:us-east-1:390844780692:runtime/psd_agent_dev-abc",
  userEmail: "hagelk@psd401.net",
  displayName: "Kris Hagel",
  workspacePrefix: "hagelk-db0f32b5",
  spaceName: "spaces/AAAA1111",
  scheduleId: "36bb0456-1c51-4fb8-97d1-4e87d02765ce",
  scheduleName: "Morning dispatch",
  scheduledRunId: "901",
  isDM: true,
  originalPrompt: "Assemble the morning dispatch.",
}

  describe("payload contract with the runner", () => {
    it("round-trips through the router's parser", () => {
      // The load-bearing assertion: what cron emits is what the runner reads.
      const parsed = parseJobPayload(buildFromCron(baseInput))

      expect(parsed.sessionId).toBe(baseInput.sessionId)
      expect(parsed.lockToken).toBe(baseInput.lockToken)
      expect(parsed.runtimeId).toBe(baseInput.runtimeId)
      expect(parsed.userEmail).toBe(baseInput.userEmail)
      expect(parsed.displayName).toBe(baseInput.displayName)
      expect(parsed.workspacePrefix).toBe(baseInput.workspacePrefix)
      expect(parsed.spaceName).toBe(baseInput.spaceName)
      expect(parsed.scheduleId).toBe(baseInput.scheduleId)
      expect(parsed.scheduleName).toBe(baseInput.scheduleName)
      expect(parsed.scheduledRunId).toBe(baseInput.scheduledRunId)
      expect(parsed.isDM).toBe(true)
      expect(parsed.promptExcerpt).toBe(baseInput.originalPrompt)
    })

    it("produces byte-identical output to the router's builder", () => {
      // Stronger than round-tripping: catches a field the parser happens to
      // tolerate (it defaults displayName and promptExcerpt) but that would
      // still change runner behaviour.
      expect(buildFromCron(baseInput)).toBe(buildFromRouter(baseInput))
    })

    it("agrees with the router on the deadline classes", () => {
      // Two copies of the same error-class set. If the router gains a class
      // and cron does not, scheduled tasks silently stop being promoted.
      for (const cls of [
        "ChatDeadlineExpired",
        "ChatDeadlineExpiredPartial",
        "OpenClawChatError",
        "SomeFutureError",
        "",
        undefined,
      ]) {
        expect(shouldPromoteFromCron(cls)).toBe(shouldPromoteFromRouter(cls))
      }
    })

    it("INTENTIONALLY diverges from the router on context overflow", () => {
      // Pinned rather than omitted, because the test above exists to catch
      // exactly this kind of drift and would otherwise be routed around.
      //
      // Scheduled tasks restart on overflow: nobody is watching, the request
      // is fully described by the stored schedule prompt, and the alternative
      // is a silent failure every morning.
      //
      // Interactive turns do NOT, deliberately. A restart discards the user's
      // conversation, and they are right there — they can /reset or rephrase,
      // and they can see that something went wrong. Silently throwing away a
      // chat history to retry is worse than telling them it failed.
      //
      // If interactive restart is ever wanted, change the router AND this
      // test together.
      expect(shouldPromoteFromCron("ContextOverflow")).toBe(true)
      expect(shouldPromoteFromRouter("ContextOverflow")).toBe(false)
    })

    it("truncates a CONTINUATION prompt and stays inside the 8 KiB cap", () => {
      // AWS caps the total container-override payload. A continuation resumes
      // a session whose transcript already holds the full request, so an
      // excerpt is only context garnish.
      const payload = buildFromCron({
        ...baseInput,
        originalPrompt: "x".repeat(50_000),
      })
      expect(Buffer.byteLength(payload, "utf8")).toBeLessThan(8 * 1024)
      expect(parseJobPayload(payload).promptExcerpt.length).toBe(2000)
    })

    it("carries a RESTART prompt in full, past the excerpt cap", () => {
      // A restart has NO transcript to supply the omitted half. Schedule
      // validation accepts up to 20,000 chars, so truncating to 2,000 would
      // let an overflowed task silently execute an incomplete request —
      // which looks like success and produces the wrong work.
      const prompt = "y".repeat(5_000)
      const parsed = parseJobPayload(
        buildFromCron({
          ...baseInput,
          reason: "context-overflow",
          originalPrompt: prompt,
        }),
      )

      expect(parsed.promptExcerpt).toBe(prompt)
      expect(parsed.promptExcerpt.length).toBe(5_000)
    })

    it("refuses to build a restart that would not fit, rather than truncating", () => {
      // Falling back to a truncated restart would be the silent-wrong-work
      // failure again. The caller catches this and posts the partial instead.
      expect(() =>
        buildFromCron({
          ...baseInput,
          reason: "context-overflow",
          originalPrompt: "z".repeat(20_000),
        }),
      ).toThrow(/RunTask override cap/)
    })

    it("keeps continuation payloads buildable no matter the prompt size", () => {
      // The cap must never break the deadline path, which truncates first.
      expect(() =>
        buildFromCron({ ...baseInput, originalPrompt: "z".repeat(100_000) }),
      ).not.toThrow()
    })
  })

  describe("promotion decision", () => {
    it("promotes recoverable failures, not real ones", () => {
      // Promoting a genuine error would re-run a broken turn for two hours.
      expect(shouldPromoteFromCron("ChatDeadlineExpired")).toBe(true)
      expect(shouldPromoteFromCron("ChatDeadlineExpiredPartial")).toBe(true)
      expect(shouldPromoteFromCron("ContextOverflow")).toBe(true)

      // The GENERIC chat error must stay unpromotable. Context overflow used
      // to arrive under this class, and the temptation is to promote it to
      // cover the overflow case — which would hand every genuine crash a
      // two-hour retry budget. The container classifies overflow separately
      // (harness_adapter._classify_chat_error) precisely so this can stay no.
      expect(shouldPromoteFromCron("OpenClawChatError")).toBe(false)

      expect(shouldPromoteFromCron("InvocationContextInvalid")).toBe(false)
      expect(shouldPromoteFromCron(undefined)).toBe(false)
      expect(shouldPromoteFromCron("")).toBe(false)
    })

    it("distinguishes the two recoverable reasons", () => {
      // The reason drives OPPOSITE runner behaviour — resume vs restart — so
      // conflating them silently either re-overflows or throws away work.
      expect(promotionReason("ChatDeadlineExpired")).toBe("deadline")
      expect(promotionReason("ChatDeadlineExpiredPartial")).toBe("deadline")
      expect(promotionReason("ContextOverflow")).toBe("context-overflow")
      expect(promotionReason("OpenClawChatError")).toBeNull()
      expect(promotionReason(undefined)).toBeNull()
    })

    it("carries the reason through to the runner's parser", () => {
      const overflow = parseJobPayload(
        buildFromCron({ ...baseInput, reason: "context-overflow" }),
      )
      expect(overflow.reason).toBe("context-overflow")

      const deadline = parseJobPayload(
        buildFromCron({ ...baseInput, reason: "deadline" }),
      )
      expect(deadline.reason).toBe("deadline")
    })

    it("defaults a reason-less payload to deadline, not restart", () => {
      // Back-compat with a payload written by an older cron build. Guessing
      // 'context-overflow' here would silently discard in-progress work.
      const parsed = parseJobPayload(buildFromCron(baseInput))
      expect(parsed.reason).toBeUndefined()

      const garbage = parseJobPayload(
        JSON.stringify({ ...JSON.parse(buildFromCron(baseInput)), reason: "nonsense" }),
      )
      expect(garbage.reason).toBeUndefined()
    })
  })

  describe("cross-language error-class contract", () => {
    it("matches the class name the container actually emits", () => {
      // The promotion decision is made in TypeScript from a string produced in
      // Python. Nothing at build time links them, so a rename on either side
      // silently stops every scheduled restart — the failure would show up as
      // the Morning Dispatch quietly failing again, weeks later.
      const harness = fs.readFileSync(
        path.join(process.cwd(), "infra/agent-image/harness_adapter.py"),
        "utf8",
      )
      const declared = /CONTEXT_OVERFLOW_ERROR_CLASS\s*=\s*"([^"]+)"/.exec(harness)

      expect(declared).not.toBeNull()
      expect(declared?.[1]).toBe("ContextOverflow")
      // And that literal is what actually triggers promotion.
      expect(promotionReason(declared?.[1])).toBe("context-overflow")
    })

    it("classifies overflow separately from the generic chat error", () => {
      // Guards the Python side's whole reason for existing: if the classifier
      // were removed and overflow went back to OpenClawChatError, promotion
      // would stop and this catches it.
      const harness = fs.readFileSync(
        path.join(process.cwd(), "infra/agent-image/harness_adapter.py"),
        "utf8",
      )
      expect(harness).toContain("def _classify_chat_error")
      expect(harness).toContain("error_class=err_class")
    })
  })

  describe("restart session ids", () => {
    const original = "hagelk-db0f32b5-sched-5123b45b-2026-07-27"

    it("derives a fresh id so the overflowing transcript is discarded", () => {
      // AgentCore sticky-routes by session id. Reusing it would hand the
      // runner the exact history that blew the context window.
      const restart = restartSessionId(original, "aaaaaaaa-1111-2222-3333-444444444444")
      expect(restart).not.toBe(original)
      expect(restart.startsWith(original)).toBe(true)
    })

    it("is unique per PROMOTION, not per day", () => {
      // THE BUG THIS REPLACED. A scheduled session id is date-based and stable
      // for the whole UTC day, and cron always passes that original id — never
      // a derived one. A counter-based suffix therefore returned the SAME
      // "-r2" on every promotion that day, so a task overflowing twice would
      // sticky-route the second restart into the first restart's transcript.
      const first = restartSessionId(original, "11111111-aaaa-bbbb-cccc-dddddddddddd")
      const second = restartSessionId(original, "22222222-aaaa-bbbb-cccc-dddddddddddd")

      expect(first).not.toBe(second)
    })

    it("replaces the suffix rather than accumulating it", () => {
      // AgentCore enforces a session-id length limit, so a repeatedly
      // overflowing task must not grow the id without bound.
      const first = restartSessionId(original, "11111111-aaaa-bbbb-cccc-dddddddddddd")
      const second = restartSessionId(first, "22222222-aaaa-bbbb-cccc-dddddddddddd")

      expect(second.match(/-r[0-9a-f]+/g)).toHaveLength(1)
      expect(second.length).toBeLessThanOrEqual(first.length)
    })

    it("stays traceable to the run that spawned it", () => {
      // Derived rather than random, so a restart in the logs can be tied back
      // to the original scheduled run.
      expect(restartSessionId(original, "abcdef01-0000-0000-0000-000000000000")).toContain(
        "sched-5123b45b-2026-07-27",
      )
    })

    it("never returns a bare base id, even on a malformed token", () => {
      // Falling back to the original id would silently resume the overflowing
      // session — the exact failure this function exists to prevent.
      expect(restartSessionId(original, "")).not.toBe(original)
      expect(restartSessionId(original, "!!!!")).not.toBe(original)
    })
  })

  describe("restart prompt", () => {
    it("does not tell a fresh session to continue from nowhere", () => {
      // The continuation prompt says "carry on from where you stopped", which
      // is meaningless without the transcript and invites the model to hunt
      // for work it cannot see.
      const restart = buildOverflowRestartPrompt("Assemble the morning dispatch.")
      expect(restart).toContain("[job-restart]")
      expect(restart).not.toContain("Continue the task from where you stopped")
    })

    it("warns about side effects it can no longer verify", () => {
      // THE hazard of restarting: the previous leg's tool calls are not in
      // this session, so the model cannot see what already ran.
      const restart = buildOverflowRestartPrompt("do the thing")
      expect(restart).toMatch(/side effects/i)
      expect(restart).toMatch(/already/i)
    })

    it("carries the original request, since history will not", () => {
      expect(buildOverflowRestartPrompt("Assemble the morning dispatch.")).toContain(
        "Assemble the morning dispatch.",
      )
    })
  })

  describe("runner invocation selection", () => {
    it("restarts context overflow with a derived session and restart prompt", () => {
      const invocation = resolveJobInvocation({
        ...baseInput,
        reason: "context-overflow",
        promptExcerpt: baseInput.originalPrompt,
      })

      expect(invocation.restart).toBe(true)
      expect(invocation.invokeSessionId).not.toBe(baseInput.sessionId)
      expect(invocation.prompt).toContain("[job-restart]")
      expect(invocation.prompt).toContain(baseInput.originalPrompt)
    })

    it("resumes deadline work in the original session", () => {
      const invocation = resolveJobInvocation({
        ...baseInput,
        reason: "deadline",
        promptExcerpt: baseInput.originalPrompt,
      })

      expect(invocation.restart).toBe(false)
      expect(invocation.invokeSessionId).toBe(baseInput.sessionId)
      expect(invocation.prompt).toContain("[job-continuation]")
    })
  })

  describe("scheduled-task specifics", () => {
    it("marks scheduled turns as DM so the reply is not prefixed", () => {
      // Scheduled tasks deliver to the owner's DM. isDM=false would make the
      // runner prefix the briefing with "[Kris Hagel's Agent] ".
      expect(parseJobPayload(buildFromCron({ ...baseInput, isDM: true })).isDM).toBe(
        true,
      )
    })

    it("omits threadName when absent rather than emitting undefined", () => {
      // JSON.stringify drops undefined values, but an explicit null or the
      // string "undefined" would fail the runner's string check.
      const payload = buildFromCron(baseInput)
      expect(payload).not.toContain("threadName")
      expect(parseJobPayload(payload).threadName).toBeUndefined()
    })

    it("queues recovery before persisting and launching the promoted task", () => {
      const promotion = cronSource.slice(
        cronSource.indexOf("async function tryPromoteScheduledResult("),
        cronSource.indexOf("async function deliverScheduledResult("),
      )
      expect(promotion.indexOf("persistRun: (scheduledRunId) =>")).toBeLessThan(
        promotion.indexOf("await sendPromotionAcknowledgement(context, reason)"),
      )
      const launch = cronSource.slice(
        cronSource.indexOf("async function promoteScheduledTurnToJob("),
        cronSource.indexOf("async function sendChatMessage("),
      )
      const preparation = cronSource.slice(
        cronSource.indexOf("async function prepareScheduledJobPromotion("),
        cronSource.indexOf("function readJobRunnerConfig("),
      )
      expect(preparation.indexOf("await reserveRun()")).toBeLessThan(
        preparation.indexOf("await prepareLaunch("),
      )
      expect(preparation.indexOf("await prepareLaunch(")).toBeLessThan(
        preparation.indexOf("await persistRun("),
      )
      expect(launch.indexOf("await prepareScheduledJobPromotion(")).toBeLessThan(
        launch.indexOf("await launchScheduledJob("),
      )
      expect(launch.indexOf("await afterLaunchFailure(")).toBeLessThan(
        launch.indexOf("phase: 'run-task'"),
      )
      expect(cronSource).toContain("scheduleFireLaunchIdentity(fireIdentity)")
      expect(cronSource).toContain(
        "clientToken: launchIdentity.clientToken",
      )
      expect(cronSource).toContain(
        "startedBy: launchIdentity.startedBy",
      )
      expect(cronSource).toContain(
        "reconcileRunTaskLaunch({",
      )
      expect(cronSource).toContain(
        "listRunningTasks: async () =>",
      )
      expect(cronSource).toContain(
        "listStoppedTasks: async (nextToken) =>",
      )
      expect(cronSource).toContain(
        "describeTasks: async (taskArns) =>",
      )
      const runningLookup = cronSource.slice(
        cronSource.indexOf("listRunningTasks: async () =>"),
        cronSource.indexOf("listStoppedTasks: async (nextToken) =>"),
      )
      expect(runningLookup).toContain("startedBy,")
      expect(runningLookup).not.toContain("desiredStatus")
      const stoppedLookup = cronSource.slice(
        cronSource.indexOf("listStoppedTasks: async (nextToken) =>"),
        cronSource.indexOf("describeTasks: async (taskArns) =>"),
      )
      expect(stoppedLookup).toContain("desiredStatus: 'STOPPED'")
      expect(stoppedLookup).not.toContain("startedBy")
      expect(launch).toContain(
        "if (error instanceof AmbiguousRunTaskError)",
      )
      expect(launch).toContain(
        "return { promoted: true, ambiguity: detail }",
      )
      expect(cronSource).toContain(
        "return sanitizeDiagnostic(",
      )
    })
  })

  describe("CDK wiring", () => {
    // Every one of these fails ONLY at runtime, in a 6am scheduled task with
    // nobody watching. The code declines to promote when config is missing, so
    // a gap here is silent: scheduled tasks quietly go back to being truncated
    // with no error anywhere. CI does not run the infra jest suite, so these
    // assertions read the CDK source.

    it("reads real, comment-stripped source (parser guard)", () => {
      expect(stackSource.length).toBeGreaterThan(10_000)
      expect(stackSource).toContain("CronLambda")
    })

    it("gives the cron Lambda every JOB_* value it requires", () => {
      // promoteScheduledTurnToJob bails unless cluster, task def, subnets AND
      // security group are all present.
      for (const key of [
        "JOB_CLUSTER_ARN",
        "JOB_TASK_DEF_ARN",
        "JOB_SUBNETS",
        "JOB_SECURITY_GROUP",
        "JOB_CONTAINER_NAME",
      ]) {
        expect(stackSource).toContain(
          `resources.cronLambda.addEnvironment('${key}'`,
        )
      }
    })

    it("gives the cron Lambda the session-locks table", () => {
      // Without it the code declines to promote rather than launching a job
      // no one can lock — so a missing grant disables the feature silently.
      expect(stackSource).toContain(
        "resources.cronLambda.addEnvironment(\n      'SESSION_LOCKS_TABLE'",
      )
      expect(stackSource).toContain(
        "resources.sessionLocksTable.grantReadWriteData(resources.cronLambdaRole)",
      )
    })

    it("durably delays ambiguous-launch reconciliation before RunTask", () => {
      expect(stackSource).toContain("'CronReconciliationQueue'")
      expect(stackSource).toContain(
        "SCHEDULE_RECONCILIATION_QUEUE_URL:",
      )
      expect(stackSource).toContain(
        "resources.cronReconciliationQueue.grantSendMessages(",
      )
      expect(stackSource).toContain(
        "new lambdaEventSources.SqsEventSource(",
      )
      expect(cronSource).toContain(
        "new SendMessageCommand({",
      )
      expect(cronSource).toContain(
        "DelaySeconds: SCHEDULED_RUN_RECONCILIATION_DELAY_SECONDS",
      )
      expect(cronSource).toContain(
        "abortSignal: AbortSignal.timeout(RUN_TASK_ATTEMPT_TIMEOUT_MS)",
      )
      const preparation = cronSource.slice(
        cronSource.indexOf("async function prepareScheduledJobPromotion("),
        cronSource.indexOf("function readJobRunnerConfig("),
      )
      expect(preparation.indexOf("await prepareLaunch(")).toBeLessThan(
        preparation.indexOf("await persistRun("),
      )
      expect(cronSource).toContain(
        "Delayed promotion reconciliation terminalized ambiguity",
      )
    })

    it("grants RunTask and PassRole on BOTH task roles", () => {
      // PassRole on only the task role fails at launch with an opaque
      // AccessDenied — ECS assumes the execution role too.
      const cronPolicies = stackSource.slice(
        stackSource.indexOf(
          "JobRunnerLaunch",
          stackSource.indexOf("resources.cronLambda.addEnvironment"),
        ),
      )
      expect(cronPolicies).toContain("'ecs:RunTask'")
      expect(cronPolicies).toContain("'iam:PassRole'")
      expect(cronPolicies).toContain("jobTaskDef.taskRole.roleArn")
      expect(cronPolicies).toContain("jobTaskDef.obtainExecutionRole().roleArn")
      expect(cronPolicies).toContain("'iam:PassedToService': 'ecs-tasks.amazonaws.com'")
    })

    it("keeps the router's own promotion wiring intact", () => {
      // The cron wiring reuses the router's cluster, task definition and
      // security group; breaking the router's half breaks both.
      expect(stackSource).toContain(
        "resources.routerLambda.addEnvironment('JOB_CLUSTER_ARN'",
      )
      expect(stackSource).toContain(
        "resources.routerLambda.addEnvironment('JOB_TASK_DEF_ARN'",
      )
    })

    it("supervises every stopped job through the cron telemetry handler", () => {
      expect(stackSource).toContain("'JobRunnerStoppedRule'")
      expect(stackSource).toContain("'ECS Task State Change'")
      expect(stackSource).toContain("lastStatus: ['STOPPED']")
      expect(stackSource).toContain(
        "actions: ['ecs:DescribeTasks', 'ecs:ListTasks']",
      )
      expect(stackSource).toContain(
        "new eventsTargets.LambdaFunction(resources.cronLambda",
      )
      expect(stackSource).toContain(
        "deadLetterQueue: resources.agentAsyncDlq",
      )
    })
  })
