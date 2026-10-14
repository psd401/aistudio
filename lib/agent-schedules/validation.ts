/**
 * Timezone a schedule falls back to when the record does not name one.
 *
 * Lives here rather than in `service.ts` so the read-only audit script can
 * share it without pulling the AWS SDK in through the service module.
 */
export const DEFAULT_SCHEDULE_TIMEZONE = "America/Los_Angeles";

const MAX_NAME_LENGTH = 120;
const MAX_PROMPT_LENGTH = 20_000;
const MAX_EXPRESSION_LENGTH = 256;
const MAX_TIMEZONE_LENGTH = 100;
const SCHEDULE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_SCHEDULE_ID_RE = /^[0-9a-f]{8}$/i;

export class AgentScheduleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentScheduleInputError";
  }
}

function requireBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw new AgentScheduleInputError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new AgentScheduleInputError(`${field} is required`);
  }
  if (normalized.length > maxLength) {
    throw new AgentScheduleInputError(
      `${field} must be at most ${maxLength} characters`,
    );
  }
  return normalized;
}

export function validateScheduleId(value: unknown): string {
  const scheduleId = requireBoundedString(value, "scheduleId", 64);
  if (
    !SCHEDULE_ID_RE.test(scheduleId) &&
    !LEGACY_SCHEDULE_ID_RE.test(scheduleId)
  ) {
    throw new AgentScheduleInputError(
      "scheduleId must be a UUID or legacy 8-character hexadecimal ID",
    );
  }
  return scheduleId.toLowerCase();
}

export function validateScheduleName(value: unknown): string {
  return requireBoundedString(value, "name", MAX_NAME_LENGTH);
}

export function validateSchedulePrompt(value: unknown): string {
  return requireBoundedString(value, "prompt", MAX_PROMPT_LENGTH);
}

export function validateScheduleTimezone(value: unknown): string {
  const timezone = requireBoundedString(value, "timezone", MAX_TIMEZONE_LENGTH);
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    throw new AgentScheduleInputError("timezone must be a valid IANA timezone");
  }
  return timezone;
}

interface MinuteSegment {
  start: number;
  end: number;
  step: number;
}

function parseMinuteSegment(segment: string): MinuteSegment | null {
  const pieces = segment.split("/");
  const [base, stepText] = pieces;
  if (!base || pieces.length > 2) return null;
  const step = stepText === undefined ? 1 : Number.parseInt(stepText, 10);
  if (!Number.isInteger(step) || step < 1 || step > 59) return null;

  let start: number;
  let end: number;
  if (base === "*") {
    start = 0;
    end = 59;
  } else if (base.includes("-")) {
    const [startText, endText] = base.split("-");
    start = Number.parseInt(startText, 10);
    end = Number.parseInt(endText, 10);
  } else {
    start = Number.parseInt(base, 10);
    end = stepText === undefined ? start : 59;
  }
  const valid =
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end <= 59 &&
    start <= end;
  return valid ? { start, end, step } : null;
}

function minuteOccurrences(field: string): number | null {
  if (!/^[\d*/,-]+$/.test(field)) return null;
  const minutes = new Set<number>();
  for (const segment of field.split(",")) {
    const parsed = parseMinuteSegment(segment);
    if (!parsed) return null;
    const { start, end, step } = parsed;
    for (let minute = start; minute <= end; minute += step) {
      minutes.add(minute);
    }
  }
  return minutes.size;
}

function validateCronFields(fields: string[]): void {
  if (fields.length !== 6) {
    throw new AgentScheduleInputError(
      "cron expressions must contain exactly 6 EventBridge fields",
    );
  }
  const occurrences = minuteOccurrences(fields[0]);
  if (occurrences !== null && occurrences > 12) {
    throw new AgentScheduleInputError(
      "schedule frequency cannot exceed once every 5 minutes",
    );
  }
  const dayOfMonthSpecified = fields[2] !== "*" && fields[2] !== "?";
  const dayOfWeekSpecified = fields[4] !== "*" && fields[4] !== "?";
  if (dayOfMonthSpecified && dayOfWeekSpecified) {
    throw new AgentScheduleInputError(
      "cron cannot specify both day-of-month and day-of-week",
    );
  }
  validateCronFieldDomains(fields);
}

