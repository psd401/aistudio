#!/usr/bin/env node

'use strict';

const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validatedFs } = require('../../../validated-fs.cjs');
const { requestAgentBroker } = require('../_shared/agent-broker');
const {
  DEFAULT_EMPTY_MESSAGES,
  compactObject,
  renderNewspaper,
  safeUrl,
} = require('./newspaper');

const SKILL_ID = 'psd-morning-brief';
const SKILLS_DIR = process.env.PSD_SKILLS_DIR || '/opt/psd-skills';
const VENV_PYTHON =
  process.env.PSD_VENV_PYTHON || '/opt/agentcore-venv/bin/python3';
const DEFAULT_OPENCLAW_HOME =
  process.env.OPENCLAW_HOME || '/home/node/.openclaw';
const MAX_EXTERNAL_BUFFER = 64 * 1024 * 1024;
const BRIEF_TAG = 'psd-morning-brief';
const CORE_SECTION_IDS = Object.freeze([
  'calendar',
  'inbox',
  'chat',
  'freshservice',
  'staff_leave',
  'atrium',
  'weather',
  'news',
]);

const DEFAULT_CONFIG = Object.freeze({
  timezone: 'America/Los_Angeles',
  retainDays: 30,
  enabledSections: CORE_SECTION_IDS,
  calendar: { maxResults: 30 },
  inbox: { maxResults: 12, query: 'newer_than:1d -in:spam -in:trash' },
  chat: { spaces: [], maxResults: 40 },
  freshservice: { maxTickets: 30 },
  staffLeave: {},
  atrium: { sinceHours: 24 },
  weather: {
    label: 'Gig Harbor',
    latitude: 47.3293,
    longitude: -122.5801,
  },
  news: {
    topics: ['K-12 education', 'artificial intelligence in education'],
    days: 7,
    limit: 5,
    sources: 'web,hackernews,arxiv',
  },
  people: [],
  customSections: [],
  podcast: { enabled: true, voice: 'Ruth', engine: 'long-form' },
  leadWeights: {
    calendar: 4,
    inbox: 5,
    chat: 3,
    freshservice: 5,
    staff_leave: 4,
    atrium: 2,
    weather: 1,
    news: 2,
  },
});

class BriefError extends Error {
  constructor(message, code = 'brief_failed', phase = 'run') {
    super(message);
    this.name = 'BriefError';
    this.code = code;
    this.phase = phase;
  }
}

class SourceUnavailableError extends Error {
  constructor(message, source, cause = null) {
    super(message);
    this.name = 'SourceUnavailableError';
    this.source = source;
    this.cause = cause;
  }
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  const args = Object.create(null);
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (!token.startsWith('--')) {
      throw new BriefError(
        `Unexpected positional argument: ${token}`,
        'bad_args',
        'arguments',
      );
    }
    const key = token.slice(2).replace(/-/g, '_');
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function validateUserEmail(email) {
  if (typeof email !== 'string' || email.length > 254 || /\s|\//.test(email)) {
    return false;
  }
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return false;
  const domain = email.slice(at + 1);
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

function rejectAuthorityArgs(args) {
  for (const key of [
    'owner_email',
    'user_email',
    'user_id',
    'owner_id',
    'dm_space_name',
    'workspace_prefix',
  ]) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      throw new BriefError(
        `--${key.replace(/_/g, '-')} is not accepted; owner authority comes from the signed invocation context`,
        'bad_args',
        'arguments',
      );
    }
  }
}

function stateDir() {
  return (
    process.env.PSD_MORNING_BRIEF_STATE_DIR ||
    path.join(
      DEFAULT_OPENCLAW_HOME,
      'skills',
      SKILL_ID,
      'state',
    )
  );
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(validatedFs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new BriefError(
      `${label} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
      'bad_args',
      'input',
    );
  }
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : Object.create(null);
}

function boundedString(value, fallback, maxLength = 500) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maxLength)
    : fallback;
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, parsed))
    : fallback;
}

function valueOr(value, fallback) {
  return value || fallback;
}

function uniqueStrings(value, fallback = [], maxItems = 20, maxLength = 300) {
  const source = Array.isArray(value) ? value : fallback;
  return [
    ...new Set(
      source
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim().slice(0, maxLength))
        .filter(Boolean),
    ),
  ].slice(0, maxItems);
}

function normalizeSpaces(value) {
  return (Array.isArray(value) ? value : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      id: boundedString(entry.id || entry.space, '', 200),
      title: boundedString(entry.title || entry.name, 'Chat space', 200),
    }))
    .filter((entry) => /^spaces\/[A-Za-z0-9_-]+$/.test(entry.id))
    .slice(0, 20);
}

function customSectionId(entry, index) {
  const explicit = boundedString(entry.id, '', 80)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (explicit) return `custom-${explicit}`;
  const title = boundedString(entry.title, `section-${index + 1}`, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `custom-${title || index + 1}`;
}

function normalizeCustomSections(value) {
  const seen = new Set();
  const normalized = [];
  for (const [index, raw] of (Array.isArray(value) ? value : []).entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const title = boundedString(raw.title, '', 160);
    const instructions = boundedString(raw.instructions, '', 2_000);
    const sources = uniqueStrings(raw.sources, [], 12, 300);
    if (!title || !instructions || sources.length === 0) continue;
    let id = customSectionId(raw, index);
    let suffix = 2;
    while (seen.has(id)) {
      id = `${customSectionId(raw, index)}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    normalized.push({ id, title, instructions, sources });
  }
  return normalized.slice(0, 12);
}

function normalizePeople(value) {
  return (Array.isArray(value) ? value : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      email: boundedString(entry.email, '', 254).toLowerCase(),
      chatId: boundedString(entry.chatId || entry.chat_id, '', 200),
      note: boundedString(entry.note, '', 500),
    }))
    .filter(
      (entry) =>
        validateUserEmail(entry.email) ||
        /^(?:users\/)?\d{6,30}$/.test(entry.chatId),
    )
    .slice(0, 50);
}

function normalizeLeadWeights(value) {
  const source = asObject(value);
  const result = Object.create(null);
  for (const id of CORE_SECTION_IDS) {
    result[id] = boundedNumber(
      source[id],
      DEFAULT_CONFIG.leadWeights[id],
      0,
      20,
    );
  }
  return result;
}

function normalizedEnabledSections(input) {
  const camelCase = Object.prototype.hasOwnProperty.call(
    input,
    'enabledSections',
  );
  const hasSetting =
    camelCase ||
    Object.prototype.hasOwnProperty.call(input, 'enabled_sections');
  const enabled = uniqueStrings(
    camelCase ? input.enabledSections : input.enabled_sections,
    CORE_SECTION_IDS,
    CORE_SECTION_IDS.length,
    80,
  ).filter((id) => CORE_SECTION_IDS.includes(id));
  return hasSetting ? enabled : [...CORE_SECTION_IDS];
}

