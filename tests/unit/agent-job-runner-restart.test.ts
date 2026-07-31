/**
 * The job runner must not resume a session that overflowed.
 *
 * AgentCore sticky-routes by session id, so a context-overflow promotion that
 * reuses the id hands the runner the exact transcript that outgrew the model
 * window. It would re-overflow on the first model call, having spent a Fargate
 * cold start to get there — the failure the promotion was supposed to fix.
 *
 * These assertions read job-main.ts source rather than executing it: the module
 * runs main() on import and pulls in the whole router bundle (postgres, Google
 * Chat, AWS SDK), which is not loadable under jest. Reading source is a weaker
 * check than executing, so each assertion is paired with the behavioural test
 * of the pure helper it depends on in agent-cron-job-promotion.test.ts.
 */

import fs from "node:fs"
import path from "node:path"
import { stripComments } from "../helpers/strip-ts-comments"

const source = stripComments(
  fs.readFileSync(
    path.join(process.cwd(), "infra/lambdas/agent-router/job-main.ts"),
    "utf8",
  ),
)

describe("job runner restart handling", () => {
  it("reads real, comment-stripped source (parser guard)", () => {
    expect(source).toContain("parseJobPayload")
    expect(source).toContain("invokeAgentCore")
  })

  it("branches on the promotion reason", () => {
    expect(source).toContain("resolveJobInvocation(job)")
  })

  it("invokes with the RESTART session id, never the original, on overflow", () => {
    // The pure selector is behaviour-tested separately. This source assertion
    // pins the runner to its result rather than the original session id.
    expect(source).toContain("invokeSessionId")

    // The invoke must use the derived id.
    const invokeCall = source.slice(
      source.indexOf("await invokeAgentCore("),
      source.indexOf("await invokeAgentCore(") + 200,
    )
    expect(invokeCall).toContain("invokeSessionId")
    expect(invokeCall).not.toContain("job.sessionId")
  })

  it("sends the restart prompt, not the continuation prompt, on overflow", () => {
    expect(source).toContain("prompt,")
    expect(source).toContain("resolveJobInvocation(job)")
  })

  it("keeps the inherited lock and bridges legacy jobs to the stable owner mutex", () => {
    expect(source).toContain("resolveJobWorkspaceLockPlan(job)")
    expect(source).toContain("lockPlan.inheritedLockId")
    expect(source).toContain("lockPlan.bridgeLockId")
    expect(source).toContain("tryAcquireSessionLock(")
    expect(source).not.toContain("renewSessionLock(invokeSessionId")
    expect(source).not.toContain("releaseSessionLock(invokeSessionId")
  })

  it("renews before half the lease so one transient failure cannot expose it", () => {
    expect(source).toContain("const RENEW_INTERVAL_MS = 5 * 60 * 1000")
    const immediateRenewal = source.indexOf(
      "const ownsLock = await renewSessionLock(",
    )
    const interval = source.indexOf("renewTimer = setInterval(")
    const invocation = source.indexOf("const agentResult = await invokeAgentCore(")
    expect(immediateRenewal).toBeGreaterThan(-1)
    expect(interval).toBeGreaterThan(immediateRenewal)
    expect(invocation).toBeGreaterThan(interval)
    expect(source).toContain("if (!ownsLock)")
    expect(source.slice(immediateRenewal, interval)).toContain(
      "job.lockToken,\n      log,\n      true,",
    )
  })

  it("releases only after explicit workspace finalization proof", () => {
    const proof = source.indexOf(
      "agentResult.workspaceFinalizationConfirmed === true",
    )
    const releaseGuard = source.indexOf(
      "if (workspaceFinalizationConfirmed)",
    )
    expect(proof).toBeGreaterThan(-1)
    expect(releaseGuard).toBeGreaterThan(proof)
    expect(source).toContain(
      "Retaining background workspace lock after unconfirmed finalization",
    )
  })

  it("still delivers to Chat on the restart path", () => {
    // A restart that finishes silently is indistinguishable from one that
    // died. The runner's "always post something" contract must survive.
    expect(source).toContain("sendGoogleChatResponse")
  })

  it("records the terminal result of a cron-promoted job", () => {
    expect(source).toContain("recordScheduledJobTerminal(")
    expect(source).toContain("writeScheduledRun,")
    expect(source).toContain(
      "status: agentResult.failed || deliveryFailed ? 'error' : 'success'",
    )
  })

  it("exits nonzero when both room and DM delivery fail", () => {
    expect(source).toContain(
      "return deliveryOutcome === 'failed' ? 3 : agentResult.failed ? 2 : 0",
    )
    const deliveryFailureBranch = source.slice(
      source.indexOf("if (deliveryFailed)"),
      source.indexOf("if (!agentResult.failed)"),
    )
    expect(deliveryFailureBranch).toContain(
      "marker: 'JOB_RUNNER_FAILED_TURN'",
    )
    expect(deliveryFailureBranch).toContain("failureKind: 'delivery'")
    expect(deliveryFailureBranch).toContain("JOB_RUNNER_DELIVERY_FAILED")
  })

  it("records a router invocation failure before handling delivery failure", () => {
    const invocationFailure = source.indexOf(
      "if (agentResult.failed && agentResult.errorSource === 'router')",
    )
    const deliveryFailure = source.indexOf("if (deliveryFailed)")
    expect(invocationFailure).toBeGreaterThan(-1)
    expect(deliveryFailure).toBeGreaterThan(invocationFailure)
  })

  it("exits nonzero after delivering an agent failure for ECS supervision", () => {
    expect(source).toContain("agentResult.failed ? 2 : 0")
  })
})
