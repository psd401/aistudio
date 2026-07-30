#!/usr/bin/env node
/**
 * psd-observances — bounded, cited NSPRA calendar lookups over the existing
 * AI Studio repository MCP tools.
 */

'use strict';

const {
  SkillFailure,
  callRepositoryTool,
  defaultRequestAgentBroker,
  fail,
} = require('./common');

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;
const DEFAULT_EXCERPT_CHARS = 300;
const FULL_EXCERPT_CHARS = 2_000;
const FULL_TOTAL_CHARS = 25_000;
const COVERAGE_START = '2026-01-01';
const COVERAGE_END = '2027-06-30';
const ACCURACY_NOTICE = 'Data was verified as of November 2025.';
const PART_II_NOTICE =
  'Part II is not intended to serve as the official or legal listing of holidays for each state.';
const COVERAGE_NOTICE =
  'Coverage is January 2026 through June 2027, plus the six-year holiday summary through 2031.';
const MONTH_NAMES = Object.freeze([
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]);

const USAGE = `psd-observances — cited NSPRA school-calendar reference

Usage:
  node run.js lookup <name> [--limit N] [--full] [--json]
  node run.js search <terms> [--any] [--limit N] [--full] [--json]
  node run.js month <YYYY-MM> [--limit N] [--full] [--json]
  node run.js on --date <YYYY-MM-DD> [--limit N] [--full] [--json]
  node run.js state <name> [--section legal|school] [--limit N] [--full] [--json]
  node run.js conferences [--year N] [--org <text>] [--limit N] [--full] [--json]
  node run.js holiday-years <name> [--limit N] [--full] [--json]

The skill resolves an accessible repository whose name contains "NSPRA".
Default output returns at most five cited results with 300-character excerpts.`;

const VALUE_FLAGS = new Set(['limit', 'date', 'section', 'year', 'org']);
const BOOLEAN_FLAGS = new Set(['json', 'full', 'any', 'help']);
const GLOBAL_FLAGS = new Set(['limit', 'json', 'full', 'help']);
const COMMAND_FLAGS = Object.freeze({
  lookup: new Set(),
  search: new Set(['any']),
  month: new Set(),
  on: new Set(['date']),
  state: new Set(['section']),
  conferences: new Set(['year', 'org']),
  'holiday-years': new Set(),
});

function parseCli(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { help: true };
  }
  if (argv[0] === '--help' || argv[0] === '-h') {
    return { help: true };
  }

  const command = argv[0];
  const flags = Object.create(null);
  const positionals = [];
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      flags.help = true;
      continue;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    if (token.includes('=')) {
      fail(`Use "${token.split('=')[0]} <value>" instead of equals syntax.`);
    }
    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(key)) {
      fail(`Unknown flag: --${key}`);
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      fail(`--${key} requires a value`);
    }
    flags[key] = next;
    index += 1;
  }

  return { command, flags, positionals, help: flags.help === true };
}

function assertAllowedFlags(command, flags) {
  const commandFlags = COMMAND_FLAGS[command];
  if (!commandFlags) {
    fail(`Unknown subcommand: ${command}. Run with --help to see options.`);
  }
  for (const key of Object.keys(flags)) {
    if (!GLOBAL_FLAGS.has(key) && !commandFlags.has(key)) {
      fail(`--${key} is not valid with ${command}`);
    }
  }
}

