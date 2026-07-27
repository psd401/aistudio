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

const baseInput = {
  sessionId: "hagelk-db0f32b5-sched-5123b45b-2026-07-27",
  lockToken: "lock-token-abc",
  runtimeId: "arn:aws:bedrock-agentcore:us-east-1:390844780692:runtime/psd_agent_dev-abc",
  userEmail: "hagelk@psd401.net",
  displayName: "Kris Hagel",
  workspacePrefix: "hagelk-db0f32b5",
  spaceName: "spaces/AAAA1111",
  isDM: true,
  originalPrompt: "Assemble the morning dispatch.",
}

describe("cron job promotion", () => {
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

    it("stays inside the 8 KiB RunTask override cap", () => {
      // AWS caps the total container-override payload. A long prompt must be
      // truncated by the builder, not rejected by RunTask at launch.
      const payload = buildFromCron({
        ...baseInput,
        originalPrompt: "x".repeat(50_000),
      })
      expect(Buffer.byteLength(payload, "utf8")).toBeLessThan(8 * 1024)
      expect(parseJobPayload(payload).promptExcerpt.length).toBe(2000)
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
    it("derives a fresh id so the overflowing transcript is discarded", () => {
      // AgentCore sticky-routes by session id. Reusing it would hand the
      // runner the exact history that blew the context window.
      const original = "hagelk-db0f32b5-sched-5123b45b-2026-07-27"
      expect(restartSessionId(original)).toBe(`${original}-r2`)
      expect(restartSessionId(original)).not.toBe(original)
    })

    it("keeps a single suffix across repeated restarts", () => {
      // AgentCore enforces a session-id length limit, so the suffix must not
      // accumulate (…-r2-r3-r4) on a task that overflows repeatedly.
      const first = restartSessionId("task-2026-07-27")
      const second = restartSessionId(first)
      const third = restartSessionId(second)

      expect(second).toBe("task-2026-07-27-r3")
      expect(third).toBe("task-2026-07-27-r4")
      expect(third.match(/-r\d+/g)).toHaveLength(1)
    })

    it("stays traceable to the run that spawned it", () => {
      // Derived rather than random, so a restart in the logs can be tied back
      // to the original scheduled run.
      expect(restartSessionId("abc-2026-07-27")).toContain("abc-2026-07-27")
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
        expect(stackSource).toContain(`cronLambda.addEnvironment('${key}'`)
      }
    })

    it("gives the cron Lambda the session-locks table", () => {
      // Without it the code declines to promote rather than launching a job
      // no one can lock — so a missing grant disables the feature silently.
      expect(stackSource).toContain(
        "cronLambda.addEnvironment(\n      'SESSION_LOCKS_TABLE'",
      )
      expect(stackSource).toContain(
        "this.sessionLocksTable.grantReadWriteData(this.cronLambdaRole)",
      )
    })

    it("grants RunTask and PassRole on BOTH task roles", () => {
      // PassRole on only the task role fails at launch with an opaque
      // AccessDenied — ECS assumes the execution role too.
      const cronPolicies = stackSource.slice(
        stackSource.indexOf("JobRunnerLaunch", stackSource.indexOf("cronLambda.addEnvironment")),
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
      expect(stackSource).toContain("this.routerLambda.addEnvironment('JOB_CLUSTER_ARN'")
      expect(stackSource).toContain("this.routerLambda.addEnvironment('JOB_TASK_DEF_ARN'")
    })
  })
})
