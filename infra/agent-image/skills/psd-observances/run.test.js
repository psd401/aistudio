/**
 * psd-observances CLI, repository-resolution, output-bound, and broker tests.
 *
 * Every documented command runs through main() with a mocked owner-bound
 * broker. Fixtures contain names and dates only, never NSPRA prose comments.
 */

'use strict';

const { afterEach, describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  createRepositoryResolver,
  excerptAround,
  main,
  parseCli,
} = require('./run');

const DEFAULT_REPOSITORIES = [
  { id: 1476, name: 'District NSPRA 2026-2027 Calendar' },
];

function toolEnvelope(data, options = {}) {
  return {
    httpStatus: options.httpStatus ?? 200,
    keySource: options.keySource ?? 'oauth',
    payload:
      options.payload ??
      {
        jsonrpc: '2.0',
        id: 'test',
        result: {
          content: [{ type: 'text', text: JSON.stringify(data) }],
        },
      },
  };
}

function factForQuery(query) {
  if (/washington/i.test(query)) {
    return 'Washington — Legal holidays — School holidays';
  }
  if (/conference|National PTA/i.test(query)) {
    return 'National PTA conference — June 18-21, 2026';
  }
  if (/christmas/i.test(query)) {
    return 'Christmas — December 25 — 2026, 2027, 2028, 2029, 2030, 2031';
  }
  return 'American Education Week — November 16-20, 2026';
}

function searchResult(query, overrides = {}) {
  return {
    itemName: 'NSPRA calendar',
    content: factForQuery(query),
    sourceLocator: { page: 17 },
    citations: [{ sourceLocator: { page: 17 }, label: 'Page 17' }],
    similarity: 0.91,
    ...overrides,
  };
}

function createBroker(options = {}) {
  const calls = [];
  const broker = async (route, body, requestOptions) => {
    calls.push({ route, body, requestOptions });
    const toolName = body && body.params && body.params.name;
    if (options.respond) {
      const response = await options.respond(toolName, body.params.arguments);
      if (response !== undefined) return response;
    }
    if (toolName === 'repositories_list') {
      return toolEnvelope({
        repositories: options.repositories ?? DEFAULT_REPOSITORIES,
      });
    }
    if (toolName === 'repositories_search') {
      const query = body.params.arguments.query;
      return toolEnvelope({
        results:
          options.results ??
          [searchResult(query)],
        diagnostics: { returnedResults: 1 },
      });
    }
    throw new Error(`Unexpected tool: ${toolName}`);
  };
  return { broker, calls };
}

async function invoke(argv, broker) {
  let stdout = '';
  let stderr = '';
  const exitCode = await main(
    argv,
    { requestAgentBroker: broker },
    {
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
    },
  );
  return { exitCode, stdout, stderr };
}

describe('documented command forms', () => {
  const cases = [
    {
      name: 'lookup',
      argv: ['lookup', 'American Education Week'],
      query: 'American Education Week',
    },
    {
      name: 'search --any',
      argv: ['search', 'school', 'counseling', '--any'],
      query: 'school OR counseling',
    },
    {
      name: 'month',
      argv: ['month', '2026-11'],
      query: 'November 2026',
    },
    {
      name: 'on',
      argv: ['on', '--date', '2026-11-16'],
      query: 'November 16, 2026',
    },
    {
      name: 'state',
      argv: ['state', 'Washington'],
      query: 'Washington legal holidays school holidays',
    },
    {
      name: 'conferences',
      argv: ['conferences', '--year', '2026', '--org', 'National PTA'],
      query: 'education conferences National PTA 2026',
    },
    {
      name: 'holiday-years',
      argv: ['holiday-years', 'Christmas'],
      query: 'Christmas 2026 2027 2028 2029 2030 2031 six-year summary',
    },
  ];

  for (const commandCase of cases) {
    test(`runs ${commandCase.name} with real arguments`, async () => {
      const { broker, calls } = createBroker();
      const result = await invoke(commandCase.argv, broker);
      expect(result.exitCode).toBe(0);
      expect(calls).toHaveLength(2);
      expect(calls[0].route).toBe('/api/agent/aistudio');
      expect(calls[0].body).toEqual({
        method: 'tools/call',
        params: {
          name: 'repositories_list',
          arguments: { query: 'NSPRA', limit: 50 },
        },
      });
      expect(calls[1].body).toEqual({
        method: 'tools/call',
        params: {
          name: 'repositories_search',
          arguments: {
            query: commandCase.query,
            repositoryIds: [1476],
            mode: 'hybrid',
            limit: 5,
          },
        },
      });
      expect(result.stdout).toContain('Page 17');
    });
  }
});

