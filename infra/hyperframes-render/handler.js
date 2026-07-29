'use strict';
const { validatedFs } = require("../validated-fs.cjs");


/**
 * hyperframes-render — AWS Lambda handler (container image).
 *
 * Renders a self-contained HyperFrames HTML/CSS/JS composition to an MP4
 * using the upstream `hyperframes` CLI (headless Chromium + FFmpeg, both
 * bundled in the container image — see ./Dockerfile), then uploads the
 * result to the agent workspace S3 bucket under the public `public-images/`
 * prefix and returns an unsigned, shareable HTTPS URL.
 *
 * This is the render half of the `psd-hyperframes` OpenClaw agent skill
 * (issue #1175). Chromium/FFmpeg live HERE, never in the agent image — the
 * AgentCore Firecracker overlay-mount snapshotter cannot carry that native
 * stack (see infra/agent-image/Dockerfile). The thin agent skill sends a
 * bounded request to the root-owned direct-AWS relay, which invokes this
 * function synchronously without exposing reusable execution-role credentials
 * to the model-facing subprocess.
 *
 * Event contract (RequestResponse invoke):
 *   {
 *     "html":            "<!doctype html>…",   // required — full composition
 *     "css":             "…",                   // optional — injected before </head>
 *     "js":              "…",                   // optional — injected before </body>
 *     "durationSeconds": 8,                     // required — cap-validated (<= 180)
 *     "fps":             30,                     // optional — default 30, 1..60
 *     "width":           1920,                   // optional — metadata + cap check
 *     "height":          1080,                   // optional — metadata + cap check
 *     "userEmail":       "person@psd401.net",   // required — scopes the S3 key
 *     "dryRun":          false                   // optional — render but skip S3 upload
 *   }
 *
 * Success result:
 *   { "status":"ok", "url":"https://…/public-images/<email>/<uuid>.mp4",
 *     "s3Key":"public-images/<email>/<uuid>.mp4", "bytes":N, "fps":30,
 *     "durationSeconds":8, "width":1920, "height":1080, "sharing":"public-by-link" }
 *
 * Error result (never throws a bare string / silent null):
 *   { "status":"error", "error":"<code>", "message":"<actionable text>" }
 */

const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const execFileAsync = promisify(execFile);

// ── Caps (v1). Documented in psd-hyperframes/SKILL.md — keep in sync. ─────────
// A synchronous invoke has to fit inside the Lambda timeout AND the agent turn.
// Render time scales with the FRAME COUNT (each frame = one headless screenshot),
// so the real ceiling is frames, not seconds: `fps × duration ≤ MAX_FRAMES`.
// MAX_FRAMES = 3600 is the proven budget (the former 60s × 60fps ceiling) that
// fits inside RENDER_TIMEOUT_MS. Duration may now run up to 3 minutes, but a
// longer scene must use a lower fps to stay within the same frame budget
// (e.g. 180s at 20fps = 3600 frames — same render cost as 60s at 60fps).
const MAX_DURATION_SECONDS = 180;
const MAX_FRAMES = 3600;
const DEFAULT_FPS = 30;
const MIN_FPS = 1;
const MAX_FPS = 60;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const MIN_DIMENSION = 16;
const MAX_DIMENSION = 3840; // 4K wide — supersampling above this blows the /tmp + memory budget.
// A composition is HTML + inline CSS/JS. 4 MB is generous headroom over any
// hand-authored scene while bounding the Lambda invoke payload (max 6 MB sync).
const MAX_HTML_BYTES = 4 * 1024 * 1024;

const PUBLIC_PREFIX = 'public-images';
const REGION = process.env.AWS_REGION || 'us-east-1';
const HYPERFRAMES_BIN = process.env.HYPERFRAMES_BIN || 'hyperframes';
// Under the Lambda timeout so a stuck render surfaces a clean `render_timeout`
// instead of an opaque Lambda `Task timed out` kill. The CDK construct injects
// this with 180 s of headroom (720 s for a 900 s Lambda) so the clean timeout
// also fires before the enclosing ~840 s agent-turn transport budget aborts.
const RENDER_TIMEOUT_MS = Number(process.env.HYPERFRAMES_RENDER_TIMEOUT_MS) || 720_000;
// Each worker launches a separate Chrome (~256 MB). Keep conservative so the
// render fits the Lambda memory budget; overridable per deployment.
const RENDER_WORKERS = process.env.HYPERFRAMES_WORKERS || '2';
// hyperframes render can be chatty on stdout/stderr; give execFile room.
const RENDER_MAX_BUFFER = 32 * 1024 * 1024;

