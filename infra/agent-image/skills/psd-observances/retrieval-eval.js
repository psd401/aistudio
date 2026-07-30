#!/usr/bin/env node
/**
 * Live retrieval-quality gate for the NSPRA observances repository.
 *
 * The runner exercises the real psd-observances command boundary while keeping
 * raw repository excerpts in memory. Its persisted output contains only
 * question ids, expected fact names/dates, page numbers, and aggregate scores.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { main: runSkill } = require('./run');
const { parseToolEnvelope } = require('./common');

const DEFAULT_FIXTURE = path.join(
  __dirname,
  'evals',
  'retrieval-cases.json',
);
const DEFAULT_API_KEY_ENV = 'PSD_OBSERVANCES_EVAL_API_KEY';
const CLASS_A_THRESHOLD = 0.9;
const CLASS_B_THRESHOLD = 0.8;
const MCP_PROTOCOL_VERSION = '2024-11-05';
const OPTION_NAMES = new Set([
  'environment',
  'base-url',
  'fixture',
  'api-key-env',
  'out',
]);
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'in',
  'of',
  'on',
  'the',
]);

const USAGE = `psd-observances live retrieval evaluation

Usage:
  node retrieval-eval.js \\
    --environment <name> \\
    --base-url <https://environment.example> \\
    [--fixture <path>] \\
    [--api-key-env <environment-variable>] \\
    [--out <sanitized-report.json>]

The API key is read only from an environment variable and is never accepted on
the command line or written to the report. The key needs repositories:list,
repositories:read, and repositories:search.`;

function fail(message) {
  throw new Error(message);
}

function parseOptionTokens(argv) {
  const options = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      return { help: true, options };
    }
    if (!token.startsWith('--')) fail(`Unexpected argument: ${token}`);
    if (token.includes('=')) {
      fail(`Use "${token.split('=')[0]} <value>" instead of equals syntax.`);
    }
    const key = token.slice(2);
    if (!OPTION_NAMES.has(key)) fail(`Unknown flag: --${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`--${key} requires a value`);
    options[key] = value;
    index += 1;
  }
  return { help: false, options };
}

function parseBaseUrl(value) {
  if (!value) fail('--base-url is required');
  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(value);
  } catch {
    fail('--base-url must be a valid URL');
  }
  const localHost =
    parsedBaseUrl.hostname === 'localhost' ||
    parsedBaseUrl.hostname === '127.0.0.1';
  if (parsedBaseUrl.protocol !== 'https:' && !localHost) {
    fail('--base-url must use HTTPS unless it targets localhost');
  }
  return parsedBaseUrl.origin;
}

function parseArgs(argv) {
  const parsed = parseOptionTokens(argv);
  if (parsed.help) return { help: true };
  const { options } = parsed;
  const environment = options.environment?.trim();
  if (!environment) fail('--environment is required');

  return {
    help: false,
    environment,
    baseUrl: parseBaseUrl(options['base-url']?.trim()),
    fixture: path.resolve(options.fixture || DEFAULT_FIXTURE),
    apiKeyEnv: options['api-key-env'] || DEFAULT_API_KEY_ENV,
    out: options.out ? path.resolve(options.out) : undefined,
  };
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateFact(questionId, fact) {
  if (
    !fact ||
    typeof fact.name !== 'string' ||
    typeof fact.date !== 'string' ||
    !Array.isArray(fact.pages) ||
    fact.pages.length === 0 ||
    fact.pages.some((page) => !isPositiveInteger(page))
  ) {
    fail(`Question ${questionId} has an invalid expected fact`);
  }
}

function validateQuestion(question) {
  if (
    !question ||
    typeof question.id !== 'string' ||
    !['A', 'B'].includes(question.class) ||
    typeof question.question !== 'string' ||
    !Array.isArray(question.argv) ||
    question.argv.some((value) => typeof value !== 'string') ||
    !Array.isArray(question.expected) ||
    question.expected.length === 0
  ) {
    fail('Every retrieval question needs id, class, question, argv, and facts');
  }
  for (const fact of question.expected) {
    validateFact(question.id, fact);
  }
}

function loadFixture(fixturePath) {
  // The operator-selected local fixture path is the purpose of --fixture.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  if (
    !fixture ||
    fixture.version !== 1 ||
    typeof fixture.publication !== 'string' ||
    !Array.isArray(fixture.questions)
  ) {
    fail('Retrieval fixture has an unsupported shape');
  }
  const ids = new Set();
  for (const question of fixture.questions) {
    validateQuestion(question);
    if (ids.has(question.id)) fail(`Duplicate question id: ${question.id}`);
    ids.add(question.id);
  }
  if (
    !fixture.questions.some((question) => question.class === 'A') ||
    !fixture.questions.some((question) => question.class === 'B')
  ) {
    fail('Retrieval fixture needs at least one Class A and Class B question');
  }
  return fixture;
}

function normalizeText(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()
    .replace(/\b(january|jan)\b/g, 'jan')
    .replace(/\b(february|feb)\b/g, 'feb')
    .replace(/\b(march|mar)\b/g, 'mar')
    .replace(/\b(april|apr)\b/g, 'apr')
    .replace(/\b(june|jun)\b/g, 'jun')
    .replace(/\b(july|jul)\b/g, 'jul')
    .replace(/\b(august|aug)\b/g, 'aug')
    .replace(/\b(september|sept|sep)\b/g, 'sep')
    .replace(/\b(october|oct)\b/g, 'oct')
    .replace(/\b(november|nov)\b/g, 'nov')
    .replace(/\b(december|dec)\b/g, 'dec')
    .replace(/\bfollowing\b/g, 'after')
    .replace(/\bimmediately\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function factTokens(fact) {
  return normalizeText(`${fact.name} ${fact.date}`)
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !STOP_WORDS.has(token));
}

function resultTokens(result) {
  return new Set(
    normalizeText(result.excerpt)
      .split(/\s+/)
      .filter(Boolean),
  );
}

function citationPages(result) {
  const page = Number(result?.citation?.page);
  const pageEnd = Number(result?.citation?.pageEnd);
  if (!isPositiveInteger(page)) return [];
  const end = isPositiveInteger(pageEnd) && pageEnd >= page ? pageEnd : page;
  return Array.from({ length: end - page + 1 }, (_, index) => page + index);
}

function scoreFact(fact, preparedResults) {
  const required = factTokens(fact);
  const matches = preparedResults.filter(({ tokens }) =>
    required.every((token) => tokens.has(token)),
  );
  const correctlyCited = matches.find(({ pages }) =>
    pages.some((page) => fact.pages.includes(page)),
  );
  const selected = correctlyCited || matches[0];
  return {
    name: fact.name,
    date: fact.date,
    expectedPages: fact.pages,
    matched: Boolean(selected),
    citationCorrect: Boolean(correctlyCited),
    returnedPages: selected?.pages ?? [],
  };
}

function scoreQuestion(question, skillResult, durationMs) {
  const preparedResults = skillResult.results.map((result) => ({
    tokens: resultTokens(result),
    pages: citationPages(result),
  }));
  const returnedPages = [
    ...new Set(preparedResults.flatMap((result) => result.pages)),
  ].sort((left, right) => left - right);
  const facts = question.expected.map((fact) =>
    scoreFact(fact, preparedResults),
  );
  const matchedFacts = facts.filter((fact) => fact.matched).length;
  const correctlyCitedFacts = facts.filter(
    (fact) => fact.citationCorrect,
  ).length;
  return {
    id: question.id,
    class: question.class,
    question: question.question,
    expectedFactCount: facts.length,
    matchedFactCount: matchedFacts,
    correctlyCitedFactCount: correctlyCitedFacts,
    recall: matchedFacts / facts.length,
    citationCorrectness: correctlyCitedFacts / facts.length,
    correct: matchedFacts === facts.length,
    returnedResultCount: skillResult.results.length,
    returnedPages,
    durationMs,
    facts,
  };
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return { payload: null, rawText: '' };
  try {
    return { payload: JSON.parse(text), rawText: '' };
  } catch {
    return { payload: null, rawText: text.slice(0, 512) };
  }
}

function createLiveMcpClient(baseUrl, apiKey) {
  const endpoint = new URL('/api/mcp', baseUrl);
  async function call(method, params) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method,
        params,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(180_000),
    });
    const parsed = await readJsonResponse(response);
    return {
      httpStatus: response.status,
      payload: parsed.payload,
      rawText: parsed.rawText,
    };
  }

  return {
    callTool: async (name, args) => {
      const response = await call('tools/call', { name, arguments: args });
      return parseToolEnvelope(response, name);
    },
    requestAgentBroker: async (route, body) => {
      if (route !== '/api/agent/aistudio') {
        fail(`Unexpected broker route: ${route}`);
      }
      return call(body.method, body.params);
    },
  };
}

// Keep this rule aligned with run.js:createRepositoryResolver so the
// preflight and every skill invocation select the same live repository.
function selectRepository(payload) {
  const matches = (payload?.repositories ?? [])
    .filter(
      (repository) =>
        isPositiveInteger(repository?.id) &&
        typeof repository.name === 'string' &&
        /nspra/i.test(repository.name),
    )
    .sort((left, right) => {
      const leftPreferred = /2026/i.test(left.name) ? 0 : 1;
      const rightPreferred = /2026/i.test(right.name) ? 0 : 1;
      return leftPreferred - rightPreferred || left.id - right.id;
    });
  if (matches.length === 0) fail('No accessible NSPRA repository was found');
  const selected = matches[0];
  return {
    id: selected.id,
    name: selected.name,
    visibility: selected.visibility,
    itemCount: selected.itemCount,
    activeIndexGenerationId: selected.activeIndexGenerationId,
    lastUpdated: selected.lastUpdated,
  };
}

async function invokeQuestion(question, requestAgentBroker) {
  let stdout = '';
  let stderr = '';
  const startedAt = Date.now();
  const exitCode = await runSkill(
    [...question.argv, '--limit', '50', '--full', '--json'],
    { requestAgentBroker },
    {
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
    },
  );
  const durationMs = Date.now() - startedAt;
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    fail(`Question ${question.id} returned non-JSON output`);
  }
  if (exitCode !== 0 || result.status !== 'ok') {
    fail(
      `Question ${question.id} failed: ${
        result.message || stderr.trim() || `exit ${exitCode}`
      }`,
    );
  }
  return { result, durationMs };
}

function sum(cases, field) {
  return cases.reduce((total, result) => total + result[field], 0);
}

function aggregate(cases) {
  const classA = cases.filter((result) => result.class === 'A');
  const classB = cases.filter((result) => result.class === 'B');
  const classACorrect = classA.filter((result) => result.correct).length;
  const classBExpected = sum(classB, 'expectedFactCount');
  const classBMatched = sum(classB, 'matchedFactCount');
  const allExpected = sum(cases, 'expectedFactCount');
  const allCited = sum(cases, 'correctlyCitedFactCount');
  const classAAccuracy = classACorrect / classA.length;
  const classBRecall = classBMatched / classBExpected;
  const citationCorrectness = allCited / allExpected;
  let decision;
  if (classAAccuracy < CLASS_A_THRESHOLD) {
    decision = {
      outcome: 'investigate_named_retrieval',
      markdownRegenerationNeeded: null,
      reason:
        'Class A is below 90%; investigate ingest or retrieval before deciding on chunk regeneration.',
    };
  } else if (classBRecall < CLASS_B_THRESHOLD) {
    decision = {
      outcome: 'structured_markdown_needed',
      markdownRegenerationNeeded: true,
      reason:
        'Class A passed, but Class B recall is below 80%; proceed with structured-markdown regeneration.',
    };
  } else {
    decision = {
      outcome: 'direct_pdf_sufficient',
      markdownRegenerationNeeded: false,
      reason:
        'Class A accuracy is at least 90% and Class B recall is at least 80%.',
    };
  }
  return {
    classA: {
      questionCount: classA.length,
      correctQuestionCount: classACorrect,
      accuracy: classAAccuracy,
      threshold: CLASS_A_THRESHOLD,
      passed: classAAccuracy >= CLASS_A_THRESHOLD,
    },
    classB: {
      questionCount: classB.length,
      expectedFactCount: classBExpected,
      matchedFactCount: classBMatched,
      recall: classBRecall,
      threshold: CLASS_B_THRESHOLD,
      passed: classBRecall >= CLASS_B_THRESHOLD,
    },
    citations: {
      expectedFactCount: allExpected,
      correctlyCitedFactCount: allCited,
      correctness: citationCorrectness,
    },
    decision,
  };
}

async function runEvaluation(options, io = process.stderr) {
  const fixture = loadFixture(options.fixture);
  const apiKey = process.env[options.apiKeyEnv];
  if (!apiKey) {
    fail(`Environment variable ${options.apiKeyEnv} is required`);
  }
  if (!/^sk-[0-9a-f]{64}$/.test(apiKey)) {
    fail(`Environment variable ${options.apiKeyEnv} is not an API key`);
  }
  const client = createLiveMcpClient(options.baseUrl, apiKey);
  const startedAt = new Date();
  const repository = selectRepository(
    await client.callTool('repositories_list', { query: 'NSPRA', limit: 50 }),
  );
  const cases = [];
  for (const question of fixture.questions) {
    const invocation = await invokeQuestion(
      question,
      client.requestAgentBroker,
    );
    if (invocation.result.repository.id !== repository.id) {
      fail(`Question ${question.id} selected a different repository`);
    }
    const scored = scoreQuestion(
      question,
      invocation.result,
      invocation.durationMs,
    );
    cases.push(scored);
    io.write(
      `${question.id}: ${scored.matchedFactCount}/${scored.expectedFactCount} facts, ` +
        `${scored.correctlyCitedFactCount}/${scored.expectedFactCount} cited\n`,
    );
  }
  const completedAt = new Date();
  return {
    schemaVersion: 1,
    publication: fixture.publication,
    fixtureVersion: fixture.version,
    environment: options.environment,
    baseUrl: options.baseUrl,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    repository,
    ...aggregate(cases),
    cases,
  };
}

async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const report = await runEvaluation(options);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.out) {
      // --out intentionally selects a local, sanitized report destination.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.writeFileSync(options.out, serialized, {
        encoding: 'utf8',
        mode: 0o600,
      });
      process.stdout.write(
        `${JSON.stringify({
          status: 'completed',
          out: options.out,
          classAAccuracy: report.classA.accuracy,
          classBRecall: report.classB.recall,
          citationCorrectness: report.citations.correctness,
          outcome: report.decision.outcome,
        })}\n`,
      );
    } else {
      process.stdout.write(serialized);
    }
    return 0;
  } catch (error) {
    process.stderr.write(
      `psd-observances retrieval eval: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  CLASS_A_THRESHOLD,
  CLASS_B_THRESHOLD,
  USAGE,
  aggregate,
  citationPages,
  factTokens,
  loadFixture,
  main,
  normalizeText,
  parseArgs,
  scoreFact,
  scoreQuestion,
  selectRepository,
};
