#!/usr/bin/env node
'use strict';

// Daily Red Rover absence summary (all staff).
// Usage: node get_daily_summary.js --user <email> [--date today|yesterday|monday|"last friday"|YYYY-MM-DD]
// Read-only.

const {
  parseArgs, requireUser, getVacancyDetails, parseDate, emit, fail,
} = require('./lib/api.js');

function buildSummary(vacancies, dateLabel, dateStr) {
  const dateObj = new Date(`${dateStr}T12:00:00`);
  const summary = createEmptySummary(dateObj, dateLabel, dateStr, vacancies.length);
  for (const vacancy of vacancies) addVacancyToSummary(summary, vacancy);
  summary.by_school = sortedCounts(summary.by_school);
  summary.by_reason = sortedCounts(summary.by_reason);
  summary.by_position_type = sortedCounts(summary.by_position_type);
  summary.fill_rate = summary.total_absences > 0
    ? Math.round((summary.filled / summary.total_absences) * 100)
    : 100;
  return summary;
}

function createEmptySummary(dateObj, dateLabel, dateStr, totalAbsences) {
  return {
    date: dateLabel,
    date_iso: dateStr,
    day_of_week: dateObj.toLocaleDateString('en-US', { weekday: 'long' }),
    full_date: dateObj.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    }),
    total_absences: totalAbsences,
    filled: 0,
    unfilled: 0,
    by_school: Object.create(null),
    by_reason: Object.create(null),
    by_position_type: Object.create(null),
    unfilled_positions: [],
    absences: [],
  };
}

function addVacancyToSummary(summary, vacancy) {
  const record = vacancySummaryRecord(vacancy);
  if (record.filled) {
    summary.filled++;
  } else {
    summary.unfilled++;
    summary.unfilled_positions.push({
      school: record.school,
      position: record.position,
      employee: record.employee,
      start: record.start,
      end: record.end,
    });
  }
  incrementCount(summary.by_school, record.school);
  incrementCount(summary.by_reason, record.reason);
  incrementCount(summary.by_position_type, record.position_type);
  const { position_type: _positionType, ...absence } = record;
  summary.absences.push(absence);
}

function vacancySummaryRecord(vacancy) {
  const filled = !!vacancy.substitute;
  return {
    employee: personName(vacancy.absenceDetail?.employee),
    school: vacancy.location?.name || 'Unknown',
    position: vacancy.position?.title || 'Unknown',
    position_type: vacancy.position?.positionType?.name || 'Unknown',
    reason: vacancy.absenceDetail?.reasons?.[0]?.name || 'Unknown',
    filled,
    substitute: filled ? personName(vacancy.substitute) : null,
    start: vacancy.start,
    end: vacancy.end,
  };
}

function personName(person) {
  return `${person?.firstName || ''} ${person?.lastName || ''}`.trim();
}

function incrementCount(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

function sortedCounts(counts) {
  return Object.fromEntries(
    Object.entries(counts).sort((left, right) => right[1] - left[1])
  );
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
    fail(err.message, 'redrover_daily_failed');
  }
})();
