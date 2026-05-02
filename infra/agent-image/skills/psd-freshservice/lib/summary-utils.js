/**
 * Aggregation helpers shared between daily and weekly summary scripts.
 *
 * Pacific time is handled via the container's TZ=America/Los_Angeles
 * setting (Dockerfile). Date objects use the system timezone automatically
 * — no manual offset arithmetic needed. .toISOString() converts local
 * timestamps to the correct UTC instants for Freshservice API queries.
 */

'use strict';

const { fsFetch } = require('./api');

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

/**
 * Build an agent-ID-to-name map. When agentIds are provided, fetches
 * only those specific agents (one API call per agent) instead of
 * paginating through all agents (up to 50 pages / 5000 agents).
 * Falls back to full pagination when no IDs are provided.
 */
async function fetchAgentMap(apiKey, agentIds) {
  const map = Object.create(null);

  if (agentIds && agentIds.length > 0) {
    // Fetch only the agents we need — one call per unique ID. For a
    // typical daily summary (~10-20 unique responders) this is 10-20
    // API calls vs. potentially 50 paginated calls for the full roster.
    const uniqueIds = [...new Set(agentIds)];
    await Promise.all(uniqueIds.map(async (id) => {
      const r = await fsFetch(apiKey, `/agents/${id}`);
      if (!r.__ok) return;
      const agent = r.data.agent || r.data;
      map[id] = {
        name: `${agent.first_name || ''} ${agent.last_name || ''}`.trim(),
        first_name: agent.first_name,
        job_title: agent.job_title,
      };
    }));
    return map;
  }

  // Fallback: fetch all agents via pagination (used when caller
  // doesn't know which IDs to expect).
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
  // startDate/endDate are local Date objects (Pacific, per Dockerfile TZ).
  // .toISOString() emits the correct UTC instant for Pacific midnight/EOD.
  // Previous code used toUTC() then .split('T')[0] which discarded the time
  // component and reconstructed midnight UTC — off by 7-8 hours.
  const query = `(status:4 OR status:5) AND updated_at:>'${startDate.toISOString()}' AND updated_at:<'${endDate.toISOString()}'`;

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
  categorizeTicket,
  fetchAgentMap,
  searchClosedTickets,
};
