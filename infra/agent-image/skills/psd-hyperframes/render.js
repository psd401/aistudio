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
const { validatedFs } = require("../../../validated-fs.cjs");

const http = require('node:http');
const AWS_RELAY_HOST = '127.0.0.1';
const AWS_RELAY_PORT = 18791;
const AWS_RELAY_PATH = '/aws-skill/hyperframes/invoke';
const MAX_RELAY_RESPONSE_BYTES = 8 * 1024 * 1024;
// Keep in sync with the render Lambda (infra/hyperframes-render/handler.js) and
// SKILL.md. Client-side checks fail fast; the Lambda re-validates authoritatively.
const MAX_DURATION_SECONDS = 180;
const MAX_FRAMES = 3600; // render-time budget: fps × duration (see handler.js)
const DEFAULT_FPS = 30;
const MIN_FPS = 1;
const MAX_FPS = 60;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const MIN_DIMENSION = 16;
const MAX_DIMENSION = 3840;
// Combined html + css + js budget. Mirrors the render Lambda's MAX_HTML_BYTES
// and keeps the JSON invoke payload under Lambda's 6 MB synchronous ceiling —
// fail fast here with an actionable message rather than an opaque invoke error.
const MAX_COMPOSITION_BYTES = 4 * 1024 * 1024;

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
  if (at <= 0 || email.includes('@', at + 1)) return false;
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  if (dot <= 0 || dot === domain.length - 1) return false;
  return true;
}

