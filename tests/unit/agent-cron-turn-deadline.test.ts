/**
 * Scheduled-task deadline ordering.
 *
 * Four clocks bound a scheduled turn and they must fire in this order:
 *
 *   harness turn deadline
 *     < final workspace persistence
 *     < fetch abort
 *     < Lambda timeout (900s hard max)
 *
 * When that ordering inverts, the outer layer kills a turn the inner layer was
 * about to complete, and the owner gets an error instead of an answer.
 *
 * That is exactly what happened on 2026-07-27: a Morning Dispatch ran 824s of
 * turn time (inside the harness's 840s budget), but ~47s of AgentCore cold
 * start meant the fixed 870s abort fired 5.6s before the agent finished. The
 * harness never reached its own deadline, so it never produced the partial
 * answer the design intended.
 *
 * These live in tests/unit rather than beside the Lambda because jest runs NO
 * tests under infra/lambdas — job-promotion.test.ts and schedule-record.test.ts
 * have never executed in CI.
 */

import {
  DEADLINE_ORDERING_GUARD_S,
  GATEWAY_SHUTDOWN_MAX_S,
  HARNESS_DEADLINE_MAX_S,
  HARNESS_DEADLINE_MIN_S,
  HARNESS_LEAD_S,
  INTERACTIVE_PROXY_DRAIN_CLIENT_MAX_S,
  PROXY_RESTART_MAX_S,
  REPLY_RESERVE_MS,
  STARTUP_RESERVE_S,
  WORKSPACE_FINALIZATION_BOUNDED_MAX_S,
  WORKSPACE_FINALIZATION_RESERVE_S,
  WORKSPACE_FLUSH_MAX_S,
  resolveAbortMs,
  resolveTurnDeadlineS,
} from "../../infra/lambdas/agent-cron/turn-deadline"
import {
  createScheduledInvocationContextToken,
  SCHEDULED_INVOCATION_CONTEXT_TTL_S,
} from "../../infra/lambdas/agent-cron/invocation-context"

/** AWS hard ceiling for Lambda, and what the cron function is configured to. */
const LAMBDA_MAX_MS = 900_000

