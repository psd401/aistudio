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
  shouldPromoteToJob as shouldPromoteFromCron,
} from "../../infra/lambdas/agent-cron/job-promotion"
import {
  buildJobPayload as buildFromRouter,
  parseJobPayload,
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

    it("agrees with the router on which errors are promotable", () => {
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
    it("promotes only deadline expiry, not real failures", () => {
      // Promoting a genuine error would re-run a broken turn for two hours.
      expect(shouldPromoteFromCron("ChatDeadlineExpired")).toBe(true)
      expect(shouldPromoteFromCron("ChatDeadlineExpiredPartial")).toBe(true)

      // The class the 2026-07-27 dispatch actually produced under the old
      // fixed-deadline code. It is NOT promotable — which is precisely why
      // the deadline fix had to land first: without an explicit deadline_s
      // the harness never reports expiry, so promotion can never trigger.
      expect(shouldPromoteFromCron("OpenClawChatError")).toBe(false)

      expect(shouldPromoteFromCron("InvocationContextInvalid")).toBe(false)
      expect(shouldPromoteFromCron(undefined)).toBe(false)
      expect(shouldPromoteFromCron("")).toBe(false)
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
