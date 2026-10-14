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
/**
 * Largest instant a `Date` can represent (ECMA-262 time-value limit).
 *
 * `rate(...)` has no upper bound in `validation.ts` — it only rejects faster
 * than every 5 minutes — so a stored `rate(100000000 days)` is reachable, and
 * `anchor + k * interval` then lands outside this range. `Intl.formatToParts`
 * throws `RangeError: Invalid time value` on such a value, which would reject
 * the whole `list()` over one row. Occurrences past this point are dropped
 * instead: this module's contract is that it never throws and never guesses.
 */
const MAX_INSTANT_MS = 8.64e15;

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
   * computable occurrences: an unsupported cron extension, a past `at(...)`,
   * a year field already in the past, no match inside the search horizon
   * (five years, or the end of the expression's own last year when it pins
   * one), or a `rate(...)` expression described without its anchor. Fewer than
   * `count` entries means the horizon was reached — or, for an enormous
   * `rate(...)`, the end of the representable `Date` range — not that the
   * schedule stops.
   *
   * These are scheduled times, not guaranteed instants. EventBridge Scheduler
   * "invoke[s] their targets with 60 second precision… if you set your
   * schedule to run at 1:00, it will invoke the target API between 1:00:00 and
   * 1:00:59" (Scheduler User Guide, schedule types), so the minute is the
   * meaningful unit here. The seconds are carried because they are part of
   * what was stored — an `at(...)` names them, and a `rate(...)` inherits
   * them from its anchor — not because the invocation lands on them.
   */
  nextRuns: string[];
}

export interface DescribeScheduleOptions {
  /** Instant to compute from. Defaults to now; injected by tests. */
  now?: Date;
  /**
   * How many upcoming fire times to return. Defaults to 3, which is what
   * every production caller uses; tests widen it to span a DST boundary.
   */
  count?: number;
  /**
   * When the schedule's interval was last anchored — the record's `updatedAt`,
   * because EventBridge Scheduler restarts a `rate(...)` interval at create and
   * at update. Only a `rate(...)` expression uses it; `cron(...)` and `at(...)`
   * carry their own wall-clock anchor.
   *
   * Without it a `rate(...)` schedule has no computable fire times: projecting
   * from "now" would report an hourly schedule anchored at 09:15 as firing at
   * 10:45 when read at 09:45. Absent or unparseable, `nextRuns` is empty rather
   * than wrong.
   */
  anchor?: Date | string;
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

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * Formatters are reused per timezone: constructing one is the expensive part
 * of `Intl`, and a single list() of 50 schedules resolves a few hundred
 * wall-clock times. The cache is keyed by timezone only, since every call
 * uses the same options, and holds at most one entry per IANA zone.
 */
function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/**
 * Wall-clock parts of an instant in a timezone.
 *
 * `Intl` is the only timezone database available here; `formatToParts` with
 * `hourCycle: "h23"` avoids the 24-vs-0 midnight discrepancy between runtimes.
 *
 * The caller owns the range check: `formatToParts` throws `RangeError` on an
 * instant outside the representable `Date` range (see `MAX_INSTANT_MS`).
 */
function zonedParts(timestamp: number, timeZone: string): ZonedParts {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(timestamp));
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
  // Seconds come off the instant, not the formatter: every IANA zone in use
  // is a whole number of minutes from UTC, so the seconds-of-minute is the
  // same in any zone, and `zonedParts` is deliberately minute-granular. A
  // cron fire time always lands on :00, but an `at(...)` carries seconds and
  // a `rate(...)` inherits them from its anchor, and printing :00 for those
  // would contradict the stored expression in the field SKILL.md tells the
  // agent to trust.
  const second = ((Math.floor(timestamp / 1000) % 60) + 60) % 60;
  return (
    `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}` +
    `T${pad(parts.hour)}:${pad(parts.minute)}:${pad(second)}` +
    offsetSuffix(timestamp, timeZone)
  );
}

