#!/usr/bin/env node
'use strict';

// Weekly Red Rover absence summary and trends (Mon–Fri).
// Usage: node get_weekly_summary.js --user <email> [--weeks-ago 0|1|2|...]
// Read-only.

const {
  parseArgs, requireUser, getCredentials, getOrganization, getVacancyDetails, getWeekRange, emit, fail,
} = require('./lib/api.js');

const SCHOOL_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

// Use Intl.DateTimeFormat with explicit timezone to avoid UTC-shift bugs.
// The container may run in UTC; PSD is always America/Los_Angeles.
const DAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  timeZone: 'America/Los_Angeles',
});

function buildWeeklySummary(vacancies, weekRange) {
  const summary = {
    week: weekRange.rangeLabel,
    week_label: weekRange.label,
    date_range: { start: weekRange.start, end: weekRange.end },
    total_absences: vacancies.length,
    daily_average: 0,
    filled: 0,
    unfilled: 0,
    fill_rate: 0,
    peak_day: null,
    slow_day: null,
    by_day: Object.create(null),
    by_school: Object.create(null),
    by_reason: Object.create(null),
    by_position_type: Object.create(null),
    daily_details: Object.create(null),
    trends: [],
  };

  for (const day of SCHOOL_DAYS) {
    summary.by_day[day] = 0;
    summary.daily_details[day] = { total: 0, filled: 0, unfilled: 0 };
  }

  for (const v of vacancies) {
    const dayOfWeek = DAY_FORMATTER.format(new Date(v.start));
    const isFilled = !!v.substitute;

    if (Object.prototype.hasOwnProperty.call(summary.by_day, dayOfWeek)) {
      summary.by_day[dayOfWeek]++;
      summary.daily_details[dayOfWeek].total++;
      if (isFilled) summary.daily_details[dayOfWeek].filled++;
      else summary.daily_details[dayOfWeek].unfilled++;
    }

    if (isFilled) summary.filled++;
    else summary.unfilled++;

    const school = v.location?.name || 'Unknown';
    const reason = v.absenceDetail?.reasons?.[0]?.name || 'Unknown';
    const posType = v.position?.positionType?.name || 'Unknown';
    summary.by_school[school] = (summary.by_school[school] || 0) + 1;
    summary.by_reason[reason] = (summary.by_reason[reason] || 0) + 1;
    summary.by_position_type[posType] = (summary.by_position_type[posType] || 0) + 1;
  }

  // Intentionally divide by 5 (full school week) even on partial weeks so
  // cross-week trend comparisons use a consistent denominator.
  summary.daily_average = Math.round((summary.total_absences / SCHOOL_DAYS.length) * 10) / 10;
  summary.fill_rate = summary.total_absences > 0
    ? Math.round((summary.filled / summary.total_absences) * 100)
    : 100;

  const dayEntries = Object.entries(summary.by_day).filter(([, c]) => c > 0);
  if (dayEntries.length > 0) {
    const sorted = dayEntries.sort((a, b) => b[1] - a[1]);
    summary.peak_day = { day: sorted[0][0], count: sorted[0][1] };
    summary.slow_day = { day: sorted[sorted.length - 1][0], count: sorted[sorted.length - 1][1] };
  }

  const sortDesc = obj => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]));
  summary.by_school = sortDesc(summary.by_school);
  summary.by_reason = sortDesc(summary.by_reason);
  summary.by_position_type = sortDesc(summary.by_position_type);

  if (summary.fill_rate < 80) {
    summary.trends.push({
      type: 'warning',
      message: `Low fill rate (${summary.fill_rate}%) - ${summary.unfilled} unfilled positions`,
    });
  }
  if (summary.peak_day && summary.peak_day.count > summary.daily_average * 1.5) {
    summary.trends.push({
      type: 'info',
      message: `${summary.peak_day.day} had ${summary.peak_day.count} absences (50%+ above average)`,
    });
  }

  return summary;
}

(async () => {
  const args = parseArgs(process.argv);
  const user = requireUser(args);
  const weeksAgoRaw = args.weeks_ago ?? args._positional[0] ?? '0';
  const weeksAgo = Number.parseInt(weeksAgoRaw, 10);
  if (!Number.isFinite(weeksAgo) || weeksAgo < 0 || weeksAgo > 52) {
    fail('--weeks-ago must be an integer between 0 and 52', 'bad_args');
  }
  const weekRange = getWeekRange(weeksAgo);

  try {
    const creds = getCredentials(user);
    const org = await getOrganization(creds);
    const result = await getVacancyDetails(org.orgId, org.apiKey, creds, weekRange.start, weekRange.end);
    if (result.error) fail(result.error, 'redrover_api_error');
    emit(buildWeeklySummary(result.data, weekRange));
  } catch (err) {
    fail(err.message, 'redrover_weekly_failed');
  }
})();
