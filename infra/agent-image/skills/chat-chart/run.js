#!/usr/bin/env node
/**
 * run.js — chat-chart
 *
 * Renders a chart from a JSON data payload and emits a PSD_AGENT_RICH_V1
 * envelope wrapping a Google Chat cardsV2 image card. The Router Lambda
 * detects the envelope in the agent's reply and posts the card to Chat.
 *
 * Two engines:
 *   - `quickchart` — encode a Chart.js spec into a quickchart.io URL.
 *     No bytes leave the agent container here; the URL is what travels.
 *     But: Chat will fetch the URL on render → the chart spec (including
 *     the user's data) lives on quickchart.io's logs. Hence the PII gate.
 *   - `local` — invoke render_local.py (matplotlib via the agentcore venv)
 *     to write a PNG to a temp file, then upload to the workspace S3 bucket
 *     under `public-images/<email>/<uuid>.png` (same pattern as
 *     psd-image-gen). The unsigned URL is the image widget src.
 *
 * The inline PII regexes are intentionally narrow — they catch the
 * obvious cases (emails, US phone numbers, SSNs, PSD-format student IDs)
 * and fail safe by routing to `local`. The agent's `--sensitive` flag is
 * the load-bearing knob; the regex is backup, not policy enforcement.
 */

'use strict';

const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// NOTE: @aws-sdk/client-s3 is imported lazily inside renderLocal() because:
//   1. The local-engine path was disabled when matplotlib was removed from
//      the agent image (it tripped AgentCore's overlay snapshotter — see
//      2026-05-18 incident). Until we find a chart renderer that doesn't
//      break the snapshotter, the local engine is unreachable.
//   2. With the local path gone, the chat-chart skill no longer needs an
//      `npm install` step in the Dockerfile — and that npm install is one
//      of the things the bisect implicated. Loading the SDK only when
//      really needed lets the QuickChart path work even with no
//      node_modules present.
// When the local engine is reinstated, the require + path inside
// renderLocal() can stay exactly as-is; just put matplotlib + the chat-chart
// npm install back in the Dockerfile.

const REGION = process.env.AWS_REGION || 'us-east-1';
const WORKSPACE_BUCKET = process.env.WORKSPACE_BUCKET || '';
// Mirrors psd-image-gen's prefix — granted public s3:GetObject by the
// workspace bucket policy. Anyone with the URL can fetch.
const PUBLIC_PREFIX = 'public-images';

const RICH_ENVELOPE_OPEN = '<<<PSD_AGENT_RICH_V1>>>';
const RICH_ENVELOPE_CLOSE = '<<<END_PSD_AGENT_RICH_V1>>>';

const ALLOWED_TYPES = new Set(['bar', 'line', 'pie', 'scatter']);
const ALLOWED_ENGINES = new Set(['auto', 'quickchart', 'local']);

// Backstop detectors for the auto-engine decision. These are intentionally
// narrow: false negatives are acceptable (the agent's --sensitive flag is
// the real safety knob), but false positives waste 2-3s routing through
// matplotlib for clearly-public data.
const PII_PATTERNS = [
  { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: 'us-phone', re: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/ },
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
  // `local` never leaves the district, so an explicit request bypasses the
  // sensitivity gate below outright — it's also currently unreachable since
  // the local engine is disabled in this build (see comment below).
  if (requested === 'local') return { engine: 'local', reason: 'explicit' };
  // Local (on-host, matplotlib) engine is currently disabled in this build
  // (matplotlib + the chat-chart npm install were removed because they tripped
  // AgentCore's overlay snapshotter — see 2026-05-18 incident). QuickChart is
  // therefore the only reachable engine, and it transmits the chart data
  // (including the user's values) to the third-party quickchart.io. So both
  // `auto` and explicit `--engine quickchart` FAIL CLOSED here: refuse to
  // render anything flagged --sensitive or matching a PII pattern rather than
  // silently leaking it off-district (REV-INFRA-002). An explicit
  // `--engine quickchart` must not be usable to route around this check —
  // `local` isn't reachable anyway, so there's no legitimate reason to prefer
  // quickchart over auto for sensitive data. Genuinely public data still
  // renders via QuickChart either way. When the local engine is reinstated,
  // restore the prior routing: route to `local` if --sensitive set OR if data
  // trips detectPII(), else QuickChart.
  if (args['--sensitive']) {
    return {
      engine: 'refuse',
      reason: '--sensitive is set and the local on-host engine is disabled in ' +
              'this build, so the only available engine (QuickChart) would ' +
              'transmit the data to third-party quickchart.io. Refusing to ' +
              'render sensitive data off-district — restore the local engine ' +
              'to chart sensitive data.',
    };
  }
  const hit = detectPII(dataText);
  if (hit) {
    return {
      engine: 'refuse',
      reason: `data matched the ${hit} pattern and the local on-host engine is ` +
              'disabled in this build, so the only available engine (QuickChart) ' +
              'would transmit it to third-party quickchart.io. Refusing to render ' +
              'likely-PII off-district — pass verified-public data or restore the ' +
              'local engine.',
    };
  }
  return { engine: 'quickchart', reason: requested === 'quickchart' ? 'explicit' : 'auto: data looks public' };
}

