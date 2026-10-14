/**
 * Pure audit rules for stored agent schedules (issue #1888).
 *
 * Split from `scripts/audit-agent-schedules.ts` so the rules can be unit
 * tested without pulling the AWS SDK into the test runtime. The script keeps
 * the I/O (scan, print); everything that decides whether a schedule is wrong
 * lives here.
 *
 * These rules only REPORT. Nothing here rewrites a schedule — the stored
 * expression is evidence of what was typed, not of what was wanted, so the
 * correction is the owner's call.
 */

import { describeScheduleExpression } from "@/lib/agent-schedules/schedule-description";

export interface StoredSchedule {
  scheduleId: string;
  ownerEmail: string;
  name: string;
  timezone: string;
  enabled: boolean;
  schedulerExpression: string;
  /**
   * Stored `updatedAt`, which anchors a `rate(...)` interval. Optional because
   * an old row may not carry one; its fire times are then left uncomputed
   * rather than reported from the wrong phase.
   */
  updatedAt?: string;
}

/** EventBridge numbers day-of-week 1=SUN; ordinary cron numbers it 0=SUN. */
const EVENTBRIDGE_DAY_NAMES = [
  "SUN",
  "MON",
  "TUE",
  "WED",
  "THU",
  "FRI",
  "SAT",
];

const DAILY_NAME_RE =
  /\b(daily|every\s*day|each\s*day|morning|evening|nightly|overnight)\b/i;
const WEEKDAY_NAME_RE = /\b(weekday|weekdays|workday|workdays|business\s*day)\b/i;
/**
 * Names that state a monthly or yearly cadence outright.
 *
 * DAILY_NAME_RE matches times of day, not just frequencies, and a time of day
 * says nothing about frequency: "Monthly morning report" on
 * `cron(0 9 1 * ? *)` is a correct monthly schedule, but it was reported as a
 * mismatch and handed the suggestion `cron(9 1 * * ? *)` — turning a 9:00am
 * monthly job into a 1:09am daily one. When the name names the cadence, it
 * wins over the time-of-day word.
 */
const MONTHLY_OR_YEARLY_NAME_RE =
  /\b(month|monthly|quarter|quarterly|annual|annually|year|yearly)\b/i;

export interface ScheduleFinding {
  scheduleId: string;
  ownerEmail: string;
  name: string;
  enabled: boolean;
  timezone: string;
  schedulerExpression: string;
  description: string;
  nextRuns: string[];
  issues: string[];
  suggestedExpression: string | null;
}

function cronFields(expression: string): string[] | null {
  const match = expression.trim().match(/^cron\((.+)\)$/);
  if (!match) return null;
  const fields = match[1].trim().split(/\s+/);
  return fields.length === 6 ? fields : null;
}

function isWildcard(field: string): boolean {
  return field === "*" || field === "?";
}

/**
 * Rewrite a numeric EventBridge day-of-week field into names.
 *
 * The numbers are left exactly as EventBridge reads them (1=SUN), so the
 * suggestion says what the schedule is doing TODAY. Whether the owner meant
 * MON-FRI instead is a question for the owner — guessing their intent is how
 * an audit turns into a silent rewrite.
 */
function namedDayOfWeek(field: string): string | null {
  if (isWildcard(field) || !/\d/.test(field)) return null;
  if (!/^[\d,-]+$/.test(field)) return null;
  const named = field.replace(/\d+/g, (token) => {
    const value = Number.parseInt(token, 10);
    return value >= 1 && value <= 7 ? EVENTBRIDGE_DAY_NAMES[value - 1] : token;
  });
  return /\d/.test(named) ? null : named;
}

