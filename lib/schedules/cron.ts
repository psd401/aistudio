/**
 * Cron helpers for Assistant Architect schedules.
 *
 * Extracted from `actions/db/schedule-actions.ts` (a `"use server"` module,
 * whose exports must be async server actions) so the pure conversion/validation
 * logic can be unit-tested directly. See REV-COR-046 (weekly day-of-week
 * off-by-one) and REV-COR-047 (custom POSIX cron → AWS EventBridge cron).
 *
 * EventBridge Scheduler cron grammar differs from POSIX crontab:
 *   - 6 fields: `minutes hours day-of-month month day-of-week year`
 *   - day-of-week is 1-7 with 1=SUN..7=SAT (POSIX is 0-6, 0=SUN)
 *   - day-of-month and day-of-week cannot both be specified; the unused one
 *     must be `?` (POSIX uses `*` in both).
 */

import { ErrorFactories } from "@/lib/error-utils"

/**
 * Minimal structural shape of the schedule config the converter needs. Kept
 * local (rather than importing the `"use server"` module's `ScheduleConfig`) to
 * avoid a lib → actions dependency; the action's interface is assignable to it.
 */
export interface CronScheduleConfig {
  frequency: "daily" | "weekly" | "monthly" | "custom"
  time: string // HH:MM
  timezone?: string
  cron?: string // 5-field POSIX, for custom schedules
  daysOfWeek?: number[] // 0=Sunday..6=Saturday (UI encoding)
  dayOfMonth?: number // 1-31
}

/**
 * Validates the individual fields of a custom (5-field POSIX) cron expression.
 * Returns any validation errors found (empty array when valid).
 */
export function validateCustomCronExpression(cron: string): string[] {
  const errors: string[] = []

  // Comprehensive cron validation with strict input sanitization
  const trimmedCron = cron.trim()

  // First, ensure the cron string only contains allowed characters
  // eslint-disable-next-line no-useless-escape
  if (!/^[\d\s*,/\-]+$/.test(trimmedCron)) {
    errors.push("Cron expression contains invalid characters")
    return errors
  }

  const cronFields = trimmedCron.split(/\s+/)

  // Validate exact field count first
  if (cronFields.length !== 5) {
    errors.push("cron expression must have exactly 5 fields (minute hour day month day-of-week)")
    return errors
  }

  // Validate each field individually to prevent bypass attempts.
  //
  // Note: each field is split on commas and every part is regex-checked, so
  // comma lists (e.g. "1,15,30") are accepted — AWS EventBridge supports them.
  // This validation is intentionally permissive about combining list parts with
  // step values (e.g. "*/2,*/3"): such corner cases pass here but EventBridge is
  // the final authority and will reject anything it does not accept at
  // create/update time. We do not attempt to fully replicate EventBridge's cron
  // grammar; we only block obviously malformed input and ReDoS vectors.
  const [minute, hour, day, month, dayOfWeek] = cronFields

  // Validate minute field (0-59) - supports comma-separated lists, ReDoS-safe
  const minuteRegex = /^\*$|^[0-5]?\d$|^[0-5]?\d-[0-5]?\d$|^[0-5]?\d\/\d+$|^\*\/\d+$/
  if (minute.split(",").some(p => !minuteRegex.test(p))) {
    errors.push("Invalid minute field in cron expression")
  }

  // Validate hour field (0-23) - supports comma-separated lists, ReDoS-safe
  const hourRegex = /^\*$|^(?:[01]?\d|2[0-3])$|^(?:[01]?\d|2[0-3])-(?:[01]?\d|2[0-3])$|^(?:[01]?\d|2[0-3])\/\d+$|^\*\/\d+$/
  if (hour.split(",").some(p => !hourRegex.test(p))) {
    errors.push("Invalid hour field in cron expression")
  }

  // Validate day field (1-31, no leading-zero "0") - supports comma-separated
  // lists, ReDoS-safe. The single-digit alternative is restricted to [1-9] (not
  // [12]?\d) so "0" is rejected — day-of-month has no zero value, and accepting
  // it let an invalid POSIX cron like "0 0 0 * *" pass validation and then be
  // converted into an AWS cron that EventBridge rejects at create/update time.
  const dayRegex = /^\*$|^(?:[1-9]|[12]\d|3[01])$|^(?:[1-9]|[12]\d|3[01])-(?:[1-9]|[12]\d|3[01])$|^(?:[1-9]|[12]\d|3[01])\/\d+$|^\*\/\d+$/
  if (day.split(",").some(p => !dayRegex.test(p))) {
    errors.push("Invalid day field in cron expression")
  }

  // Validate month field (1-12) - supports comma-separated lists, ReDoS-safe
  const monthRegex = /^\*$|^(?:[1-9]|1[0-2])$|^(?:[1-9]|1[0-2])-(?:[1-9]|1[0-2])$|^(?:[1-9]|1[0-2])\/\d+$|^\*\/\d+$/
  if (month.split(",").some(p => !monthRegex.test(p))) {
    errors.push("Invalid month field in cron expression")
  }

  // Validate day-of-week field (0-6) - supports comma-separated lists, ReDoS-safe,
  // and — unlike the other fields' regexes — combined ranges-with-step (e.g.
  // "1-5/2"), which the previous pattern rejected outright.
  //
  // Split into small single-purpose regexes (rather than one combined
  // `^(\*|[0-6](-[0-6])?)(\/\d+)?$` pattern) because eslint-plugin-security's
  // detect-unsafe-regex static-complexity heuristic flags the combined form
  // as unprovably safe, even though neither form has real catastrophic-
  // backtracking risk (no ambiguous nested repetition).
  const isValidDayOfWeekToken = (token: string): boolean => {
    const stepSplit = token.match(/^([^/]*)\/(\d+)$/)
    const base = stepSplit ? stepSplit[1] : token
    if (base === "*") return true
    if (/^[0-6]$/.test(base)) return true
    return /^[0-6]-[0-6]$/.test(base)
  }
  if (dayOfWeek.split(",").some(p => !isValidDayOfWeekToken(p))) {
    errors.push("Invalid day-of-week field in cron expression")
  }

  // AWS EventBridge forbids constraining BOTH day-of-month and day-of-week; one
  // must be `?`. We accept 5-field POSIX input (no `?`), so reject the case where
  // the user constrains both — convertToCronExpression cannot emit a valid AWS
  // expression for it. (REV-COR-047)
  if (day !== "*" && dayOfWeek !== "*") {
    errors.push("Specify a day-of-month or a day-of-week, but not both")
  }

  return errors
}

