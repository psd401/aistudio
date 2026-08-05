#!/usr/bin/env node

/**
 * run.js — chat-chart
 *
 * Renders a chart from a JSON data payload and emits a PSD_AGENT_RICH_V1
 * envelope wrapping a Google Chat cardsV2 image card. The Router Lambda
 * detects the envelope in the agent's reply and posts the card to Chat.
 *
 * Two engines:
 *   - `local` (default) — rasterise the chart in-process with
 *     render_local.js and upload the PNG through the agent broker. The
 *     data never leaves PSD AWS. Zero npm/pip dependencies, so it adds no
 *     Docker layer (issue #1596 — see render_local.js for why the previous
 *     matplotlib implementation had to go).
 *   - `quickchart` — encode a Chart.js spec into a quickchart.io URL.
 *     No bytes leave the agent container here; the URL is what travels.
 *     But: Chat will fetch the URL on render → the chart spec (including
 *     the user's data) lives on quickchart.io's logs. Hence the PII gate:
 *     this engine only runs when it is asked for BY NAME and the data is
 *     neither flagged --sensitive nor matching a PII pattern.
 *
 * The inline PII regexes are intentionally narrow — they catch the
 * obvious cases (emails, US phone numbers, SSNs, PSD-format student IDs)
 * and fail safe by refusing to hand the data to QuickChart. The agent's
 * `--sensitive` flag is the load-bearing knob; the regex is backup, not
 * policy enforcement. Neither is needed for the default path: `auto`
 * renders locally regardless of what the data contains.
 */

'use strict';

const { randomUUID } = require('node:crypto');
const { publishArtifact } = require('../_shared/artifact-publisher');
const { renderChartPng } = require('./render_local');

const RICH_ENVELOPE_OPEN = '<<<PSD_AGENT_RICH_V1>>>';
const RICH_ENVELOPE_CLOSE = '<<<END_PSD_AGENT_RICH_V1>>>';

const ALLOWED_TYPES = new Set(['bar', 'line', 'pie', 'scatter']);
const ALLOWED_ENGINES = new Set(['auto', 'quickchart', 'local']);

// Backstop detectors for the QuickChart gate. These are intentionally
// narrow: false negatives are acceptable (the agent's --sensitive flag is
// the real safety knob), and a false positive costs nothing worse than
// rendering on-host, which is where charts go by default anyway.
//
// Every quantifier is bounded. The email pattern's two character classes
// both contain `.`, so unbounded `+`s backtrack quadratically: a single
// 60KB label took 5s of CPU to reject, and argv allows twice that.
const PII_PATTERNS = [
  { name: 'email', re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,4}\.[A-Za-z]{2,24}/ },
  { name: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: 'us-phone', re: /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/ },
  { name: 'us-phone', re: /\(\d{3}\)\s\d{3}-\d{4}\b/ },
  { name: 'us-phone', re: /\b1[-.\s]\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/ },
  { name: 'us-phone', re: /\b1\d{10}\b/ },
  // PSD student IDs: 7 digits starting with 2. Matches the convention used
  // by lib/safety/types.ts in the Next.js app.
  { name: 'psd-student-id', re: /\b2\d{6}\b/ },
];

