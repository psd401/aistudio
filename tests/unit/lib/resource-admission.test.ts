import {
  RESOURCE_ADMISSION_REPLAY_TTL_MS,
  resourceAdmissionCleanupCutoff,
  resourceAdmissionCountsTowardHourlyBudget,
} from "@/lib/resource-admission"

describe("resource admission terminal semantics", () => {
  it("restores hourly capacity only for known-unused releases", () => {
    expect(resourceAdmissionCountsTowardHourlyBudget("released")).toBe(false)
    expect(resourceAdmissionCountsTowardHourlyBudget("completed")).toBe(true)
    expect(resourceAdmissionCountsTowardHourlyBudget("expired")).toBe(true)
    expect(resourceAdmissionCountsTowardHourlyBudget("active")).toBe(true)
  })

  it("retains replay keys beyond the rolling-hour budget window", () => {
    expect(RESOURCE_ADMISSION_REPLAY_TTL_MS).toBeGreaterThan(
      60 * 60 * 1000,
    )
    const now = new Date("2026-07-26T12:00:00.000Z")
    expect(resourceAdmissionCleanupCutoff(now).toISOString()).toBe(
      "2026-07-25T12:00:00.000Z",
    )
  })
})
