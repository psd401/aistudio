#!/usr/bin/env node
'use strict';

// Daily Red Rover absence summary, certificated staff only (Teacher, ESA - Certificated, CTE - Teacher).
// Usage: node get_certificated_summary.js --user <email> [--date today|yesterday|monday|"last friday"|YYYY-MM-DD]
// Read-only.

const {
  parseArgs, requireUser, getCredentials, getOrganization, getVacancyDetails, parseDate, emit, fail,
} = require('./lib/api.js');

const CERTIFICATED_TYPES = new Set(['Teacher', 'ESA - Certificated', 'CTE - Teacher']);

function buildSummary(vacancies, dateLabel, dateStr) {
  const dateObj = new Date(`${dateStr}T12:00:00`);
  const dayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'long' });
  const fullDate = dateObj.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const cert = vacancies.filter(v => CERTIFICATED_TYPES.has(v.position?.positionType?.name));
  const filled = cert.filter(v => v.substitute).length;
  const unfilled = cert.length - filled;

  const summary = {
    date: dateLabel,
    date_iso: dateStr,
    day_of_week: dayOfWeek,
    full_date: fullDate,
    staff_type: 'Certificated Only',
    total_absences: cert.length,
    filled,
    unfilled,
    fill_rate: cert.length > 0 ? Math.round((filled / cert.length) * 100) : 100,
    by_school: Object.create(null),
    by_reason: Object.create(null),
    by_position: Object.create(null),
    unfilled_positions: [],
  };

  for (const v of cert) {
    const school = v.location?.name || 'Unknown';
    const reason = v.absenceDetail?.reasons?.[0]?.name || 'Unknown';
    const position = v.position?.title || 'Unknown';
    summary.by_school[school] = (summary.by_school[school] || 0) + 1;
    summary.by_reason[reason] = (summary.by_reason[reason] || 0) + 1;
    summary.by_position[position] = (summary.by_position[position] || 0) + 1;
    if (!v.substitute) {
      summary.unfilled_positions.push({
        school,
        position,
        employee: `${v.absenceDetail?.employee?.firstName || ''} ${v.absenceDetail?.employee?.lastName || ''}`.trim(),
        start: v.start,
        end: v.end,
      });
    }
  }

  const sortDesc = obj => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]));
  summary.by_school = sortDesc(summary.by_school);
  summary.by_reason = sortDesc(summary.by_reason);
  summary.by_position = sortDesc(summary.by_position);

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
    fail(err.message, 'redrover_certificated_failed');
  }
})();