/** The values one cron-field segment covers, before expansion. */
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
  // A pinned year set can sit beyond the default horizon — `2027,2033` would
  // have returned only the 2027 occurrence and silently dropped the other.
  // Walking to the end of the last named year costs only arithmetic, since
  // non-matching days never touch Intl.
  const searchDays =
    lastYear === null
      ? MAX_SEARCH_DAYS
      : Math.max(
          0,
          Math.ceil(
            (Date.UTC(lastYear + 1, 0, 1) -
              Date.UTC(start.year, start.month - 1, start.day)) /
              DAY_MS,
          ),
        );
  // Walk civil days in the schedule's timezone, anchored at local noon so a
  // DST shift never moves the cursor onto the wrong calendar day.
  const cursor = Date.UTC(start.year, start.month - 1, start.day, 12);
  for (let offset = 0; offset < searchDays && runs.length < count; offset += 1) {
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

function formatClock(hour: number, minute: number, second = 0): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  const seconds = second === 0 ? "" : `:${String(second).padStart(2, "0")}`;
  return `${display}:${String(minute).padStart(2, "0")}${seconds} ${suffix}`;
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

/**
 * Milliseconds of the anchor instant, or null when there is nothing usable.
 *
 * `updatedAt` reaches here as a stored string, and the degraded read path can
 * hand over an empty string or a truncated one, so an unparseable value has to
 * mean "no anchor" rather than `NaN` arithmetic that formats as a bogus date.
 */
function resolveAnchorMs(anchor: Date | string | undefined): number | null {
  if (anchor === undefined) return null;
  const ms = anchor instanceof Date ? anchor.getTime() : Date.parse(anchor);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Fire times of a `rate(...)` schedule, counting intervals from its anchor.
 *
 * EventBridge Scheduler fires a rate schedule at `anchor + k * interval`, so
 * the first upcoming run is the smallest such instant strictly after `now` —
 * not `now + interval`.
 */
function nextRateRuns(
  anchorMs: number,
  interval: number,
  now: number,
  count: number,
): number[] {
  const elapsed = now - anchorMs;
  const firstIndex = elapsed < 0 ? 1 : Math.floor(elapsed / interval) + 1;
  const runs: number[] = [];
  for (let index = firstIndex; index < firstIndex + count; index += 1) {
    const instant = anchorMs + interval * index;
    // A huge rate() runs off the end of the representable Date range; stop
    // rather than hand an unformattable instant to Intl. See MAX_INSTANT_MS.
    if (!Number.isFinite(instant) || Math.abs(instant) > MAX_INSTANT_MS) break;
    runs.push(instant);
  }
  return runs;
}

function rateIntervalMs(count: number, unit: string): number {
  if (unit.startsWith("minute")) return count * MINUTE_MS;
  if (unit.startsWith("hour")) return count * HOUR_MS;
  return count * DAY_MS;
}

/**
 * Describe a one-shot `at(...)`, or null when the expression is not one.
 *
 * Range-checked, not just shape-checked: the regex and validation.ts's own
 * `at(...)` rule both accept any two digits, so a record holding
 * `at(2026-13-45T09:00:00)` can already exist. Returning the fallback for
 * those keeps a half-garbled "Once, on undefined 45, 2026" out of the
 * response. Seconds are range-checked and kept: AWS's documented
 * `at(yyyy-mm-ddThh:mm:ss)` carries them, so dropping them would make the
 * read-back disagree with the stored expression.
 */
/** Days in a month, leap years included. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function describeAt(
  expression: string,
  timeZone: string,
  now: number,
): ScheduleSummary | null {
  const at = expression.match(
    /^at\((\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\)$/,
  );
  if (!at) return null;
  const date: CivilDate = {
    year: Number.parseInt(at[1], 10),
    month: Number.parseInt(at[2], 10),
    day: Number.parseInt(at[3], 10),
  };
  const hour = Number.parseInt(at[4], 10);
  const minute = Number.parseInt(at[5], 10);
  const second = Number.parseInt(at[6], 10);
  if (
    date.month < 1 ||
    date.month > 12 ||
    date.day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    // Against the actual month, not a flat 31: `at(2027-02-30T09:00:00)` is
    // shape-valid, and wallClockToInstant rightly returns null for it, but the
    // description was still emitted as "Once, on February 30" — a confident
    // reading of a date that does not exist.
    date.day > daysInMonth(date.year, date.month)
  ) {
    return { description: expression, nextRuns: [] };
  }
  // AWS's at(yyyy-mm-ddThh:mm:ss) carries seconds, and nothing rejects a
  // nonzero value, so the read-back has to carry them too: wallClockToInstant
  // resolves the zone at minute granularity and the seconds are added on top.
  const minuteInstant = wallClockToInstant(timeZone, date, hour, minute);
  const instant = minuteInstant === null ? null : minuteInstant + second * 1000;
  return {
    description:
      `Once, on ${MONTH_NAMES[date.month - 1]} ${date.day}, ${date.year} ` +
      `at ${formatClock(hour, minute, second)}`,
    nextRuns:
      instant !== null && instant > now
        ? [formatZonedIso(instant, timeZone)]
        : [],
  };
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
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    return fallback;
  }

  const trimmed = expression.trim();

  const at = describeAt(trimmed, timeZone, now);
  if (at) return at;

  const rate = trimmed.match(/^rate\((\d+)\s+(minutes?|hours?|days?)\)$/);
  if (rate) {
    const every = Number.parseInt(rate[1], 10);
    const interval = rateIntervalMs(every, rate[2]);
    // A rate schedule's phase lives in the record, not the expression: it is
    // anchored when created or updated. Without that anchor there is no honest
    // answer, and a wrong one is worse than none now that SKILL.md tells the
    // agent to confirm the schedule from `nextRuns`.
    const anchorMs = resolveAnchorMs(options.anchor);
    return {
      description: describeRate(every, rate[2]),
      nextRuns:
        anchorMs === null
          ? []
          : nextRateRuns(anchorMs, interval, now, count).map((instant) =>
              formatZonedIso(instant, timeZone),
            ),
    };
  }

  const cron = trimmed.match(/^cron\((.+)\)$/);
  if (!cron) return fallback;
  const parsed = parseCronFields(cron[1].trim().split(/\s+/));
  if (!parsed) return fallback;

  const description = `${describeTime(parsed)}, ${describeDays(parsed)}`;
  return {
    description,
    nextRuns: nextCronRuns(parsed, timeZone, now, count).map((instant) =>
      formatZonedIso(instant, timeZone),
    ),
  };
}
