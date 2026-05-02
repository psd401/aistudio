/**
 * Aggregation helpers shared between daily and weekly summary scripts.
 *
 * Pacific time conversions are intentionally fixed at UTC-8 (no DST
 * adjustment) — matches the reference implementation's behavior. The
 * date math is correct for the bulk of the school year; during DST
 * (Mar–Nov) summary boundaries shift by one hour. Acceptable tradeoff
 * versus pulling in a tz library here.
 */

'use strict';

const { fsFetch } = require('./api');

const PACIFIC_OFFSET_HOURS = 8;

function toUTC(date) {
  return new Date(date.getTime() + PACIFIC_OFFSET_HOURS * 60 * 60 * 1000).toISOString();
}

function fromUTCToPacific(date) {
  return new Date(date.getTime() - PACIFIC_OFFSET_HOURS * 60 * 60 * 1000);
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