describe("scheduled-task turn deadline", () => {
  it("keeps scheduled broker authority alive through finalization", () => {
    const token = createScheduledInvocationContextToken(
      "0123456789abcdef0123456789abcdef",
      {
        ownerEmail: "owner@psd401.net",
        sessionId: "scheduled-session",
        workspacePrefix: "owner-a1b2c3d4",
      },
      { nowSeconds: 100, nonce: "scheduled-authority" }
    )
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")
    ) as { issuedAt: number; expiresAt: number }
    const lifetime = claims.expiresAt - claims.issuedAt

    expect(lifetime).toBe(SCHEDULED_INVOCATION_CONTEXT_TTL_S)
    expect(lifetime).toBeGreaterThanOrEqual(
      STARTUP_RESERVE_S
      + HARNESS_DEADLINE_MAX_S
      + WORKSPACE_FINALIZATION_BOUNDED_MAX_S
    )
  })

  it("keeps harness deadline < abort < remaining time", () => {
    // The core invariant, checked across the whole plausible range of
    // remaining-time values rather than at one convenient point.
    for (const remainingMs of [
      LAMBDA_MAX_MS,
      880_000,
      800_000,
      600_000,
      300_000,
      150_000,
    ]) {
      const deadlineMs = resolveTurnDeadlineS(remainingMs) * 1000
      const abortMs = resolveAbortMs(remainingMs)

      expect(abortMs).toBeLessThan(remainingMs)
      expect(deadlineMs).toBeLessThan(abortMs)
    }
  })

  it("leaves room to post the reply after aborting", () => {
    // Without this the Lambda dies mid-post and the owner gets silence rather
    // than a failure message.
    expect(resolveAbortMs(LAMBDA_MAX_MS)).toBe(LAMBDA_MAX_MS - REPLY_RESERVE_MS)
  })

  it("reserves the wrapper's complete final workspace persistence budget", () => {
    expect(WORKSPACE_FINALIZATION_RESERVE_S).toBeGreaterThanOrEqual(200)
    for (const remainingMs of [LAMBDA_MAX_MS, 880_000, 800_000, 600_000]) {
      const deadlineMs = resolveTurnDeadlineS(remainingMs) * 1000
      const finalizationMs = WORKSPACE_FINALIZATION_RESERVE_S * 1000
      const startupMs = STARTUP_RESERVE_S * 1000
      const harnessLeadMs = HARNESS_LEAD_S * 1000

      expect(
        startupMs + deadlineMs + harnessLeadMs + finalizationMs,
      ).toBeLessThan(
        resolveAbortMs(remainingMs),
      )
    }
  })

  it("uses the true bounded interactive finalization maximum", () => {
    expect(WORKSPACE_FINALIZATION_BOUNDED_MAX_S).toBe(
      INTERACTIVE_PROXY_DRAIN_CLIENT_MAX_S
        + PROXY_RESTART_MAX_S
        + GATEWAY_SHUTDOWN_MAX_S
        + WORKSPACE_FLUSH_MAX_S,
    )
    expect(WORKSPACE_FINALIZATION_BOUNDED_MAX_S).toBe(200)
    expect(WORKSPACE_FINALIZATION_RESERVE_S).toBeGreaterThanOrEqual(
      WORKSPACE_FINALIZATION_BOUNDED_MAX_S,
    )

    const completeLambdaBudgetS =
      STARTUP_RESERVE_S
      + HARNESS_DEADLINE_MAX_S
      + HARNESS_LEAD_S
      + WORKSPACE_FINALIZATION_BOUNDED_MAX_S
      + REPLY_RESERVE_MS / 1000
      + DEADLINE_ORDERING_GUARD_S
    expect(completeLambdaBudgetS).toBeLessThan(LAMBDA_MAX_MS / 1000)
  })

  it("would have let the 2026-07-27 dispatch report a partial", () => {
    // Replay of the real failure. Cold start ~47s, turn ran 824s.
    //
    // The turn is still longer than the budget — this fix does NOT make an
    // oversized dispatch fit, and pretending otherwise would be the wrong
    // claim. What it guarantees is that the HARNESS hits its deadline first
    // and returns a partial, instead of the abort discarding the turn.
    const STARTUP_MS = 47_000
    const TURN_MS = 824_000

    const deadlineMs = resolveTurnDeadlineS(LAMBDA_MAX_MS) * 1000
    const abortMs = resolveAbortMs(LAMBDA_MAX_MS)

    // The harness stops work before we hang up, even including cold start.
    expect(STARTUP_MS + deadlineMs).toBeLessThan(abortMs)

    // And the old hardcoded pair genuinely inverted under these conditions,
    // which is what makes this a regression test and not a tautology.
    const OLD_ABORT_MS = 870_000
    const OLD_HARNESS_MS = 840_000
    expect(STARTUP_MS + Math.min(OLD_HARNESS_MS, TURN_MS)).toBeGreaterThan(
      OLD_ABORT_MS,
    )
  })

  it("respects the harness clamp so the value is not silently rewritten", () => {
    // harness_adapter.py clamps to [60, 550] for a non-job turn; sending
    // anything outside that range means the deadline we reasoned about is not
    // the deadline in force.
    for (const remainingMs of [LAMBDA_MAX_MS, 500_000, 200_000, 95_000]) {
      const deadlineS = resolveTurnDeadlineS(remainingMs)
      expect(deadlineS).toBeGreaterThanOrEqual(HARNESS_DEADLINE_MIN_S)
      expect(deadlineS).toBeLessThanOrEqual(HARNESS_DEADLINE_MAX_S)
    }
  })

  it("degrades safely when almost no time is left", () => {
    // A near-exhausted Lambda must not produce a negative or zero timeout: a
    // non-positive AbortSignal.timeout aborts instantly, turning "little time"
    // into "no attempt at all".
    expect(resolveAbortMs(1_000)).toBeGreaterThan(0)
    expect(resolveAbortMs(0)).toBeGreaterThan(0)
    expect(resolveTurnDeadlineS(0)).toBe(HARNESS_DEADLINE_MIN_S)
  })

  it("gives more turn time as more Lambda time remains", () => {
    // Monotonicity: guards against a sign error that would make the deadline
    // shrink as the budget grows.
    expect(resolveTurnDeadlineS(900_000)).toBeGreaterThanOrEqual(
      resolveTurnDeadlineS(600_000),
    )
    expect(resolveTurnDeadlineS(600_000)).toBeGreaterThan(
      resolveTurnDeadlineS(300_000),
    )
  })
})
