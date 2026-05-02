/**
 * Aggregation helpers shared between daily and weekly summary scripts.
 *
 * Pacific time conversions use Intl.DateTimeFormat with
 * 'America/Los_Angeles' for correct PST/PDT handling. No external
 * tz library needed — Node.js ships ICU data by default.
 */

'use strict';

const { fsFetch } = require('./api');

const PACIFIC_TZ = 'America/Los_Angeles';

/**
 * Get the UTC offset in milliseconds for a given date in Pacific time.
 * Handles PST (UTC-8) vs PDT (UTC-7) automatically via Intl API.
 */
function getPacificOffsetMs(date) {
  // Format the date parts in Pacific time to reconstruct the local
  // timestamp, then diff against the UTC timestamp to find the offset.
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((p) => [p.type, p.value]),
  );
  // Reconstruct a UTC timestamp that represents "what Pacific clocks show"
  const pacificAsUtc = new Date(
    `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`,
  );
  return date.getTime() - pacificAsUtc.getTime();
}

function toUTC(date) {
  const offsetMs = getPacificOffsetMs(date);
  return new Date(date.getTime() + offsetMs).toISOString();
}

function fromUTCToPacific(date) {
  const offsetMs = getPacificOffsetMs(date);
  return new Date(date.getTime() - offsetMs);
}

function categorizeTicket(subject) {
  const lower = (subject || '').toLowerCase();
  if (lower.includes('password reset')) return 'Password Reset';
  if (lower.includes('security alert') || lower.includes('compromised') || lower.includes('breach')) return 'Security Alert';
  if (lower.includes('schoology')) return 'Schoology';
  if (lower.includes('powerschool')) return 'PowerSchool';
  if (lower.includes('promethean')) return 'Promethean Board';
  if (lower.includes('chromebook')) return 'Chromebook';
  if (lower.includes('phone') || lower.includes('voicemail') || lower.includes('ext.')) return 'Phone/Voicemail';
  if (lower.includes('badge')) return 'Badge Request';
  if (lower.includes('new student') || lower.includes('enrollee')) return 'New Student';
  if (lower.includes('intercom')) return 'Intercom';
  if (lower.includes('raptor')) return 'Raptor';
  if (lower.includes('goguardian') || lower.includes('go guardian')) return 'GoGuardian';
  if (lower.includes('login') || lower.includes('access') || lower.includes('mfa')) return 'Access/Login';
  return 'Other';
}

async function fetchAgentMap(apiKey) {
  let all = [];
  let page = 1;
  while (page <= 50) {
    const r = await fsFetch(apiKey, `/agents?per_page=100&page=${page}`);
    if (!r.__ok) break;
    const batch = r.data.agents || [];
    all = all.concat(batch);
    if (batch.length < 100) break;
    page += 1;
  }
  const map = Object.create(null);
  for (const agent of all) {
    map[agent.id] = {
      name: `${agent.first_name || ''} ${agent.last_name || ''}`.trim(),
      first_name: agent.first_name,
      job_title: agent.job_title,
    };
  }
  return map;
}

async function searchClosedTickets(apiKey, startDate, endDate, workspaceId = 2) {
  const startUTC = toUTC(startDate);
  const endUTC = toUTC(endDate);
  const query = `(status:4 OR status:5) AND updated_at:>'${startUTC.split('T')[0]}T00:00:00Z' AND updated_at:<'${endUTC.split('T')[0]}T23:59:59Z'`;

  let all = [];
  let page = 1;
  while (page <= 50) {
    const url = `/tickets/filter?query="${encodeURIComponent(query)}"&workspace_id=${workspaceId}&page=${page}&per_page=100`;
    const r = await fsFetch(apiKey, url);
    if (!r.__ok) return { error: r.error };
    const batch = r.data.tickets || [];
    all = all.concat(batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return { tickets: all };
}

module.exports = {
  toUTC,
  fromUTCToPacific,
  categorizeTicket,
  fetchAgentMap,
  searchClosedTickets,
};
