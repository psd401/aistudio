/**
 * Echo a saved schedule back in terms its owner can check.
 *
 * A schedule can be stored with a different meaning than the person asked for
 * — a misread cron field, a day-of-week dialect mismatch — and nothing in the
 * create/update/list responses showed what was actually saved. The agent could
 * only repeat the raw expression it had just sent, so a wrong schedule read
 * back as confirmation. This turns the normalized scheduler expression into a
 * plain-language description and concrete next fire times, which a person can
 * disagree with immediately.
 *
 * No cron library is in the dependency tree, and the one thing that matters
 * here is EventBridge Scheduler's dialect specifically (1=SUN day-of-week, a
 * year field, `?` in exactly one day field), which general-purpose cron
 * libraries get wrong. So this computes the occurrences directly, with the
 * timezone handled through `Intl` rather than assumed to be UTC.
 */

/** Longest span searched for the next fire time, in days (just over 5 years). */
const MAX_SEARCH_DAYS = 1900;
const DEFAULT_OCCURRENCE_COUNT = 3;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
/** EventBridge day-of-week numbering: 1=SUN … 7=SAT. */
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const DAY_ABBREVIATIONS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTH_ABBREVIATIONS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

export interface ScheduleSummary {
  /** Plain-language reading of the stored expression, e.g. "At 6:30 AM, Monday through Friday". */
  description: string;
  /**
   * Upcoming fire times as ISO 8601 with the schedule timezone's UTC offset,
   * e.g. `2026-10-14T06:30:00-07:00`. Empty when the expression has no
   * computable occurrences (an unsupported cron extension, a past `at(...)`,
   * or a year field already in the past).
   */
  nextRuns: string[];
}

export interface DescribeScheduleOptions {
  /** Instant to compute from. Defaults to now; injected by tests. */
  now?: Date;
  /** How many upcoming fire times to return. Defaults to 3. */
  count?: number;
}

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

interface ZonedParts extends CivilDate {
  hour: number;
  minute: number;
}

/**
 * Wall-clock parts of an instant in a timezone.
 *
 * `Intl` is the only timezone database available here; `formatToParts` with
 * `hourCycle: "h23"` avoids the 24-vs-0 midnight discrepancy between runtimes.
 */
function zonedParts(timestamp: number, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(timestamp));
  const lookup: Record<string, string> = {};
  for (const part of parts) lookup[part.type] = part.value;
  return {
    year: Number.parseInt(lookup.year, 10),
    month: Number.parseInt(lookup.month, 10),
    day: Number.parseInt(lookup.day, 10),
    hour: Number.parseInt(lookup.hour, 10),
    minute: Number.parseInt(lookup.minute, 10),
  };
}