/**
 * Build a minimal Chart.js v4 config from our normalised (type, data)
 * shape. Chart.js is what QuickChart speaks natively; matplotlib reads
 * the same input shape too so the two engines stay symmetric.
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
    for (const point of data) {
      if (typeof point.x !== 'number' || typeof point.y !== 'number') {
        fail('scatter data points need numeric `x` and `y` fields');
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
    if (typeof point.label !== 'string' || typeof point.value !== 'number') {
      fail(`${type} data points need string \`label\` and numeric \`value\` fields`);
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

async function renderLocal(config, userEmail) {
  if (!validateEmail(userEmail)) {
    fail('--user is required (valid email) when using the local engine');
  }
  if (!WORKSPACE_BUCKET) {
    fail('WORKSPACE_BUCKET env var not set — cannot upload chart for local engine');
  }

  // Lazy import — the SDK is only available when the chat-chart npm
  // install runs in the Dockerfile, which is currently disabled.
  let S3Client;
  let PutObjectCommand;
  try {
    ({ S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'));
  } catch (err) {
    fail(
      'local engine is not available in this build of the agent image — ' +
        'use --engine=quickchart instead, or rebuild the image with ' +
        'chat-chart npm install + matplotlib enabled. (cause: ' +
        (err && err.message ? err.message : err) + ')',
      3,
    );
  }

  // Hand the Chart.js config off to matplotlib via stdin. render_local.py
  // converts the (type, data) shape to a matplotlib plot and writes the
  // PNG to the path we provide.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-chart-'));
  const outPath = path.join(tmpDir, 'chart.png');
  const scriptPath = path.join(__dirname, 'render_local.py');

  const py = spawnSync('python3', [scriptPath, '--out', outPath], {
    input: JSON.stringify(config),
    encoding: 'utf8',
    timeout: 30000,
  });
  if (py.status !== 0) {
    const stderr = (py.stderr || '').slice(0, 1000);
    fail(`local renderer failed (exit ${py.status}): ${stderr}`, 3);
  }
  if (!fs.existsSync(outPath)) {
    fail(`local renderer claimed success but produced no file at ${outPath}`, 3);
  }

  const bytes = fs.readFileSync(outPath);
  // Best-effort cleanup; the temp dir lives under /tmp which is also wiped
  // on container restart.
  try { fs.unlinkSync(outPath); fs.rmdirSync(tmpDir); } catch (_) {}

  const key = `${PUBLIC_PREFIX}/${userEmail}/${randomUUID()}.png`;
  const s3 = new S3Client({ region: REGION });
  await s3.send(new PutObjectCommand({
    Bucket: WORKSPACE_BUCKET,
    Key: key,
    Body: bytes,
    ContentType: 'image/png',
    Metadata: {
      generated_by: 'chat-chart',
      engine: 'local-matplotlib',
    },
  }));
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `https://${WORKSPACE_BUCKET}.s3.${REGION}.amazonaws.com/${encodedKey}`;
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
      'Usage: chat-chart --user <email> --type bar|line|pie|scatter ' +
        '--data-json <json-array> [--title T] [--engine auto|quickchart|local] ' +
        '[--sensitive] [--text-fallback F]\n',
    );
    process.exit(0);
  }

  const type = args['--type'];
  if (!ALLOWED_TYPES.has(type)) {
    fail(`--type must be one of ${[...ALLOWED_TYPES].join(', ')}`);
  }

  const dataJson = args['--data-json'];
  if (!dataJson) fail('--data-json is required');
  let data;
  try {
    data = JSON.parse(dataJson);
  } catch (err) {
    fail(`--data-json is not valid JSON: ${err.message}`);
  }

  const { engine, reason } = chooseEngine(args, dataJson);
  if (engine === 'refuse') {
    // Fail closed: never fall through to QuickChart for sensitive/PII data
    // (REV-INFRA-002). Non-zero exit so the agent sees the chart was not made.
    fail(reason, 3);
  }
  process.stderr.write(`chat-chart: engine=${engine} (${reason})\n`);

  const config = buildChartJsConfig(type, data, args['--title']);

  let imageUrl;
  if (engine === 'quickchart') {
    imageUrl = renderQuickChart(config);
  } else {
    imageUrl = await renderLocal(config, args['--user']);
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