function normalizeConfig(raw = {}) {
  const input = asObject(raw);
  const calendar = asObject(input.calendar);
  const inbox = asObject(input.inbox);
  const chat = asObject(input.chat);
  const freshservice = asObject(input.freshservice);
  const staffLeave = asObject(input.staffLeave || input.staff_leave);
  const atrium = asObject(input.atrium);
  const weather = asObject(input.weather);
  const news = asObject(input.news);
  const podcast = asObject(input.podcast);

  return {
    timezone: boundedString(
      input.timezone,
      DEFAULT_CONFIG.timezone,
      100,
    ),
    retainDays: Math.round(
      boundedNumber(
        input.retainDays || input.retain_days,
        DEFAULT_CONFIG.retainDays,
        1,
        365,
      ),
    ),
    enabledSections: normalizedEnabledSections(input),
    calendar: {
      maxResults: Math.round(
        boundedNumber(
          calendar.maxResults || calendar.max_results,
          DEFAULT_CONFIG.calendar.maxResults,
          1,
          100,
        ),
      ),
    },
    inbox: {
      maxResults: Math.round(
        boundedNumber(
          inbox.maxResults || inbox.max_results,
          DEFAULT_CONFIG.inbox.maxResults,
          1,
          50,
        ),
      ),
      query: boundedString(
        inbox.query,
        DEFAULT_CONFIG.inbox.query,
        500,
      ),
    },
    chat: {
      spaces: normalizeSpaces(chat.spaces),
      maxResults: Math.round(
        boundedNumber(
          chat.maxResults || chat.max_results,
          DEFAULT_CONFIG.chat.maxResults,
          1,
          100,
        ),
      ),
    },
    freshservice: {
      maxTickets: Math.round(
        boundedNumber(
          freshservice.maxTickets || freshservice.max_tickets,
          DEFAULT_CONFIG.freshservice.maxTickets,
          1,
          100,
        ),
      ),
    },
    staffLeave: {
      table: boundedString(staffLeave.table, '', 200),
      dateColumn: boundedString(
        staffLeave.dateColumn || staffLeave.date_column,
        '',
        200,
      ),
    },
    atrium: {
      sinceHours: boundedNumber(
        atrium.sinceHours || atrium.since_hours,
        DEFAULT_CONFIG.atrium.sinceHours,
        1,
        720,
      ),
    },
    weather: {
      label: boundedString(
        weather.label,
        DEFAULT_CONFIG.weather.label,
        160,
      ),
      latitude: boundedNumber(
        weather.latitude,
        DEFAULT_CONFIG.weather.latitude,
        -90,
        90,
      ),
      longitude: boundedNumber(
        weather.longitude,
        DEFAULT_CONFIG.weather.longitude,
        -180,
        180,
      ),
    },
    news: {
      topics: uniqueStrings(
        news.topics,
        DEFAULT_CONFIG.news.topics,
        5,
        300,
      ),
      days: Math.round(
        boundedNumber(news.days, DEFAULT_CONFIG.news.days, 1, 30),
      ),
      limit: Math.round(
        boundedNumber(news.limit, DEFAULT_CONFIG.news.limit, 1, 10),
      ),
      sources: boundedString(
        news.sources,
        DEFAULT_CONFIG.news.sources,
        200,
      ),
    },
    people: normalizePeople(input.people),
    customSections: normalizeCustomSections(
      input.customSections || input.custom_sections,
    ),
    podcast: {
      enabled: podcast.enabled !== false,
      voice: boundedString(
        podcast.voice,
        DEFAULT_CONFIG.podcast.voice,
        80,
      ),
      engine: ['generative', 'neural', 'long-form', 'standard'].includes(
        podcast.engine,
      )
        ? podcast.engine
        : DEFAULT_CONFIG.podcast.engine,
    },
    leadWeights: normalizeLeadWeights(
      input.leadWeights || input.lead_weights,
    ),
  };
}

function loadConfig(configPath = path.join(stateDir(), 'config.json')) {
  if (!validatedFs.existsSync(configPath)) {
    return { config: normalizeConfig(), configPath, usedDefaults: true };
  }
  return {
    config: normalizeConfig(readJsonFile(configPath, 'config.json')),
    configPath,
    usedDefaults: false,
  };
}

function localDateParts(now, timezone) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    throw new BriefError(
      `Invalid IANA timezone in config: ${timezone}`,
      'bad_config',
      'config',
    );
  }
  const values = Object.fromEntries(
    formatter.formatToParts(now).map((part) => [part.type, part.value]),
  );
  const localDate = `${values.year}-${values.month}-${values.day}`;
  const displayDate = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(now);
  return { localDate, displayDate };
}

function zonedDateTimeIso(parts, timezone) {
  const target = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0,
  );
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const values = Object.fromEntries(
      formatter
        .formatToParts(new Date(candidate))
        .map((part) => [part.type, part.value]),
    );
    const represented = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    );
    const correction = target - represented;
    candidate += correction;
    if (correction === 0) break;
  }
  return new Date(candidate).toISOString();
}

function dayWindow(localDate, timezone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) {
    throw new BriefError(
      `Invalid local date: ${localDate}`,
      'bad_config',
      'config',
    );
  }
  const start = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  const startDate = new Date(
    Date.UTC(start.year, start.month - 1, start.day),
  );
  if (
    startDate.getUTCFullYear() !== start.year ||
    startDate.getUTCMonth() !== start.month - 1 ||
    startDate.getUTCDate() !== start.day
  ) {
    throw new BriefError(
      `Invalid local date: ${localDate}`,
      'bad_config',
      'config',
    );
  }
  const nextDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1_000);
  const next = {
    year: nextDate.getUTCFullYear(),
    month: nextDate.getUTCMonth() + 1,
    day: nextDate.getUTCDate(),
  };
  return {
    timeMin: zonedDateTimeIso(start, timezone),
    timeMax: zonedDateTimeIso(next, timezone),
  };
}

function lastJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const suffix = lines.slice(index).join('\n').trim();
      if (!suffix || !['{', '['].includes(suffix[0])) continue;
      try {
        return JSON.parse(suffix);
      } catch {
        // Try the next suffix.
      }
    }
  }
  return null;
}

function defaultRunExternal(spec) {
  const entries = {
    'freshservice-tickets': {
      command: 'node',
      base: [
        path.join(
          SKILLS_DIR,
          'psd-freshservice',
          'list_tickets.js',
        ),
      ],
    },
    'freshservice-approvals': {
      command: 'node',
      base: [
        path.join(
          SKILLS_DIR,
          'psd-freshservice',
          'get_approvals.js',
        ),
      ],
    },
    'psd-data': {
      command: 'node',
      base: [path.join(SKILLS_DIR, 'psd-data', 'run.js')],
    },
    news: {
      command: VENV_PYTHON,
      base: [
        path.join(
          SKILLS_DIR,
          'psd-last30days',
          'scripts',
          'last30days.py',
        ),
      ],
    },
    tts: {
      command: VENV_PYTHON,
      base: [
        path.join(
          SKILLS_DIR,
          'psd-tts',
          'scripts',
          'synthesize.py',
        ),
      ],
    },
  };
  const entry = entries[spec.skill];
  if (!entry) {
    throw new BriefError(
      `Unknown external skill: ${spec.skill}`,
      'internal_error',
      'external',
    );
  }
  const result = spawnSync(entry.command, [...entry.base, ...spec.args], {
    input: spec.input,
    encoding: 'utf8',
    maxBuffer: MAX_EXTERNAL_BUFFER,
    timeout: spec.timeoutMs || 120_000,
  });
  return {
    code: result.status == null ? 1 : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? result.error.message : ''),
  };
}

