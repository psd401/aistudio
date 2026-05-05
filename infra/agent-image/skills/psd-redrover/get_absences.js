#!/usr/bin/env node
'use strict';

// Fetch raw Red Rover vacancy/absence records for a date range.
// Usage:
//   node get_absences.js --user <email> --start <YYYY-MM-DD> --end <YYYY-MM-DD> [--filter filled|unfilled|all]
// Max date range: 31 days. Read-only.

const {
  parseArgs, requireUser, getCredentials, getOrganization, getVacancyDetails, emit, fail,
} = require('./lib/api.js');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

(async () => {
  const args = parseArgs(process.argv);
  const user = requireUser(args);
  const startDate = args.start;
  const endDate = args.end;
  const filledFilter = args.filter || 'all';

  if (!startDate || startDate === true || !endDate || endDate === true) {
    fail('--start and --end are required (YYYY-MM-DD)', 'bad_args');
  }
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    fail('Dates must be in YYYY-MM-DD format', 'bad_args');
  }
  if (!['filled', 'unfilled', 'all'].includes(filledFilter)) {
    fail('--filter must be one of: filled, unfilled, all', 'bad_args');
  }
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  const endMs = Date.parse(`${endDate}T00:00:00Z`);
  if (!(startMs <= endMs)) fail('--end must be on or after --start', 'bad_args');
  if ((endMs - startMs) / (1000 * 60 * 60 * 24) > 31) {
    fail('Date range exceeds 31-day maximum', 'bad_args');
  }

  try {
    const creds = getCredentials(user);
    const org = await getOrganization(creds);
    const result = await getVacancyDetails(org.orgId, org.apiKey, creds, startDate, endDate, filledFilter);
    if (result.error) fail(result.error, 'redrover_api_error');
    emit({ start: startDate, end: endDate, filter: filledFilter, total: result.total, data: result.data });
  } catch (err) {
    fail(err.message, 'redrover_absences_failed');
  }
})();
