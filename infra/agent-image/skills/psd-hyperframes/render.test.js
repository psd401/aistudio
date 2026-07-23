'use strict';
/**
 * Unit tests for psd-hyperframes/render.js (#1175).
 *
 * Covers CLI arg parsing + payload validation and the Lambda-invocation path
 * with a mocked LambdaClient (injected via `deps.client`) so no AWS is touched.
 *
 * Run: cd infra/agent-image/skills/psd-hyperframes && bun test
 */

const { test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseArgs,
  buildPayload,
  invokeRender,
  validateEmail,
  main,
} = require('./render');

const HTML =
  '<div data-composition-id="demo" data-duration="3">hi</div>';

// fail() calls process.exit(1); stub it to throw so validation branches are
// observable. Stdout/stderr are captured so the emitted JSON can be asserted.
class ExitError extends Error {
  constructor(code) {
    super(`exit(${code})`);
    this.code = code;
  }
}

let originalExit;
let originalStdout;
let originalStderr;
let stdout;

beforeEach(() => {
  stdout = '';
  originalExit = process.exit;
  originalStdout = process.stdout.write;
  originalStderr = process.stderr.write;
  process.exit = (code) => { throw new ExitError(code); };
  process.stdout.write = (chunk) => { stdout += chunk; return true; };
  process.stderr.write = () => true;
  process.env.HYPERFRAMES_RENDER_FUNCTION = 'psd-hyperframes-render-dev';
});

afterEach(() => {
  process.exit = originalExit;
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  delete process.env.HYPERFRAMES_RENDER_FUNCTION;
});

function lastJson() {
  const lines = stdout.trim().split('\n');
  return JSON.parse(lines.join('\n'));
}

function argv(...rest) {
  return ['node', 'render.js', ...rest];
}

// ── validateEmail / parseArgs ────────────────────────────────────────────────

test('validateEmail accepts real emails, rejects junk and path separators', () => {
  expect(validateEmail('person@psd401.net')).toBe(true);
  expect(validateEmail('nope')).toBe(false);
  expect(validateEmail('a/b@psd401.net')).toBe(false);
});

test('parseArgs maps --dashed-flags to underscore keys and boolean flags', () => {
  const args = parseArgs(argv('--user', 'x@y.z', '--css-file', '/tmp/a.css', '--dry-run'));
  expect(args.user).toBe('x@y.z');
  expect(args.css_file).toBe('/tmp/a.css');
  expect(args.dry_run).toBe(true);
});

// ── buildPayload validation ──────────────────────────────────────────────────

test('buildPayload assembles a valid payload with defaults', () => {
  const p = buildPayload(parseArgs(argv('--user', 'p@psd401.net', '--html', HTML, '--duration', '3')));
  expect(p.userEmail).toBe('p@psd401.net');
  expect(p.html).toBe(HTML);
  expect(p.durationSeconds).toBe(3);
  expect(p.fps).toBe(30);
  expect(p.width).toBe(1920);
  expect(p.height).toBe(1080);
  expect(p.css).toBeUndefined();
});

test('buildPayload rejects a missing user', () => {
  expect(() => buildPayload(parseArgs(argv('--html', HTML, '--duration', '3')))).toThrow(ExitError);
  expect(lastJson().error).toBe('bad_args');
});

test('buildPayload rejects a missing composition', () => {
  expect(() => buildPayload(parseArgs(argv('--user', 'p@psd401.net', '--duration', '3')))).toThrow(ExitError);
  expect(lastJson().error).toBe('bad_args');
});

test('buildPayload rejects a missing / non-positive / over-cap duration', () => {
  const base = ['--user', 'p@psd401.net', '--html', HTML];
  expect(() => buildPayload(parseArgs(argv(...base)))).toThrow(ExitError);
  expect(() => buildPayload(parseArgs(argv(...base, '--duration', '0')))).toThrow(ExitError);
  expect(() => buildPayload(parseArgs(argv(...base, '--duration', '181')))).toThrow(ExitError); // > 180s (3 min) cap
});

