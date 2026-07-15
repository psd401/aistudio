/**
 * Aggregation helpers shared between daily and weekly summary scripts.
 *
 * Pacific time is handled via the container's TZ=America/Los_Angeles
 * setting (Dockerfile). Date objects use the system timezone automatically
 * — no manual offset arithmetic needed.
 *
 * Freshservice's /tickets/filter API only accepts DATE-ONLY ('yyyy-mm-dd')
 * values for updated_at comparisons; a full ISO timestamp (what
 * .toISOString() emits) is rejected with an unconditional 400 (#1228).
 * searchClosedTickets() therefore queries a widened date-only window and
 * re-applies the exact time-of-day boundaries client-side against each
 * ticket's full-precision updated_at.
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

/**
 * Format a local Date as 'yyyy-mm-dd' from its local calendar components.
 *
 * The summary scripts build their start/end boundaries with local Date
 * constructors (Pacific, per the container TZ), so reading the same local
 * components back round-trips the intended Pacific business day regardless
 * of what TZ the process actually runs under — the value is whatever local
 * day was put in. This is the date-only form Freshservice's filter API
 * requires for updated_at comparisons (#1228).
 */
function toLocalYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Return a new Date shifted by `days` (may be negative), preserving time-of-day. */
function shiftDays(date, days) {
  const copy = new Date(date.getTime());
  copy.setDate(copy.getDate() + days);
  return copy;
}

// Widen the date-only query window by this many days on each side of the
// requested range. Freshservice compares updated_at by calendar date and we
// don't control which timezone it uses for that comparison; a 2-day pad
// (48h) comfortably exceeds the ≤8h Pacific⇄UTC skew, so the widened query
// is guaranteed to be a superset of the requested [start, end] instants.
// The exact boundaries are then re-applied client-side below.
const QUERY_PAD_DAYS = 2;

async function searchClosedTickets(apiKey, startDate, endDate, workspaceId = 2) {
  // startDate/endDate are local Date objects (Pacific, per Dockerfile TZ).
  // Freshservice's /tickets/filter rejects full ISO timestamps on updated_at
  // (#1228) and only accepts 'yyyy-mm-dd'. Query a padded date-only window,
  // then filter to the exact instants client-side (updated_at in the results
  // still carries full precision, so no fidelity is lost).
  const lowerBound = toLocalYmd(shiftDays(startDate, -QUERY_PAD_DAYS));
  const upperBound = toLocalYmd(shiftDays(endDate, QUERY_PAD_DAYS));
  const query = `(status:4 OR status:5) AND updated_at:>'${lowerBound}' AND updated_at:<'${upperBound}'`;

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

  // Re-apply the exact [startDate, endDate] boundaries client-side. The API
  // window was padded to date-only granularity; here we compare absolute
  // instants (both sides are UTC-anchored) so the returned set matches the
  // requested Pacific business range precisely. Tickets with a missing or
  // unparseable updated_at yield NaN and fall outside the range — dropped.
  const startMs = startDate.getTime();
  const endMs = endDate.getTime();
  const tickets = all.filter((t) => {
    const ms = new Date(t.updated_at).getTime();
    return ms >= startMs && ms <= endMs;
  });

  // Signal to callers when the page cap (50 × 100 = 5,000 tickets) was reached
  // so the agent can warn the user that the summary may be incomplete.
  return { tickets, truncated: hitPageCap };
}

module.exports = {
  categorizeTicket,
  fetchAgentMap,
  searchClosedTickets,
  toLocalYmd,
  shiftDays,
};
