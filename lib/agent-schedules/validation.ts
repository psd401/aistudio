const MAX_NAME_LENGTH = 120
const MAX_PROMPT_LENGTH = 20_000
const MAX_EXPRESSION_LENGTH = 256
const MAX_TIMEZONE_LENGTH = 100
const SCHEDULE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class AgentScheduleInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentScheduleInputError"
  }
}

function requireBoundedString(
  value: unknown,
  field: string,
  maxLength: number
): string {
  if (typeof value !== "string") {
    throw new AgentScheduleInputError(`${field} must be a string`)
  }
  const normalized = value.trim()
  if (!normalized) {
    throw new AgentScheduleInputError(`${field} is required`)
  }
  if (normalized.length > maxLength) {
    throw new AgentScheduleInputError(
      `${field} must be at most ${maxLength} characters`
    )
  }
  return normalized
}

export function validateScheduleId(value: unknown): string {
  const scheduleId = requireBoundedString(value, "scheduleId", 64)
  if (!SCHEDULE_ID_RE.test(scheduleId)) {
    throw new AgentScheduleInputError("scheduleId must be a UUID")
  }
  return scheduleId.toLowerCase()
}

export function validateScheduleName(value: unknown): string {
  return requireBoundedString(value, "name", MAX_NAME_LENGTH)
}

export function validateSchedulePrompt(value: unknown): string {
  return requireBoundedString(value, "prompt", MAX_PROMPT_LENGTH)
}

export function validateScheduleTimezone(value: unknown): string {
  const timezone = requireBoundedString(
    value,
    "timezone",
    MAX_TIMEZONE_LENGTH
  )
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone })
  } catch {
    throw new AgentScheduleInputError(
      "timezone must be a valid IANA timezone"
    )
  }
  return timezone
}

function minuteOccurrences(field: string): number | null {
  if (!/^[\d*/,-]+$/.test(field)) return null
  const minutes = new Set<number>()
  for (const segment of field.split(",")) {
    const [base, stepText] = segment.split("/")
    if (!base || segment.split("/").length > 2) return null
    const step = stepText === undefined ? 1 : Number.parseInt(stepText, 10)
    if (!Number.isInteger(step) || step < 1 || step > 59) return null

    let start: number
    let end: number
    if (base === "*") {
      start = 0
      end = 59
    } else if (base.includes("-")) {
      const [startText, endText] = base.split("-")
      start = Number.parseInt(startText, 10)
      end = Number.parseInt(endText, 10)
    } else {
      start = Number.parseInt(base, 10)
      end = stepText === undefined ? start : 59
    }
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end > 59 ||
      start > end
    ) {
      return null
    }
    for (let minute = start; minute <= end; minute += step) {
      minutes.add(minute)
    }
  }
  return minutes.size
}

function validateCronFields(fields: string[]): void {
  if (fields.length !== 6) {
    throw new AgentScheduleInputError(
      "cron expressions must contain exactly 6 EventBridge fields"
    )
  }
  const occurrences = minuteOccurrences(fields[0])
  if (occurrences !== null && occurrences > 12) {
    throw new AgentScheduleInputError(
      "schedule frequency cannot exceed once every 5 minutes"
    )
  }
  const dayOfMonthSpecified = fields[2] !== "*" && fields[2] !== "?"
  const dayOfWeekSpecified = fields[4] !== "*" && fields[4] !== "?"
  if (dayOfMonthSpecified && dayOfWeekSpecified) {
    throw new AgentScheduleInputError(
      "cron cannot specify both day-of-month and day-of-week"
    )
  }
}

export function toSchedulerExpression(value: unknown): string {
  const expression = requireBoundedString(
    value,
    "cron",
    MAX_EXPRESSION_LENGTH
  )

  const wrappedCron = expression.match(/^cron\((.+)\)$/)
  if (wrappedCron) {
    const fields = wrappedCron[1].trim().split(/\s+/)
    validateCronFields(fields)
    return `cron(${fields.join(" ")})`
  }

  const rate = expression.match(
    /^rate\((\d+)\s+(minute|minutes|hour|hours|day|days)\)$/
  )
  if (rate) {
    const count = Number.parseInt(rate[1], 10)
    if (
      count < 1 ||
      ((rate[2] === "minute" || rate[2] === "minutes") && count < 5)
    ) {
      throw new AgentScheduleInputError(
        "schedule frequency cannot exceed once every 5 minutes"
      )
    }
    return expression
  }

  if (/^at\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\)$/.test(expression)) {
    return expression
  }

  const fields = expression.split(/\s+/)
  if (fields.length !== 5 && fields.length !== 6) {
    throw new AgentScheduleInputError(
      "cron must be a 5/6-field cron, cron(...), rate(...), or at(...)"
    )
  }
  const expanded =
    fields.length === 5 ? [...fields, "*"] : fields
  const dayOfMonthSpecified = expanded[2] !== "*" && expanded[2] !== "?"
  const dayOfWeekSpecified = expanded[4] !== "*" && expanded[4] !== "?"
  if (dayOfMonthSpecified && dayOfWeekSpecified) {
    throw new AgentScheduleInputError(
      "cron cannot specify both day-of-month and day-of-week"
    )
  }
  if (dayOfWeekSpecified) expanded[2] = "?"
  else expanded[4] = "?"
  validateCronFields(expanded)
  return `cron(${expanded.join(" ")})`
}

export function parseEnabled(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new AgentScheduleInputError("enabled must be a boolean")
  }
  return value
}
