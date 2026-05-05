/**
 * Shared helpers for the psd-redrover OpenClaw skill.
 *
 * READ-ONLY contract:
 *   - Every HTTP call goes through rrGet() — GET only, no method override.
 *   - No fs.write*, no child_process other than psd-credentials/get.js.
 *   - Credential values are held in module-scope memory only and never
 *     written to disk, workspace, or chat.
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

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const BASE_URL = 'https://connect.redroverk12.com';
const CREDENTIALS_GET = path.resolve(__dirname, '..', '..', 'psd-credentials', 'get.js');

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

let _credentialsCache = null;

/**
 * Fetch the shared Red Rover credential bundle from psd-credentials.
 * Cached for the process lifetime. Never logged, never echoed.
 */
function getCredentials(userEmail) {
  if (_credentialsCache) return _credentialsCache;

  let stdout = '';
  try {
    stdout = execFileSync('node', [
      CREDENTIALS_GET,
      '--user', userEmail,
      '--name', 'redrover_credentials',
      '--shared',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (err) {
    fail(
      `redrover credentials not provisioned. Ask an administrator to create the shared secret at psd-agent-creds/<env>/shared/redrover_credentials with shape {"username","password","apiKey"}. (psd-credentials error: ${err.message})`,
      'redrover_credentials_missing'
    );
  }

  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) fail('psd-credentials returned no output', 'redrover_credentials_missing');

  let parsed;
  try {
    parsed = JSON.parse(lines[lines.length - 1]);
  } catch (err) {
    fail(`psd-credentials returned non-JSON: ${err.message}`, 'redrover_credentials_missing');
  }
  if (parsed.error || !parsed.value) {
    fail('psd-credentials returned no value', 'redrover_credentials_missing');
  }

  // Secret value is a JSON-encoded string; parse it once.
  let creds;
  try {
    creds = JSON.parse(parsed.value);
  } catch (err) {
    fail(
      'redrover_credentials secret value is not valid JSON. Expected shape: {"username","password","apiKey"}.',
      'redrover_credentials_malformed'
    );
  }
  if (!creds || typeof creds.username !== 'string' || typeof creds.password !== 'string') {
    fail(
      'redrover_credentials secret missing required fields. Expected shape: {"username","password","apiKey"}.',
      'redrover_credentials_malformed'
    );
  }
  _credentialsCache = {
    username: creds.username,
    password: creds.password,
    apiKey: typeof creds.apiKey === 'string' ? creds.apiKey : null,
  };
  return _credentialsCache;
}

function basicAuthHeader(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

/**
 * Read-only HTTP chokepoint. All Red Rover API access in this skill
 * goes through this function. There is no companion rrPost/rrPut —
 * adding one would be a violation of the read-only contract.
 *
 * urlOrPath: absolute URL string OR a path beginning with '/'.
 * headers: extra headers to merge in (Authorization is added here).
 */
async function rrGet(urlOrPath, creds, extraHeaders = {}) {
  const url = urlOrPath.startsWith('http') ? urlOrPath : `${BASE_URL}${urlOrPath}`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: basicAuthHeader(creds.username, creds.password),
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return { __ok: false, status: resp.status, error: `Red Rover API error ${resp.status}: ${body.slice(0, 500)}` };
  }
  const json = await resp.json().catch(() => ({}));
  return { __ok: true, status: resp.status, data: json };
}

let _orgCache = null;

/**
 * Get organization info (orgId + dynamic apiKey). Memoized per process.
 * The dynamic apiKey is preferred; falls back to the static one stored
 * in Secrets Manager if Red Rover ever stops returning it.
 */
async function getOrganization(creds) {
  if (_orgCache) return _orgCache;
  const resp = await rrGet('/api/v1/organization', creds);
  if (!resp.__ok) {
    throw new Error(resp.error);
  }
  const data = Array.isArray(resp.data) ? resp.data[0] : resp.data;
  if (!data || !data.orgId) {
    throw new Error('Red Rover /organization response missing orgId');
  }
  const apiKey = data.apiKey || creds.apiKey;
  if (!apiKey) {
    throw new Error('Red Rover did not return an apiKey and no static apiKey is provisioned in Secrets Manager');
  }
  _orgCache = { orgId: data.orgId, apiKey, raw: data };
  return _orgCache;
}

/**
 * Fetch all pages of /Vacancy/details for a date range, optionally
 * filtered by filled/unfilled status. Read-only; uses rrGet under the
 * hood. Returns { data: [...] } on success or { error } on API failure.
 */
async function getVacancyDetails(orgId, apiKey, creds, startDate, endDate, filledFilter) {
  const url = new URL(`${BASE_URL}/api/v1/${orgId}/Vacancy/details`);
  url.searchParams.set('fromDate', `${startDate}T00:00:00Z`);
  url.searchParams.set('toDate', `${endDate}T23:59:59Z`);
  url.searchParams.set('pageSize', '100');
  if (filledFilter === 'filled') url.searchParams.set('filled', 'true');
  else if (filledFilter === 'unfilled') url.searchParams.set('filled', 'false');

  let allData = [];
  let page = 1;
  while (true) {
    url.searchParams.set('page', String(page));
    const resp = await rrGet(url.toString(), creds, { apiKey });
    if (!resp.__ok) {
      return { error: resp.error, status: resp.status };
    }
    const result = resp.data || {};
    allData = allData.concat(result.data || []);
    if (!result.hasMoreData) break;
    page++;
    // Defensive ceiling to prevent runaway loops on a misbehaving API.
    if (page > 200) break;
  }
  return { data: allData, total: allData.length };
}

// ---------- Date helpers ----------

function formatDate(date) {
  return date.toISOString().split('T')[0];
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

  const d = new Date(dateArg);
  if (isNaN(d.getTime())) {
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
  rrGet,
  getOrganization,
  getVacancyDetails,
  formatDate,
  parseDate,
  getWeekRange,
};