test('buildPayload allows up to the 3-minute cap at a budget-safe fps', () => {
  const base = ['--user', 'p@psd401.net', '--html', HTML];
  // 180s at 20fps = 3600 frames = exactly the render budget.
  expect(() => buildPayload(parseArgs(argv(...base, '--duration', '180', '--fps', '20')))).not.toThrow();
});

test('buildPayload rejects an over-budget frame count (fps × duration > 3600)', () => {
  const base = ['--user', 'p@psd401.net', '--html', HTML];
  // 120s at 60fps = 7200 frames — over the budget even though each is in range.
  expect(() => buildPayload(parseArgs(argv(...base, '--duration', '120', '--fps', '60')))).toThrow(ExitError);
  expect(lastJson().error).toBe('bad_args');
});

test('buildPayload rejects fps and dimensions out of range', () => {
  const base = ['--user', 'p@psd401.net', '--html', HTML, '--duration', '3'];
  expect(() => buildPayload(parseArgs(argv(...base, '--fps', '61')))).toThrow(ExitError);
  expect(() => buildPayload(parseArgs(argv(...base, '--width', '9')))).toThrow(ExitError);
});

test('buildPayload fails on a valueless --css-file / --js-file instead of silently dropping it', () => {
  const base = ['--user', 'p@psd401.net', '--html', HTML, '--duration', '3'];
  // --css-file as the last token parses to boolean true — must be a hard error.
  expect(() => buildPayload(parseArgs(argv(...base, '--css-file')))).toThrow(ExitError);
  expect(lastJson().error).toBe('bad_args');
  stdout = ''; // reset so lastJson() reads only the second fail's JSON
  expect(() => buildPayload(parseArgs(argv(...base, '--js-file')))).toThrow(ExitError);
  expect(lastJson().error).toBe('bad_args');
});

test('buildPayload rejects a --dry-run given a value', () => {
  const base = ['--user', 'p@psd401.net', '--html', HTML, '--duration', '3'];
  expect(() => buildPayload(parseArgs(argv(...base, '--dry-run', 'true')))).toThrow(ExitError);
  expect(lastJson().error).toBe('bad_args');
});

test('buildPayload caps the combined html+css+js size', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-skill-big-'));
  const cssPath = path.join(dir, 'big.css');
  fs.writeFileSync(cssPath, 'a'.repeat(5 * 1024 * 1024));
  try {
    expect(() => buildPayload(parseArgs(argv(
      '--user', 'p@psd401.net', '--html', HTML, '--duration', '3', '--css-file', cssPath,
    )))).toThrow(ExitError);
    expect(lastJson().error).toBe('bad_args');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildPayload reads css/js from files and carries dryRun', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-skill-'));
  const cssPath = path.join(dir, 'a.css');
  fs.writeFileSync(cssPath, 'body{color:red}');
  try {
    const p = buildPayload(parseArgs(argv(
      '--user', 'p@psd401.net', '--html', HTML, '--duration', '3',
      '--css-file', cssPath, '--dry-run',
    )));
    expect(p.css).toBe('body{color:red}');
    expect(p.dryRun).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildPayload injects an <audio> track from --audio-url into the composition root', () => {
  const url = 'https://psd-agents-dev.s3.us-east-1.amazonaws.com/public-images/p@psd401.net/n.mp3';
  const p = buildPayload(parseArgs(argv(
    '--user', 'p@psd401.net', '--html', HTML, '--duration', '3', '--audio-url', url,
  )));
  expect(p.html).toContain(`<audio src="${url}"`);
  expect(p.html).toContain('data-duration="3"');
  expect(p.html).toContain('data-track-index="0"');
  // Injected as the first child of the data-composition-id root element.
  expect(p.html).toMatch(/data-composition-id="demo"[^>]*>\s*<audio /);
});