/** Numeric bound for a cron field, ignoring `*`, `?`, names, and step syntax. */
function numericValuesOutOfRange(
  field: string,
  min: number,
  max: number,
): boolean {
  if (!/^[\d*/,-]+$/.test(field)) return false;
  for (const token of field.split(/[,/-]/)) {
    if (token === "" || token === "*") continue;
    const value = Number.parseInt(token, 10);
    if (!Number.isInteger(value)) continue;
    if (value < min || value > max) return true;
  }
  return false;
}

const DAY_OF_WEEK_NAME = /^(SUN|MON|TUE|WED|THU|FRI|SAT)/i;

/**
 * Is this cron field a YEAR — `*`, a 4-digit year, or a list/range/step of
 * them?
 *
 * Written as a parser rather than one regex: the equivalent pattern nests
 * quantifiers inside an alternation, which is a ReDoS shape on attacker-
 * reachable input (this field comes straight off an agent request).
 */
function isYearField(field: string): boolean {
  if (field === "*") return true;
  return field.split(",").every((segment) => {
    const pieces = segment.split("/");
    if (pieces.length > 2) return false;
    // `(?!0+$)` rejects a zero step: `2024/0` is nonsense, and accepting it
    // here would let it reach AWS as an opaque 400.
    if (pieces.length === 2 && !/^(?!0+$)\d{1,3}$/.test(pieces[1])) return false;
    if (pieces[0] === "*") return true;
    const bounds = pieces[0].split("-");
    return (
      bounds.length <= 2 && bounds.every((token) => /^\d{4}$/.test(token))
    );
  });
}

/**
 * Reject an expression whose field COUNT is right but whose field VALUES are
 * not EventBridge's.
 *
 * A 6-field count check alone accepts Quartz-style input, which carries a
 * leading seconds field and so shifts every later field by one. That is how
 * `cron(0 45 6 * ? MON-FRI)` — an agent's attempt at "6:45am on weekdays" —
 * passed validation and reached EventBridge, which rejected it with
 * `Invalid Schedule Expression` behind an opaque HTTP 502. One user retried it
 * five times over two days (agent_failures 6507, 7053; broker logs
 * 2026-08-12T19:10:58, 19:11:05, 19:11:12, 2026-08-13T14:53:27). The correct
 * expression is `cron(45 6 ? * MON-FRI *)`.
 *
 * Checking the two fields that make the shift unmistakable — an hour above 23,
 * and a day name where the year belongs — turns that into an actionable local
 * error naming the likely cause, instead of a 502 from AWS.
 */