function parseLimit(value) {
  if (value === undefined) return DEFAULT_LIMIT;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    fail(`--limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

function joinedPositionals(positionals, label) {
  const value = positionals.join(' ').trim();
  if (!value) fail(`${label} is required`);
  return value;
}

function assertNoPositionals(positionals, command) {
  if (positionals.length > 0) {
    fail(`${command} does not accept positional arguments`);
  }
}

function validIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function assertCoveredDate(value, label) {
  if (!validIsoDate(value)) fail(`${label} must use YYYY-MM-DD`);
  if (value < COVERAGE_START || value > COVERAGE_END) {
    fail(
      `${label} is outside the January 2026 through June 2027 coverage window. ` +
        'Use holiday-years only for the six-year holiday summary through 2031.',
      'out_of_range',
      1,
    );
  }
}

function monthQuery(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) fail('month must use YYYY-MM');
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) fail('month must use YYYY-MM');
  assertCoveredDate(
    `${match[1]}-${match[2]}-01`,
    'month',
  );
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

function naturalDate(value) {
  assertCoveredDate(value, '--date');
  const [year, month, day] = value.split('-').map(Number);
  return `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
}

function buildAnyQuery(value) {
  const terms = value.split(/\s+/).filter(Boolean);
  return terms.length > 1 ? terms.join(' OR ') : value;
}

function explicitYears(value) {
  const years = [];
  for (let index = 0; index <= value.length - 4; index += 1) {
    const candidate = value.slice(index, index + 4);
    const digitsOnly = [...candidate].every(
      (character) => character >= '0' && character <= '9',
    );
    const previous = value[index - 1];
    const next = value[index + 4];
    const bounded =
      (previous === undefined || previous < '0' || previous > '9') &&
      (next === undefined || next < '0' || next > '9');
    if (digitsOnly && bounded) {
      years.push({ year: Number(candidate), index });
      index += 3;
    }
  }
  return years;
}

function explicitIsoDates(value) {
  const dates = [];
  for (let index = 0; index <= value.length - 10; index += 1) {
    const candidate = value.slice(index, index + 10);
    if (validIsoDate(candidate)) {
      dates.push(candidate);
      index += 9;
    }
  }
  return dates;
}

function wordTokens(value) {
  const tokens = [];
  let token = '';
  const flushToken = () => {
    if (!token) return;
    tokens.push(token);
    token = '';
  };

  for (const character of value) {
    if (/[\p{L}\p{N}]/u.test(character)) {
      token += character;
    } else {
      flushToken();
    }
  }
  flushToken();
  return tokens;
}

function numericDateTokens(value) {
  const tokens = [];
  let digits = '';
  const flushDigits = () => {
    if (!digits) return;
    tokens.push(digits);
    digits = '';
  };

  for (const character of value) {
    if (character >= '0' && character <= '9') {
      digits += character;
      continue;
    }
    flushDigits();
    if (character === '/' || character === '-' || character === '.') {
      tokens.push(character);
    } else if (tokens.at(-1) !== '|') {
      tokens.push('|');
    }
  }
  flushDigits();
  return tokens;
}

function isNumericToken(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    [...value].every(
      (character) => character >= '0' && character <= '9',
    )
  );
}

function numericMonthYearAt(tokens, index) {
  const candidates = [];
  const first = tokens[index];
  const separator = tokens[index + 1];
  const second = tokens[index + 2];
  if (
    !isNumericToken(first) ||
    !['/', '-', '.'].includes(separator) ||
    !isNumericToken(second)
  ) {
    return candidates;
  }

  const followsNumericDatePart =
    tokens[index - 1] === separator &&
    isNumericToken(tokens[index - 2]);
  if (first.length === 4 && second.length <= 2) {
    candidates.push({ year: Number(first), month: Number(second) });
  } else if (
    second.length === 4 &&
    first.length <= 2 &&
    !followsNumericDatePart
  ) {
    candidates.push({ year: Number(second), month: Number(first) });
  }

  const third = tokens[index + 4];
  if (
    tokens[index + 3] === separator &&
    typeof third === 'string' &&
    third.length === 4 &&
    first.length <= 2
  ) {
    candidates.push({ year: Number(third), month: Number(first) });
  }
  return candidates;
}

function numericMonthYears(value) {
  const tokens = numericDateTokens(value);
  return tokens.flatMap((_, index) => numericMonthYearAt(tokens, index));
}

function nearestYearIs2027(tokens, index) {
  const targetYears = new Set(['2027']);
  let nearestDistance = Number.POSITIVE_INFINITY;
  let nearestIncludes2027 = false;
  for (const [yearIndex, token] of tokens.entries()) {
    if (token.length !== 4 || !Number.isSafeInteger(Number(token))) continue;
    const distance = Math.abs(yearIndex - index);
    if (distance > nearestDistance) continue;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIncludes2027 = targetYears.has(token);
    } else if (targetYears.has(token)) {
      nearestIncludes2027 = true;
    }
  }
  return nearestIncludes2027;
}