const MONTH_NAMES_IN_ORDER = [
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

/**
 * The day-of-week token with EventBridge's ordinal suffixes removed.
 *
 * `#` selects an occurrence within the month and `L` the last one, and both
 * carry digits that say nothing about how the weekday itself is written:
 * `MON#1` (first Monday) names its weekday and is unambiguous, but a plain
 * digit test read the `1` and reported it as a numeric day-of-week copied
 * from ordinary cron. `6L` keeps its `6` and is still reported, correctly —
 * that IS EventBridge's 1=SUN numbering, so a range copied from ordinary
 * cron is off by a day whether or not it carries an ordinal.
 */
function dayOfWeekWithoutOrdinal(field: string): string {
  return field
    .split(",")
    .map((segment) => segment.replace(/#\d+$/, "").replace(/L$/i, ""))
    .join(",");
}

/**
 * Does `field` already cover every value in its own domain?
 *
 * `1-31` on day-of-month and `JAN-DEC` (or `1-12`) on month match every
 * calendar day or month, so they restrict nothing — but they are not `*`,
 * and reading them as restrictions reported a correct "Daily report" as
 * firing only on specific days.
 */
function coversWholeDomain(field: string, min: number, max: number): boolean {
  const [range, step] = field.split("/");
  if (step !== undefined && step !== "1") return false;
  const bounds = range.split("-");
  if (bounds.length !== 2) return false;
  const toNumber = (token: string): number | null => {
    const monthIndex = MONTH_NAMES_IN_ORDER.indexOf(token.toUpperCase());
    if (monthIndex >= 0) return monthIndex + 1;
    return /^\d+$/.test(token) ? Number.parseInt(token, 10) : null;
  };
  const start = toNumber(bounds[0]);
  const end = toNumber(bounds[1]);
  if (start === null || end === null) return false;
  return start <= min && end >= max;
}

function nameSuggestsDaily(name: string): boolean {
  if (MONTHLY_OR_YEARLY_NAME_RE.test(name)) return false;
  return DAILY_NAME_RE.test(name) || WEEKDAY_NAME_RE.test(name);
}

/**
 * Does this field restrict which days/months fire?
 *
 * `*` and `?` do not, and neither does a step of one. A larger step DOES —
 * that is the shape an "every 5th day of the month" expression takes, and
 * treating any field containing a star as unrestricted missed it, so a
 * schedule named "Daily report" that fires only every fifth day went
 * unreported. A range spanning the field's whole domain (`1-31`, `JAN-DEC`)
 * does not restrict anything either, however little it looks like `*`.
 */
function isRestricted(field: string, min: number, max: number): boolean {
  if (isWildcard(field) || field === "*/1") return false;
  return !coversWholeDomain(field, min, max);
}

function firesMonthlyOrYearly(fields: string[]): string | null {
  const dayOfMonthPinned = isRestricted(fields[2], 1, 31);
  const monthPinned = isRestricted(fields[3], 1, 12);
  const yearPinned = fields[5] !== "*";
  if (yearPinned) return "fires only in a fixed year";
  if (monthPinned) return "fires only in specific months";
  if (dayOfMonthPinned) return "fires only on specific days of the month";
  return null;
}

export function auditSchedule(schedule: StoredSchedule): ScheduleFinding | null {
  const fields = cronFields(schedule.schedulerExpression);
  if (!fields) return null;

  const issues: string[] = [];
  const suggested = [...fields];

  const named = namedDayOfWeek(fields[4]);
  const dayOfWeekTokens = dayOfWeekWithoutOrdinal(fields[4]);
  if (/\d/.test(dayOfWeekTokens) && !isWildcard(fields[4])) {
    issues.push(
      "numeric day-of-week — EventBridge reads 1=SUN, so a range copied " +
        `from ordinary cron runs a day early (currently ${
          named ?? fields[4]
        })`,
    );
    if (named) suggested[4] = named;
  }

  const cadence = firesMonthlyOrYearly(fields);
  if (cadence && nameSuggestsDaily(schedule.name)) {
    issues.push(
      `name suggests a daily or weekday cadence, but the expression ${cadence}`,
    );
    // The classic misread: a seconds-first cron whose seconds landed in the
    // minute slot and whose hour landed in day-of-month. `0 15 18 * ? *` at
    // minute 0 with an hour-sized day-of-month is that shape.
    // `fields[4] === "?"` is implied by EventBridge's own rule (if
    // day-of-month is concrete, day-of-week must be `?`), but stating it
    // keeps this rewrite from clobbering a day-of-week suggestion computed
    // above should a row ever reach here without that invariant.
    if (
      fields[0] === "0" &&
      /^\d{1,2}$/.test(fields[2]) &&
      Number.parseInt(fields[2], 10) <= 23 &&
      fields[4] === "?"
    ) {
      suggested[0] = fields[1];
      suggested[1] = fields[2];
      suggested[2] = "*";
      suggested[4] = "?";
    }
  }

  if (issues.length === 0) return null;

  const suggestedExpression = `cron(${suggested.join(" ")})`;
  const summary = describeScheduleExpression(
    schedule.schedulerExpression,
    schedule.timezone,
    { anchor: schedule.updatedAt },
  );
  return {
    scheduleId: schedule.scheduleId,
    ownerEmail: schedule.ownerEmail,
    name: schedule.name,
    enabled: schedule.enabled,
    timezone: schedule.timezone,
    schedulerExpression: schedule.schedulerExpression,
    description: summary.description,
    // Same rule as the broker's publicSchedule: a disabled schedule is held
    // by EventBridge and has no upcoming executions to report.
    nextRuns: schedule.enabled ? summary.nextRuns : [],
    issues,
    suggestedExpression:
      suggestedExpression === schedule.schedulerExpression
        ? null
        : suggestedExpression,
  };
}