function fail(message, code = 2) {
  process.stderr.write(`chat-chart: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const known = new Set([
    '--user',
    '--type',
    '--data-json',
    '--title',
    '--engine',
    '--sensitive',
    '--text-fallback',
    '--help',
    '-h',
  ]);
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--') && tok !== '-h') {
      fail(`unexpected positional argument: ${tok}`);
    }
    if (!known.has(tok)) {
      fail(`unknown flag: ${tok}`);
    }
    if (tok === '--sensitive' || tok === '--help' || tok === '-h') {
      args[tok] = true;
      continue;
    }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) {
      fail(`flag ${tok} requires a value`);
    }
    args[tok] = val;
    i++;
  }
  return args;
}

function validateEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function detectPII(text) {
  for (const { name, re } of PII_PATTERNS) {
    if (re.test(text)) return name;
  }
  return null;
}

function chooseEngine(args, dataText) {
  const requested = args['--engine'] || 'auto';
  if (!ALLOWED_ENGINES.has(requested)) {
    fail(`--engine must be one of ${[...ALLOWED_ENGINES].join(', ')}`);
  }
  // The on-host engine never leaves the district and costs ~100ms, so it is
  // both the explicit choice and the default: `auto` no longer weighs the
  // data's sensitivity at all, because there is nothing to weigh it against.
  // That is the fix for #1596 — sensitive/student data charts normally
  // instead of hitting a hard refusal.
  if (requested === 'local') return { engine: 'local', reason: 'explicit' };
  if (requested === 'auto') {
    return { engine: 'local', reason: 'auto: on-host engine, data stays in PSD AWS' };
  }
  // QuickChart transmits the chart spec (including the user's values) to
  // third-party quickchart.io, so it stays FAIL CLOSED (REV-INFRA-002):
  // asking for it by name is not a way around the sensitivity gate. Rerun
  // without `--engine quickchart` to render the same chart locally.
  if (args['--sensitive']) {
    return {
      engine: 'refuse',
      reason: '--sensitive is set and --engine quickchart would transmit the ' +
              'data to third-party quickchart.io. Refusing to render sensitive ' +
              'data off-district — drop --engine quickchart to render it on-host.',
    };
  }
  const hit = detectPII(dataText);
  if (hit) {
    return {
      engine: 'refuse',
      reason: `data matched the ${hit} pattern and --engine quickchart would ` +
              'transmit it to third-party quickchart.io. Refusing to render ' +
              'likely-PII off-district — drop --engine quickchart to render it ' +
              'on-host.',
    };
  }
  return { engine: 'quickchart', reason: 'explicit' };
}

/**
 * Build a minimal Chart.js v4 config from our normalised (type, data)
 * shape. Chart.js is what QuickChart speaks natively; render_local.js
 * reads the same shape so the two engines stay symmetric.
 */
function buildChartJsConfig(type, data, title) {
  if (!Array.isArray(data) || data.length === 0) {
    fail('--data-json must be a non-empty array');
  }

  // Dataset label. Without one, Chart.js renders the legend chip as
  // "undefined" — ugly. We try the title, then a type-derived default.
  // QuickChart's default Chart.js version honours `dataset.label` for the
  // legend; suppressing the legend entirely via plugins.legend.display=false
  // didn't take effect on QuickChart's renderer, so we work WITH the legend
  // rather than against it.
  const seriesLabel = title || `${type[0].toUpperCase()}${type.slice(1)}`;

  // Title (suptitle above the plot) lives at the plugins level. Setting it
  // alongside legend label gives a clear two-piece header.
  const options = title
    ? { plugins: { title: { display: true, text: title } } }
    : {};

  if (type === 'scatter') {
    // Number.isFinite, not typeof: JSON.parse turns 1e999 into Infinity,
    // which is typeof 'number' and would serialise into the QuickChart URL
    // as `null`.
    for (const point of data) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        fail('scatter data points need finite numeric `x` and `y` fields');
      }
    }
    return {
      type: 'scatter',
      data: {
        datasets: [{ label: seriesLabel, data: data.map(p => ({ x: p.x, y: p.y })) }],
      },
      options,
    };
  }

  // bar / line / pie
  for (const point of data) {
    if (typeof point.label !== 'string' || !Number.isFinite(point.value)) {
      fail(`${type} data points need string \`label\` and finite numeric \`value\` fields`);
    }
  }
  const labels = data.map(p => p.label);
  const values = data.map(p => p.value);
  return {
    type,
    data: {
      labels,
      datasets: [{ label: seriesLabel, data: values }],
    },
    options,
  };
}

function renderQuickChart(config) {
  // QuickChart accepts the config as a URL query param. Plain encoding
  // keeps the URL human-readable when it ends up in logs. There's a
  // 16KB practical URL ceiling; for our 50-point limit we're far under.
  const encoded = encodeURIComponent(JSON.stringify(config));
  return `https://quickchart.io/chart?c=${encoded}&format=png&backgroundColor=white`;
}

