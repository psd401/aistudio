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

function nameSuggestsDaily(name: string): boolean {
  return DAILY_NAME_RE.test(name) || WEEKDAY_NAME_RE.test(name);
}

function firesMonthlyOrYearly(fields: string[]): string | null {
  const dayOfMonthPinned = !isWildcard(fields[2]) && !fields[2].includes("*");
  const monthPinned = !isWildcard(fields[3]) && !fields[3].includes("*");
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
  if (/\d/.test(fields[4]) && !isWildcard(fields[4])) {
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
    if (
      fields[0] === "0" &&
      /^\d{1,2}$/.test(fields[2]) &&
      Number.parseInt(fields[2], 10) <= 23
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
  );
  return {
    scheduleId: schedule.scheduleId,
    ownerEmail: schedule.ownerEmail,
    name: schedule.name,
    enabled: schedule.enabled,
    timezone: schedule.timezone,
    schedulerExpression: schedule.schedulerExpression,
    description: summary.description,
    nextRuns: summary.nextRuns,
    issues,
    suggestedExpression:
      suggestedExpression === schedule.schedulerExpression
        ? null
        : suggestedExpression,
  };
}