/** Offset of `timeZone` from UTC at `timestamp`, in milliseconds. */
function zoneOffsetMs(timestamp: number, timeZone: string): number {
  const parts = zonedParts(timestamp, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
  // Round to the minute so the seconds the formatter drops do not leak in.
  return asUtc - Math.floor(timestamp / MINUTE_MS) * MINUTE_MS;
}

/**
 * The instant at which `timeZone` reads the given wall-clock time, or null
 * when that wall clock does not exist (the hour a spring-forward skips).
 *
 * Two passes: the first offset guess is taken at the naive UTC instant, the
 * second at the corrected one, which settles every real-world transition.
 */
function wallClockToInstant(
  timeZone: string,
  date: CivilDate,
  hour: number,
  minute: number,
): number | null {
  const naive = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  let instant = naive - zoneOffsetMs(naive, timeZone);
  instant = naive - zoneOffsetMs(instant, timeZone);
  const check = zonedParts(instant, timeZone);
  const matches =
    check.year === date.year &&
    check.month === date.month &&
    check.day === date.day &&
    check.hour === hour &&
    check.minute === minute;
  return matches ? instant : null;
}

/** `+HH:MM` / `-HH:MM` form of the timezone's offset at an instant. */
function offsetSuffix(timestamp: number, timeZone: string): string {
  const offsetMinutes = Math.round(zoneOffsetMs(timestamp, timeZone) / MINUTE_MS);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

function formatZonedIso(timestamp: number, timeZone: string): string {
  const parts = zonedParts(timestamp, timeZone);
  const pad = (value: number, width = 2) =>
    String(value).padStart(width, "0");
  return (
    `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}` +
    `T${pad(parts.hour)}:${pad(parts.minute)}:00` +
    offsetSuffix(timestamp, timeZone)
  );
}

/**
 * Expand a cron field into the set of values it matches.
 *
 * Returns null for anything outside the subset this module reasons about —
 * notably the `L`, `W` and `#` extensions — so callers can report "no computed
 * fire times" rather than a confidently wrong one.
 */
interface FieldRange {
  start: number;
  end: number;
  step: number;
}

/** One comma-separated piece of a cron field: `5`, `1-5`, a step, `MON-FRI`. */
function parseFieldSegment(
  segment: string,
  min: number,
  max: number,
  names?: string[],
): FieldRange | null {
  const pieces = segment.split("/");
  if (pieces.length > 2) return null;
  const [base, stepText] = pieces;
  const step = stepText === undefined ? 1 : Number.parseInt(stepText, 10);
  if (!Number.isInteger(step) || step < 1) return null;
  if (base === "*") return { start: min, end: max, step };
  if (base.includes("-")) {
    const [startText, endText] = base.split("-");
    const start = parseFieldToken(startText, names);
    const end = parseFieldToken(endText, names);
    return start === null || end === null ? null : { start, end, step };
  }
  const value = parseFieldToken(base, names);
  if (value === null) return null;
  return { start: value, end: stepText === undefined ? value : max, step };
}

/**
 * Expand a cron field into the set of values it matches.
 *
 * Returns null for anything outside the subset this module reasons about —
 * notably the `L`, `W` and `#` extensions — so callers can report "no computed
 * fire times" rather than a confidently wrong one.
 */
function expandField(
  field: string,
  min: number,
  max: number,
  names?: string[],
): Set<number> | null {
  const values = new Set<number>();
  if (field === "*" || field === "?") {
    for (let value = min; value <= max; value += 1) values.add(value);
    return values;
  }
  for (const segment of field.split(",")) {
    const range = parseFieldSegment(segment, min, max, names);
    if (!range) return null;
    const { start, end, step } = range;
    if (start < min || end > max) return null;
    if (start <= end) {
      for (let value = start; value <= end; value += step) values.add(value);
    } else {
      // A wrapping range such as FRI-MON or NOV-FEB.
      for (let value = start; value <= max; value += step) values.add(value);
      for (let value = min; value <= end; value += step) values.add(value);
    }
  }
  return values.size > 0 ? values : null;
}

function parseFieldToken(token: string, names?: string[]): number | null {
  const trimmed = token.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (!names) return null;
  const index = names.indexOf(trimmed.toUpperCase());
  return index === -1 ? null : index + 1;
}

interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number> | null;
  months: Set<number>;
  /** EventBridge numbering, 1=SUN … 7=SAT. */
  daysOfWeek: Set<number> | null;
  years: Set<number> | null;
  fields: string[];
}

interface DayFields {
  daysOfMonth: Set<number> | null;
  daysOfWeek: Set<number> | null;
}

/**
 * Day-of-month and day-of-week, where null means "unconstrained".
 *
 * EventBridge requires `?` in exactly one of the two, but a stored expression
 * read back here may predate that rule, so both wildcard forms are tolerated.
 */
function parseDayFields(fields: string[]): DayFields | null {
  const dayOfMonthWildcard = fields[2] === "*" || fields[2] === "?";
  const dayOfWeekWildcard = fields[4] === "*" || fields[4] === "?";
  const daysOfMonth = dayOfMonthWildcard ? null : expandField(fields[2], 1, 31);
  const daysOfWeek = dayOfWeekWildcard
    ? null
    : expandField(fields[4], 1, 7, DAY_ABBREVIATIONS);
  if (!dayOfMonthWildcard && !daysOfMonth) return null;
  if (!dayOfWeekWildcard && !daysOfWeek) return null;
  return { daysOfMonth, daysOfWeek };
}

function parseCronFields(fields: string[]): ParsedCron | null {
  if (fields.length !== 6) return null;
  const minutes = expandField(fields[0], 0, 59);
  const hours = expandField(fields[1], 0, 23);
  const months = expandField(fields[3], 1, 12, MONTH_ABBREVIATIONS);
  if (!minutes || !hours || !months) return null;

  const days = parseDayFields(fields);
  if (!days) return null;
  const { daysOfMonth, daysOfWeek } = days;

  const years = fields[5] === "*" ? null : expandField(fields[5], 1970, 2199);
  if (fields[5] !== "*" && !years) return null;

  return { minutes, hours, daysOfMonth, months, daysOfWeek, years, fields };
}

function civilDayMatches(parsed: ParsedCron, date: CivilDate): boolean {
  if (parsed.years && !parsed.years.has(date.year)) return false;
  if (!parsed.months.has(date.month)) return false;
  if (parsed.daysOfMonth && !parsed.daysOfMonth.has(date.day)) return false;
  if (parsed.daysOfWeek) {
    // EventBridge numbers Sunday 1; getUTCDay numbers it 0.
    const weekday =
      new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 1;
    if (!parsed.daysOfWeek.has(weekday)) return false;
  }
  return true;
}

function nextCronRuns(
  parsed: ParsedCron,
  timeZone: string,
  from: number,
  count: number,
): number[] {
  const minutesOfDay: number[] = [];
  for (const hour of [...parsed.hours].sort((a, b) => a - b)) {
    for (const minute of [...parsed.minutes].sort((a, b) => a - b)) {
      minutesOfDay.push(hour * 60 + minute);
    }
  }
  minutesOfDay.sort((a, b) => a - b);

  const runs: number[] = [];
  const lastYear = parsed.years ? Math.max(...parsed.years) : null;
  const start = zonedParts(from, timeZone);
  // Walk civil days in the schedule's timezone, anchored at local noon so a
  // DST shift never moves the cursor onto the wrong calendar day.
  const cursor = Date.UTC(start.year, start.month - 1, start.day, 12);
  for (let offset = 0; offset < MAX_SEARCH_DAYS && runs.length < count; offset += 1) {
    const civil = new Date(cursor + offset * DAY_MS);
    const date: CivilDate = {
      year: civil.getUTCFullYear(),
      month: civil.getUTCMonth() + 1,
      day: civil.getUTCDate(),
    };
    if (lastYear !== null && date.year > lastYear) break;
    if (!civilDayMatches(parsed, date)) continue;
    for (const minuteOfDay of minutesOfDay) {
      const instant = wallClockToInstant(
        timeZone,
        date,
        Math.floor(minuteOfDay / 60),
        minuteOfDay % 60,
      );
      if (instant === null || instant <= from) continue;
      runs.push(instant);
      if (runs.length >= count) break;
    }
  }
  return runs;
}

function formatClock(hour: number, minute: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** "Monday through Friday" when the set is contiguous, otherwise a list. */
function describeNameSet(values: Set<number>, names: string[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const contiguous = sorted.every(
    (value, index) => index === 0 || value === sorted[index - 1] + 1,
  );
  if (contiguous && sorted.length > 2) {
    return `${names[sorted[0] - 1]} through ${names[sorted[sorted.length - 1] - 1]}`;
  }
  return joinList(sorted.map((value) => names[value - 1]));
}

function describeTime(parsed: ParsedCron): string {
  const [minuteField, hourField] = parsed.fields;
  const minuteStep = minuteField.match(/^\*\/(\d+)$/);
  if (minuteStep && hourField === "*") {
    return `Every ${minuteStep[1]} minutes`;
  }
  const hourStep = hourField.match(/^\*\/(\d+)$/);
  if (hourStep && parsed.minutes.size === 1) {
    const minute = [...parsed.minutes][0];
    return `Every ${hourStep[1]} hours at minute ${minute}`;
  }
  if (parsed.hours.size === 1 && parsed.minutes.size === 1) {
    return `At ${formatClock([...parsed.hours][0], [...parsed.minutes][0])}`;
  }
  if (parsed.minutes.size === 1) {
    const minute = [...parsed.minutes][0];
    const hours = [...parsed.hours]
      .sort((a, b) => a - b)
      .map((hour) => formatClock(hour, minute));
    return `At ${joinList(hours)}`;
  }
  return `At minute ${minuteField} of hour ${hourField}`;
}

function describeDays(parsed: ParsedCron): string {
  const segments: string[] = [];
  if (parsed.daysOfWeek) {
    segments.push(`on ${describeNameSet(parsed.daysOfWeek, DAY_NAMES)}`);
  } else if (parsed.daysOfMonth) {
    const days = [...parsed.daysOfMonth].sort((a, b) => a - b);
    segments.push(
      `on day ${joinList(days.map(String))} of the month`,
    );
  } else {
    segments.push("every day");
  }
  if (parsed.months.size < 12) {
    segments.push(`in ${describeNameSet(parsed.months, MONTH_NAMES)}`);
  }
  if (parsed.years) {
    segments.push(`in ${joinList([...parsed.years].sort((a, b) => a - b).map(String))}`);
  }
  return segments.join(" ");
}

function describeRate(count: number, unit: string): string {
  const singular = unit.replace(/s$/, "");
  return count === 1
    ? `Every ${singular}`
    : `Every ${count} ${singular}s`;
}

function rateIntervalMs(count: number, unit: string): number {
  if (unit.startsWith("minute")) return count * MINUTE_MS;
  if (unit.startsWith("hour")) return count * HOUR_MS;
  return count * DAY_MS;
}

/**
 * Describe a normalized EventBridge Scheduler expression and compute its next
 * fire times in the schedule's own timezone.
 *
 * Never throws: an expression this module cannot reason about yields the raw
 * expression as the description and an empty `nextRuns`, because a schedule
 * response must not fail over its explanatory fields.
 */
export function describeScheduleExpression(
  expression: string,
  timeZone: string,
  options: DescribeScheduleOptions = {},
): ScheduleSummary {
  const now = (options.now ?? new Date()).getTime();
  const count = options.count ?? DEFAULT_OCCURRENCE_COUNT;
  const fallback: ScheduleSummary = { description: expression, nextRuns: [] };
  const zone = timeZone;
  if (count < 1) return fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    return fallback;
  }

  const trimmed = expression.trim();

  const at = trimmed.match(/^at\((\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\)$/);
  if (at) {
    const date: CivilDate = {
      year: Number.parseInt(at[1], 10),
      month: Number.parseInt(at[2], 10),
      day: Number.parseInt(at[3], 10),
    };
    const hour = Number.parseInt(at[4], 10);
    const minute = Number.parseInt(at[5], 10);
    const instant = wallClockToInstant(zone, date, hour, minute);
    const description =
      `Once, on ${MONTH_NAMES[date.month - 1]} ${date.day}, ${date.year} ` +
      `at ${formatClock(hour, minute)}`;
    return {
      description,
      nextRuns: instant !== null && instant > now ? [formatZonedIso(instant, zone)] : [],
    };
  }

  const rate = trimmed.match(/^rate\((\d+)\s+(minutes?|hours?|days?)\)$/);
  if (rate) {
    const every = Number.parseInt(rate[1], 10);
    const interval = rateIntervalMs(every, rate[2]);
    const runs: string[] = [];
    // EventBridge anchors a rate schedule at its creation time, which is not
    // knowable from the expression alone, so these are projected from now.
    for (let index = 1; index <= count; index += 1) {
      runs.push(formatZonedIso(now + interval * index, zone));
    }
    return { description: describeRate(every, rate[2]), nextRuns: runs };
  }

  const cron = trimmed.match(/^cron\((.+)\)$/);
  if (!cron) return fallback;
  const parsed = parseCronFields(cron[1].trim().split(/\s+/));
  if (!parsed) return fallback;

  const description = `${describeTime(parsed)}, ${describeDays(parsed)}`;
  return {
    description,
    nextRuns: nextCronRuns(parsed, zone, now, count).map((instant) =>
      formatZonedIso(instant, zone),
    ),
  };
}