function externalJson(runExternal, spec, source) {
  const result = runExternal(spec);
  const parsed = lastJson(result.stdout);
  if (result.code !== 0) {
    const detail =
      compactObject(parsed) ||
      String(result.stderr || '').trim().slice(0, 1_000) ||
      `${source} exited ${result.code}`;
    throw new SourceUnavailableError(detail, source);
  }
  if (parsed === null) {
    throw new SourceUnavailableError(
      `${source} returned non-JSON output`,
      source,
    );
  }
  return parsed;
}

function unwrapAtrium(result) {
  const status = Number(result && result.httpStatus);
  const payload = result && result.payload;
  if (status < 200 || status >= 300) {
    const message =
      payload && payload.error && payload.error.message
        ? payload.error.message
        : `Atrium returned HTTP ${status || 'unknown'}`;
    const error = new SourceUnavailableError(message, 'psd-atrium');
    error.status = status;
    error.responseBody = payload;
    throw error;
  }
  return payload && payload.data !== undefined ? payload.data : payload;
}

function isUnavailableError(error) {
  if (error instanceof SourceUnavailableError) return true;
  const status = Number(error && error.status);
  const responseStatus =
    error &&
    error.responseBody &&
    typeof error.responseBody.status === 'string'
      ? error.responseBody.status
      : '';
  return (
    [401, 403, 404, 409].includes(status) ||
    /auth|forbidden|permission|provision|credential|scope/i.test(
      `${responseStatus} ${error && error.message ? error.message : ''}`,
    )
  );
}

function parseWorkspaceStdout(result, source) {
  const parsed = lastJson(result && result.stdout);
  if (parsed === null) {
    throw new SourceUnavailableError(
      `${source} returned non-JSON output`,
      source,
    );
  }
  return parsed;
}

async function workspaceJson(broker, scope, argv, source) {
  try {
    const result = await broker('/api/agent/workspace-execute', {
      scope,
      argv,
    });
    return parseWorkspaceStdout(result, source);
  } catch (error) {
    throw new SourceUnavailableError(
      error instanceof Error ? error.message : String(error),
      source,
      error,
    );
  }
}

function headerValue(message, name) {
  const headers =
    message &&
    message.payload &&
    Array.isArray(message.payload.headers)
      ? message.payload.headers
      : [];
  const found = headers.find(
    (header) =>
      header &&
      typeof header.name === 'string' &&
      header.name.toLowerCase() === name.toLowerCase(),
  );
  return found && typeof found.value === 'string' ? found.value : '';
}

function calendarAdapter() {
  return {
    id: 'calendar',
    title: "Today's calendar",
    async available() {
      return true;
    },
    async fetch(context) {
      const window = dayWindow(
        context.localDate,
        context.config.timezone,
      );
      const result = await workspaceJson(
        context.broker,
        'user',
        [
          'calendar',
          'events',
          'list',
          '--params',
          JSON.stringify({
            calendarId: 'primary',
            timeMin: window.timeMin,
            timeMax: window.timeMax,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: context.config.calendar.maxResults,
          }),
        ],
        'psd-workspace calendar',
      );
      const events = Array.isArray(result.items) ? result.items : [];
      return {
        events: events.map((event) => ({
          title: boundedString(event.summary, 'Untitled event', 500),
          start:
            event.start && (event.start.dateTime || event.start.date)
              ? event.start.dateTime || event.start.date
              : '',
          end:
            event.end && (event.end.dateTime || event.end.date)
              ? event.end.dateTime || event.end.date
              : '',
          location: boundedString(event.location, '', 500),
          url: safeUrl(event.htmlLink),
        })),
      };
    },
  };
}

function inboxAdapter() {
  return {
    id: 'inbox',
    title: 'Inbox triage',
    async available() {
      return true;
    },
    async fetch(context) {
      const result = await workspaceJson(
        context.broker,
        'user',
        [
          'gmail',
          'users',
          'messages',
          'list',
          '--params',
          JSON.stringify({
            userId: 'me',
            q: context.config.inbox.query,
            maxResults: context.config.inbox.maxResults,
          }),
        ],
        'psd-workspace inbox',
      );
      const refs = Array.isArray(result.messages) ? result.messages : [];
      const emails = [];
      for (let index = 0; index < refs.length; index += 4) {
        const batch = refs.slice(index, index + 4);
        const resolved = await Promise.all(
          batch.map((ref) =>
            workspaceJson(
              context.broker,
              'user',
              [
                'gmail',
                'users',
                'messages',
                'get',
                '--params',
                JSON.stringify({
                  userId: 'me',
                  id: ref.id,
                  format: 'metadata',
                  metadataHeaders: ['From', 'Subject', 'Date'],
                }),
              ],
              'psd-workspace inbox item',
            ),
          ),
        );
        for (const message of resolved) {
          emails.push({
            id: boundedString(message.id, '', 200),
            threadId: boundedString(message.threadId, '', 200),
            from: headerValue(message, 'From'),
            subject: headerValue(message, 'Subject') || '(no subject)',
            date: headerValue(message, 'Date'),
            snippet: boundedString(message.snippet, '', 1_000),
            labelIds: uniqueStrings(message.labelIds, [], 30, 100),
          });
        }
      }
      return { emails };
    },
  };
}

function chatAdapter() {
  return {
    id: 'chat',
    title: 'Chat-space highlights',
    async available(context) {
      return context.config.chat.spaces.length > 0;
    },
    async fetch(context) {
      const spaces = [];
      for (const configured of context.config.chat.spaces) {
        const result = await workspaceJson(
          context.broker,
          'agent',
          [
            'chat',
            'spaces',
            'messages',
            'list',
            '--params',
            JSON.stringify({
              parent: configured.id,
              pageSize: context.config.chat.maxResults,
              orderBy: 'createTime desc',
            }),
          ],
          'psd-workspace chat',
        );
        spaces.push({
          id: configured.id,
          title: configured.title,
          messages: (Array.isArray(result.messages) ? result.messages : []).map(
            (message) => ({
              text: boundedString(message.text, '', 2_000),
              createTime: boundedString(message.createTime, '', 100),
              senderChatId: boundedString(
                message.sender && message.sender.name,
                '',
                200,
              ),
            }),
          ),
        });
      }
      return {
        spaces,
        messages: spaces.flatMap((space) =>
          space.messages.map((message) => ({
            ...message,
            space: space.title,
          })),
        ),
      };
    },
  };
}

function freshserviceAdapter() {
  return {
    id: 'freshservice',
    title: 'Freshservice tickets & approvals',
    async available(context) {
      return validateUserEmail(context.user);
    },
    async fetch(context) {
      const options = {
        filter: 'new_and_my_open',
        per_page: context.config.freshservice.maxTickets,
        order_type: 'desc',
      };
      const tickets = externalJson(
        context.runExternal,
        {
          skill: 'freshservice-tickets',
          args: [
            '--user',
            context.user,
            '--options',
            JSON.stringify(options),
          ],
        },
        'psd-freshservice tickets',
      );
      const approvals = externalJson(
        context.runExternal,
        {
          skill: 'freshservice-approvals',
          args: ['--user', context.user, '--status', 'requested'],
        },
        'psd-freshservice approvals',
      );
      return {
        tickets: Array.isArray(tickets.tickets) ? tickets.tickets : [],
        approvals: Array.isArray(approvals.approvals)
          ? approvals.approvals
          : [],
      };
    },
  };
}

function recursivelyParseJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !['{', '['].includes(trimmed[0])) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function collectStructuredStrings(value, output = []) {
  const parsed = recursivelyParseJson(value);
  if (typeof parsed === 'string') {
    output.push(parsed);
    return output;
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) collectStructuredStrings(item, output);
    return output;
  }
  if (parsed && typeof parsed === 'object') {
    for (const [key, item] of Object.entries(parsed)) {
      output.push(key);
      collectStructuredStrings(item, output);
    }
  }
  return output;
}

function sqlIdentifier(value) {
  const raw = boundedString(value, '', 200);
  if (
    !raw ||
    !raw
      .split('.')
      .every((part) => /^[A-Za-z_][A-Za-z0-9_$]*$/.test(part))
  ) {
    return null;
  }
  return raw
    .split('.')
    .map((part) => `"${part}"`)
    .join('.');
}

function findWarehouseTable(catalog, configured) {
  if (sqlIdentifier(configured)) return configured;
  return (
    collectStructuredStrings(catalog).find(
      (value) =>
        /absence|vacanc|red.?rover|staff.?leave/i.test(value) &&
        sqlIdentifier(value),
    ) || null
  );
}

function findDateColumn(schema, configured) {
  if (sqlIdentifier(configured)) return configured;
  const candidates = collectStructuredStrings(schema).filter(sqlIdentifier);
  return (
    candidates.find((value) =>
      /^(absence_?date|start_?date|start_?time|date)$/i.test(value),
    ) ||
    candidates.find((value) => /date|start/i.test(value)) ||
    null
  );
}

function findLargestObjectArray(value, best = []) {
  const parsed = recursivelyParseJson(value);
  if (Array.isArray(parsed)) {
    const objects = parsed.filter(
      (item) => item && typeof item === 'object' && !Array.isArray(item),
    );
    let winner = objects.length > best.length ? objects : best;
    for (const item of parsed) {
      winner = findLargestObjectArray(item, winner);
    }
    return winner;
  }
  if (parsed && typeof parsed === 'object') {
    let winner = best;
    for (const item of Object.values(parsed)) {
      winner = findLargestObjectArray(item, winner);
    }
    return winner;
  }
  return best;
}

function staffLeaveAdapter() {
  return {
    id: 'staff_leave',
    title: 'Staff leave',
    async available() {
      return true;
    },
    async fetch(context) {
      const catalog = externalJson(
        context.runExternal,
        {
          skill: 'psd-data',
          args: ['tables', '--detailed'],
          timeoutMs: 60_000,
        },
        'psd-data table discovery',
      );
      const table = findWarehouseTable(
        catalog,
        context.config.staffLeave.table,
      );
      if (!table) {
        return {
          records: [],
          note:
            'No accessible warehouse table describing absences or vacancies was discovered.',
        };
      }
      const schema = externalJson(
        context.runExternal,
        {
          skill: 'psd-data',
          args: ['schema', '--table', JSON.stringify([table])],
          timeoutMs: 60_000,
        },
        'psd-data absence schema',
      );
      const dateColumn = findDateColumn(
        schema,
        context.config.staffLeave.dateColumn,
      );
      const tableSql = sqlIdentifier(table);
      const dateSql = sqlIdentifier(dateColumn);
      if (!tableSql || !dateSql) {
        return {
          table,
          records: [],
          note:
            'The absence table is accessible, but no safe date column could be inferred. Configure staffLeave.dateColumn.',
        };
      }
      const sql =
        `SELECT * FROM ${tableSql} ` +
        `WHERE CAST(${dateSql} AS DATE) = '${context.localDate}' ` +
        `ORDER BY ${dateSql} LIMIT 100`;
      const queried = externalJson(
        context.runExternal,
        {
          skill: 'psd-data',
          args: [
            'query',
            '--reason',
            `Daily staff leave section for ${context.localDate}`,
            '--sql',
            sql,
            '--limit',
            '100',
          ],
          timeoutMs: 90_000,
        },
        'psd-data staff leave query',
      );
      return {
        table,
        dateColumn,
        records: findLargestObjectArray(queried).slice(0, 100),
      };
    },
  };
}

function atriumAdapter() {
  return {
    id: 'atrium',
    title: 'Atrium digest',
    async available() {
      return true;
    },
    async fetch(context) {
      const since = new Date(
        context.now.getTime() -
          context.config.atrium.sinceHours * 60 * 60 * 1_000,
      ).toISOString();
      let result;
      try {
        result = await context.broker('/api/agent/atrium', {
          method: 'GET',
          path: '',
          query: { since },
        });
      } catch (error) {
        throw new SourceUnavailableError(
          error instanceof Error ? error.message : String(error),
          'psd-atrium',
          error,
        );
      }
      const items = unwrapAtrium(result);
      return {
        since,
        items: (Array.isArray(items) ? items : []).map((item) => ({
          id: item.id,
          title: boundedString(item.title, 'Untitled', 500),
          kind: boundedString(item.kind, '', 40),
          status: boundedString(item.status, '', 40),
          updatedAt: boundedString(item.updatedAt, '', 100),
          url: safeUrl(item.url),
        })),
      };
    },
  };
}

function weatherCodeLabel(code) {
  const labels = {
    0: 'Clear',
    1: 'Mostly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Freezing fog',
    51: 'Light drizzle',
    53: 'Drizzle',
    55: 'Heavy drizzle',
    61: 'Light rain',
    63: 'Rain',
    65: 'Heavy rain',
    71: 'Light snow',
    73: 'Snow',
    75: 'Heavy snow',
    80: 'Rain showers',
    81: 'Rain showers',
    82: 'Heavy showers',
    95: 'Thunderstorms',
  };
  return labels[code] || `Weather code ${code}`;
}

function weatherAdapter() {
  return {
    id: 'weather',
    title: 'Weather',
    async available(context) {
      return (
        Number.isFinite(context.config.weather.latitude) &&
        Number.isFinite(context.config.weather.longitude)
      );
    },
    async fetch(context) {
      const params = new URLSearchParams({
        latitude: String(context.config.weather.latitude),
        longitude: String(context.config.weather.longitude),
        timezone: context.config.timezone,
        forecast_days: '1',
        current:
          'temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m',
        daily:
          'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code',
      });
      let response;
      try {
        response = await context.fetch(
          `https://api.open-meteo.com/v1/forecast?${params.toString()}`,
          { signal: AbortSignal.timeout(15_000) },
        );
      } catch (error) {
        throw new SourceUnavailableError(
          `Open-Meteo request failed: ${error instanceof Error ? error.message : String(error)}`,
          'weather',
          error,
        );
      }
      if (!response.ok) {
        throw new SourceUnavailableError(
          `Open-Meteo returned HTTP ${response.status}`,
          'weather',
        );
      }
      const data = await response.json();
      const current = asObject(data.current);
      const daily = asObject(data.daily);
      return {
        location: context.config.weather.label,
        condition: weatherCodeLabel(
          Number(current.weather_code ?? daily.weather_code?.[0]),
        ),
        temperature: current.temperature_2m,
        apparentTemperature: current.apparent_temperature,
        precipitation: current.precipitation,
        windSpeed: current.wind_speed_10m,
        high: Array.isArray(daily.temperature_2m_max)
          ? daily.temperature_2m_max[0]
          : null,
        low: Array.isArray(daily.temperature_2m_min)
          ? daily.temperature_2m_min[0]
          : null,
        precipitationProbability: Array.isArray(
          daily.precipitation_probability_max,
        )
          ? daily.precipitation_probability_max[0]
          : null,
        units: data.current_units || {},
      };
    },
  };
}

