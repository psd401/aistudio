import { toSchedulerExpression } from "@/lib/agent-schedules/validation"

describe("cron field domain validation", () => {
  it("rejects the Quartz-shifted expression that reached EventBridge as a 502", () => {
    // Exactly what an agent produced for "6:45am weekdays" and retried five
    // times: 6 fields, so the count check passed, but seconds-first shifts
    // everything — hour=45, year=MON-FRI.
    expect(() => toSchedulerExpression("cron(0 45 6 * ? MON-FRI)")).toThrow(
      /shifted by one/
    )
  })

  it("names the correct expression in the error", () => {
    let message = ""
    try {
      toSchedulerExpression("cron(0 45 6 * ? MON-FRI)")
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("cron(45 6 ? * MON-FRI *)")
  })

  it("accepts the correct 6-field weekday expression", () => {
    expect(toSchedulerExpression("cron(45 6 ? * MON-FRI *)")).toBe(
      "cron(45 6 ? * MON-FRI *)"
    )
  })

  it("still expands the documented 5-field form correctly", () => {
    // SKILL.md's cheat sheet is 5-field; the expansion appends the year and
    // applies the DoM/DoW exclusion.
    expect(toSchedulerExpression("45 6 * * MON-FRI")).toBe(
      "cron(45 6 ? * MON-FRI *)"
    )
    expect(toSchedulerExpression("0 18 * * *")).toBe("cron(0 18 * * ? *)")
  })

  it("rejects the in-range shifted expression that silently never fired", () => {
    // agent_failures 7101: intended 6:15pm daily, became 15:00 on the 18th.
    // Every field is in range, so only the ?-rule catches it. The schedule was
    // created, reported healthy, and never fired.
    expect(() => toSchedulerExpression("cron(0 15 18 * * *)")).toThrow(/\? in exactly one/)
  })

  it("accepts the correct daily form and the 5-field equivalent", () => {
    expect(toSchedulerExpression("cron(15 18 * * ? *)")).toBe("cron(15 18 * * ? *)")
    expect(toSchedulerExpression("15 18 * * *")).toBe("cron(15 18 * * ? *)")
  })

  it("rejects out-of-range values in each field", () => {
    expect(() => toSchedulerExpression("cron(75 6 ? * MON-FRI *)")).toThrow(/minute/)
    expect(() => toSchedulerExpression("cron(0 26 ? * MON-FRI *)")).toThrow(/shifted|hour/)
    expect(() => toSchedulerExpression("cron(0 6 45 * ? *)")).toThrow(/day-of-month/)
    expect(() => toSchedulerExpression("cron(0 6 ? 13 * *)")).toThrow(/month/)
  })
})

describe("day-of-week must be named, not numeric", () => {
  it("rejects the numeric range that ran Sun-Thu instead of Mon-Fri", () => {
    // agent_failures 8157: `30 6 * * 1-5` became cron(30 6 ? * 1-5 *), which
    // EventBridge reads as SUN-THU (1=SUN). Run history shows fires on
    // Sun/Mon/Tue/Wed/Thu and none on Friday — a valid expression running on
    // the wrong days, which nothing else catches.
    expect(() => toSchedulerExpression("30 6 * * 1-5")).toThrow(/names/)
    expect(() => toSchedulerExpression("cron(30 6 ? * 1-5 *)")).toThrow(/names/)
  })

  it("explains the off-by-one so the fix is obvious", () => {
    let message = ""
    try {
      toSchedulerExpression("30 6 * * 1-5")
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("1=SUN")
    expect(message).toContain("MON-FRI")
  })

  it("accepts named days, which mean the same in both cron dialects", () => {
    expect(toSchedulerExpression("30 6 * * MON-FRI")).toBe("cron(30 6 ? * MON-FRI *)")
    expect(toSchedulerExpression("0 12 * * TUE,THU")).toBe("cron(0 12 ? * TUE,THU *)")
  })

  it("leaves ? and * alone, and does not touch numeric day-of-MONTH", () => {
    expect(toSchedulerExpression("0 18 * * *")).toBe("cron(0 18 * * ? *)")
    // 1,15 here is day-of-month, which IS numeric and unambiguous.
    expect(toSchedulerExpression("0 8 1,15 * *")).toBe("cron(0 8 1,15 * ? *)")
  })
})

describe("an unwrapped 6-field cron must carry a YEAR in field 6", () => {
  it("rejects the seconds-first daily form that became a monthly schedule", () => {
    // #1888: "6:15pm daily". Six fields, so the count check passed; field 6 is
    // `*`, so the year check passes too. normalizeUnwrappedCron then set `?`
    // itself and produced cron(0 15 18 * ? *) — 3:00pm on the 18th of every
    // month — which the server's `?` guard could never see as wrong.
    expect(() => toSchedulerExpression("0 15 18 * * *")).toThrow(
      /seconds-first/
    )
  })

  it("names the right 5-field form in that error", () => {
    let message = ""
    try {
      toSchedulerExpression("0 15 18 * * *")
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("15 18 * * *")
    expect(message).toContain("day-of-month 18")
  })

  it("rejects the seconds-first morning form too", () => {
    // "6:30am daily" would have become 06:00 on the 30th of the month.
    expect(() => toSchedulerExpression("0 30 6 * * *")).toThrow(/seconds-first/)
  })

  it("rejects a 6th field that is neither a year nor *", () => {
    expect(() => toSchedulerExpression("0 45 6 * ? MON-FRI")).toThrow(
      /4-digit year/
    )
    expect(() => toSchedulerExpression("cron(45 6 ? * * JAN)")).toThrow(
      /4-digit year/
    )
  })

  it("still accepts a valid 5-field cron", () => {
    expect(toSchedulerExpression("30 6 * * MON-FRI")).toBe(
      "cron(30 6 ? * MON-FRI *)"
    )
  })

  it("still accepts a valid wrapped 6-field cron", () => {
    expect(toSchedulerExpression("cron(15 18 * * ? *)")).toBe(
      "cron(15 18 * * ? *)"
    )
    expect(toSchedulerExpression("cron(0 6 ? * MON-FRI 2027)")).toBe(
      "cron(0 6 ? * MON-FRI 2027)"
    )
  })

  it("leaves a legitimate unwrapped 6-field expression alone", () => {
    // Minute 0, hour 0, day-of-month 1 — field 1 is `0` and field 3 is an
    // hour-sized number, which is the seconds-first fingerprint, but `?` in
    // day-of-week says this is really EventBridge shape.
    expect(toSchedulerExpression("0 0 1 * ? *")).toBe("cron(0 0 1 * ? *)")
    expect(toSchedulerExpression("45 6 ? * MON-FRI *")).toBe(
      "cron(45 6 ? * MON-FRI *)"
    )
  })

  it("keeps an explicit-year expression that matches the seconds fingerprint", () => {
    // 9:00am on the 1st, in 2027. Field 1 is `0` and field 3 is hour-sized, so
    // the seconds-first heuristic would fire — but a seconds-first cron carries
    // day-of-week in field 6, never a 4-digit year, so this form is unambiguous.
    expect(toSchedulerExpression("0 9 1 * * 2027")).toBe("cron(0 9 1 * ? 2027)")
    expect(toSchedulerExpression("0 23 23 * * 2027-2029")).toBe(
      "cron(0 23 23 * ? 2027-2029)"
    )
  })
})
