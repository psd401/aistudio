#!/usr/bin/env node
/**
 * render.js — psd-hyperframes.render
 *
 * Thin OpenClaw skill: compose a short video by writing a HyperFrames
 * HTML/CSS/JS scene, hand it to the `hyperframes-render` Lambda (headless
 * Chromium + FFmpeg live THERE, not in this image), and return a shareable
 * public-by-link MP4 URL — same delivery + reply-format contract as
 * psd-image-gen / psd-tts (issue #1175).
 *
 * Usage:
 *   node render.js --user <email> --file <composition.html> --duration <sec>
 *                  [--html "<inline composition>"]
 *                  [--css-file <path>] [--js-file <path>]
 *                  [--fps 30] [--width 1920] [--height 1080] [--dry-run]
 *
 * Emits JSON: { url, s3Key, bytes, fps, durationSeconds, width, height, sharing }
 * On any failure emits { error, message } and exits non-zero — never a silent null.
 */

'use strict';

const fs = require('node:fs');

const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const REGION = process.env.AWS_REGION || 'us-east-1';
// Keep in sync with the render Lambda (infra/hyperframes-render/handler.js) and
// SKILL.md. Client-side checks fail fast; the Lambda re-validates authoritatively.
const MAX_DURATION_SECONDS = 60;
const DEFAULT_FPS = 30;
const MIN_FPS = 1;
const MAX_FPS = 60;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const MIN_DIMENSION = 16;
const MAX_DIMENSION = 3840;

function fail(message, code = 'error') {
  process.stderr.write(`Error: ${message}\n`);
  process.stdout.write(JSON.stringify({ error: code, message }) + '\n');
  process.exit(1);
}

function emit(obj) {
  // Pretty-print for parity with the other psd skills (psd-image-gen/psd-tts).
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// parseArgs/fail/emit/validateEmail are intentionally duplicated from
// psd-image-gen/generate.js — skills are standalone packages with no
// cross-skill require(). Keep behavior in sync with that file.
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      fail(`Unexpected positional argument: ${arg}`, 'bad_args');
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

function validateEmail(email) {
  // Linear, non-backtracking validation. A regex with overlapping `[^\s@]+`
  // groups around the dot trips CodeQL's js/polynomial-redos (ReDoS). The email
  // is interpolated into the S3 key by the render Lambda, so a `/` (or any
  // whitespace) is rejected explicitly.
  if (typeof email !== 'string' || email.length === 0 || email.length > 320) return false;
  if (email.includes('/') || /\s/.test(email)) return false;
  const at = email.indexOf('@');
  if (at <= 0 || email.indexOf('@', at + 1) !== -1) return false;
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  if (dot <= 0 || dot === domain.length - 1) return false;
  return true;
}

function readFileOrFail(filePath, flag) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    fail(`${flag} file not found or unreadable: ${filePath} (${err.message})`, 'bad_args');
    return ''; // unreachable — fail() exits
  }
}

function coerceInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    fail(`${flag} must be an integer`, 'bad_args');
  }
  return n;
}

/**
 * Validate the CLI args and assemble the render Lambda invoke payload.
 * Every invalid input fails fast with an actionable message.
 */