function newsAdapter() {
  return {
    id: 'news',
    title: 'News & emerging topics',
    async available(context) {
      return context.config.news.topics.length > 0;
    },
    async fetch(context) {
      const topics = [];
      for (const topic of context.config.news.topics) {
        try {
          const result = externalJson(
            context.runExternal,
            {
              skill: 'news',
              args: [
                '--topic',
                topic,
                '--format',
                'md',
                '--days',
                String(context.config.news.days),
                '--limit',
                String(context.config.news.limit),
                '--sources',
                context.config.news.sources,
              ],
              timeoutMs: 90_000,
            },
            'psd-last30days',
          );
          topics.push({
            topic,
            totalItems: result.total_items || 0,
            counts: result.counts || {},
            warnings: Array.isArray(result.warnings) ? result.warnings : [],
            sourceBrief: boundedString(
              result.brief_markdown,
              '',
              20_000,
            ),
          });
        } catch (error) {
          topics.push({
            topic,
            totalItems: 0,
            warnings: [
              error instanceof Error ? error.message : String(error),
            ],
            sourceBrief: '',
          });
        }
      }
      if (topics.every((topic) => !topic.sourceBrief)) {
        throw new SourceUnavailableError(
          'No configured news topic returned source material',
          'psd-last30days',
        );
      }
      return { topics };
    },
  };
}

function createSectionRegistry() {
  return [
    calendarAdapter(),
    inboxAdapter(),
    chatAdapter(),
    freshserviceAdapter(),
    staffLeaveAdapter(),
    atriumAdapter(),
    weatherAdapter(),
    newsAdapter(),
  ];
}

function sectionHasItems(id, data) {
  const object = asObject(data);
  const keysBySection = {
    calendar: ['events'],
    inbox: ['emails'],
    chat: ['messages'],
    freshservice: ['tickets', 'approvals'],
    staff_leave: ['records'],
    atrium: ['items'],
    news: ['topics'],
  };
  const keys = keysBySection[id] || [];
  if (keys.some((key) => Array.isArray(object[key]) && object[key].length > 0)) {
    return true;
  }
  if (id === 'weather') {
    return Boolean(object.condition || object.temperature !== undefined);
  }
  return false;
}

async function resolvePeople(context) {
  const results = [];
  for (const person of context.config.people) {
    const payload = person.email
      ? { email: person.email }
      : { chatId: person.chatId };
    try {
      const resolved = await context.broker(
        '/api/agent/directory-lookup',
        payload,
      );
      results.push({
        ...resolved,
        note: person.note,
        query: person.email || person.chatId,
      });
    } catch (error) {
      results.push({
        found: false,
        email: person.email || undefined,
        chatId: person.chatId || undefined,
        note: person.note,
        reason:
          error instanceof Error
            ? `Directory lookup unavailable: ${error.message}`
            : 'Directory lookup unavailable',
      });
    }
  }
  return results;
}

function customSnapshotSections(config) {
  return config.customSections.map((section) => ({
    id: section.id,
    title: section.title,
    custom: true,
    status: 'awaiting-synthesis',
    emptyMessage: 'No material was gathered for this custom section.',
    data: {
      instructions: section.instructions,
      sources: section.sources,
    },
  }));
}

async function gatherCoreSection(adapter, context) {
  let available;
  try {
    available = await adapter.available(context);
  } catch (error) {
    return {
      omitted: {
        id: adapter.id,
        reason:
          error instanceof Error
            ? `availability check failed: ${error.message}`
            : 'availability check failed',
      },
    };
  }
  if (!available) {
    return {
      omitted: {
        id: adapter.id,
        reason: 'source not configured or not available to this user',
      },
    };
  }
  try {
    const data = await adapter.fetch(context);
    return {
      section: {
        id: adapter.id,
        title: adapter.title,
        custom: false,
        status: sectionHasItems(adapter.id, data) ? 'ok' : 'empty',
        emptyMessage: DEFAULT_EMPTY_MESSAGES[adapter.id],
        data,
      },
    };
  } catch (error) {
    if (!isUnavailableError(error)) throw error;
    return {
      omitted: {
        id: adapter.id,
        reason:
          error instanceof Error
            ? `source unavailable: ${error.message}`
            : 'source unavailable',
      },
    };
  }
}

async function gatherSnapshot(options = {}, deps = {}) {
  const now = valueOr(options.now, new Date());
  const config = valueOr(options.config, normalizeConfig());
  const broker = valueOr(deps.broker, requestAgentBroker);
  const context = {
    user: options.user,
    config,
    now,
    ...localDateParts(now, config.timezone),
    broker,
    runExternal: valueOr(deps.runExternal, defaultRunExternal),
    fetch: valueOr(deps.fetch, globalThis.fetch),
  };
  const sections = [];
  const omittedSections = [];
  const registry = valueOr(deps.registry, createSectionRegistry());
  const enabledAdapters = [];
  for (const adapter of registry) {
    if (!config.enabledSections.includes(adapter.id)) {
      omittedSections.push({ id: adapter.id, reason: 'disabled in config' });
      continue;
    }
    enabledAdapters.push(adapter);
  }
  const gathered = await Promise.all(
    enabledAdapters.map((adapter) =>
      gatherCoreSection(adapter, context),
    ),
  );
  for (const result of gathered) {
    if (result.section) sections.push(result.section);
    if (result.omitted) omittedSections.push(result.omitted);
  }
  const custom = customSnapshotSections(config);
  if (sections.length === 0 && custom.length === 0) {
    throw new BriefError(
      'No enabled morning-brief section is available for this user',
      'no_sources',
      'data',
    );
  }
  const date = localDateParts(now, config.timezone);
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    localDate: date.localDate,
    displayDate: date.displayDate,
    timezone: config.timezone,
    title: `Morning Brief — ${date.localDate}`,
    people: await resolvePeople(context),
    sections: [...sections, ...custom],
    omittedSections,
  };
}

function makeSynthesisRequest(snapshot) {
  const sections = snapshot.sections.map((section) => ({
    id: section.id,
    title: section.title,
    custom: section.custom === true,
    status: section.status,
    ...(section.custom
      ? {
          instructions: section.data.instructions,
          sources: section.data.sources,
        }
      : {
          dataPath: `sections[id=${section.id}].data`,
        }),
  }));
  return {
    task:
      'Read the data snapshot, gather every custom section from its listed sources, and write the synthesis JSON. Cross-connect related topics, curate rather than dump, make an explicit decision for every inbox item, and write a complete spoken podcast script.',
    dataFile: null,
    availableSections: sections,
    outputShape: {
      headline: 'string',
      subheadline: 'string',
      leadStory: {
        sectionId: 'one available section id',
        headline: 'string',
        summary: 'string',
      },
      sections: [
        {
          id: 'available section id',
          title: 'string',
          summary: 'string',
          emptyMessage: 'string when no data',
          items: [
            {
              headline: 'string',
              body: 'string',
              meta: 'string',
              url: 'optional absolute URL',
            },
          ],
        },
      ],
      inboxDecisions: [
        {
          messageId: 'snapshot inbox message id',
          decision: 'act-now | review | defer | archive',
          rationale: 'string',
        },
      ],
      podcastScript: 'complete natural-language narration for the full edition',
    },
    rules: [
      'Use only section ids in availableSections; unavailable core sections were deliberately omitted.',
      'Custom sections are first-class: gather their sources and include them in sections.',
      'Do not infer a person name from an email or Chat id; use only directory-resolved names in snapshot.people.',
      'Keep URLs exactly as supplied by sources.',
      'Return JSON only.',
    ],
  };
}

