#!/usr/bin/env node
/**
 * get_daily_summary.js — daily ticket-close summary for a workspace.
 *
 * Usage:
 *   node get_daily_summary.js --user <email> [--date <today|yesterday|YYYY-MM-DD|day-name|"last <day>">]
 *                              [--workspace-id 2]
 */

'use strict';

const { fail, emit, parseArgs, requireUser, getApiKey } = require('./lib/api');
const {
  categorizeTicket,
  fetchAgentMap,
  searchClosedTickets,
} = require('./lib/summary-utils');

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Parse a human-friendly --date argument into a start/end Date pair.
 *
 * TIMEZONE: Date labels (toLocaleDateString) and day-of-week calculations
 * depend on the container's TZ environment variable. The agent Dockerfile
 * sets TZ=America/Los_Angeles so all date operations use Pacific time.
 * If TZ is incorrect, date labels will misalign with the query window
 * constructed in searchClosedTickets().
 */
function parseDate(arg) {
  const now = new Date();
  if (!arg || arg === 'today') {
    return {
      start: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0),
      end: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59),
      label: 'today',
    };
  }
  if (arg === 'yesterday') {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    return {
      start: new Date(y.getFullYear(), y.getMonth(), y.getDate(), 0, 0, 0),
      end: new Date(y.getFullYear(), y.getMonth(), y.getDate(), 23, 59, 59),
      label: 'yesterday',
    };
  }
  const lower = arg.toLowerCase();
  if (lower.startsWith('last ')) {
    const dayName = lower.replace('last ', '').trim();
    const target = DAY_NAMES.indexOf(dayName);
    if (target !== -1) {
      const current = now.getDay();
      let back = current - target;
      if (back <= 0) back += 7;
      const t = new Date(now);
      t.setDate(t.getDate() - back);
      return {
        start: new Date(t.getFullYear(), t.getMonth(), t.getDate(), 0, 0, 0),
        end: new Date(t.getFullYear(), t.getMonth(), t.getDate(), 23, 59, 59),
        label: `last ${dayName.charAt(0).toUpperCase() + dayName.slice(1)}`,
      };
    }
  }
  const justDay = DAY_NAMES.indexOf(lower);
  if (justDay !== -1) {
    const current = now.getDay();
    let back = current - justDay;
    if (back < 0) back += 7;
    if (back === 0) back = 7;
    const t = new Date(now);
    t.setDate(t.getDate() - back);
    return {
      start: new Date(t.getFullYear(), t.getMonth(), t.getDate(), 0, 0, 0),
      end: new Date(t.getFullYear(), t.getMonth(), t.getDate(), 23, 59, 59),
      label: t.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
    };
  }
  // Append T00:00:00 to force parsing as local midnight. Without it,
  // `new Date('2024-01-15')` is parsed as UTC midnight, which in the
  // Pacific timezone (UTC-7/8) yields the *previous* calendar day for
  // d.getFullYear()/getMonth()/getDate() — an off-by-one bug.
  const d = new Date(`${arg}T00:00:00`);
  if (isNaN(d.getTime())) fail(`Could not parse --date: ${arg}`, 'bad_args');
  return {
    start: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0),
    end: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59),
    label: d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: get_daily_summary.js --user <email> [--date <today|yesterday|YYYY-MM-DD>] [--workspace-id 2]');
    process.exit(0);
  }
  const userEmail = requireUser(args);
  const dateArg = args.date && args.date !== true ? String(args.date) : 'today';
  const workspaceId = args.workspace_id ? Number(args.workspace_id) : 2;
  if (isNaN(workspaceId)) fail('--workspace-id must be a number', 'bad_args');
  const range = parseDate(dateArg);

  const apiKey = getApiKey(userEmail);
  const ticketRes = await searchClosedTickets(apiKey, range.start, range.end, workspaceId);
  if (ticketRes.error) fail(ticketRes.error, 'upstream_error');

  // Fetch only agents that appear in ticket results — avoids paginating
  // through the full agent roster (up to 50 API calls) on every summary.
  const responderIds = (ticketRes.tickets || [])
    .map((t) => t.responder_id)
    .filter(Boolean);
  const agentMap = await fetchAgentMap(apiKey, responderIds);

  const tickets = ticketRes.tickets || [];
  const byAgent = Object.create(null);
  const byCategory = Object.create(null);
  const automated = [];

  for (const ticket of tickets) {
    const category = categorizeTicket(ticket.subject);
    byCategory[category] = (byCategory[category] || 0) + 1;

    if (!ticket.responder_id) {
      automated.push({
        id: ticket.id,
        subject: ticket.subject,
        category,
        updated_at: ticket.updated_at,
      });
      continue;
    }
    const id = ticket.responder_id;
    if (!byAgent[id]) {
      byAgent[id] = {
        agent: agentMap[id] || { name: `Agent ${id}`, first_name: 'Unknown' },
        tickets: [],
        categories: Object.create(null),
      };
    }
    byAgent[id].tickets.push({
      id: ticket.id,
      subject: ticket.subject,
      category,
      status: ticket.status,
      priority: ticket.priority,
      created_at: ticket.created_at,
      updated_at: ticket.updated_at,
    });
    byAgent[id].categories[category] = (byAgent[id].categories[category] || 0) + 1;
  }

  const sortedAgents = Object.entries(byAgent)
    .map(([id, data]) => ({
      id,
      name: data.agent.name,
      first_name: data.agent.first_name,
      job_title: data.agent.job_title,
      count: data.tickets.length,
      categories: data.categories,
      tickets: data.tickets.sort((a, b) => new Date(a.updated_at) - new Date(b.updated_at)),
    }))
    .sort((a, b) => b.count - a.count);

  const output = {
    date: range.label,
    date_range: { start: range.start.toISOString(), end: range.end.toISOString() },
    workspace_id: workspaceId,
    total_closed: tickets.length,
    by_category: Object.fromEntries(
      Object.entries(byCategory).sort((a, b) => b[1] - a[1]),
    ),
    by_agent: sortedAgents,
    automated: { count: automated.length, tickets: automated },
  };
  // Surface truncation warning so the agent can inform the user that
  // the summary may be incomplete (>5,000 tickets in the period).
  if (ticketRes.truncated) output.truncated = true;
  // Surface partial-name warning when some agent lookups failed — callers
  // should note that agent names like "Agent 12345" are placeholders.
  if (agentMap.__partialNames) output.partial_agent_names = true;
  emit(output);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
