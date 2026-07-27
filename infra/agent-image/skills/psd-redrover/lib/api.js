/**
 * Shared helpers for the psd-redrover OpenClaw skill.
 *
 * READ-ONLY contract:
 *   - Every provider call goes through a fixed read-only web-tier operation.
 *   - No provider credential enters this model-launched process.
 *
 * Authenticates with a single district-wide credential set fetched on
 * demand from psd-credentials at:
 *   psd-agent-creds/{env}/shared/redrover_credentials
 * Secret value shape: {"username":"...","password":"...","apiKey":"..."}
 *
 * The static apiKey is currently unused at runtime — the Red Rover
 * /api/v1/organization endpoint mints a dynamic apiKey on each call —
 * but it's stored alongside username/password for parity with the
 * upstream secrets.js and 1Password entry, and is wired through as a
 * fallback if the org call ever stops returning one.
 */

'use strict';

const { requestAgentBroker } = require('../../_shared/agent-broker');

const BASE_URL = 'https://connect.redroverk12.com';
const EMAIL_RE = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;

function fail(message, code = 'error') {
  process.stderr.write(`Error: ${message}\n`);
  process.stdout.write(JSON.stringify({ error: code, message }) + '\n');
  process.exit(1);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function parseArgs(argv) {
  const args = { _positional: [] };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      args._positional.push(arg);
      continue;
    }
    const key = arg.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function requireUser(args) {
  if (typeof args.user !== 'string' || !EMAIL_RE.test(args.user)) {
    fail('--user is required and must be a valid email address', 'bad_args');
  }
  return args.user;
}

/**
 * Compatibility marker for existing command modules. Provider credentials are
 * resolved only inside the trusted operation broker and never enter this
 * model-launched process.
 */
function getCredentials(_userEmail) {
  return Object.freeze({ ownerBoundOperationBroker: true });
}

let _orgCache = null;

/**
 * Get organization info (orgId + dynamic apiKey). Memoized per process.
 * The dynamic apiKey is preferred; falls back to the static one stored
 * in Secrets Manager if Red Rover ever stops returning it.
 */
async function getOrganization(creds) {
  void creds;
  if (_orgCache) return _orgCache;
  const data = await requestAgentBroker('/api/agent/credentials', {
    operation: 'redrover',
    action: 'organization',
  });
  if (!data || typeof data.orgId !== 'string') {
    throw new Error('Red Rover /organization response missing orgId');
  }
  _orgCache = { orgId: data.orgId, apiKey: null, raw: data.raw || {} };
  return _orgCache;
}

/**
 * Fetch all pages of /Vacancy/details for a date range, optionally
 * filtered by filled/unfilled status. Read-only; uses rrGet under the
 * hood. Returns { data: [...] } on success or { error } on API failure.
 */
async function getVacancyDetails(startDate, endDate, filledFilter) {
  return requestAgentBroker('/api/agent/credentials', {
    operation: 'redrover',
    action: 'vacancies',
    startDate,
    endDate,
    filledFilter,
  });
}

// ---------- Date helpers ----------

/**
 * Format a Date as YYYY-MM-DD using local time components.
 * Previous implementation used toISOString() which converts to UTC first —
 * after 5 PM Pacific (UTC-7/-8), "today" would format as tomorrow's date.
 */
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Parse a date argument into { date: 'YYYY-MM-DD', label: '...' }.
 * Supports: undefined/today, yesterday, day names, "last <day>",
 * and explicit YYYY-MM-DD.
 */
function parseDate(dateArg) {
  const now = new Date();
  if (!dateArg || dateArg === 'today') {
    return { date: formatDate(now), label: 'today' };
  }
  if (dateArg === 'yesterday') {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    return { date: formatDate(y), label: 'yesterday' };
  }
  const lower = String(dateArg).toLowerCase();

  if (lower.startsWith('last ')) {
    const dayName = lower.slice(5).trim();
    const targetDay = DAY_NAMES.indexOf(dayName);
    if (targetDay !== -1) {
      const currentDay = now.getDay();
      let daysBack = currentDay - targetDay;
      if (daysBack <= 0) daysBack += 7;
      const t = new Date(now);
      t.setDate(t.getDate() - daysBack);
      return {
        date: formatDate(t),
        label: `last ${dayName.charAt(0).toUpperCase() + dayName.slice(1)}`,
      };
    }
  }

  const justDay = DAY_NAMES.indexOf(lower);
  if (justDay !== -1) {
    const currentDay = now.getDay();
    let daysBack = currentDay - justDay;
    if (daysBack < 0) daysBack += 7;
    if (daysBack === 0) daysBack = 7;
    const t = new Date(now);
    t.setDate(t.getDate() - daysBack);
    return {
      date: formatDate(t),
      label: t.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
    };
  }

  // Force local-midnight parsing. `new Date('2026-01-15')` parses a date-only
  // ISO string as UTC midnight, which in the container's America/Los_Angeles TZ
  // (UTC-7/8) reads back as the *previous* calendar day through formatDate's
  // local getters — a silent off-by-one on both the query window and the label.
  // Appending T00:00:00 parses as local midnight, preserving the requested day
  // (mirrors the psd-freshservice fix). See REV-COR-331.
  // Only do this for an unambiguous YYYY-MM-DD value — appending T00:00:00 to
  // any other format (MM/DD/YYYY, "Month DD, YYYY", ...) produces an invalid
  // date string in Node's parser (gemini-code-assist review).
  const d = /^\d{4}-\d{2}-\d{2}$/.test(dateArg)
    ? new Date(`${dateArg}T00:00:00`)
    : new Date(dateArg);
  if (Number.isNaN(d.getTime())) {
    fail(`Could not parse date: ${dateArg}`, 'bad_args');
  }
  return {
    date: formatDate(d),
    label: d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
  };
}

/**
 * Calculate a school-week range (Mon–Fri) offset by `weeksAgo`.
 */
function getWeekRange(weeksAgo = 0) {
  const now = new Date();
  const currentDay = now.getDay();
  const monday = new Date(now);
  const daysFromMonday = currentDay === 0 ? 6 : currentDay - 1;
  monday.setDate(monday.getDate() - daysFromMonday - weeksAgo * 7);
  const friday = new Date(monday);
  friday.setDate(friday.getDate() + 4);
  const fmtLabel = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return {
    start: formatDate(monday),
    end: formatDate(friday),
    label: weeksAgo === 0 ? 'this week' : weeksAgo === 1 ? 'last week' : `${weeksAgo} weeks ago`,
    rangeLabel: `${fmtLabel(monday)}-${fmtLabel(friday)}, ${monday.getFullYear()}`,
  };
}

module.exports = {
  BASE_URL,
  fail,
  emit,
  parseArgs,
  requireUser,
  getCredentials,
  getOrganization,
  getVacancyDetails,
  formatDate,
  parseDate,
  getWeekRange,
};