function writeSnapshot(snapshot, request, outputDir) {
  const directory = outputDir
    ? path.resolve(outputDir)
    : validatedFs.mkdtempSync(
        path.join(os.tmpdir(), 'psd-morning-brief-'),
      );
  validatedFs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dataFile = path.join(directory, 'data.json');
  validatedFs.writeFileSync(
    dataFile,
    `${JSON.stringify(snapshot, null, 2)}\n`,
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
  return {
    dataFile,
    synthesisRequest: { ...request, dataFile },
  };
}

function extractSectionItems(section) {
  const data = asObject(section.data);
  for (const key of [
    'events',
    'emails',
    'messages',
    'tickets',
    'approvals',
    'records',
    'items',
    'topics',
  ]) {
    if (Array.isArray(data[key])) return data[key];
  }
  return Object.keys(data).length > 0 ? [data] : [];
}

function urgencyScore(value) {
  const text = compactObject(value).toLowerCase();
  const matches = text.match(
    /\b(urgent|overdue|unfilled|approval|deadline|critical|action required|high priority)\b/g,
  );
  return matches ? Math.min(12, matches.length * 2) : 0;
}

function computeLeadStory(snapshot, leadWeights = DEFAULT_CONFIG.leadWeights) {
  const candidates = snapshot.sections
    .filter((section) => section.custom !== true)
    .map((section) => {
      const items = extractSectionItems(section);
      const score =
        Number(leadWeights[section.id] || 0) +
        Math.min(items.length, 10) +
        urgencyScore(items);
      return { section, items, score };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.section.id.localeCompare(right.section.id),
    );
  const best = candidates[0];
  if (!best) {
    return {
      sectionId: snapshot.sections[0] ? snapshot.sections[0].id : 'brief',
      headline: 'Your day, at a glance',
      summary: 'Today’s available sources are collected below.',
    };
  }
  return {
    sectionId: best.section.id,
    headline: best.section.title,
    summary:
      best.items.length > 0
        ? `${best.items.length} item${best.items.length === 1 ? '' : 's'} surfaced in this section.`
        : best.section.emptyMessage || 'Nothing urgent surfaced.',
  };
}

function deterministicSynthesis(snapshot, config) {
  const leadStory = computeLeadStory(snapshot, config.leadWeights);
  const sections = snapshot.sections.map((section) => ({
    id: section.id,
    title: section.title,
    summary:
      section.status === 'empty'
        ? section.emptyMessage
        : `${extractSectionItems(section).length || 1} source item${extractSectionItems(section).length === 1 ? '' : 's'} collected.`,
    emptyMessage: section.emptyMessage,
    items: extractSectionItems(section).slice(0, 10).map((item, index) => ({
      headline:
        boundedString(
          item &&
            (item.title ||
              item.subject ||
              item.summary ||
              item.topic ||
              item.name),
          `Item ${index + 1}`,
          500,
        ),
      body: compactObject(item).slice(0, 1_500),
      url: safeUrl(item && (item.url || item.link)) || undefined,
    })),
  }));
  const spokenSections = sections
    .map((section) => {
      const itemText = section.items
        .slice(0, 4)
        .map((item) => `${item.headline}. ${item.body}`)
        .join(' ');
      return `${section.title}. ${section.summary}. ${itemText}`.trim();
    })
    .join('\n\n');
  return {
    headline: leadStory.headline,
    subheadline: leadStory.summary,
    leadStory,
    sections,
    inboxDecisions: snapshot.sections
      .filter((section) => section.id === 'inbox')
      .flatMap((section) => {
        const data = asObject(section.data);
        return Array.isArray(data.emails) ? data.emails : [];
      })
      .filter((email) => email && typeof email.id === 'string' && email.id)
      .map((email) => ({
        messageId: email.id,
        decision: 'review',
        rationale: 'Review this message in the inbox.',
      })),
    podcastScript:
      `Good morning. This is your morning brief for ${snapshot.displayDate}. ` +
      `${spokenSections} That concludes today's brief.`,
  };
}

function validateSynthesis(raw, snapshot, config) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BriefError(
      'synthesis file must contain a JSON object',
      'bad_synthesis',
      'synthesis',
    );
  }
  const allowedIds = new Set(snapshot.sections.map((section) => section.id));
  const sections = Array.isArray(raw.sections)
    ? raw.sections
        .filter(
          (section) =>
            section &&
            typeof section === 'object' &&
            typeof section.id === 'string' &&
            allowedIds.has(section.id),
        )
        .map((section) => ({
          id: section.id,
          title: boundedString(section.title, '', 300),
          summary: boundedString(section.summary, '', 3_000),
          emptyMessage: boundedString(section.emptyMessage, '', 1_000),
          items: (Array.isArray(section.items) ? section.items : [])
            .slice(0, 30)
            .map((item) => ({
              headline: boundedString(
                item && (item.headline || item.title),
                'Untitled',
                500,
              ),
              body: boundedString(
                item && (item.body || item.summary),
                '',
                4_000,
              ),
              meta: boundedString(item && item.meta, '', 500),
              url: safeUrl(item && (item.url || item.link)) || undefined,
            })),
        }))
    : [];
  const synthesizedIds = new Set(sections.map((section) => section.id));
  const missingCustom = snapshot.sections
    .filter(
      (section) =>
        section.custom === true && !synthesizedIds.has(section.id),
    )
    .map((section) => section.id);
  if (missingCustom.length > 0) {
    throw new BriefError(
      `synthesis is missing configured custom section(s): ${missingCustom.join(', ')}`,
      'bad_synthesis',
      'synthesis',
    );
  }
  const inboxMessageIds = new Set(
    snapshot.sections
      .filter((section) => section.id === 'inbox')
      .flatMap((section) => {
        const data = asObject(section.data);
        return Array.isArray(data.emails) ? data.emails : [];
      })
      .filter((email) => email && typeof email.id === 'string' && email.id)
      .map((email) => email.id),
  );
  const allowedInboxDecisions = new Set([
    'act-now',
    'review',
    'defer',
    'archive',
  ]);
  const inboxDecisions = (
    Array.isArray(raw.inboxDecisions) ? raw.inboxDecisions : []
  )
    .filter(
      (decision) =>
        decision &&
        typeof decision === 'object' &&
        inboxMessageIds.has(decision.messageId) &&
        allowedInboxDecisions.has(decision.decision),
    )
    .slice(0, 100)
    .map((decision) => ({
      messageId: decision.messageId,
      decision: decision.decision,
      rationale: boundedString(decision.rationale, '', 1_000),
    }));
  const decidedMessageIds = new Set(
    inboxDecisions.map((decision) => decision.messageId),
  );
  const missingInboxDecisions = [...inboxMessageIds].filter(
    (messageId) => !decidedMessageIds.has(messageId),
  );
  if (missingInboxDecisions.length > 0) {
    throw new BriefError(
      `synthesis must make a valid decision for every inbox item; missing: ${missingInboxDecisions.join(', ')}`,
      'bad_synthesis',
      'synthesis',
    );
  }
  if (
    typeof raw.podcastScript === 'string' &&
    raw.podcastScript.trim().length > 200_000
  ) {
    throw new BriefError(
      'synthesis podcastScript exceeds the 200000 character limit',
      'bad_synthesis',
      'synthesis',
    );
  }
  const podcastScript = boundedString(raw.podcastScript, '', 200_000);
  if (config.podcast.enabled && !podcastScript) {
    throw new BriefError(
      'synthesis must include a complete podcastScript while podcast delivery is enabled',
      'bad_synthesis',
      'synthesis',
    );
  }
  const lead = asObject(raw.leadStory);
  return {
    headline: boundedString(raw.headline, 'Your day, at a glance', 500),
    subheadline: boundedString(raw.subheadline, '', 2_000),
    leadStory: {
      sectionId: allowedIds.has(lead.sectionId)
        ? lead.sectionId
        : computeLeadStory(snapshot, config.leadWeights).sectionId,
      headline: boundedString(lead.headline, '', 500),
      summary: boundedString(lead.summary, '', 2_000),
    },
    sections,
    inboxDecisions,
    podcastScript,
  };
}