function rejectLate2027Month(value) {
  const tokens = wordTokens(value).map((token) => token.toLocaleLowerCase());
  const lateMonths = new Set([
    'july',
    'jul',
    'august',
    'aug',
    'september',
    'sep',
    'sept',
    'october',
    'oct',
    'november',
    'nov',
    'december',
    'dec',
  ]);
  for (const [index, token] of tokens.entries()) {
    if (lateMonths.has(token) && nearestYearIs2027(tokens, index)) {
      fail(
        'The requested 2027 month is outside the January 2026 through June 2027 coverage window.',
        'out_of_range',
        1,
      );
    }
  }
  if (
    numericMonthYears(value).some(
      ({ year, month }) => year === 2027 && month > 6,
    )
  ) {
    fail(
      'The requested 2027 month is outside the January 2026 through June 2027 coverage window.',
      'out_of_range',
      1,
    );
  }
}

function rejectLate2027Period(value) {
  const tokens = wordTokens(value).map((token) => token.toLocaleLowerCase());
  const lateSeasons = new Set(['summer', 'fall', 'autumn']);
  const latePeriodNames = new Set(['q3', 'q4', 'h2']);
  const lateQuarterValues = new Set([
    '3',
    '3rd',
    'three',
    'third',
    '4',
    '4th',
    'four',
    'fourth',
  ]);
  const halfNames = new Set(['half']);
  const quarterNames = new Set(['q', 'qtr', 'quarter']);
  const describesLatePeriod = (token, index) => {
    if (lateSeasons.has(token) || latePeriodNames.has(token)) return true;
    if (halfNames.has(token)) {
      return ['2', '2nd', 'second'].includes(tokens[index - 1]);
    }
    if (quarterNames.has(token)) {
      return (
        lateQuarterValues.has(tokens[index - 1]) ||
        lateQuarterValues.has(tokens[index + 1])
      );
    }
    return (
      lateQuarterValues.has(token) &&
      [tokens[index - 1], tokens[index + 1]].some((nearby) =>
        quarterNames.has(nearby),
      )
    );
  };

  if (
    tokens.some(
      (token, index) =>
        describesLatePeriod(token, index) && nearestYearIs2027(tokens, index),
    )
  ) {
    fail(
      'The requested 2027 period extends beyond the January 2026 through June 2027 coverage window.',
      'out_of_range',
      1,
    );
  }
}

function validateOrdinaryFreeForm(value) {
  for (const { year } of explicitYears(value)) {
    if (year < 2026 || year > 2027) {
      fail(
        `Year ${year} is outside ordinary coverage. Use holiday-years only for major holidays from 2026 through 2031.`,
        'out_of_range',
        1,
      );
    }
  }
  for (const date of explicitIsoDates(value)) {
    assertCoveredDate(date, 'date');
  }
  rejectLate2027Month(value);
  rejectLate2027Period(value);
}

function validateHolidayYearsName(value) {
  for (const { year } of explicitYears(value)) {
    if (year < 2026 || year > 2031) {
      fail(
        `Year ${year} is outside the six-year holiday summary for 2026 through 2031.`,
        'out_of_range',
        1,
      );
    }
  }
}

function commandResult(
  context,
  query,
  includePartIINotice = false,
  searches = undefined,
) {
  return {
    command: context.command,
    query,
    limit: context.limit,
    output: context.output,
    includePartIINotice,
    ...(searches ? { searches } : {}),
  };
}

function buildLookupCommand(context) {
  const name = joinedPositionals(context.positionals, 'observance name');
  validateOrdinaryFreeForm(name);
  return commandResult(
    context,
    name,
  );
}

function buildSearchCommand(context) {
  const terms = joinedPositionals(context.positionals, 'search terms');
  validateOrdinaryFreeForm(terms);
  return commandResult(
    context,
    context.flags.any === true ? buildAnyQuery(terms) : terms,
  );
}