// AWS Lambda injects live temporary credentials (access key / secret / session
// token) into the function process env. The render subprocess (hyperframes ->
// headless Chromium) executes untrusted, model-authored HTML/CSS/JS and never
// makes AWS calls itself — the S3 upload runs in THIS Node process, not the
// child — so those credentials must not be handed to it. Everything else the
// renderer needs (PATH, HOME, PUPPETEER_*, PRODUCER_HEADLESS_SHELL_PATH,
// CONTAINER, locale, …) passes through untouched.
const CREDENTIAL_ENV_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
];

/** Clone `env` with the AWS credential keys removed, for the render subprocess. */
function childEnvWithoutCredentials(env = process.env) {
  const clone = { ...env };
  for (const key of CREDENTIAL_ENV_KEYS) delete clone[key];
  return clone;
}

/**
 * Typed error carrying a machine-readable `code`. The handler catches these
 * and returns `{ status:'error', error:code, message }` so the calling skill
 * can surface an actionable message rather than a stack trace.
 */
class RenderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
  }
}

let cachedS3Client = null;
function getS3Client() {
  if (!cachedS3Client) cachedS3Client = new S3Client({ region: REGION });
  return cachedS3Client;
}

/**
 * Email validation mirrors psd-image-gen/generate.js:validateEmail. The email
 * is interpolated into the S3 key (`public-images/<email>/<uuid>.mp4`), so a
 * `/` would create an unexpected key prefix — reject it explicitly.
 */
function validateEmail(email) {
  // Linear, non-backtracking validation. A regex with overlapping `[^\s@]+`
  // groups around the dot trips CodeQL's js/polynomial-redos (ReDoS). The email
  // is interpolated into the S3 key (`public-images/<email>/<uuid>.mp4`), so a
  // `/` (or any whitespace) is rejected explicitly.
  if (typeof email !== 'string' || email.length === 0 || email.length > 320) return false;
  if (email.includes('/') || /\s/.test(email)) return false;
  const at = email.indexOf('@');
  // exactly one '@', with a non-empty local part
  if (at <= 0 || email.includes('@', at + 1)) return false;
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  // a dot in the domain that is neither the first nor the last character
  if (dot <= 0 || dot === domain.length - 1) return false;
  return true;
}

function asPositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return Math.trunc(n);
}

function validateCompositionFields(event) {
  const html = event.html;
  if (typeof html !== 'string' || html.trim().length === 0) {
    throw new RenderError(
      'bad_request',
      '`html` is required and must be a non-empty composition string.'
    );
  }
  const css = event.css;
  if (css !== undefined && typeof css !== 'string') {
    throw new RenderError(
      'bad_request',
      '`css` must be a string when provided.'
    );
  }
  const js = event.js;
  if (js !== undefined && typeof js !== 'string') {
    throw new RenderError(
      'bad_request',
      '`js` must be a string when provided.'
    );
  }
  const bytes =
    Buffer.byteLength(html, 'utf8') +
    (typeof css === 'string' ? Buffer.byteLength(css, 'utf8') : 0) +
    (typeof js === 'string' ? Buffer.byteLength(js, 'utf8') : 0);
  if (bytes > MAX_HTML_BYTES) {
    throw new RenderError(
      'bad_request',
      `Composition (html+css+js) is ${bytes} bytes; maximum is ${MAX_HTML_BYTES}.`
    );
  }
  return { html, css, js };
}

function validateDurationSeconds(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new RenderError(
      'bad_request',
      '`durationSeconds` is required and must be a positive number.'
    );
  }
  if (duration > MAX_DURATION_SECONDS) {
    throw new RenderError(
      'bad_request',
      `\`durationSeconds\` is ${duration}; v1 caps output at ${MAX_DURATION_SECONDS}s. Split longer scenes.`
    );
  }
  return duration;
}

