#!/usr/bin/env node
'use strict';

// Daily Red Rover absence summary (all staff).
// Usage: node get_daily_summary.js --user <email> [--date today|yesterday|monday|"last friday"|YYYY-MM-DD]
// Read-only.

const {
  parseArgs, requireUser, getCredentials, getOrganization, getVacancyDetails, parseDate, emit, fail,
} = require('./lib/api.js');

function buildSummary(vacancies, dateLabel, dateStr) {
  const dateObj = new Date(`${dateStr}T12:00:00`);
  const dayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'long' });
  const fullDate = dateObj.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const summary = {
    date: dateLabel,
    date_iso: dateStr,
    day_of_week: dayOfWeek,
    full_date: fullDate,
    total_absences: vacancies.length,
    filled: 0,
    unfilled: 0,
    by_school: Object.create(null),
    by_reason: Object.create(null),
    by_position_type: Object.create(null),
    unfilled_positions: [],
    absences: [],
  };

  for (const v of vacancies) {
    const isFilled = !!v.substitute;
    const school = v.location?.name || 'Unknown';
    const reason = v.absenceDetail?.reasons?.[0]?.name || 'Unknown';
    const posType = v.position?.positionType?.name || 'Unknown';
    const employee = `${v.absenceDetail?.employee?.firstName || ''} ${v.absenceDetail?.employee?.lastName || ''}`.trim();

    if (isFilled) summary.filled++;
    else {
      summary.unfilled++;
      summary.unfilled_positions.push({
        school,
        position: v.position?.title || 'Unknown',
        employee,
        start: v.start,
        end: v.end,
      });
    }

    summary.by_school[school] = (summary.by_school[school] || 0) + 1;
    summary.by_reason[reason] = (summary.by_reason[reason] || 0) + 1;
    summary.by_position_type[posType] = (summary.by_position_type[posType] || 0) + 1;

    summary.absences.push({
      employee,
      school,
      position: v.position?.title || 'Unknown',
      reason,
      filled: isFilled,
      substitute: isFilled ? `${v.substitute?.firstName || ''} ${v.substitute?.lastName || ''}`.trim() : null,
      start: v.start,
      end: v.end,
    });
  }

  const sortDesc = obj => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]));
  summary.by_school = sortDesc(summary.by_school);
  summary.by_reason = sortDesc(summary.by_reason);
  summary.by_position_type = sortDesc(summary.by_position_type);
  summary.fill_rate = summary.total_absences > 0
    ? Math.round((summary.filled / summary.total_absences) * 100)
    : 100;

  return summary;
}

(async () => {
  const args = parseArgs(process.argv);
  const user = requireUser(args);
  const dateInfo = parseDate(args.date || args._positional[0]);

  try {
    const creds = getCredentials(user);
    const org = await getOrganization(creds);
    const result = await getVacancyDetails(org.orgId, org.apiKey, creds, dateInfo.date, dateInfo.date);
    if (result.error) fail(result.error, 'redrover_api_error');
    emit(buildSummary(result.data, dateInfo.label, dateInfo.date));
  } catch (err) {
    fail(err.message, 'redrover_daily_failed');
  }
})();