function buildMonthCommand(context) {
  if (context.positionals.length !== 1) {
    fail('month requires exactly one YYYY-MM value');
  }
  return commandResult(context, monthQuery(context.positionals[0]));
}

function buildOnCommand(context) {
  assertNoPositionals(context.positionals, context.command);
  if (typeof context.flags.date !== 'string') fail('--date is required');
  return commandResult(context, naturalDate(context.flags.date));
}

function buildStateCommand(context) {
  const state = joinedPositionals(context.positionals, 'state name');
  const section = context.flags.section;
  if (
    section !== undefined &&
    section !== 'legal' &&
    section !== 'school'
  ) {
    fail('--section must be legal or school');
  }
  if (section === 'legal' || section === 'school') {
    return commandResult(
      context,
      `${state} ${section} holidays`,
      true,
    );
  }
  if (context.limit < 2) {
    fail(
      'state without --section requires --limit 2 or greater so both legal and school holiday sections can be returned.',
    );
  }
  return commandResult(
    context,
    `${state} legal and school holidays`,
    true,
    [
      {
        section: 'legal',
        sectionLabel: 'Legal holidays',
        query: `${state} legal holidays`,
      },
      {
        section: 'school',
        sectionLabel: 'School holidays',
        query: `${state} school holidays`,
      },
    ],
  );
}

function conferenceYear(value) {
  if (value === undefined) return undefined;
  const year = Number(value);
  if (!Number.isSafeInteger(year) || year < 2026 || year > 2027) {
    fail(
      '--year must be 2026 or 2027; publication coverage ends in June 2027.',
      'out_of_range',
      1,
    );
  }
  return year;
}

function buildConferencesCommand(context) {
  assertNoPositionals(context.positionals, context.command);
  const year = conferenceYear(context.flags.year);
  const org =
    typeof context.flags.org === 'string' && context.flags.org.trim()
      ? context.flags.org.trim()
      : undefined;
  return commandResult(
    context,
    ['education conferences', org, year].filter(Boolean).join(' '),
  );
}

function buildHolidayYearsCommand(context) {
  const name = joinedPositionals(context.positionals, 'holiday name');
  validateHolidayYearsName(name);
  return commandResult(
    context,
    `${name} 2026 2027 2028 2029 2030 2031 six-year summary`,
  );
}

const COMMAND_BUILDERS = Object.freeze({
  lookup: buildLookupCommand,
  search: buildSearchCommand,
  month: buildMonthCommand,
  on: buildOnCommand,
  state: buildStateCommand,
  conferences: buildConferencesCommand,
  'holiday-years': buildHolidayYearsCommand,
});

function buildCommand(parsed) {
  const { command, flags, positionals } = parsed;
  assertAllowedFlags(command, flags);
  return COMMAND_BUILDERS[command]({
    command,
    flags,
    positionals,
    limit: parseLimit(flags.limit),
    output: {
      json: flags.json === true,
      full: flags.full === true,
    },
  });
}

function repositoryEntry(value) {
  if (
    !value ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0 ||
    typeof value.name !== 'string'
  ) {
    return null;
  }
  return { id: value.id, name: value.name };
}

function createRepositoryResolver(callTool) {
  let cachedPromise;
  return async function resolveRepository() {
    if (!cachedPromise) {
      cachedPromise = (async () => {
        const payload = await callTool('repositories_list', {
          query: 'NSPRA',
          limit: 50,
        });
        if (!payload || !Array.isArray(payload.repositories)) {
          fail(
            'AI Studio returned a malformed repository list.',
            'upstream_error',
            12,
          );
        }
        const matches = payload.repositories
          .map(repositoryEntry)
          .filter(Boolean)
          .filter((repository) => /nspra/i.test(repository.name));
        if (matches.length === 0) {
          fail(
            'The NSPRA repository is not available to your account.',
            'repository_unavailable',
            1,
          );
        }
        matches.sort((left, right) => {
          const leftPreferred = /2026/i.test(left.name) ? 0 : 1;
          const rightPreferred = /2026/i.test(right.name) ? 0 : 1;
          return leftPreferred - rightPreferred || left.id - right.id;
        });
        const selected = matches[0];
        return {
          ...selected,
          selectionNotice:
            matches.length > 1
              ? `Multiple NSPRA repositories matched; selected "${selected.name}" (id ${selected.id}).`
              : undefined,
        };
      })();
    }
    return cachedPromise;
  };
}