function validateRenderGeometry(event) {
  const fps = asPositiveInt(event.fps, DEFAULT_FPS);
  if (!Number.isFinite(fps) || fps < MIN_FPS || fps > MAX_FPS) {
    throw new RenderError(
      'bad_request',
      `\`fps\` must be an integer between ${MIN_FPS} and ${MAX_FPS}.`
    );
  }
  const width = asPositiveInt(event.width, DEFAULT_WIDTH);
  const height = asPositiveInt(event.height, DEFAULT_HEIGHT);
  for (const [name, dimension] of [
    ['width', width],
    ['height', height],
  ]) {
    if (
      !Number.isFinite(dimension) ||
      dimension < MIN_DIMENSION ||
      dimension > MAX_DIMENSION
    ) {
      throw new RenderError(
        'bad_request',
        `\`${name}\` must be an integer between ${MIN_DIMENSION} and ${MAX_DIMENSION}.`
      );
    }
  }
  return { fps, width, height };
}

function maximumDeclaredDuration(html) {
  const durationRegex =
    /data-duration\s{0,20}=\s{0,20}["']?\s{0,20}([\d.]{1,15})/gi;
  let match;
  let maximum = 0;
  while ((match = durationRegex.exec(html)) !== null) {
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    if (value > MAX_DURATION_SECONDS + 0.5) {
      throw new RenderError(
        'bad_request',
        `Composition declares data-duration=${value}s, above the ${MAX_DURATION_SECONDS}s v1 cap.`
      );
    }
    if (value > maximum) maximum = value;
  }
  return maximum;
}

function validateFrameBudget(durationSeconds, declaredDuration, fps) {
  const renderSeconds = Math.max(durationSeconds, declaredDuration);
  const totalFrames = Math.ceil(fps * renderSeconds);
  if (totalFrames <= MAX_FRAMES) return;
  throw new RenderError(
    'bad_request',
    `fps × duration = ${totalFrames} frames (${fps}fps × ${renderSeconds}s) exceeds the ${MAX_FRAMES}-frame ` +
      `render budget. Lower fps (≤ ${Math.max(MIN_FPS, Math.floor(MAX_FRAMES / renderSeconds))} at ${renderSeconds}s) or shorten the scene.`
  );
}

function validateDeclaredDimensions(html) {
  const dimensionRegex =
    /data-(width|height)\s{0,20}=\s{0,20}["']?\s{0,20}([\d.]{1,15})/gi;
  let match;
  while ((match = dimensionRegex.exec(html)) !== null) {
    const value = Number(match[2]);
    if (Number.isFinite(value) && value > MAX_DIMENSION) {
      throw new RenderError(
        'bad_request',
        `Composition declares data-${match[1].toLowerCase()}=${value}px, above the ${MAX_DIMENSION}px cap.`
      );
    }
  }
}

/**
 * Validate + normalize the invoke event. Throws RenderError('bad_request', …)
 * on any invalid field so the caller gets a specific, actionable message.
 */
function validateRequest(event) {
  if (!event || typeof event !== 'object') {
    throw new RenderError('bad_request', 'Event must be a JSON object.');
  }
  const { html, css, js } = validateCompositionFields(event);
  const durationSeconds = validateDurationSeconds(event.durationSeconds);
  const { fps, width, height } = validateRenderGeometry(event);
  const userEmail = event.userEmail;
  if (!validateEmail(userEmail)) {
    throw new RenderError('bad_request', '`userEmail` is required and must be a valid email address.');
  }
  validateFrameBudget(durationSeconds, maximumDeclaredDuration(html), fps);
  validateDeclaredDimensions(html);

  return {
    html,
    css: css || null,
    js: js || null,
    durationSeconds,
    fps,
    width,
    height,
    userEmail,
    dryRun: event.dryRun === true,
  };
}

/**
 * Insert `snippet` immediately before the first occurrence of `marker`
 * (case-insensitive). If the marker is absent, append to the end so the
 * content is never silently dropped.
 */
function injectBefore(source, marker, snippet) {
  const idx = source.toLowerCase().indexOf(marker.toLowerCase());
  if (idx === -1) return `${source}\n${snippet}`;
  return `${source.slice(0, idx)}${snippet}${source.slice(idx)}`;
}

/**
 * Assemble the final composition document from the HTML plus any separately
 * supplied CSS/JS. CSS goes in a <style> before </head>; JS in a <script>
 * before </body>. When neither is supplied the HTML passes through unchanged.
 */
function buildComposition({ html, css, js }) {
  let out = html;
  if (css) out = injectBefore(out, '</head>', `<style>\n${css}\n</style>\n`);
  if (js) out = injectBefore(out, '</body>', `<script>\n${js}\n</script>\n`);
  return out;
}

/**
 * Render the composition to an MP4 via the bundled `hyperframes` CLI.
 * Writes `index.html` into `workDir` and renders to `outPath`. Software
 * rendering only (`--no-browser-gpu`) — Lambda has no GPU. Lint findings are
 * non-blocking by default (no --strict), so a best-effort model composition
 * still produces video.
 */
async function renderToMp4(compositionHtml, { fps, workDir, outPath }) {
  const htmlPath = path.join(workDir, 'index.html');
  validatedFs.writeFileSync(htmlPath, compositionHtml, 'utf8');

  const args = [
    'render', workDir,
    '-c', 'index.html',
    '-o', outPath,
    '--fps', String(fps),
    '--format', 'mp4',
    '--workers', String(RENDER_WORKERS),
    '--no-browser-gpu',
    '--quiet',
  ];

  try {
    await execFileAsync(HYPERFRAMES_BIN, args, {
      env: childEnvWithoutCredentials(),
      timeout: RENDER_TIMEOUT_MS,
      maxBuffer: RENDER_MAX_BUFFER,
      cwd: workDir,
    });
  } catch (err) {
    if (err && err.killed && err.signal === 'SIGTERM') {
      throw new RenderError('render_timeout', `Render exceeded ${RENDER_TIMEOUT_MS} ms. Shorten the scene or lower fps.`);
    }
    const detail = String((err && (err.stderr || err.message)) || err).slice(0, 800);
    // Log to CloudWatch: the handler returns errors as data (never throws to the
    // platform), so without this a render failure leaves no server-side trace.
    console.error(`[render] hyperframes failed: code=${err && err.code} signal=${err && err.signal} detail=${detail}`);
    throw new RenderError('render_failed', `hyperframes render failed: ${detail}`);
  }

  if (!validatedFs.existsSync(outPath) || validatedFs.statSync(outPath).size === 0) {
    throw new RenderError('render_failed', 'hyperframes render produced no output file.');
  }
  return outPath;
}

/**
 * Upload the MP4 to `s3://$WORKSPACE_BUCKET/public-images/<email>/<uuid>.mp4`
 * and return an unsigned, public-by-link HTTPS URL. Same delivery model as
 * psd-image-gen / psd-tts (the `public-images/` prefix has a bucket-policy
 * ALLOW for `s3:GetObject` to Principal:*; the UUID makes the key unguessable).
 */
async function uploadMp4(s3, { outPath, userEmail, bucket, uuid }) {
  const key = `${PUBLIC_PREFIX}/${userEmail}/${uuid}.mp4`;
  // Read into a Buffer rather than streaming: the file lives in workDir, which
  // the handler's finally block removes right after the upload resolves, so a
  // lazily-opened read stream could outlive the file. MP4s are well within the
  // Lambda memory budget. Matches psd-image-gen's buffer upload.
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: validatedFs.readFileSync(outPath),
    ContentType: 'video/mp4',
    Metadata: { generated_by: 'psd-hyperframes' },
  }));
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const url = `https://${bucket}.s3.${REGION}.amazonaws.com/${encodedKey}`;
  return { url, key };
}

