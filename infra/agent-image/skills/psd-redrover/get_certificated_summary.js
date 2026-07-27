#!/usr/bin/env node
'use strict';

// Daily Red Rover absence summary, certificated staff only (Teacher, ESA - Certificated, CTE - Teacher).
// Usage: node get_certificated_summary.js --user <email> [--date today|yesterday|monday|"last friday"|YYYY-MM-DD]
// Read-only.

const {
  parseArgs, requireUser, getVacancyDetails, parseDate, emit, fail,
} = require('./lib/api.js');

const CERTIFICATED_TYPES = new Set(['Teacher', 'ESA - Certificated', 'CTE - Teacher']);

function incrementCount(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

function vacancyLabels(vacancy) {
  return {
    school: vacancy.location?.name || 'Unknown',
    reason: vacancy.absenceDetail?.reasons?.[0]?.name || 'Unknown',
    position: vacancy.position?.title || 'Unknown',
  };
}

function vacancyEmployeeName(vacancy) {
  const firstName = vacancy.absenceDetail?.employee?.firstName || '';
  const lastName = vacancy.absenceDetail?.employee?.lastName || '';
  return `${firstName} ${lastName}`.trim();
}

function addVacancyToSummary(summary, vacancy) {
  const { school, reason, position } = vacancyLabels(vacancy);
  incrementCount(summary.by_school, school);
  incrementCount(summary.by_reason, reason);
  incrementCount(summary.by_position, position);
  if (!vacancy.substitute) {
    summary.unfilled_positions.push({
      school,
      position,
      employee: vacancyEmployeeName(vacancy),
      start: vacancy.start,
      end: vacancy.end,
    });
  }
}

function sortCountsDescending(counts) {
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

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

  for (const vacancy of cert) addVacancyToSummary(summary, vacancy);
  summary.by_school = sortCountsDescending(summary.by_school);
  summary.by_reason = sortCountsDescending(summary.by_reason);
  summary.by_position = sortCountsDescending(summary.by_position);

  return summary;
}

(async () => {
  const args = parseArgs(process.argv);
  requireUser(args);
  const dateInfo = parseDate(args.date || args._positional[0]);

  try {
    const result = await getVacancyDetails(dateInfo.date, dateInfo.date);
    if (result.error) fail(result.error, 'redrover_api_error');
    emit(buildSummary(result.data, dateInfo.label, dateInfo.date));
  } catch (err) {
    fail(err.message, 'redrover_certificated_failed');
  }
})();