/**
 * Translate a POSIX day-of-week field (0-6, 0=Sun — the only range
 * `validateCustomCronExpression` accepts) to AWS EventBridge numbering (1-7,
 * 1=Sun), preserving comma lists, ranges, and steps. Step VALUES are not day
 * numbers and are left unshifted. The `% 7` in `shift()` incidentally also
 * maps a literal `7` to Sun, but that input never reaches here validated.
 */
function translateDowFieldPosixToAws(dowField: string): string {
  const shift = (tok: string): string =>
    tok === "*" ? "*" : String((Number(tok) % 7) + 1)
  return dowField
    .split(",")
    .map((part) => {
      const step = part.match(/^(.+)\/(\d+)$/)
      if (step) {
        const base = step[1]
        if (base === "*") return `*/${step[2]}`
        const range = base.match(/^(\d+)-(\d+)$/)
        if (range) return `${shift(range[1])}-${shift(range[2])}/${step[2]}`
        return `${shift(base)}/${step[2]}`
      }
      const range = part.match(/^(\d+)-(\d+)$/)
      if (range) return `${shift(range[1])}-${shift(range[2])}`
      return shift(part)
    })
    .join(",")
}

/**
 * Convert a validated 5-field POSIX cron ("min hour dom month dow") to a 6-field
 * AWS EventBridge Scheduler expression ("min hour dom month dow year"). Handles
 * the AWS rule that day-of-month and day-of-week cannot both be specified (one
 * must be `?`), and translates POSIX day-of-week numbering. (REV-COR-047)
 */
function convertPosixCronToAws(cron: string): string {
  const [minute, hour, dom, month, dow] = cron.trim().split(/\s+/)
  let outDom = dom
  let outDow: string
  if (dow === "*") {
    // dom may be `*` or constrained; the unspecified day-of-week field becomes `?`.
    outDow = "?"
  } else if (dom === "*") {
    // day-of-week is specified, so day-of-month must be `?`.
    outDom = "?"
    outDow = translateDowFieldPosixToAws(dow)
  } else {
    // Both constrained — AWS forbids this (validateCustomCronExpression also
    // rejects it; this guards direct callers).
    throw ErrorFactories.validationFailed([{ field: "cron", message: "Specify a day-of-month or a day-of-week, but not both" }])
  }
  return `${minute} ${hour} ${outDom} ${month} ${outDow} *`
}

/**
 * Converts schedule configuration to an AWS EventBridge cron expression.
 */
export function convertToCronExpression(scheduleConfig: CronScheduleConfig): string {
  const { frequency, time, daysOfWeek, dayOfMonth, cron } = scheduleConfig

  if (frequency === "custom" && cron) {
    return convertPosixCronToAws(cron)
  }

  const [hours, minutes] = time.split(":").map(Number)

  switch (frequency) {
    case "daily":
      return `${minutes} ${hours} * * ? *`

    case "weekly": {
      if (!daysOfWeek || daysOfWeek.length === 0) {
        throw ErrorFactories.validationFailed([{ field: "daysOfWeek", message: "Days of week required for weekly schedules" }])
      }
      // AWS EventBridge day-of-week is 1=SUN..7=SAT; the UI encodes 0=SUN..6=SAT,
      // so shift every selected day by +1 (REV-COR-046). Previously this mapped
      // only 0→7 and left 1–6 unchanged, firing every weekly schedule one day early.
      const cronDays = daysOfWeek.map(day => day + 1).join(",")
      return `${minutes} ${hours} ? * ${cronDays} *`
    }

    case "monthly": {
      const day = dayOfMonth || 1
      return `${minutes} ${hours} ${day} * ? *`
    }

    default:
      throw ErrorFactories.validationFailed([{ field: "frequency", message: `Unsupported frequency: ${frequency}`, value: frequency }])
  }
}
