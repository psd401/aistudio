import { auditSchedule } from "@/lib/agent-schedules/schedule-audit"

function schedule(overrides: Partial<Parameters<typeof auditSchedule>[0]> = {}) {
  return {
    scheduleId: "11111111-2222-4333-8444-555555555555",
    ownerEmail: "owner@psd401.net",
    name: "Morning Brief",
    timezone: "America/Los_Angeles",
    enabled: true,
    schedulerExpression: "cron(30 6 ? * MON-FRI *)",
    ...overrides,
  }
}

describe("auditSchedule", () => {
  it("reports nothing for a correct weekday schedule", () => {
    expect(auditSchedule(schedule())).toBeNull()
  })

  it("flags a legacy numeric day-of-week and suggests the named equivalent", () => {
    const finding = auditSchedule(
      schedule({ schedulerExpression: "cron(30 6 ? * 1-5 *)" })
    )
    expect(finding).not.toBeNull()
    expect(finding?.issues[0]).toMatch(/numeric day-of-week/)
    // EventBridge's own reading, not a guess at intent: 1-5 IS SUN-THU.
    expect(finding?.suggestedExpression).toBe("cron(30 6 ? * SUN-THU *)")
    expect(finding?.description).toBe("At 6:30 AM, on Sunday through Thursday")
  })

  it("leaves a monthly or yearly schedule alone when its name says so", () => {
    // "morning" is a time of day, not a frequency. A correct monthly job was
    // reported as a mismatch and handed cron(9 1 * * ? *) — a 1:09am daily
    // schedule. A name that states its cadence wins over the time-of-day word.
    for (const name of [
      "Monthly board packet",
      "Monthly morning report",
      "Month-end evening summary",
      "Quarterly morning digest",
      "Annual overnight archive",
      "Yearly nightly cleanup",
    ]) {
      expect(
        auditSchedule(
          schedule({ name, schedulerExpression: "cron(0 9 1 * ? *)" })
        )
      ).toBeNull()
    }
  })

  it("still flags a daily name with no cadence word", () => {
    // The guard above must not swallow the real signal this audit exists for.
    const finding = auditSchedule(
      schedule({
        name: "Morning report",
        schedulerExpression: "cron(0 9 1 * ? *)",
      })
    )
    expect(finding?.issues[0]).toMatch(/fires only on specific days/)
  })

  it("reports no fire times for a disabled schedule", () => {
    const finding = auditSchedule(
      schedule({
        name: "Evening heads-up",
        schedulerExpression: "cron(0 15 18 * ? *)",
        enabled: false,
      })
    )
    expect(finding?.enabled).toBe(false)
    expect(finding?.nextRuns).toEqual([])
    expect(finding?.description).toBe("At 3:00 PM, on day 18 of the month")
  })

  it("flags a numeric day-of-week list too", () => {
    const finding = auditSchedule(
      schedule({ schedulerExpression: "cron(0 12 ? * 3,5 *)" })
    )
    expect(finding?.suggestedExpression).toBe("cron(0 12 ? * TUE,THU *)")
  })

  it("flags a daily-named schedule that actually fires monthly", () => {
    // The #1888 fingerprint: "6:15pm daily" stored as 3:00pm on the 18th.
    const finding = auditSchedule(
      schedule({
        name: "Evening heads-up",
        schedulerExpression: "cron(0 15 18 * ? *)",
      })
    )
    expect(finding?.issues[0]).toMatch(/fires only on specific days of the month/)
    expect(finding?.suggestedExpression).toBe("cron(15 18 * * ? *)")
    expect(finding?.nextRuns[0]).toMatch(/^\d{4}-\d{2}-18T15:00:00/)
  })

  it("flags a weekday-named schedule pinned to a single year", () => {
    const finding = auditSchedule(
      schedule({
        name: "Weekday digest",
        schedulerExpression: "cron(30 6 ? * MON-FRI 2024)",
      })
    )
    expect(finding?.issues[0]).toMatch(/fires only in a fixed year/)
  })

  it("ignores rate() and at() schedules", () => {
    expect(
      auditSchedule(schedule({ schedulerExpression: "rate(1 hour)" }))
    ).toBeNull()
    expect(
      auditSchedule(
        schedule({ schedulerExpression: "at(2026-10-12T20:15:00)" })
      )
    ).toBeNull()
  })

  it("carries the owner through so the report says who to contact", () => {
    const finding = auditSchedule(
      schedule({
        ownerEmail: "principal@psd401.net",
        schedulerExpression: "cron(30 6 ? * 1-5 *)",
      })
    )
    expect(finding?.ownerEmail).toBe("principal@psd401.net")
    expect(finding?.enabled).toBe(true)
  })
})

describe("auditSchedule — restriction detection", () => {
  it("flags a daily-named schedule that fires only every fifth day", () => {
    // A step is still a restriction. Treating any field containing a star as
    // unrestricted let this one through unreported.
    const finding = auditSchedule(
      schedule({
        name: "Daily report",
        schedulerExpression: "cron(0 9 */5 * ? *)",
      })
    )
    expect(finding?.issues[0]).toMatch(/fires only on specific days of the month/)
  })

  it("does not flag a step of one, which is every day", () => {
    expect(
      auditSchedule(
        schedule({
          name: "Daily report",
          schedulerExpression: "cron(0 9 */1 * ? *)",
        })
      )
    ).toBeNull()
  })
})