function validateCronFieldDomains(fields: string[]): void {
  if (numericValuesOutOfRange(fields[0], 0, 59)) {
    throw new AgentScheduleInputError("cron minute field must be 0-59");
  }
  if (
    numericValuesOutOfRange(fields[1], 0, 23) ||
    DAY_OF_WEEK_NAME.test(fields[5])
  ) {
    throw new AgentScheduleInputError(
      "cron fields look shifted by one — EventBridge takes " +
        "minute hour day-of-month month day-of-week year (6 fields, no " +
        "seconds). For 6:45am on weekdays use cron(45 6 ? * MON-FRI *).",
    );
  }
  // Same year rule the unwrapped path enforces, applied to a hand-wrapped
  // `cron(...)` so both entry points agree on what field 6 is.
  if (!isYearField(fields[5])) {
    throw new AgentScheduleInputError(
      "the 6th cron field must be a 4-digit year or *. EventBridge takes " +
        "minute hour day-of-month month day-of-week year (no seconds field).",
    );
  }
  if (numericValuesOutOfRange(fields[2], 1, 31)) {
    throw new AgentScheduleInputError("cron day-of-month field must be 1-31");
  }
  if (numericValuesOutOfRange(fields[3], 1, 12)) {
    throw new AgentScheduleInputError("cron month field must be 1-12");
  }
  // Day-of-week must be named, never numeric.
  //
  // EventBridge numbers day-of-week 1=SUN..7=SAT. Standard cron (and Quartz,
  // and every cheat sheet on the internet) numbers it 0=SUN..6=SAT, so `1-5`
  // means MON-FRI there and SUN-THU here. Nothing rejects the wrong one: it is
  // a valid expression that silently runs on the wrong days.
  //
  // A daily brief written as `30 6 ? * 1-5 *` fired Sunday through Thursday for
  // a week — the user got an unwanted Sunday brief and no Friday one, and only
  // noticed on the Friday it did not arrive (agent_failures 8157; run history
  // confirms fires on Sun/Mon/Tue/Wed/Thu and none on Fri).
  //
  // Names have the same meaning in both dialects, so requiring them removes the
  // ambiguity rather than guessing which dialect was intended — the skill's own
  // cheat sheet already uses MON-FRI.
  if (/\d/.test(fields[4]) && fields[4] !== "?" && fields[4] !== "*") {
    throw new AgentScheduleInputError(
      "cron day-of-week must use names (SUN,MON,TUE,WED,THU,FRI,SAT), not " +
        "numbers. EventBridge counts 1=SUN, while ordinary cron counts " +
        "0=SUN, so a numeric range runs a day off without failing. " +
        "Weekdays are MON-FRI.",
    );
  }
  // EventBridge requires `?` in exactly one of day-of-month / day-of-week; the
  // two cannot both be concrete, and cannot both be `*`.
  //
  // This is the check that catches a shifted expression whose every value
  // still happens to be in range, which the bounds above cannot. `cron(0 15 18
  // * * *)` — an agent's "6:15pm daily" with a Quartz seconds field in front —
  // reads to EventBridge as 15:00 on the 18th of the month. It was ACCEPTED,
  // scheduled, and simply never fired at 6:15pm; the user was told the
  // schedule existed and then got nothing, with lastRunStatus stuck at
  // "never run" (agent_failures 7101). Silent wrong-time is worse than a
  // rejection, because nobody looks for it.
  //
  // The 5-field path already sets `?` itself before reaching here, so this
  // only ever fires on a pre-wrapped `cron(...)` the model built by hand.
  if (fields[2] !== "?" && fields[4] !== "?") {
    throw new AgentScheduleInputError(
      "cron must use ? in exactly one of day-of-month / day-of-week. " +
        "If you meant a daily time, the 5-field form is safer (e.g. " +
        "`15 18 * * *` for 6:15pm daily) — the skill expands it correctly. " +
        "A leading seconds field shifts everything by one: EventBridge takes " +
        "minute hour day-of-month month day-of-week year.",
    );
  }
}

function normalizeWrappedScheduleExpression(expression: string): string | null {
  const wrappedCron = expression.match(/^cron\((.+)\)$/);
  if (wrappedCron) {
    const fields = wrappedCron[1].trim().split(/\s+/);
    validateCronFields(fields);
    return `cron(${fields.join(" ")})`;
  }

  const rate = expression.match(
    /^rate\((\d+)\s+(minute|minutes|hour|hours|day|days)\)$/,
  );
  if (rate) {
    const count = Number.parseInt(rate[1], 10);
    if (
      count < 1 ||
      ((rate[2] === "minute" || rate[2] === "minutes") && count < 5)
    ) {
      throw new AgentScheduleInputError(
        "schedule frequency cannot exceed once every 5 minutes",
      );
    }
    return expression;
  }

  if (/^at\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\)$/.test(expression)) {
    return expression;
  }
  return null;
}