/**
 * Lambda entry point. `deps` is a test seam (inject `s3` and/or `render`);
 * production callers leave it unset.
 */
async function handler(event, deps = {}) {
  const s3 = deps.s3 || getS3Client();
  const runRender = deps.render || renderToMp4;

  try {
    const req = validateRequest(event);
    // Fail fast: a missing upload target must not cost a multi-minute render.
    // dryRun never uploads, so it is exempt. (Mirrors psd-image-gen validating
    // WORKSPACE_BUCKET before spending the upstream call.)
    if (!req.dryRun && !process.env.WORKSPACE_BUCKET) {
      throw new RenderError('misconfigured', 'WORKSPACE_BUCKET env var not set — cannot upload rendered video.');
    }
    const composition = buildComposition(req);
    const uuid = randomUUID();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-render-'));
    // dryRun output lives inside workDir by default, so the finally block below
    // removes it and a production dry-run leaves nothing behind in /tmp. Only
    // the offline docker/RIE smoke sets HYPERFRAMES_OUTPUT_DIR, which redirects
    // the MP4 to a stable dir so it survives cleanup for inspection.
    const dryRunDir = process.env.HYPERFRAMES_OUTPUT_DIR || workDir;
    const outPath = req.dryRun
      ? path.join(dryRunDir, `hyperframes-${uuid}.mp4`)
      : path.join(workDir, `${uuid}.mp4`);

    try {
      await runRender(composition, {
        fps: req.fps,
        width: req.width,
        height: req.height,
        workDir,
        outPath,
      });
      const bytes = validatedFs.statSync(outPath).size;

      const base = {
        status: 'ok',
        bytes,
        fps: req.fps,
        durationSeconds: req.durationSeconds,
        width: req.width,
        height: req.height,
      };

      if (req.dryRun) {
        return { ...base, dryRun: true, localPath: outPath };
      }

      // Guaranteed set for the non-dryRun path by the fail-fast check above.
      const bucket = process.env.WORKSPACE_BUCKET;
      const { url, key } = await uploadMp4(s3, { outPath, userEmail: req.userEmail, bucket, uuid });
      return { ...base, url, s3Key: key, sharing: 'public-by-link' };
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  } catch (err) {
    if (err instanceof RenderError) {
      return { status: 'error', error: err.code, message: err.message };
    }
    return {
      status: 'error',
      error: 'internal_error',
      // Truncate to match the RenderError path (renderToMp4 slices stderr to
      // 800) so an unexpected error can't surface an unbounded message to the
      // caller / chat reply.
      message: (err instanceof Error ? err.message : String(err)).slice(0, 800),
    };
  }
}

/**
 * One-time cold-start FFmpeg self-check, logged to CloudWatch. The full Debian
 * ffmpeg failed its hyperframes preflight inside the Lambda sandbox (#1175
 * follow-up); this records whether the configured binary actually runs on this
 * environment, so a regression is diagnosable from logs rather than only the
 * caller's error string. Non-blocking (async execFile) — never affects a render.
 */
function logFfmpegSelfCheck() {
  const bin = process.env.HYPERFRAMES_FFMPEG_PATH || 'ffmpeg';
  const started = Date.now();
  execFile(bin, ['-version'], { timeout: 8000 }, (err, stdout) => {
    const ms = Date.now() - started;
    if (err) {
      console.error(
        `[ffmpeg-selfcheck] FAILED bin=${bin} code=${err.code} signal=${err.signal} killed=${err.killed} after=${ms}ms: ${String(err.message).slice(0, 200)}`,
      );
    } else {
      console.log(`[ffmpeg-selfcheck] OK bin=${bin} after=${ms}ms — ${String(stdout).split('\n')[0]}`);
    }
  });
}
// Only in the real Lambda (AWS_LAMBDA_FUNCTION_NAME is set there, unset in tests).
if (process.env.AWS_LAMBDA_FUNCTION_NAME) logFfmpegSelfCheck();

module.exports = {
  handler,
  // Exported for unit tests (bun test).
  validateRequest,
  buildComposition,
  injectBefore,
  renderToMp4,
  uploadMp4,
  childEnvWithoutCredentials,
  RenderError,
  MAX_DURATION_SECONDS,
  DEFAULT_FPS,
};