function pageCitation(result) {
  const locators = [
    result && result.sourceLocator,
    ...((result && Array.isArray(result.citations)
      ? result.citations
      : []
    ).map((citation) => citation && citation.sourceLocator)),
  ];
  for (const locator of locators) {
    const page = Number(locator && locator.page);
    const pageEnd = Number(locator && locator.pageEnd);
    if (!Number.isSafeInteger(page) || page <= 0) continue;
    if (Number.isSafeInteger(pageEnd) && pageEnd >= page && pageEnd !== page) {
      return { page, pageEnd, label: `Pages ${page}-${pageEnd}` };
    }
    return { page, label: `Page ${page}` };
  }
  fail(
    'AI Studio returned a result without the required page citation.',
    'upstream_error',
    12,
  );
}

function resultContent(result) {
  if (result && typeof result.content === 'string') return result.content;
  if (result && Array.isArray(result.context)) {
    return result.context
      .map((segment) =>
        segment && typeof segment.content === 'string' ? segment.content : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function searchTerms(query) {
  return wordTokens(query).filter(
    (term) =>
      term.toLocaleUpperCase() !== 'OR' &&
      term.length >= 3 &&
      !/^\d{4}$/.test(term),
  );
}

function excerptAround(content, query, maximum) {
  const normalized = String(content || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maximum) {
    return { text: normalized, truncated: false };
  }

  const lower = normalized.toLocaleLowerCase();
  const matchIndex = searchTerms(query)
    .map((term) => lower.indexOf(term.toLocaleLowerCase()))
    .find((index) => index >= 0);
  const center = matchIndex === undefined ? 0 : matchIndex;
  const prefix = center > 0 ? '…' : '';
  const start = Math.max(0, center - Math.floor(maximum / 3));
  const suffixBudget = start + maximum < normalized.length ? 1 : 0;
  const bodyBudget = Math.max(1, maximum - prefix.length - suffixBudget);
  const body = normalized.slice(start, start + bodyBudget);
  const suffix = start + body.length < normalized.length ? '…' : '';
  return { text: `${prefix}${body}${suffix}`, truncated: true };
}

function shapeSearchResponse(response, query, full, limit = MAX_LIMIT) {
  if (!response || !Array.isArray(response.results)) {
    fail(
      'AI Studio returned a malformed repository search response.',
      'upstream_error',
      12,
    );
  }

  const boundedResults = response.results.slice(0, limit);
  let remaining = full
    ? FULL_TOTAL_CHARS
    : DEFAULT_EXCERPT_CHARS * boundedResults.length;
  return boundedResults.map((result, index) => {
    const remainingResults = boundedResults.length - index;
    const maximum = full
      ? Math.min(FULL_EXCERPT_CHARS, Math.floor(remaining / remainingResults))
      : DEFAULT_EXCERPT_CHARS;
    const excerpt = excerptAround(resultContent(result), query, maximum);
    remaining -= excerpt.text.length;
    const citation = pageCitation(result);
    return {
      itemName:
        result && typeof result.itemName === 'string'
          ? result.itemName
          : undefined,
      citation,
      excerpt: excerpt.text,
      truncated: excerpt.truncated,
      similarity:
        result && Number.isFinite(result.similarity)
          ? result.similarity
          : undefined,
    };
  });
}

function interleaveResultGroups(groups, limit) {
  const results = [];
  for (let index = 0; results.length < limit; index += 1) {
    let foundResult = false;
    for (const group of groups) {
      const result = group[index];
      if (!result) continue;
      results.push(result);
      foundResult = true;
      if (results.length === limit) break;
    }
    if (!foundResult) break;
  }
  return results;
}

async function searchRepository(command, repository, callTool) {
  const searches = command.searches ?? [{ query: command.query }];
  const groups = [];
  for (const search of searches) {
    const response = await callTool('repositories_search', {
      query: search.query,
      repositoryIds: [repository.id],
      mode: 'hybrid',
      limit: command.limit,
    });
    const results = shapeSearchResponse(
      response,
      search.query,
      command.output.full,
      command.limit,
    ).map((result) => ({
      ...result,
      ...(search.section
        ? {
            section: search.section,
            sectionLabel: search.sectionLabel,
          }
        : {}),
    }));
    if (command.searches && results.length === 0) {
      fail(
        `No cited ${search.sectionLabel.toLocaleLowerCase()} results were found for this state.`,
        'no_results',
        1,
      );
    }
    groups.push(results);
  }
  return command.searches
    ? interleaveResultGroups(groups, command.limit)
    : groups[0];
}

async function executeCommand(
  command,
  requestAgentBroker = defaultRequestAgentBroker,
) {
  const callTool = (toolName, toolArgs) =>
    callRepositoryTool(toolName, toolArgs, requestAgentBroker);
  const resolveRepository = createRepositoryResolver(callTool);
  const repository = await resolveRepository();
  const results = await searchRepository(command, repository, callTool);
  return {
    status: 'ok',
    command: command.command,
    query: command.query,
    repository: { id: repository.id, name: repository.name },
    ...(repository.selectionNotice
      ? { selectionNotice: repository.selectionNotice }
      : {}),
    resultCount: results.length,
    results,
    accuracyNotice: ACCURACY_NOTICE,
    coverageNotice: COVERAGE_NOTICE,
    ...(command.includePartIINotice ? { partIINotice: PART_II_NOTICE } : {}),
  };
}

function renderText(result) {
  const lines = [
    `NSPRA repository: ${result.repository.name} (id ${result.repository.id})`,
  ];
  if (result.selectionNotice) lines.push(result.selectionNotice);
  if (result.results.length === 0) {
    lines.push('No matching cited results were found.');
  } else {
    for (const [index, item] of result.results.entries()) {
      const title = item.itemName ? `${item.itemName} — ` : '';
      const section = item.sectionLabel ? `${item.sectionLabel}: ` : '';
      lines.push(
        `${index + 1}. ${section}${item.citation.label} — ${title}${item.excerpt}`,
      );
    }
  }
  if (result.results.some((item) => item.truncated)) {
    lines.push(
      `Excerpts are bounded; use --full to expand them. Default excerpts are ${DEFAULT_EXCERPT_CHARS} characters.`,
    );
  }
  lines.push(result.accuracyNotice, result.coverageNotice);
  if (result.partIINotice) lines.push(result.partIINotice);
  return `${lines.join('\n')}\n`;
}

function failurePayload(error) {
  return {
    status: 'error',
    error: error.code,
    message: error.message,
    ...(error.detail ? { detail: error.detail } : {}),
  };
}

async function main(
  argv = process.argv.slice(2),
  dependencies = {},
  io = {
    stdout: process.stdout.write.bind(process.stdout),
    stderr: process.stderr.write.bind(process.stderr),
  },
) {
  try {
    const parsed = parseCli(argv);
    if (parsed.help) {
      io.stdout(`${USAGE}\n`);
      return 0;
    }
    const command = buildCommand(parsed);
    const result = await executeCommand(
      command,
      dependencies.requestAgentBroker || defaultRequestAgentBroker,
    );
    io.stdout(
      command.output.json
        ? `${JSON.stringify(result)}\n`
        : renderText(result),
    );
    return 0;
  } catch (error) {
    const failure =
      error instanceof SkillFailure
        ? error
        : new SkillFailure(
            error instanceof Error ? error.message : String(error),
            'internal',
            2,
          );
    io.stderr(`psd-observances: ${failure.message}\n`);
    io.stdout(`${JSON.stringify(failurePayload(failure))}\n`);
    return failure.exitCode;
  }
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  ACCURACY_NOTICE,
  COVERAGE_NOTICE,
  PART_II_NOTICE,
  USAGE,
  buildCommand,
  createRepositoryResolver,
  executeCommand,
  excerptAround,
  main,
  pageCitation,
  parseCli,
  renderText,
  shapeSearchResponse,
};