/**
 * Reject an UNWRAPPED 6-field cron whose sixth field is not a year.
 *
 * The 6-field unwrapped path assumes EventBridge shape — field 6 is the year.
 * A seconds-first (Quartz/standard-cron-with-seconds) expression also has six
 * fields, so it is accepted here and then silently rewritten into a different
 * schedule. `0 15 18 * * *` means 6:15pm daily to whoever wrote it; this path
 * turned it into `cron(0 15 18 * ? *)` — 3:00pm on the 18th of every month.
 *
 * The `?` guard in validateCronFieldDomains cannot catch it, because this
 * function sets `?` itself before that guard runs: by the time the fields are
 * validated the expression looks well-formed. A principal's "evening heads-up"
 * fired monthly on the 18th for weeks for exactly this reason.
 *
 * Two checks, in order:
 *  1. Field 6 must be a 4-digit year (or `*`). That catches the shape whose
 *     day names landed in the year slot, e.g. `0 45 6 * ? MON-FRI`.
 *  2. The seconds-first shape, whose year slot is a legitimate-looking `*`:
 *     field 3 an hour-sized number and neither day field `?`. Narrowing to
 *     "neither day field is `?`" keeps a real EventBridge expression like
 *     `0 0 1 * ? *` (midnight on the 1st) out of the net — EventBridge
 *     requires `?` in exactly one day field, so every expression it actually
 *     accepts carries one, and that form must stay accepted.
 *
 * Check 2 does not look at the seconds field. It once required it to be `0`,
 * which let every nonzero-seconds expression through: `30 15 18 * * *`
 * (6:15:30pm daily) was rewritten to `cron(30 15 18 * ? *)`, 3:30pm on the
 * 18th — the same silent wrong-time bug this function exists to stop, just
 * one second off the tested case.
 *
 * Check 2 only runs when the year slot is `*`, because that is the only
 * ambiguous form. An explicit 4-digit year can never be a seconds-first
 * expression — a seconds-first cron carries day-of-week there, not a year —
 * so `0 9 1 * * 2027` (9:00am on the 1st, in 2027) stays accepted.
 */
function rejectMisreadSixFieldCron(fields: string[]): void {
  if (!isYearField(fields[5])) {
    throw new AgentScheduleInputError(
      "the 6th cron field must be a 4-digit year or *. EventBridge takes " +
        "minute hour day-of-month month day-of-week year (no seconds field). " +
        "Prefer the 5-field form — e.g. `45 6 * * MON-FRI` for 6:45am on " +
        "weekdays — and let the skill expand it.",
    );
  }
  const hourLike = /^\d{1,2}$/.test(fields[2])
    ? Number.parseInt(fields[2], 10)
    : null;
  if (
    fields[5] === "*" &&
    hourLike !== null &&
    hourLike <= 23 &&
    fields[2] !== "?" &&
    fields[4] !== "?"
  ) {
    throw new AgentScheduleInputError(
      "this looks like a seconds-first cron (seconds minute hour " +
        "day-of-month month day-of-week), which EventBridge does not " +
        `accept — the hour you wrote would be read as day-of-month ` +
        `${hourLike}. EventBridge takes minute hour day-of-month month ` +
        "day-of-week year, with no seconds field. For 6:15pm daily use " +
        "the 5-field form `15 18 * * *`.",
    );
  }
}

function normalizeUnwrappedCron(expression: string): string {
  const fields = expression.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    throw new AgentScheduleInputError(
      "cron must be a 5/6-field cron, cron(...), rate(...), or at(...)",
    );
  }
  if (fields.length === 6) rejectMisreadSixFieldCron(fields);
  const expanded = fields.length === 5 ? [...fields, "*"] : fields;
  const dayOfMonthSpecified = expanded[2] !== "*" && expanded[2] !== "?";
  const dayOfWeekSpecified = expanded[4] !== "*" && expanded[4] !== "?";
  if (dayOfMonthSpecified && dayOfWeekSpecified) {
    throw new AgentScheduleInputError(
      "cron cannot specify both day-of-month and day-of-week",
    );
  }
  if (dayOfWeekSpecified) expanded[2] = "?";
  else expanded[4] = "?";
  validateCronFields(expanded);
  return `cron(${expanded.join(" ")})`;
}

export function toSchedulerExpression(value: unknown): string {
  const expression = requireBoundedString(value, "cron", MAX_EXPRESSION_LENGTH);
  return (
    normalizeWrappedScheduleExpression(expression) ??
    normalizeUnwrappedCron(expression)
  );
}

export function parseEnabled(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new AgentScheduleInputError("enabled must be a boolean");
  }
  return value;
}
