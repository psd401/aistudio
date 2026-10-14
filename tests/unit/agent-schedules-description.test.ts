import { describeScheduleExpression } from "@/lib/agent-schedules/schedule-description"

const PACIFIC = "America/Los_Angeles"
// A Monday, 09:00 Pacific (PDT, UTC-7).
const MONDAY_9AM_PDT = new Date("2026-10-12T16:00:00Z")

describe("describeScheduleExpression — plain language", () => {
  it("describes a weekday morning cron the way a person would say it", () => {
    const { description } = describeScheduleExpression(
      "cron(30 6 ? * MON-FRI *)",
      PACIFIC,
      { now: MONDAY_9AM_PDT }
    )
    expect(description).toBe("At 6:30 AM, on Monday through Friday")
  })

  it("describes a daily evening cron", () => {
    const { description } = describeScheduleExpression(
      "cron(15 18 * * ? *)",
      PACIFIC,
      { now: MONDAY_9AM_PDT }
    )
    expect(description).toBe("At 6:15 PM, every day")
  })

  it("describes the MISREAD form differently from the intended one", () => {
    // The whole point of the echo-back: `cron(0 15 18 * ? *)` is what the
    // broken normalizer produced for "6:15pm daily". Read back, it is plainly
    // not what was asked for.
    const misread = describeScheduleExpression(
      "cron(0 15 18 * ? *)",
      PACIFIC,
      { now: MONDAY_9AM_PDT }
    )
    expect(misread.description).toBe("At 3:00 PM, on day 18 of the month")
  })

  it("describes a numeric day-of-week in EventBridge's own numbering", () => {
    // 1-5 is SUN-THU to EventBridge. The description says so out loud.
    const { description } = describeScheduleExpression(
      "cron(30 6 ? * 1-5 *)",
      PACIFIC,
      { now: MONDAY_9AM_PDT }
    )
    expect(description).toBe("At 6:30 AM, on Sunday through Thursday")
  })

  it("describes a two-day list, a monthly day list, and a stepped minute", () => {
    expect(
      describeScheduleExpression("cron(0 12 ? * TUE,THU *)", PACIFIC, {
        now: MONDAY_9AM_PDT,
      }).description
    ).toBe("At 12:00 PM, on Tuesday and Thursday")
    expect(
      describeScheduleExpression("cron(0 8 1,15 * ? *)", PACIFIC, {
        now: MONDAY_9AM_PDT,
      }).description
    ).toBe("At 8:00 AM, on day 1 and 15 of the month")
    expect(
      describeScheduleExpression("cron(*/15 * * * ? *)", PACIFIC, {
        now: MONDAY_9AM_PDT,
      }).description
    ).toBe("Every 15 minutes, every day")
  })

  it("describes rate() and at() expressions", () => {
    expect(
      describeScheduleExpression("rate(1 hour)", PACIFIC, {
        now: MONDAY_9AM_PDT,
      }).description
    ).toBe("Every hour")
    expect(
      describeScheduleExpression("rate(5 minutes)", PACIFIC, {
        now: MONDAY_9AM_PDT,
      }).description
    ).toBe("Every 5 minutes")
    expect(
      describeScheduleExpression("at(2026-10-12T20:15:00)", PACIFIC, {
        now: MONDAY_9AM_PDT,
      }).description
    ).toBe("Once, on October 12, 2026 at 8:15 PM")
  })

  it("falls back to the raw expression rather than throwing", () => {
    const unsupported = describeScheduleExpression(
      "cron(0 6 ? * 6#3 *)",
      PACIFIC,
      { now: MONDAY_9AM_PDT }
    )
    expect(unsupported.description).toBe("cron(0 6 ? * 6#3 *)")
    expect(unsupported.nextRuns).toEqual([])

    const badZone = describeScheduleExpression(
      "cron(30 6 ? * MON-FRI *)",
      "Not/AZone",
      { now: MONDAY_9AM_PDT }
    )
    expect(badZone.nextRuns).toEqual([])
  })
})

describe("describeScheduleExpression — next fire times", () => {
  it("returns the next three weekday mornings in the schedule's timezone", () => {
    const { nextRuns } = describeScheduleExpression(
      "cron(30 6 ? * MON-FRI *)",
      PACIFIC,
      { now: MONDAY_9AM_PDT }
    )
    // Monday 09:00 has already passed 06:30, so the next three are Tue-Thu.
    expect(nextRuns).toEqual([
      "2026-10-13T06:30:00-07:00",
      "2026-10-14T06:30:00-07:00",
      "2026-10-15T06:30:00-07:00",
    ])
  })

  it("skips the weekend for a weekday schedule", () => {
    // Friday 2026-10-16, 09:00 Pacific.
    const friday = new Date("2026-10-16T16:00:00Z")
    const { nextRuns } = describeScheduleExpression(
      "cron(30 6 ? * MON-FRI *)",
      PACIFIC,
      { now: friday }
    )
    expect(nextRuns[0]).toBe("2026-10-19T06:30:00-07:00")
  })

  it("holds the local wall clock across a DST transition", () => {
    // US DST ends 2026-11-01; 6:30am stays 6:30am, the offset moves -07 to -08.
    const lateOctober = new Date("2026-10-30T16:00:00Z")
    const { nextRuns } = describeScheduleExpression(
      "cron(30 6 * * ? *)",
      PACIFIC,
      { now: lateOctober, count: 4 }
    )
    expect(nextRuns).toEqual([
      "2026-10-31T06:30:00-07:00",
      "2026-11-01T06:30:00-08:00",
      "2026-11-02T06:30:00-08:00",
      "2026-11-03T06:30:00-08:00",
    ])
  })

  it("computes in the schedule's OWN timezone, not the host's", () => {
    const { nextRuns } = describeScheduleExpression(
      "cron(0 9 * * ? *)",
      "Asia/Tokyo",
      { now: MONDAY_9AM_PDT }
    )
    expect(nextRuns[0]).toBe("2026-10-13T09:00:00+09:00")
  })

  it("shows the misread monthly schedule firing a month out", () => {
    const { nextRuns } = describeScheduleExpression(
      "cron(0 15 18 * ? *)",
      PACIFIC,
      { now: MONDAY_9AM_PDT }
    )
    expect(nextRuns).toEqual([
      "2026-10-18T15:00:00-07:00",
      "2026-11-18T15:00:00-08:00",
      "2026-12-18T15:00:00-08:00",
    ])
  })

  it("returns one fire time for a future at(), and none for a past one", () => {
    expect(
      describeScheduleExpression("at(2026-10-12T20:15:00)", PACIFIC, {
        now: MONDAY_9AM_PDT,
      }).nextRuns
    ).toEqual(["2026-10-12T20:15:00-07:00"])
    expect(
      describeScheduleExpression("at(2026-01-01T08:00:00)", PACIFIC, {
        now: MONDAY_9AM_PDT,
      }).nextRuns
    ).toEqual([])
  })

  it("projects rate() forward from now", () => {
    const { nextRuns } = describeScheduleExpression("rate(1 hour)", PACIFIC, {
      now: MONDAY_9AM_PDT,
    })
    expect(nextRuns).toEqual([
      "2026-10-12T10:00:00-07:00",
      "2026-10-12T11:00:00-07:00",
      "2026-10-12T12:00:00-07:00",
    ])
  })

  it("returns nothing when the year field is already in the past", () => {
    expect(
      describeScheduleExpression("cron(0 9 * * ? 2020)", PACIFIC, {
        now: MONDAY_9AM_PDT,
      }).nextRuns
    ).toEqual([])
  })
})
