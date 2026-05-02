#!/usr/bin/env node
/**
 * get_weekly_summary.js — Mon-Sun ticket close summary with trends.
 *
 * Usage:
 *   node get_weekly_summary.js --user <email> [--weeks-ago N] [--workspace-id 2]
 */

'use strict';

const { fail, emit, parseArgs, requireUser, getApiKey } = require('./lib/api');
const {
  categorizeTicket,
  fromUTCToPacific,
  fetchAgentMap,
  searchClosedTickets,
} = require('./lib/summary-utils');

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function getWeekRange(weeksAgo) {
  const now = new Date();
  const currentDay = now.getDay();
  const mondayOffset = currentDay === 0 ? -6 : 1 - currentDay;
  const monday = new Date(now);
  monday.setDate(monday.getDate() + mondayOffset - weeksAgo * 7);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  const firstDayOfYear = new Date(monday.getFullYear(), 0, 1);
  const pastDaysOfYear = (monday - firstDayOfYear) / 86400000;
  const weekNum = Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);

  return {
    start: monday,
    end: sunday,
    label: `Week ${weekNum} (${monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${sunday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`,
  };
}

function getDayName(date) {
  return date.toLocaleDateString('en-US', { weekday: 'short' });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: get_weekly_summary.js --user <email> [--weeks-ago 0] [--workspace-id 2]');
    process.exit(0);
  }
  const userEmail = requireUser(args);
  const weeksAgo = args.weeks_ago ? parseInt(args.weeks_ago, 10) : 0;
  const workspaceId = args.workspace_id ? Number(args.workspace_id) : 2;
  const range = getWeekRange(weeksAgo);

  const apiKey = getApiKey(userEmail);
  const [ticketRes, agentMap] = await Promise.all([
    searchClosedTickets(apiKey, range.start, range.end, workspaceId),
    fetchAgentMap(apiKey),
  ]);
  if (ticketRes.error) fail(ticketRes.error, 'upstream_error');

  const tickets = ticketRes.tickets || [];
  const byDay = Object.create(null);
  for (const d of DAY_LABELS) byDay[d] = { count: 0, categories: {}, agents: {} };

  const byAgent = Object.create(null);
  const byCategory = Object.create(null);
  const byCategoryByDay = Object.create(null);

  for (const ticket of tickets) {
    const updatedAt = new Date(ticket.updated_at);
    const pacific = fromUTCToPacific(updatedAt);
    const dayName = getDayName(pacific);
    const category = categorizeTicket(ticket.subject);

    if (byDay[dayName]) {
      byDay[dayName].count += 1;
      byDay[dayName].categories[category] = (byDay[dayName].categories[category] || 0) + 1;
      if (ticket.responder_id) {
        byDay[dayName].agents[ticket.responder_id] = (byDay[dayName].agents[ticket.responder_id] || 0) + 1;
      }
    }
    byCategory[category] = (byCategory[category] || 0) + 1;
    if (!byCategoryByDay[category]) byCategoryByDay[category] = Object.create(null);
    byCategoryByDay[category][dayName] = (byCategoryByDay[category][dayName] || 0) + 1;

    if (ticket.responder_id) {
      const id = ticket.responder_id;
      if (!byAgent[id]) {
        byAgent[id] = {
          agent: agentMap[id] || { name: `Agent ${id}`, first_name: 'Unknown' },
          count: 0,
          categories: Object.create(null),
          byDay: Object.create(null),
        };
      }
      byAgent[id].count += 1;
      byAgent[id].categories[category] = (byAgent[id].categories[category] || 0) + 1;
      byAgent[id].byDay[dayName] = (byAgent[id].byDay[dayName] || 0) + 1;
    }
  }

  const sortedAgents = Object.entries(byAgent)
    .map(([id, data]) => ({
      id,
      name: data.agent.name,
      first_name: data.agent.first_name,
      job_title: data.agent.job_title,
      count: data.count,
      categories: data.categories,
      byDay: data.byDay,
      avg_per_day: (data.count / 5).toFixed(1),
    }))
    .sort((a, b) => b.count - a.count);

  const weekdayCounts = DAY_LABELS.slice(0, 5).map((d) => byDay[d].count);
  const avgDaily = weekdayCounts.reduce((a, b) => a + b, 0) / 5;
  const peakDay = DAY_LABELS.slice(0, 5).reduce((max, d) => byDay[d].count > byDay[max].count ? d : max, 'Mon');
  const slowDay = DAY_LABELS.slice(0, 5).reduce((min, d) => byDay[d].count < byDay[min].count ? d : min, 'Mon');

  emit({
    week: range.label,
    date_range: { start: range.start.toISOString(), end: range.end.toISOString() },
    workspace_id: workspaceId,
    total_closed: tickets.length,
    daily_average: avgDaily.toFixed(1),
    trends: {
      peak_day: { day: peakDay, count: byDay[peakDay].count },
      slow_day: { day: slowDay, count: byDay[slowDay].count },
      daily_counts: byDay,
    },
    by_category: Object.fromEntries(
      Object.entries(byCategory)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [k, { total: v, pct: tickets.length ? `${((v / tickets.length) * 100).toFixed(1)}%` : '0.0%' }]),
    ),
    category_trends: byCategoryByDay,
    top_agents: sortedAgents.slice(0, 10),
    all_agents: sortedAgents,
  });
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