test('buildPayload rejects an unsafe / non-https --audio-url', () => {
  const base = ['--user', 'p@psd401.net', '--html', HTML, '--duration', '3'];
  expect(() => buildPayload(parseArgs(argv(...base, '--audio-url', 'http://insecure.example/n.mp3')))).toThrow(ExitError);
  expect(lastJson().error).toBe('bad_args');
  stdout = ''; // reset so lastJson() reads only the second failure
  expect(() => buildPayload(parseArgs(argv(...base, '--audio-url', 'https://x/a" onerror=1')))).toThrow(ExitError);
  expect(lastJson().error).toBe('bad_args');
});

// ── invokeRender (mocked LambdaClient) ───────────────────────────────────────

function fakeClient(responder) {
  const sent = [];
  return {
    sent,
    send: async (command) => {
      sent.push(command);
      return responder(command);
    },
  };
}

function okPayload(extra = {}) {
  return Buffer.from(JSON.stringify({
    status: 'ok',
    url: 'https://psd-agents-dev.s3.us-east-1.amazonaws.com/public-images/p@psd401.net/uuid.mp4',
    s3Key: 'public-images/p@psd401.net/uuid.mp4',
    bytes: 12345,
    fps: 30,
    durationSeconds: 3,
    width: 1920,
    height: 1080,
    sharing: 'public-by-link',
    ...extra,
  }));
}

test('invokeRender sends a RequestResponse invoke to the configured function and returns the parsed result', async () => {
  const client = fakeClient(() => ({ Payload: okPayload() }));
  const result = await invokeRender({ html: HTML, durationSeconds: 3 }, { client });
  expect(result.status).toBe('ok');
  expect(result.s3Key).toBe('public-images/p@psd401.net/uuid.mp4');
  expect(client.sent).toHaveLength(1);
  expect(client.sent[0].input.FunctionName).toBe('psd-hyperframes-render-dev');
  expect(client.sent[0].input.InvocationType).toBe('RequestResponse');
  const decoded = JSON.parse(Buffer.from(client.sent[0].input.Payload).toString('utf8'));
  expect(decoded.html).toBe(HTML);
});

test('invokeRender surfaces a structured render error (status:error) as an exit', async () => {
  const client = fakeClient(() => ({
    Payload: Buffer.from(JSON.stringify({ status: 'error', error: 'render_failed', message: 'chromium crashed' })),
  }));
  await expect(invokeRender({ html: HTML }, { client })).rejects.toThrow(ExitError);
  expect(lastJson().error).toBe('render_failed');
  expect(lastJson().message).toContain('chromium crashed');
});

test('invokeRender surfaces a Lambda FunctionError as render_failed', async () => {
  const client = fakeClient(() => ({ FunctionError: 'Unhandled', Payload: Buffer.from('{"errorMessage":"Task timed out"}') }));
  await expect(invokeRender({ html: HTML }, { client })).rejects.toThrow(ExitError);
  expect(lastJson().error).toBe('render_failed');
});

test('invokeRender fails misconfigured when the function name env var is unset', async () => {
  delete process.env.HYPERFRAMES_RENDER_FUNCTION;
  const client = fakeClient(() => ({ Payload: okPayload() }));
  await expect(invokeRender({ html: HTML }, { client })).rejects.toThrow(ExitError);
  expect(lastJson().error).toBe('misconfigured');
});

// ── main end-to-end (mocked client) ──────────────────────────────────────────

test('main emits the bare result JSON with the url on success', async () => {
  const client = fakeClient(() => ({ Payload: okPayload() }));
  await main(argv('--user', 'p@psd401.net', '--html', HTML, '--duration', '3'), { client });
  const out = lastJson();
  expect(out.url).toContain('/public-images/');
  expect(out.s3Key).toBe('public-images/p@psd401.net/uuid.mp4');
  expect(out.sharing).toBe('public-by-link');
});