test('lookup returns the acceptance date with a page citation', async () => {
  const { broker } = createBroker();
  const result = await invoke(
    ['lookup', 'American Education Week'],
    broker,
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('November 16-20, 2026');
  expect(result.stdout).toContain('Page 17');
});

test('state Washington includes both sections and the Part II disclaimer', async () => {
  const { broker } = createBroker();
  const result = await invoke(['state', 'Washington'], broker);
  expect(result.stdout).toContain('Legal holidays');
  expect(result.stdout).toContain('School holidays');
  expect(result.stdout).toContain(
    'not intended to serve as the official or legal listing',
  );
});

test('default lookup remains below an approximate 500-token bound', async () => {
  const results = Array.from({ length: 8 }, (_, index) =>
    searchResult('American Education Week', {
      content:
        `American Education Week — November 16-20, 2026 — ${index} ` +
        'calendar '.repeat(200),
      sourceLocator: { page: 17 + index },
      citations: [{ sourceLocator: { page: 17 + index } }],
    }),
  );
  const { broker } = createBroker({ results });
  const result = await invoke(
    ['lookup', 'American Education Week'],
    broker,
  );
  expect(result.stdout.split(/\s+/).filter(Boolean).length).toBeLessThan(500);
  expect((result.stdout.match(/^\d+\. Page/gm) || [])).toHaveLength(5);
});

test('--limit overrides the default and --json emits parseable output without a banner', async () => {
  const results = Array.from({ length: 5 }, (_, index) =>
    searchResult('American Education Week', {
      sourceLocator: { page: index + 1 },
      citations: [{ sourceLocator: { page: index + 1 } }],
    }),
  );
  const { broker, calls } = createBroker({ results });
  const result = await invoke(
    ['lookup', 'American Education Week', '--limit', '2', '--json'],
    broker,
  );
  const payload = JSON.parse(result.stdout);
  expect(result.exitCode).toBe(0);
  expect(payload.results).toHaveLength(2);
  expect(result.stdout).not.toContain('Excerpts are bounded');
  expect(calls[1].body.params.arguments.limit).toBe(2);
});

test('--full expands the default 300-character excerpt', async () => {
  const content =
    'American Education Week — November 16-20, 2026 — ' +
    'calendar '.repeat(100);
  const { broker } = createBroker({
    results: [searchResult('American Education Week', { content })],
  });
  const defaultResult = await invoke(
    ['lookup', 'American Education Week'],
    broker,
  );
  const { broker: fullBroker } = createBroker({
    results: [searchResult('American Education Week', { content })],
  });
  const fullResult = await invoke(
    ['lookup', 'American Education Week', '--full'],
    fullBroker,
  );
  expect(fullResult.stdout.length).toBeGreaterThan(defaultResult.stdout.length);
});

test('repository resolution prefers a 2026 name, then the lowest id, and reports it', async () => {
  const { broker, calls } = createBroker({
    repositories: [
      { id: 2, name: 'NSPRA archive' },
      { id: 9, name: 'NSPRA 2026 Calendar B' },
      { id: 4, name: 'NSPRA 2026 Calendar A' },
    ],
  });
  const result = await invoke(['lookup', 'American Education Week'], broker);
  expect(result.exitCode).toBe(0);
  expect(calls[1].body.params.arguments.repositoryIds).toEqual([4]);
  expect(result.stdout).toContain('Multiple NSPRA repositories matched');
  expect(result.stdout).toContain('NSPRA 2026 Calendar A');
});

test('repository resolution uses the lowest id when no name contains 2026', async () => {
  const { broker, calls } = createBroker({
    repositories: [
      { id: 12, name: 'NSPRA calendar archive' },
      { id: 3, name: 'NSPRA district reference' },
    ],
  });
  const result = await invoke(['lookup', 'American Education Week'], broker);
  expect(result.exitCode).toBe(0);
  expect(calls[1].body.params.arguments.repositoryIds).toEqual([3]);
});

test('repository resolver caches the id for one invocation', async () => {
  let calls = 0;
  const resolve = createRepositoryResolver(async () => {
    calls += 1;
    return { repositories: DEFAULT_REPOSITORIES };
  });
  expect(await resolve()).toEqual({
    id: 1476,
    name: 'District NSPRA 2026-2027 Calendar',
    selectionNotice: undefined,
  });
  expect(await resolve()).toEqual(await resolve());
  expect(calls).toBe(1);
});

test('no accessible NSPRA repository gives a clear account-specific error', async () => {
  const { broker } = createBroker({ repositories: [] });
  const result = await invoke(['lookup', 'American Education Week'], broker);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain(
    'The NSPRA repository is not available to your account',
  );
});

test('HTTP unauthorized includes a connect/reconnect hint and exits 11', async () => {
  const { broker } = createBroker({
    respond: (toolName) =>
      toolName === 'repositories_list'
        ? toolEnvelope(null, {
            httpStatus: 401,
            payload: { error: 'expired' },
          })
        : undefined,
  });
  const result = await invoke(['lookup', 'American Education Week'], broker);
  expect(result.exitCode).toBe(11);
  expect(result.stdout).toMatch(/connect AI Studio access/i);
  expect(result.stdout).toMatch(/reconnect/i);
});

test('an unconfigured AI Studio credential is a re-auth error with exit 11', async () => {
  const { broker } = createBroker({
    respond: () => {
      const error = new Error(
        'Agent broker rejected the request: AI Studio credential is not configured',
      );
      error.status = 404;
      throw error;
    },
  });
  const result = await invoke(['lookup', 'American Education Week'], broker);
  expect(result.exitCode).toBe(11);
  expect(result.stdout).toMatch(/connect AI Studio access/i);
});

test('insufficient-scope JSON-RPC errors include a re-auth hint and exit 11', async () => {
  const { broker } = createBroker({
    respond: (toolName) =>
      toolName === 'repositories_list'
        ? toolEnvelope(null, {
            payload: {
              jsonrpc: '2.0',
              id: 'test',
              error: {
                code: -32602,
                message: 'Insufficient scope for repositories_list',
              },
            },
          })
        : undefined,
  });
  const result = await invoke(['lookup', 'American Education Week'], broker);
  expect(result.exitCode).toBe(11);
  expect(result.stdout).toMatch(/connect AI Studio access/i);
});

test('rate limiting exits 14 and generic MCP errors exit 12', async () => {
  const rateLimited = createBroker({
    respond: () =>
      toolEnvelope(null, { httpStatus: 429, payload: { error: 'slow down' } }),
  });
  expect(
    (await invoke(['lookup', 'American Education Week'], rateLimited.broker))
      .exitCode,
  ).toBe(14);

  const upstreamError = createBroker({
    respond: () =>
      toolEnvelope(null, {
        payload: {
          jsonrpc: '2.0',
          id: 'test',
          error: { code: -32603, message: 'retrieval unavailable' },
        },
      }),
  });
  expect(
    (await invoke(['lookup', 'American Education Week'], upstreamError.broker))
      .exitCode,
  ).toBe(12);
});

test('malformed, tool-level, and transport failures exit 12', async () => {
  const malformed = createBroker({
    respond: () => ({ payload: null }),
  });
  expect(
    (await invoke(['lookup', 'American Education Week'], malformed.broker))
      .exitCode,
  ).toBe(12);

  const toolError = createBroker({
    respond: () =>
      toolEnvelope(null, {
        payload: {
          jsonrpc: '2.0',
          id: 'test',
          result: {
            isError: true,
            content: [{ type: 'text', text: 'repository unavailable' }],
          },
        },
      }),
  });
  expect(
    (await invoke(['lookup', 'American Education Week'], toolError.broker))
      .exitCode,
  ).toBe(12);

  const transportError = createBroker({
    respond: () => {
      throw new Error('socket closed');
    },
  });
  expect(
    (await invoke(['lookup', 'American Education Week'], transportError.broker))
      .exitCode,
  ).toBe(12);
});

test('a result without a page citation is rejected', async () => {
  const { broker } = createBroker({
    results: [
      searchResult('American Education Week', {
        sourceLocator: {},
        citations: [],
      }),
    ],
  });
  const result = await invoke(['lookup', 'American Education Week'], broker);
  expect(result.exitCode).toBe(12);
  expect(result.stdout).toContain('required page citation');
});

test('invalid command-specific flags and out-of-range dates fail before broker access', async () => {
  const { broker, calls } = createBroker();
  const invalidSection = await invoke(
    ['state', 'Washington', '--section', 'statute'],
    broker,
  );
  expect(invalidSection.exitCode).toBe(1);
  const outOfRange = await invoke(['month', '2028-01'], broker);
  expect(outOfRange.exitCode).toBe(1);
  expect(outOfRange.stdout).toContain('outside');
  expect(calls).toHaveLength(0);
});

test('free-form commands reject explicit out-of-range years and dates before broker access', async () => {
  const { broker, calls } = createBroker();
  for (const argv of [
    ['lookup', 'Christmas 2030'],
    ['search', 'Constitution Day', '2030'],
    ['lookup', 'Observances on 2027-07-01'],
    ['search', 'observances in July 2027'],
    ['holiday-years', 'Christmas 2032'],
  ]) {
    const result = await invoke(argv, broker);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('out_of_range');
  }
  expect(calls).toHaveLength(0);
});

test('holiday-years accepts an in-range summary year', async () => {
  const { broker, calls } = createBroker();
  const result = await invoke(['holiday-years', 'Christmas 2030'], broker);
  expect(result.exitCode).toBe(0);
  expect(calls[1].body.params.arguments.query).toContain('Christmas 2030');
});

test('parser accepts bare subcommand positionals and rejects unknown flags', () => {
  expect(parseCli(['lookup', 'American', 'Education', 'Week']).positionals).toEqual([
    'American',
    'Education',
    'Week',
  ]);
  expect(() => parseCli(['lookup', 'Name', '--bogus'])).toThrow(
    'Unknown flag',
  );
});

test('excerpting centers the named fact and keeps the hard character bound', () => {
  const content =
    'unrelated '.repeat(100) +
    'American Education Week — November 16-20, 2026 — ' +
    'unrelated '.repeat(100);
  const excerpt = excerptAround(content, 'American Education Week', 300);
  expect(excerpt.text.length).toBeLessThanOrEqual(300);
  expect(excerpt.text).toContain('American Education Week');
  expect(excerpt.truncated).toBe(true);
});

describe('skill registration and policy', () => {
  const skillPath = path.join(__dirname, 'SKILL.md');
  const packagePath = path.join(__dirname, 'package.json');
  const skill = fs.readFileSync(skillPath, 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

  test('frontmatter has a single-line summary, trigger terms, and only Bash(node:*)', () => {
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter[1].match(/^summary:\s*.+$/gm)).toHaveLength(1);
    expect(frontmatter[1]).toMatch(/when is/i);
    expect(frontmatter[1]).toMatch(/state school holidays/i);
    expect(frontmatter[1]).toMatch(/education conference/i);
    expect(frontmatter[1]).toMatch(/NSPRA calendar/i);
    expect(frontmatter[1]).toContain('allowed-tools: Bash(node:*)');
  });

  test('documents coverage, both accuracy disclaimers, re-auth, and all commands', () => {
    const normalizedSkill = skill.replace(/\s+/g, ' ');
    expect(skill).toContain('January 2026');
    expect(skill).toContain('June 2027');
    expect(skill).toContain('through **2031**');
    expect(skill).toContain('verified as of November 2025');
    expect(normalizedSkill).toContain(
      'not intended to serve as the official or legal listing of holidays for each state',
    );
    expect(skill).toMatch(/connect AI Studio access/i);
    for (const command of [
      'lookup',
      'search',
      'month',
      'on',
      'state',
      'conferences',
      'holiday-years',
    ]) {
      expect(skill).toContain(command);
    }
  });

  test('declares zero npm dependencies', () => {
    expect(packageJson.dependencies).toEqual({});
  });

  test('inner implementation paths never call process.exit', () => {
    const runSource = fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8');
    const commonSource = fs.readFileSync(
      path.join(__dirname, 'common.js'),
      'utf8',
    );
    expect(runSource).not.toContain('process.exit(');
    expect(commonSource).not.toContain('process.exit(');
  });
});

afterEach(() => {
  process.exitCode = undefined;
});
