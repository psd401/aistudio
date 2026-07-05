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
  // Track whether any individual agent lookups failed, so callers can
  // warn the user that some agent names are placeholders ("Agent 12345").
  let partialNames = false;

  // Type guard: callers must pass an array (or omit entirely for full pagination).
  // Spreading a non-array into `new Set()` throws cryptically — fail fast instead.
  if (agentIds != null && !Array.isArray(agentIds)) {
    throw new Error('fetchAgentMap: agentIds must be an array or null/undefined');
  }

  // An explicit array — even an empty one — means "fetch only these". An empty
  // list is a no-op that returns an empty map, NOT a request to page the entire
  // roster (REV-COR-332): responderIds is [] on any period with zero closed
  // tickets (weekends/holidays), and paging 50 sequential /agents calls to build
  // a map the caller never indexes just burns the tenant's rate budget. Full
  // pagination is reserved for the agentIds-omitted (null/undefined) case below.
  if (Array.isArray(agentIds)) {
    // Fetch only the agents we need. Batched in groups of 10 to avoid
    // saturating Freshservice's rate limits when a workspace has 50+
    // unique responders in a single summary period. An empty uniqueIds list
    // simply skips the loop and returns the empty map.
    const BATCH_SIZE = 10;
    const INTER_BATCH_DELAY_MS = 50;
    // Unassigned tickets contribute a null/undefined responder_id; filter those
    // out before batching so we don't burn a call on /agents/null and don't
    // flag partialNames for an id that was never a real agent (gemini-code-assist review).
    const uniqueIds = [...new Set(agentIds)].filter((id) => id != null);
    for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) {
      // Yield between batches to avoid saturating Freshservice's 400 req/min
      // rate limit when a workspace has 50+ unique responders in a single
      // summary period. The first batch fires immediately; subsequent batches
      // wait 50ms to spread the load.
      if (i > 0) {
        await new Promise((r) => setTimeout(r, INTER_BATCH_DELAY_MS));
      }
      const batch = uniqueIds.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (id) => {
        const r = await fsFetch(apiKey, `/agents/${id}`);
        if (!r.__ok) {
          partialNames = true;
          return;
        }
        const agent = r.data.agent || r.data;
        map[id] = {
          name: `${agent.first_name || ''} ${agent.last_name || ''}`.trim(),
          first_name: agent.first_name,
          job_title: agent.job_title,
        };
      }));
    }
    map.__partialNames = partialNames;
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

  const MAX_PAGES = 50;
  let all = [];
  let page = 1;
  let hitPageCap = false;
  while (page <= MAX_PAGES) {
    const url = `/tickets/filter?query="${encodeURIComponent(query)}"&workspace_id=${workspaceId}&page=${page}&per_page=100`;
    const r = await fsFetch(apiKey, url);
    if (!r.__ok) return { error: r.error };
    const batch = r.data.tickets || [];
    all = all.concat(batch);
    // If this page was full AND we've reached the cap, stop with truncation flag.
    // Explicit break avoids a subtle post-increment check that's fragile to refactoring.
    if (batch.length === 100 && page === MAX_PAGES) {
      hitPageCap = true;
      break;
    }
    if (batch.length < 100) break;
    page += 1;
  }
  // Signal to callers when the page cap (50 × 100 = 5,000 tickets) was reached
  // so the agent can warn the user that the summary may be incomplete.
  return { tickets: all, truncated: hitPageCap };
}

module.exports = {
  categorizeTicket,
  fetchAgentMap,
  searchClosedTickets,
};