function synthesizePodcast(synthesis, user, config, runExternal) {
  if (!config.podcast.enabled) {
    return { enabled: false, url: null };
  }
  const result = externalJson(
    runExternal,
    {
      skill: 'tts',
      args: [
        '--user',
        user,
        '--voice',
        config.podcast.voice,
        '--engine',
        config.podcast.engine,
      ],
      input: synthesis.podcastScript,
      timeoutMs: 900_000,
    },
    'psd-tts',
  );
  const url = safeUrl(result.url);
  if (!url) {
    throw new BriefError(
      'psd-tts returned no absolute audio URL',
      'podcast_failed',
      'podcast',
    );
  }
  return {
    enabled: true,
    url,
    voice: result.voice || config.podcast.voice,
    engine: result.engine || config.podcast.engine,
    characters: result.characters,
  };
}

async function createPrivateAtriumArtifact(
  snapshot,
  html,
  broker = requestAgentBroker,
) {
  let result;
  try {
    result = await broker('/api/agent/atrium', {
      method: 'POST',
      path: '',
      body: {
        kind: 'artifact',
        title: snapshot.title,
        body: Buffer.from(html, 'utf8').toString('base64'),
        bodyFormat: 'html',
        codeEncoding: 'base64',
        visibility: { level: 'private' },
        tags: [BRIEF_TAG, `morning-brief:${snapshot.localDate}`],
      },
    });
  } catch (error) {
    throw new BriefError(
      `Atrium create failed: ${error instanceof Error ? error.message : String(error)}`,
      'atrium_delivery_failed',
      'atrium',
    );
  }
  let created;
  try {
    created = unwrapAtrium(result);
  } catch (error) {
    throw new BriefError(
      `Atrium create failed: ${error instanceof Error ? error.message : String(error)}`,
      'atrium_delivery_failed',
      'atrium',
    );
  }
  if (
    !created ||
    !created.id ||
    created.visibilityLevel !== 'private'
  ) {
    throw new BriefError(
      'Atrium did not confirm a private artifact; no fallback delivery is allowed',
      'atrium_delivery_failed',
      'atrium',
    );
  }
  if (!safeUrl(created.url)) {
    throw new BriefError(
      'Atrium returned a relative or missing contentDeepLink; the DM requires an absolute URL',
      'atrium_delivery_failed',
      'atrium',
    );
  }
  return created;
}

function ledgerPath() {
  return path.join(stateDir(), 'briefs.json');
}

function readLedger() {
  const filePath = ledgerPath();
  if (!validatedFs.existsSync(filePath)) return [];
  const parsed = readJsonFile(filePath, 'brief retention ledger');
  return Array.isArray(parsed) ? parsed : [];
}