function buildPayload(args) {
  if (!validateEmail(args.user)) {
    fail('--user is required and must be a valid email', 'bad_args');
  }

  let html;
  if (args.file && args.file !== true) {
    html = readFileOrFail(String(args.file), '--file');
  } else if (args.html && args.html !== true) {
    html = String(args.html);
  } else {
    fail('Provide the composition via --file <path> or --html "<inline html>"', 'bad_args');
  }
  if (!html || html.trim().length === 0) {
    fail('Composition HTML is empty', 'bad_args');
  }

  let css;
  if (args.css_file && args.css_file !== true) css = readFileOrFail(String(args.css_file), '--css-file');
  else if (args.css && args.css !== true) css = String(args.css);

  let js;
  if (args.js_file && args.js_file !== true) js = readFileOrFail(String(args.js_file), '--js-file');
  else if (args.js && args.js !== true) js = String(args.js);

  if (args.duration === undefined || args.duration === true) {
    fail('--duration <seconds> is required', 'bad_args');
  }
  const durationSeconds = Number(args.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    fail('--duration must be a positive number of seconds', 'bad_args');
  }
  if (durationSeconds > MAX_DURATION_SECONDS) {
    fail(`--duration must be ${MAX_DURATION_SECONDS}s or fewer (v1 cap). Split longer scenes.`, 'bad_args');
  }

  const fps = args.fps && args.fps !== true ? coerceInt(args.fps, '--fps') : DEFAULT_FPS;
  if (fps < MIN_FPS || fps > MAX_FPS) {
    fail(`--fps must be between ${MIN_FPS} and ${MAX_FPS}`, 'bad_args');
  }

  const width = args.width && args.width !== true ? coerceInt(args.width, '--width') : DEFAULT_WIDTH;
  const height = args.height && args.height !== true ? coerceInt(args.height, '--height') : DEFAULT_HEIGHT;
  for (const [name, dim] of [['--width', width], ['--height', height]]) {
    if (dim < MIN_DIMENSION || dim > MAX_DIMENSION) {
      fail(`${name} must be between ${MIN_DIMENSION} and ${MAX_DIMENSION}`, 'bad_args');
    }
  }

  const payload = { html, durationSeconds, fps, width, height, userEmail: args.user };
  if (css) payload.css = css;
  if (js) payload.js = js;
  if (args.dry_run === true) payload.dryRun = true;
  return payload;
}

/**
 * Invoke the render Lambda synchronously and return its parsed result.
 * `deps.client` is a test seam; production leaves it unset.
 */
async function invokeRender(payload, deps = {}) {
  const functionName = process.env.HYPERFRAMES_RENDER_FUNCTION;
  if (!functionName) {
    fail(
      'HYPERFRAMES_RENDER_FUNCTION env var not set — the render Lambda name is injected by the agent runtime. Ask an administrator to redeploy the agent platform.',
      'misconfigured',
    );
  }

  const client = deps.client || new LambdaClient({ region: REGION });
  let resp;
  try {
    resp = await client.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(payload), 'utf8'),
    }));
  } catch (err) {
    fail(`Render Lambda invocation failed: ${err instanceof Error ? err.message : String(err)}`, 'invoke_failed');
  }

  const raw = resp.Payload ? Buffer.from(resp.Payload).toString('utf8') : '';

  // Unhandled Lambda exception (the handler catches its own errors, so this is
  // an infra-level failure — OOM, timeout kill, cold-start crash).
  if (resp.FunctionError) {
    fail(`Render Lambda failed (${resp.FunctionError}): ${raw.slice(0, 600)}`, 'render_failed');
  }

  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    fail(`Render Lambda returned non-JSON output: ${raw.slice(0, 300)}`, 'render_failed');
  }

  if (!result || result.status !== 'ok') {
    const code = (result && result.error) || 'render_failed';
    const message = (result && result.message) || 'Render failed with no message.';
    fail(message, code);
  }
  return result;
}

async function main(argv = process.argv, deps = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      'Usage: render.js --user <email> --file <composition.html> --duration <sec> ' +
        '[--html "<inline>"] [--css-file <path>] [--js-file <path>] ' +
        '[--fps 30] [--width 1920] [--height 1080] [--dry-run]\n',
    );
    process.exit(0);
  }

  const payload = buildPayload(args);
  const result = await invokeRender(payload, deps);

  emit({
    url: result.url,
    s3Key: result.s3Key,
    bytes: result.bytes,
    fps: result.fps,
    durationSeconds: result.durationSeconds,
    width: result.width,
    height: result.height,
    sharing: result.sharing || 'public-by-link',
    ...(result.dryRun ? { dryRun: true, localPath: result.localPath } : {}),
  });
}

if (require.main === module) {
  main().catch((err) => {
    fail(err instanceof Error ? err.message : String(err), 'error');
  });
}

module.exports = {
  main,
  parseArgs,
  buildPayload,
  invokeRender,
  validateEmail,
  MAX_DURATION_SECONDS,
};