function readFileOrFail(filePath, flag) {
  try {
    return validatedFs.readFileSync(filePath, 'utf8');
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

function isAsciiLetter(character) {
  const code = character?.charCodeAt(0) ?? 0;
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isHtmlWhitespace(character) {
  return (
    character === ' ' ||
    character === '\t' ||
    character === '\n' ||
    character === '\r' ||
    character === '\f'
  );
}

function isCompositionIdAttributeAt(html, index) {
  if (html[index] !== 'd') return false;
  const target = 'data-composition-id';
  if (!html.startsWith(target, index)) return false;
  // A closing quote is also a legal boundary: browsers (and the regex this
  // scanner replaced) treat `class="x"data-composition-id` as carrying the
  // attribute even without the separating space.
  const before = html[index - 1];
  if (!isHtmlWhitespace(before) && before !== '"' && before !== "'") {
    return false;
  }
  const after = html[index + target.length];
  return (
    after === '=' ||
    after === '>' ||
    after === '/' ||
    isHtmlWhitespace(after)
  );
}

/**
 * Locate the end of the first opening tag with data-composition-id in one
 * bounded pass. Tracking quotes avoids treating attribute text or `>` inside
 * a quoted value as markup and avoids a backtracking regex on supplied HTML.
 */
function findCompositionRootOpenTagEnd(html) {
  let inOpeningTag = false;
  let quote = '';
  let hasCompositionId = false;

  for (let index = 0; index < html.length; index += 1) {
    const character = html[index];
    if (!inOpeningTag) {
      if (character === '<' && isAsciiLetter(html[index + 1])) {
        inOpeningTag = true;
        hasCompositionId = false;
      }
      continue;
    }

    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') {
      if (hasCompositionId) return index + 1;
      inOpeningTag = false;
      continue;
    }

    if (isCompositionIdAttributeAt(html, index)) hasCompositionId = true;
  }
  return -1;
}

/**
 * Insert an <audio> track as the first child of the composition root (the
 * element carrying data-composition-id) so hyperframes treats it as a timeline
 * audio clip and muxes it into the MP4. `url` is pre-validated (https/data:audio,
 * no quotes) by the caller. Falls back to before </body>, then appending, if the
 * root element cannot be located.
 */
function injectAudioElement(html, url, durationSeconds) {
  const audio =
    `<audio src="${url}" data-start="0" data-duration="${durationSeconds}" ` +
    `data-track-index="0" data-volume="1"></audio>`;
  const rootOpenEnd = findCompositionRootOpenTagEnd(html);
  if (rootOpenEnd !== -1) {
    const at = rootOpenEnd;
    return `${html.slice(0, at)}\n${audio}${html.slice(at)}`;
  }
  const bodyAt = html.toLowerCase().lastIndexOf('</body>');
  if (bodyAt !== -1) return `${html.slice(0, bodyAt)}${audio}\n${html.slice(bodyAt)}`;
  return `${html}\n${audio}`;
}

function resolveCompositionHtml(args) {
  let html;
  if (args.file && args.file !== true) {
    html = readFileOrFail(String(args.file), '--file');
  } else if (args.html && args.html !== true) {
    html = String(args.html);
  } else {
    fail(
      'Provide the composition via --file <path> or --html "<inline html>"',
      'bad_args'
    );
  }
  if (!html || html.trim().length === 0) {
    fail('Composition HTML is empty', 'bad_args');
  }
  return html;
}

function resolveOptionalSource(args, inlineName, fileName) {
  if (args[fileName] === true) {
    fail(`--${fileName.replace(/_/g, '-')} requires a file path`, 'bad_args');
  }
  if (args[fileName]) {
    return readFileOrFail(
      String(args[fileName]),
      `--${fileName.replace(/_/g, '-')}`
    );
  }
  if (args[inlineName] === true) {
    fail(`--${inlineName} requires a value`, 'bad_args');
  }
  return args[inlineName] ? String(args[inlineName]) : undefined;
}

function resolveAudioUrl(args) {
  if (args.audio_url === true) {
    fail('--audio-url requires a URL', 'bad_args');
  }
  if (!args.audio_url) return undefined;
  const url = String(args.audio_url);
  if (
    !/^https:\/\/[^\s"'<>]+$/.test(url) &&
    !/^data:audio\/[^\s"'<>]+$/i.test(url)
  ) {
    fail(
      '--audio-url must be an https:// URL or a data:audio/ URI (no spaces or quotes)',
      'bad_args'
    );
  }
  return url;
}

function validateCompositionSize(html, css, js) {
  const bytes =
    Buffer.byteLength(html, 'utf8') +
    (css ? Buffer.byteLength(css, 'utf8') : 0) +
    (js ? Buffer.byteLength(js, 'utf8') : 0);
  if (bytes > MAX_COMPOSITION_BYTES) {
    fail(
      `Composition (html+css+js) is ${bytes} bytes; the ${MAX_COMPOSITION_BYTES}-byte cap keeps the invoke under the Lambda payload limit. Trim the scene.`,
      'bad_args'
    );
  }
}

function resolveDuration(args) {
  if (args.duration === undefined || args.duration === true) {
    fail('--duration <seconds> is required', 'bad_args');
  }
  const duration = Number(args.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    fail('--duration must be a positive number of seconds', 'bad_args');
  }
  if (duration > MAX_DURATION_SECONDS) {
    fail(
      `--duration must be ${MAX_DURATION_SECONDS}s (3 min) or fewer. Split longer scenes.`,
      'bad_args'
    );
  }
  return duration;
}

function resolveFps(args, durationSeconds) {
  if (args.fps === true) fail('--fps requires a value', 'bad_args');
  const fps = args.fps ? coerceInt(args.fps, '--fps') : DEFAULT_FPS;
  if (fps < MIN_FPS || fps > MAX_FPS) {
    fail(`--fps must be between ${MIN_FPS} and ${MAX_FPS}`, 'bad_args');
  }
  const totalFrames = Math.ceil(fps * durationSeconds);
  if (totalFrames > MAX_FRAMES) {
    fail(
      `fps × duration = ${totalFrames} frames exceeds the ${MAX_FRAMES}-frame render budget. ` +
        `Use --fps ${Math.max(MIN_FPS, Math.floor(MAX_FRAMES / durationSeconds))} or fewer at ${durationSeconds}s.`,
      'bad_args'
    );
  }
  return fps;
}

function resolveDimensions(args) {
  if (args.width === true) fail('--width requires a value', 'bad_args');
  if (args.height === true) fail('--height requires a value', 'bad_args');
  const width = args.width ? coerceInt(args.width, '--width') : DEFAULT_WIDTH;
  const height = args.height
    ? coerceInt(args.height, '--height')
    : DEFAULT_HEIGHT;
  for (const [name, dimension] of [
    ['--width', width],
    ['--height', height],
  ]) {
    if (dimension < MIN_DIMENSION || dimension > MAX_DIMENSION) {
      fail(
        `${name} must be between ${MIN_DIMENSION} and ${MAX_DIMENSION}`,
        'bad_args'
      );
    }
  }
  return { width, height };
}

/**
 * Validate the CLI args and assemble the render Lambda invoke payload.
 * Every invalid input fails fast with an actionable message.
 */
function buildPayload(args) {
  if (!validateEmail(args.user)) {
    fail('--user is required and must be a valid email', 'bad_args');
  }
  let html = resolveCompositionHtml(args);
  const css = resolveOptionalSource(args, 'css', 'css_file');
  const js = resolveOptionalSource(args, 'js', 'js_file');
  const audioUrl = resolveAudioUrl(args);
  validateCompositionSize(html, css, js);
  const durationSeconds = resolveDuration(args);
  const fps = resolveFps(args, durationSeconds);
  const { width, height } = resolveDimensions(args);
  if (args.dry_run !== undefined && args.dry_run !== true) {
    fail('--dry-run is a flag and takes no value', 'bad_args');
  }
  if (audioUrl) html = injectAudioElement(html, audioUrl, durationSeconds);

  const payload = { html, durationSeconds, fps, width, height, userEmail: args.user };
  if (css) payload.css = css;
  if (js) payload.js = js;
  if (args.dry_run === true) payload.dryRun = true;
  return payload;
}

/**
 * Ask the root-owned relay to invoke the configured render Lambda. OpenClaw
 * intentionally strips AWS credential variables from model-launched exec
 * subprocesses, so this process never receives or returns reusable credentials.
 */
function requestRenderRelay(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: AWS_RELAY_HOST,
      port: AWS_RELAY_PORT,
      path: AWS_RELAY_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
      },
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RELAY_RESPONSE_BYTES) {
          request.destroy(new Error('HyperFrames relay response exceeded the configured limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode !== 200) {
          reject(new Error(`HyperFrames relay returned HTTP ${response.statusCode || 502}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('HyperFrames relay returned invalid JSON'));
        }
      });
    });
    request.setTimeout(190_000, () => {
      request.destroy(new Error('HyperFrames relay timed out'));
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function invokeRender(payload, deps = {}) {
  const relay = deps.relay || requestRenderRelay;
  let result;
  try {
    result = await relay(payload);
  } catch (err) {
    fail(`Render Lambda invocation failed: ${err instanceof Error ? err.message : String(err)}`, 'invoke_failed');
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
        '[--audio-url <https-mp3-url>] ' +
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
  findCompositionRootOpenTagEnd,
  injectAudioElement,
  invokeRender,
  requestRenderRelay,
  validateEmail,
  MAX_DURATION_SECONDS,
};
