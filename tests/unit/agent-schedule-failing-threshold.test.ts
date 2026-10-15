/**
 * The failing threshold is defined twice, in two separately-deployed units,
 * and nothing but this test keeps them equal (#1890).
 *
 * `NOTICE_THRESHOLD` decides when the PLATFORM messages the schedule's owner,
 * from inside the agent-cron Lambda bundle. `FAILING_SCHEDULE_THRESHOLD`
 * decides when the broker reports `failing: true` to the agent, from the
 * Next.js app. They cannot share a module across that boundary — the Lambda
 * bundles independently with its own package.json — so if they drift, a
 * schedule gets flagged to the agent at one count and messaged to its owner at
 * another, and nobody finds out from a type error.
 */

import { NOTICE_THRESHOLD } from "../../infra/lambdas/agent-cron/schedule-failure-notice"
import { FAILING_SCHEDULE_THRESHOLD } from "@/lib/agent-schedules/run-reader"

describe("the failing threshold is one number in two places", () => {
  it("agrees between the owner notice and the agent-visible marker", () => {
    expect(NOTICE_THRESHOLD).toBe(FAILING_SCHEDULE_THRESHOLD)
  })

  it("is the documented value", () => {
    // Stated in the issue's Definition of Done and in psd-schedules/SKILL.md.
    expect(FAILING_SCHEDULE_THRESHOLD).toBe(3)
  })
})
