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