async function renderLocal(config) {
  // `--user` is accepted for call-site compatibility and provenance only
  // (main() validates it): the broker derives the storage path from the
  // calling agent's identity, so the email is not used to build a key.
  // Rasterised in-process — no subprocess, no temp file, no dependency.
  let bytes;
  try {
    bytes = renderChartPng(config);
  } catch (err) {
    fail(`local renderer failed: ${err && err.message ? err.message : err}`, 3);
  }
  const published = await publishArtifact(bytes, '.png', 'image/png');
  return published.url;
}

function emitEnvelope(imageUrl, title, textFallback, type) {
  const widgets = [{ image: { imageUrl } }];
  const card = {};
  if (title) {
    card.header = { title };
  }
  card.sections = [{ widgets }];
  const envelope = {
    cardsV2: [{ cardId: `chart-${randomUUID()}`, card }],
  };
  // textFallback becomes the message's `text` field — Chat uses it for the
  // notification preview ("PSD AI Agent: <text>") and any client that
  // can't render cards. Always populate it so users never see the
  // generic "Rich response" Router-side fallback.
  envelope.textFallback = textFallback || (title ? `Chart: ${title}` : `${type} chart`);
  return `${RICH_ENVELOPE_OPEN}\n${JSON.stringify(envelope)}\n${RICH_ENVELOPE_CLOSE}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args['--help'] || args['-h']) {
    process.stdout.write(
      'Usage: chat-chart --type bar|line|pie|scatter --data-json <json-array> ' +
        '[--user <email>] [--title T] [--engine auto|quickchart|local] ' +
        '[--sensitive] [--text-fallback F]\n' +
        'Default engine: local (renders on-host; data stays in PSD AWS).\n',
    );
    process.exit(0);
  }

  const type = args['--type'];
  if (!ALLOWED_TYPES.has(type)) {
    fail(`--type must be one of ${[...ALLOWED_TYPES].join(', ')}`);
  }

  // Validated for every engine, not just the one that consumes it: SKILL.md
  // promises a malformed --user is an error, and silently accepting a typo on
  // the quickchart path would make that promise engine-dependent.
  if (args['--user'] !== undefined && !validateEmail(args['--user'])) {
    fail('--user must be a valid email address');
  }

  const dataJson = args['--data-json'];
  if (!dataJson) fail('--data-json is required');
  let data;
  try {
    data = JSON.parse(dataJson);
  } catch (err) {
    fail(`--data-json is not valid JSON: ${err.message}`);
  }

  // Build the config BEFORE choosing an engine, and scan the config rather
  // than the raw argv. The serialised config is what QuickChart would
  // actually receive, so it is the only text worth gating on: raw argv can
  // hide `jsmith@psd401.net` from the regex until JSON.parse restores
  // it, and it omits --title entirely even though the title is embedded in
  // the QuickChart URL twice.
  const config = buildChartJsConfig(type, data, args['--title']);

  const { engine, reason } = chooseEngine(args, JSON.stringify(config));
  if (engine === 'refuse') {
    // Fail closed: an explicit --engine quickchart never carries sensitive or
    // PII data off-district (REV-INFRA-002), and we do not silently downgrade
    // to the local engine either — the caller named an engine, so tell them
    // why it was not used. Non-zero exit so the agent sees no chart was made.
    fail(reason, 3);
  }
  process.stderr.write(`chat-chart: engine=${engine} (${reason})\n`);

  let imageUrl;
  if (engine === 'quickchart') {
    imageUrl = renderQuickChart(config);
  } else {
    imageUrl = await renderLocal(config);
  }

  // First line of stdout: the URL alone, useful if the agent wants to
  // mention or compose with it (see chat-chart + chat-card example in
  // SKILL.md). Then the envelope on its own block.
  process.stdout.write(`${imageUrl}\n`);
  process.stdout.write(emitEnvelope(imageUrl, args['--title'], args['--text-fallback'], type));
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`chat-chart: unexpected error: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  });
}

// Exported for unit tests (run.test.js). Requiring this module does not run
// main() thanks to the require.main guard above.
module.exports = { chooseEngine, detectPII, buildChartJsConfig, renderQuickChart };