function writeLedger(entries) {
  validatedFs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  validatedFs.writeFileSync(
    ledgerPath(),
    `${JSON.stringify(entries.slice(-400), null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

async function applyRetention(
  created,
  snapshot,
  config,
  broker = requestAgentBroker,
) {
  const cutoff =
    new Date(snapshot.generatedAt).getTime() -
    config.retainDays * 24 * 60 * 60 * 1_000;
  const existing = readLedger();
  const keep = [];
  const deleted = [];
  const warnings = [];
  for (const entry of existing) {
    const createdAt = Date.parse(entry.createdAt);
    if (!entry.id || !Number.isFinite(createdAt) || createdAt >= cutoff) {
      keep.push(entry);
      continue;
    }
    try {
      const result = await broker('/api/agent/atrium', {
        method: 'DELETE',
        path: `/${encodeURIComponent(String(entry.id))}`,
      });
      unwrapAtrium(result);
      deleted.push(entry.id);
    } catch (error) {
      keep.push(entry);
      warnings.push(
        `Could not delete retained brief ${entry.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  keep.push({
    id: created.id,
    slug: created.slug || null,
    createdAt: snapshot.generatedAt,
    localDate: snapshot.localDate,
  });
  writeLedger(keep);
  return { deleted, warnings };
}

function deliveryMessage(snapshot, created, podcast) {
  const lines = [
    `Your private ${snapshot.title} is ready:`,
    created.url,
  ];
  if (podcast.enabled && podcast.url) {
    lines.push('', 'Podcast edition:', podcast.url);
  }
  return lines.join('\n');
}

async function composeBrief(options, deps = {}) {
  const config = options.config || normalizeConfig();
  const snapshot = options.snapshot;
  const synthesis = validateSynthesis(options.synthesis, snapshot, config);
  const runExternal = deps.runExternal || defaultRunExternal;
  const broker = deps.broker || requestAgentBroker;
  const podcast = synthesizePodcast(
    synthesis,
    options.user,
    config,
    runExternal,
  );
  const html = renderNewspaper({ snapshot, synthesis, podcast });
  const created = await createPrivateAtriumArtifact(snapshot, html, broker);
  const retention = await applyRetention(
    created,
    snapshot,
    config,
    broker,
  );
  return {
    status: 'ok',
    mode: options.mode || 'compose',
    artifact: {
      id: created.id,
      slug: created.slug,
      title: created.title,
      visibility: created.visibilityLevel,
      url: created.url,
    },
    podcast,
    retention,
    deliveryMessage: deliveryMessage(snapshot, created, podcast),
  };
}

async function reportFailure(error, deps = {}) {
  const broker = deps.broker || requestAgentBroker;
  const code =
    error && typeof error.code === 'string'
      ? error.code
      : 'morning_brief_failed';
  const phase =
    error && typeof error.phase === 'string' ? error.phase : 'unknown';
  const message =
    error instanceof Error ? error.message : String(error || 'Unknown error');
  process.stderr.write(
    `AGENT_FAILURE_RECORD ${JSON.stringify({
      source: 'agent_self_report',
      severity: 'error',
      error_class: code,
      error_message: message.slice(0, 4_000),
      context: { skill: SKILL_ID, phase },
    })}\n`,
  );
  try {
    // This is the owner-bound persistence route used by
    // psd-failure-report/report.js. Calling it directly avoids forwarding a
    // model-supplied --user hint through a composed skill; the signed broker
    // context remains the only authority.
    return await broker('/api/agent/failures', {
      source: 'agent_self_report',
      severity: 'error',
      errorClass: code.slice(0, 128),
      errorMessage: message.slice(0, 4_000),
      context: {
        skill: SKILL_ID,
        phase,
        self_reported: true,
      },
    });
  } catch (reportError) {
    process.stderr.write(
      `${SKILL_ID}: failure self-report could not be delivered: ${
        reportError instanceof Error
          ? reportError.message
          : String(reportError)
      }\n`,
    );
    return { logged: false };
  }
}

function requireUser(args) {
  if (!validateUserEmail(args.user)) {
    throw new BriefError(
      '--user <caller-email> is required and must come verbatim from the [caller: ...] header',
      'bad_args',
      'arguments',
    );
  }
  return args.user.toLowerCase();
}

function selfCheck() {
  const config = normalizeConfig();
  const snapshot = {
    schemaVersion: 1,
    generatedAt: '2026-07-29T14:00:00.000Z',
    localDate: '2026-07-29',
    displayDate: 'Wednesday, July 29, 2026',
    title: 'Morning Brief — 2026-07-29',
    people: [],
    omittedSections: [],
    sections: [
      {
        id: 'calendar',
        title: "Today's calendar",
        status: 'empty',
        emptyMessage: DEFAULT_EMPTY_MESSAGES.calendar,
        data: { events: [] },
      },
      {
        id: 'custom-focus',
        title: 'Strategic focus',
        custom: true,
        status: 'awaiting-synthesis',
        emptyMessage: 'No custom material was gathered.',
        data: {
          instructions: 'Summarize the current strategic focus.',
          sources: ['psd-data'],
        },
      },
    ],
  };
  const request = makeSynthesisRequest(snapshot);
  const synthesis = deterministicSynthesis(snapshot, config);
  const html = renderNewspaper({
    snapshot,
    synthesis,
    podcast: { enabled: false },
  });
  const checks = {
    registry:
      createSectionRegistry().map((adapter) => adapter.id).join(',') ===
      CORE_SECTION_IDS.join(','),
    defaults: config.podcast.enabled && config.retainDays === 30,
    customSection: request.availableSections.some(
      (section) => section.id === 'custom-focus' && section.custom,
    ),
    emptyState: html.includes(DEFAULT_EMPTY_MESSAGES.calendar),
    newspaper: html.startsWith('<!doctype html>') && html.includes('Private edition'),
  };
  if (Object.values(checks).some((passed) => !passed)) {
    throw new BriefError(
      `Offline self-check failed: ${JSON.stringify(checks)}`,
      'self_test_failed',
      'test',
    );
  }
  return { status: 'ok', mode: 'test', offline: true, checks };
}

function printHelp() {
  process.stdout.write(
    [
      'psd-morning-brief — private daily newspaper + podcast',
      '',
      'Usage:',
      '  run.js --user <caller-email> --data-only [--config <path>] [--out-dir <path>]',
      '  run.js --user <caller-email> --compose --data-file <path> --synthesis-file <path> [--config <path>]',
      '  run.js --user <caller-email> --both [--config <path>]',
      '  run.js --test',
      '',
      'Identity comes from the [caller: ...] header and the signed broker context.',
      'Never pass owner selectors, DM-space ids, or workspace prefixes.',
    ].join('\n') + '\n',
  );
}

function emitResult(deps, result) {
  valueOr(deps.emit, emit)(result);
}

async function main(argv = process.argv, deps = {}) {
  const args = parseArgs(argv);
  rejectAuthorityArgs(args);
  if (args.help) {
    printHelp();
    return { status: 'ok', mode: 'help' };
  }
  const selectedModes = ['data_only', 'compose', 'both', 'test'].filter(
    (mode) => args[mode] === true,
  );
  if (selectedModes.length !== 1) {
    throw new BriefError(
      'Choose exactly one mode: --data-only, --compose, --both, or --test',
      'bad_args',
      'arguments',
    );
  }
  if (args.test === true) {
    const result = selfCheck();
    emitResult(deps, result);
    return result;
  }
  const user = requireUser(args);
  const loaded = loadConfig(
    typeof args.config === 'string'
      ? path.resolve(args.config)
      : path.join(stateDir(), 'config.json'),
  );
  const config = loaded.config;

  if (args.data_only === true) {
    const snapshot = await gatherSnapshot(
      { user, config, now: valueOr(deps.now, new Date()) },
      deps,
    );
    const written = writeSnapshot(
      snapshot,
      makeSynthesisRequest(snapshot),
      typeof args.out_dir === 'string' ? args.out_dir : undefined,
    );
    const result = {
      status: 'ok',
      mode: 'data-only',
      usedDefaultConfig: loaded.usedDefaults,
      omittedSections: snapshot.omittedSections,
      ...written,
    };
    emitResult(deps, result);
    return result;
  }

  if (args.compose === true) {
    if (
      typeof args.data_file !== 'string' ||
      typeof args.synthesis_file !== 'string'
    ) {
      throw new BriefError(
        '--compose requires --data-file and --synthesis-file',
        'bad_args',
        'arguments',
      );
    }
    const result = await composeBrief(
      {
        user,
        config,
        snapshot: readJsonFile(
          path.resolve(args.data_file),
          'data snapshot',
        ),
        synthesis: readJsonFile(
          path.resolve(args.synthesis_file),
          'synthesis file',
        ),
        mode: 'compose',
      },
      deps,
    );
    emitResult(deps, result);
    return result;
  }

  if (args.both === true) {
    const snapshot = await gatherSnapshot(
      { user, config, now: valueOr(deps.now, new Date()) },
      deps,
    );
    const result = await composeBrief(
      {
        user,
        config,
        snapshot,
        synthesis: deterministicSynthesis(snapshot, config),
        mode: 'both',
      },
      deps,
    );
    emitResult(deps, result);
    return result;
  }

  throw new BriefError(
    'Choose exactly one mode: --data-only, --compose, --both, or --test',
    'bad_args',
    'arguments',
  );
}

if (require.main === module) {
  main(process.argv, {}).catch(async (error) => {
    await reportFailure(error);
    emit({
      status: 'error',
      error:
        error && typeof error.code === 'string'
          ? error.code
          : 'morning_brief_failed',
      phase:
        error && typeof error.phase === 'string' ? error.phase : 'unknown',
      message: error instanceof Error ? error.message : String(error),
      selfReported: true,
    });
    process.exitCode = 1;
  });
}

module.exports = {
  BRIEF_TAG,
  BriefError,
  CORE_SECTION_IDS,
  DEFAULT_CONFIG,
  SourceUnavailableError,
  applyRetention,
  collectStructuredStrings,
  composeBrief,
  computeLeadStory,
  createPrivateAtriumArtifact,
  createSectionRegistry,
  deterministicSynthesis,
  dayWindow,
  findDateColumn,
  findLargestObjectArray,
  findWarehouseTable,
  gatherSnapshot,
  isUnavailableError,
  lastJson,
  loadConfig,
  main,
  makeSynthesisRequest,
  normalizeConfig,
  parseArgs,
  reportFailure,
  selfCheck,
  sqlIdentifier,
  validateSynthesis,
  validateUserEmail,
  writeSnapshot,
};
